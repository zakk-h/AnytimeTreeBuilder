# Native live builder: node queries over ArborEnum

The C++ service runs ArborEnum and answers queries against its actual C++ trie. Live sessions never export, clone, index, serialize, or accumulate a second Rashomon graph. Python is not part of the runtime.

## Build and run

Requires CMake 3.20+, a C++20 compiler with `std::jthread`, and Node.js 22.12+ for the frontend build. Runtime needs only the executable and the built HTML.

```sh
cd InteractiveTreeBuilder
npm ci
npm run typecheck
npm test
npm run build
cd ../ArborEnum
cmake -S native -B build/native -DCMAKE_BUILD_TYPE=Release
cmake --build build/native --parallel 2
ctest --test-dir build/native --output-on-failure
build/native/arborenum-builder --ui ../InteractiveTreeBuilder/dist/index.html
```

Open `http://127.0.0.1:8765`, choose **Upload → Upload dataset**, upload a CSV and select its classification target. Labels can be strings. The browser keeps numeric columns, maps case-insensitive TRUE/FALSE cells to 1/0, and encodes columns with other text as named binary indicators (one per category). Empty cells and numeric overflow are rejected; the native engine still receives only finite numeric features. Selecting a CSV immediately clears the previous graph and options, which stay hidden until the new session returns its first node view. The root becomes available as soon as it has a feasible completion, while the initial solve can still be running. Choosing a split or selecting/rewinding a node automatically reads its current options and objectives from the native model. **Update options** refreshes the currently selected node without resetting the tree, history, favorites, customization or viewport.

The native preprocessing treats columns with at most two distinct values as ordinary binary features and uses all thresholds for continuous features. Constant features are supported. Median cutpoints seed the native proxy, so intermediate sets may differ from the Python API's threshold-guessing preprocessing. The existing enumeration algorithm and objective settings are retained.

## Queries and ownership

`Session` owns a C++20 `std::jthread`; that thread exclusively owns the real `ArborEnum` model. HTTP threads enqueue bounded requests with promises. They never dereference the mutable graph. Enumeration services requests at resource checks, proxy entry points, and every 256 leaf-objective evaluations. Servicing a query temporarily suspends enumeration on the same owner thread, making native pointers, vectors and objective fields safe to read without locks over the graph. This does not wait for an entire refinement round. The idle path is an atomic queue check; at most eight requests are served per yield before enumeration resumes.

A node request contains only the user's small displayed tree and active UID. `GraphQueries` follows selected **feature + branch** decisions from the native root. It reads native minimum-objective fields and sample masks for displayed nodes, then returns leaf/split alternatives at the active node and immediate child minimum/sample-size metadata. Reading other displayed frontier minima is necessary to compute the remaining global Rashomon budget under the user's existing choices. No undisplayed descendants are traversed for a normal node request. Reported minimum objectives are the native solver's current maintained values, which can decrease during refinement.

If D is the displayed-tree size and K is the selected node's number of alternatives, normal query work depends on D, K, selected-path split lookups and the training-mask word count. During a recursive solve it also refreshes local split minima along the active solver recursion path, bottom-up. Neither step traverses the whole Rashomon DAG. `visited_nodes` counts traced displayed nodes; alternatives also read immediate child fields without recursively visiting their subgraphs.

### Early initial root

The initial solve binds `result` to the real root through the same construction binding used for child nodes. At cooperative polls, the actor refreshes active recursive parents bottom-up and announces readiness once the root has a finite minimum within its budget. It never exposes an empty allocated root. This readiness transition is independent of coarse checkpoints: a session can be `running`, `ready: true`, `checkpoint: 0`, and service native node/completion requests before the first pass returns. After readiness the idle polling path returns to its normal atomic queue check.

The frontend connects and queries that root through its existing readiness flow. The first available tree may be a leaf or require a split; options and objective values continue growing through later queries without resetting the user's choices. Initial proxy evaluation and data preparation still precede a feasible graph, and browser status polling can add up to about 500 ms plus request handling time before it appears.

### Incremental split attachment

