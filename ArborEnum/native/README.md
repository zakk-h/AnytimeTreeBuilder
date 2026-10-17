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

Open `http://127.0.0.1:8765`, choose **New enumeration**, upload a numerical CSV and select its classification target. Labels can be strings; missing/non-finite feature values are rejected. The root becomes available as soon as it has a feasible completion, while the initial solve can still be running. Choosing a split or selecting/rewinding a node automatically reads its current options and objectives from the native model. **Update options** refreshes the currently selected node without resetting the tree, history, favorites, customization or viewport.

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

Settings: `lambda_reg`, `depth_budget`, `rashomon_mult`, `second_rashomon_mult`, `multiplier_step_size`, `lookahead_k`, `refinement_width`, `proxy_mode`, `proxy_refinement`, `key_mode`, `runtime_limit_seconds`, `memory_limit_mb`. Unknown settings are rejected. Depth is 0–20, lookahead is 0–depth, limits are positive and multiplier expansion cannot decrease the initial multiplier.

The service binds to IPv4 loopback. Explicit loopback Host/Origin names are accepted on forwarded preview ports; external hosts/origins are rejected. C++ HTTP/JSON dependencies are pinned vendored MIT headers: cpp-httplib 0.18.7 and nlohmann/json 3.11.3.

## Validation

Native tests compare constrained optima against an independent exhaustive fixture oracle, validate random trees against original native pointers/budgets, verify scoped completion preserves other branches, and assert node queries visit only displayed paths with exports disabled. Concurrent actor requests and exploration after Stop are covered and tested under ThreadSanitizer.

Incremental-attachment regression tests observe null placeholders during live polling, then query and complete a newly exposed split while descendants are still being constructed. They cover optimal, random and constrained completions, monotonic exposed options, cancellation before and after a split becomes usable, no surviving placeholders or duplicate features, and identical finished graph structure/objectives/tree counts with live polling enabled or disabled, with and without trie caching.

`tests/test_initial_preview.py BINARY HTML` verifies that Chromium displays and queries the root before the initial checkpoint, then stops while retaining it. `tests/test_live_api.py BINARY HTML` exercises the actual service, including HTTP queries and cancellation at checkpoint zero. `InteractiveTreeBuilder/tests/browser_live.py URL CSV` tests automatic split/selection queries, rapid navigation, all C++ completion modes, preservation of tree/history/favorites/viewport and absence of snapshot requests. `tests/test_preview_proxy.py BACKEND_PORT` tests both browser proxy Host strategies. Browser tests require Playwright only as a test dependency.

Initial-root tests cover leaf and split-only first completions, rejection of empty roots, all completion modes before the first checkpoint, cancellation before/after initial feasibility, unchanged finished graphs, and actor queries/Stop while checkpoint remains zero.
