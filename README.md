# AnytimeTreeBuilder

Build decision trees interactively while ArborEnum grows a Rashomon set in the background. Start from a numerical CSV, explore splits and their current minimum objectives, and request optimal, random or constrained completions directly from the running C++ graph.

This repository contains the integrated ArborEnum engine and InteractiveTreeBuilder GUI. A single clone includes all source needed to build and run it; no submodules or precomputed Rashomon graph are required.

## Build and launch

Requires Node.js 22.12+ and npm, CMake 3.20+, and a C++20 compiler with `std::jthread` support. The combined build and launch scripts use Bash; Linux is tested.

```sh
git clone https://github.com/zakk-h/AnytimeTreeBuilder.git
cd AnytimeTreeBuilder
./build.sh
./launch.sh
```

Open **http://127.0.0.1:8765**, choose **New enumeration**, upload a numerical CSV, select the classification target and start enumeration. Labels may be strings. Missing or non-finite feature values are rejected. Try `ArborEnum/examples/bike_processed.csv` for an example dataset.

Use `./launch.sh --port 8766` to select another port. Launching without build outputs runs `build.sh` automatically. `BUILD_JOBS=1 ./build.sh` limits native compilation parallelism on machines with less memory.

After building, runtime requires only `bin/arborenum-builder` and `InteractiveTreeBuilder/dist/index.html`. Python and Node.js are not part of the running service.

## Exploring a growing set

- The root becomes available once it contains a feasible completion, even while the initial solve continues. Empty construction placeholders stay hidden.
- Choosing a split or selecting a node automatically queries that node's current native options and objectives. **Update options** refreshes the selected node without resetting the chosen tree, undo history, favorites, settings or viewport.
- **Optimal**, **Random** and constrained completions operate on the original C++ graph and return one concrete tree. Random completion samples feasible alternatives recursively; it is not uniform over all complete trees.
- **Stop** cancels enumeration cooperatively and retains its usable native graph for further exploration and completions. Cancellation before any feasible root exists leaves no tree to explore.

The browser receives only displayed-tree summaries, options at the selected node and immediate child metadata. It never downloads or accumulates the full Rashomon graph. Selecting a different node hides the previous node's options while the new request is pending; stale replies cannot replace newer selections.

## How the native integration works

A C++20 worker thread owns ArborEnum's actual graph. HTTP handlers enqueue requests; the worker services them at cooperative polling points between graph mutations, then resumes enumeration. Reads and writes therefore use the same owning thread.

New splits attach before recursive child solves begin. Each real child node is linked as construction starts, including canonical nodes found in the cache. A split becomes selectable once both children have a budget-feasible completion, while their other alternatives can continue growing. Scoped cleanup preserves usable progress through cancellation and removes unfinished placeholders.

Native completion uses transient objective/pointer memo tables over the original graph. It reconstructs only the selected concrete tree. There is no Python graph bridge, graph export or duplicate Rashomon graph in live mode.

See [the native design and API documentation](ArborEnum/native/README.md) for ownership, query complexity, cancellation, limits, protocol and validation. Initial runtime/memory-limit semantics are inherited from ArborEnum: those limits apply after the initial restricted solve; cooperative Stop works during that solve. Native proxy seeds use median thresholds, so intermediate results can differ from the Python API's preprocessing.

## Tests

`./build.sh` runs TypeScript checks, frontend tests, the production build and native CTest regressions. The GitHub Actions workflow also runs the HTTP integration tests.

To run the HTTP tests locally (Python is only a test dependency):

```sh
python3 ArborEnum/native/tests/test_live_api.py \
  bin/arborenum-builder InteractiveTreeBuilder/dist/index.html
```

With Playwright and Chromium installed, verify the actual GUI displays the root before the first enumeration checkpoint:

```sh
python3 ArborEnum/native/tests/test_initial_preview.py \
  bin/arborenum-builder InteractiveTreeBuilder/dist/index.html
```

Native regressions cover path queries, exhaustive constrained optima on a small fixture, random and scoped completions, concurrent requests, early initial readiness, incremental attachment, cancellation, matching completed graphs/tree counts and disabled full-graph exports. The integration was also tested under GCC ThreadSanitizer.

## Source layout

| Path | Purpose |
| --- | --- |
| `ArborEnum/native/` | Native HTTP service, actor session, direct graph queries and tests |
| `ArborEnum/src/arborenum/cpp/` | Modified enumeration engine and original native algorithms |
| `InteractiveTreeBuilder/src/` | React GUI and bounded native query adapter |
| `build.sh`, `launch.sh` | Combined build and launch entry points |
| [PROVENANCE.md](PROVENANCE.md) | Upstream repositories, exact source revisions and vendored licenses |

The original Python API, examples and standalone uploaded/embedded graph workflow remain in their respective source directories. Live enumeration uses the native service.