All eight `solve_siblings_extend` call sites supply the owning OR node and feature. In live mode a scoped attachment inserts a new split with null children **before** either recursive child solve starts. Construction binds each child to its real, canonical C++ node as soon as that node is allocated or resolved from the cache, before yielding to readers. Subsequent alternatives grow in place, so a new split no longer stays disconnected until both child solves return. Existing splits remain attached during extension.

Null children and children without a finite, budget-feasible pair are internal unfinished work, never selectable GUI options. As soon as both children contain a feasible completion, queries can offer the split and explore its growing children while their recursive solves continue. Completion DP skips missing children and respects actual child/parent budgets; it never invents a completion for a placeholder. Before a query, current recursive parents' minima are refreshed bottom-up from immediate child fields. This uses the active call path, not a graph export or recursive full-graph scan.

Scoped C++ cleanup handles ordinary return, resource limits and cancellation: it retains usable attached splits, removes only placeholders that have never become usable, and preserves prior children when an extension fails. Finalization updates the preattached split instead of appending a duplicate. Offline models without live polling retain deferred attachment. The actual initial root is also bound before construction; empty roots remain hidden until they contain a feasible completion.

The browser keeps its chosen tree and a small rendering adapter: summaries for that tree, the active node's choices and immediate children. The adapter uses the existing renderer's `AndOrGraph` interface, but discards unrelated alternatives on the next query. Local IDs identify selected feature/branch paths, so undo and favorites survive native growth. It never accumulates the visited Rashomon graph. Unknown choices are labeled **Select to explore**. Singleton choices are not automatically expanded through unqueried native nodes.

Every selection change aborts the previous browser fetch. A request sequence, session ID and captured selection prevent late replies from replacing newer choices. Completion replies include the single concrete tree and its displayed-node summaries, so the tree and render data are committed together.

`live_forbid_graph_export` is enabled on native models: calling `export_andor_graph` inside a live session is a logic error. The old full-snapshot endpoint returns HTTP 410, and `full_graph_exports` remains zero. Ordinary offline ArborEnum exports remain available on ordinary models.

## Native completions

Optimal, random and constrained completions operate directly on the native graph. The browser sends its selected tree, active subtree UID and any constraints, and receives **one concrete tree**. No graph payload is created or transferred.

- **Optimal:** memoized dynamic programming stores objective values and selected pointers into the original C++ alternatives, then reconstructs the selected tree.
- **Random:** native objective minima determine feasible alternatives under the remaining budget; sampling recursively picks feasible alternatives and allocates budgets to children. This is randomized feasible-choice sampling, not a uniform draw over all complete trees.
- **Avoid features:** forbidden internal features are excluded during native DP. Existing forbidden splits in the selected subtree produce an error rather than silently changing user choices.
- **Sample prediction:** DP tracks whether a subtree must guarantee the target class. Known feature truth follows one branch; unspecified feature truth requires both branches to satisfy the guarantee.
- **Combined constraints:** the same DP applies avoidance and prediction requirements jointly; it does not filter or copy a graph.

Existing selected splits/leaves are preserved. Only unfinished choices inside the selected subtree are filled. Global objective feasibility accounts for the other displayed frontier minima. Native local budgets are respected. An impossible constrained completion leaves the selected tree intact.

Completion DP may visit the reachable native DAG and use O(V) scalar/pointer memo storage, but never creates a duplicate graph or enumerates every tree. Enumeration is paused while a completion is computed. Node requests have a ten-second deadline; completions have a sixty-second deadline and cancellation checks. The queue has a 32-request bound, and timed-out requests are cancelled.

## Stop and lifecycle

**Stop** cancels enumeration while retaining the actual native model. The owner thread then services node/completion queries in an idle actor loop. No snapshot or graph reconstruction is needed to keep exploring a stopped or finished run. Closing/replacing a session requests lifetime cancellation and joins before destroying the model. A new dataset can start after enumeration finishes or stops. One enumeration is active per service.

The initial restricted solve retains ArborEnum's original runtime/memory-limit semantics: resource limits apply after it completes. Cancellation can interrupt it at resource checks. A root with a feasible completion is retained even when the initial solve is interrupted; cancellation before any feasible completion leaves the session unready. Reload reconnects to the same native session and queries its root; browser-local tree/history are not persisted across reloads.

## Protocol, version 2

All mutation bodies are JSON. `session_id` rejects stale session requests.

- `GET /api/health`: service identification and protocol version 2.
- `POST /api/session`: `{feature_names, class_names, X, y, settings}`; start enumeration, or 409 if one is active.
- `GET /api/session`: readiness, phase, query/checkpoint counters, last traced-node count, and zero full-graph exports.
- `GET /api/meta?session_id=ID`: feature registry, class names and objective metadata; no graph.
- `POST /api/node?session_id=ID`: `{tree, active_uid}`; displayed-node summaries and active-node alternatives.
- `POST /api/complete?session_id=ID`: `{tree, active_uid, next_uid, mode, constraint?, seed?}`; one concrete tree plus its local view. Modes: `optimal`, `random`, `constrained`.
- `POST /api/stop?session_id=ID`: `{}`; cancel enumeration while retaining native exploration.
- `GET /api/snapshot`: 410; full-graph snapshots are removed.

Settings are validated in `live_types.hpp`; `Settings::as_json()` lists every supported field. Each session returns its effective configuration in `meta.training_settings`.

- Objective: `lambda_reg`, `rashomon_mult`, `second_rashomon_mult`, `multiplier_step_size`, `additive`, `multiplicative_slack`. Additive tolerance adds the tolerance times the sample count to the reference objective; the default is relative tolerance.
- Abstention: `allow_abstain` and `abstain_cost` (default 0.1). The native prepared black-box labels are the training labels themselves. Prediction `-1` means **Abstain**, with leaf loss `gamma + round(abstain_cost * sample_count)` and no classification mistakes. Zero cost permits a trivial all-abstain optimum. This is an oracle action on training data, not a learned prediction for unseen rows. Metadata retains `use_deferral`, `eta_defer` and `abstain_uses_labels` for rendering, export and summary calculations.
- Search: `depth_budget` (0–127), `lookahead_k` (0–depth), `proxy_style` (0 recursive, 1 block, 3 without postprocessing), `greedy_split_mode` (0 entropy, 1 entropy with exact depth-one, 2 child-leaf objective), `greedy_continuous_mode` (`binary` / `numerical`), `rule_list_mode` (guarantees recovery of rule lists alongside trees), `majority_leaf_only`, `use_multipass`, `stronger_rollout`, `evaluated_use_min_objectives`.
- Refinement: `refinement_width`, `max_refinement_rounds` (-1 unlimited, 0 skips threshold refinement), `max_number_thresholds_per_feature` (-1 exhaustive, otherwise a positive cap), `proxy_mode`, `proxy_refinement`.
- Identity/caching: `key_mode` (`hash`, `hash128`, `exact`, `lits_exact`), `trie_cache`, `cache_cheap_subproblems`. Anytime enumeration always enables its required proxy objective cache.
- Expert overrides: `proxy_threshold_features` and `initial_active_threshold_features` are distinct nonnegative internal threshold IDs after preprocessing; an empty list selects the native defaults. `continuous_proxy_in_lickety`, `continuous_proxy_in_depthd_exact`, and `continuous_proxy_in_greedy` accept true, false or null (follow `proxy_mode`). Invalid IDs fail the session with a reported error.
- Resources: `runtime_limit_seconds` and `memory_limit_mb` accept positive values or -1 for unlimited. Their initial-solve semantics remain as described above.

Unknown fields, invalid types, non-finite values and objective integer overflows are rejected. Expanding the Rashomon tolerance cannot decrease it. The UI groups these settings under the training dialog and its Advanced section.

The service binds to IPv4 loopback. Explicit loopback Host/Origin names are accepted on forwarded preview ports; external hosts/origins are rejected. C++ HTTP/JSON dependencies are pinned vendored MIT headers: cpp-httplib 0.18.7 and nlohmann/json 3.11.3.

## Validation

Native tests compare constrained optima against an independent exhaustive fixture oracle, validate random trees against original native pointers/budgets, verify scoped completion preserves other branches, and assert node queries visit only displayed paths with exports disabled. Concurrent actor requests and exploration after Stop are covered and tested under ThreadSanitizer.

Incremental-attachment regression tests observe null placeholders during live polling, then query and complete a newly exposed split while descendants are still being constructed. They cover optimal, random and constrained completions, monotonic exposed options, cancellation before and after a split becomes usable, no surviving placeholders or duplicate features, and identical finished graph structure/objectives/tree counts with live polling enabled or disabled, with and without trie caching.

`tests/test_dataset_upload.py BINARY HTML` covers boolean/text CSV conversion through the real GUI and C++ service, clearing on upload, stale replies, delayed metadata/node views, validation failures and retries. `tests/test_initial_preview.py BINARY HTML` verifies that Chromium displays and queries the root before the initial checkpoint, then stops while retaining it. `tests/test_live_api.py BINARY HTML` exercises the actual service, including HTTP queries and cancellation at checkpoint zero. `InteractiveTreeBuilder/tests/browser_live.py URL CSV` tests automatic split/selection queries, rapid navigation, all C++ completion modes, preservation of tree/history/favorites/viewport and absence of snapshot requests. `tests/test_preview_proxy.py BACKEND_PORT` tests both browser proxy Host strategies. Browser tests require Playwright only as a test dependency.

Initial-root tests cover leaf and split-only first completions, rejection of empty roots, all completion modes before the first checkpoint, cancellation before/after initial feasibility, unchanged finished graphs, and actor queries/Stop while checkpoint remains zero.

## Embedded desktop build

The portable app uses the same HTTP service, owner thread, graph queries, cancellation and native completions. Configure `-DARBORENUM_DESKTOP=ON -DARBORENUM_EMBED_UI=/absolute/path/to/dist/index.html` to embed the UI as exact UTF-8 bytes and name the binary `AnytimeTreeBuilder`. CMake tracks the HTML as a build dependency. The root `build-desktop` launchers handle the frontend build, compilation, native tests, packaging and notices.

Desktop builds select a free IPv4 loopback port and open the generated URL through ShellExecute on Windows, `open` on macOS, or `xdg-open` on Linux, without a shell. They ignore hosting environment configuration and keep the existing Host/Origin and per-browser cookie checks. `--no-browser` suppresses opening; `--port 0` explicitly requests a free port. Windows uses a static MSVC runtime. Official Linux packages use static musl linking.

`python3 native/tests/test_desktop.py BINARY EXPECTED_HTML` (from the ArborEnum directory) copies the executable into an unrelated directory with spaces, checks the embedded UI byte-for-byte, runs simultaneous instances on distinct free ports, verifies external hosts stay blocked, and exercises real native enumeration/completion and shutdown. On Linux it also verifies automatic browser launch using a fixture opener.

## Managed desktop window

The default root build launchers now also package an Electron window in `dist/apps`. The native service still embeds its UI and owns the same C++ graph. The desktop parent starts it with `--managed --no-browser --port 0`, checks the health protocol, then opens a sandboxed BrowserWindow at the announced loopback origin. The renderer has no Node integration or privileged preload bridge.

`--managed` requires a parent-owned stdin pipe (or Unix socket). The existing shutdown watcher checks it without blocking: EOF triggers the same cooperative session cancellation and HTTP shutdown as Ctrl+C. Closing the desktop window ends that pipe; a crashed parent also closes it at the OS level. There is no network-accessible shutdown endpoint. The janitor uses a stop-token-aware wait so it does not delay shutdown by its five-second idle interval. After twelve seconds the desktop parent terminates an unresponsive child as a last resort.

`node desktop/app/tests/engine.cjs BINARY` verifies native startup, enumeration, cooperative parent-pipe shutdown and cleanup after an abruptly terminated parent. `desktop/app/tests/app.cjs PACKAGED_APPLICATION` exercises the actual packaged window and checks that its native service disappears on close.

Constrained completion accepts `minimizeAbstention: true` alongside feature avoidance or sample-prediction constraints (use `mode: "avoid"` with no forbidden features for this preference alone). It minimizes abstained training samples, then objective, within every native node budget and the root Rashomon bound. Selected splits/leaves stay fixed; only unfinished choices in the selected subtree are filled. The native planner keeps nondominated objective/abstention pairs and backpointers into the live graph; it exports no graph.
