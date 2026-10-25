# AnytimeTreeBuilder

Build decision trees interactively while ArborEnum grows a Rashomon set in the background. Start from a CSV, explore splits and their current minimum objectives, and request optimal, random or constrained completions directly from the running C++ graph.

This repository contains the integrated ArborEnum engine and InteractiveTreeBuilder GUI. A single clone includes all source needed to build and run it; no submodules or precomputed Rashomon graph are required.

## Desktop application

Download **Actions → Desktop applications → the latest successful run → Artifacts → AnytimeTreeBuilder-App-…** for your computer. Extract the artifact download, then launch the package inside:

| Computer | Application package |
| --- | --- |
| Windows x64 | Run the installer `.exe`, or extract the portable ZIP and open `AnytimeTreeBuilder.exe` |
| Mac, Apple silicon / Intel | Open the DMG and drag `AnytimeTreeBuilder.app` into Applications, or extract the app ZIP |
| Linux x64 / ARM64 | Install the `.deb` on Debian/Ubuntu, open the executable AppImage, or extract the `.tar.gz` and run `anytimetreebuilder` |

The app opens its own desktop window. Choose **Upload → Upload dataset** to start live enumeration. Closing the window quits the application and stops the engine automatically. No external browser, Python, Node.js installation, compiler, port forwarding, internet connection or precomputed graph is required. Datasets stay on your computer. Each operating system has its own packages.

The window uses bundled Electron/Chromium. A managed native C++ process contains the current UI and ArborEnum engine; graph queries and completions still operate on its actual C++ graph. The sandboxed renderer has no Node integration, external navigation and permissions are blocked, and it only accesses its own loopback API. The parent owns a private stdin pipe: closing it, including on a parent crash, makes the engine stop cooperatively. This does not add a Python bridge or another Rashomon graph.

To rebuild the current checkout whenever the source changes:

| Build computer | Launcher in the repository root |
| --- | --- |
| Windows | Double-click `build-desktop.cmd` |
| macOS | Double-click `build-desktop.command`, or run `./build-desktop.sh` |
| Linux | Run `./build-desktop.sh` |

Outputs appear under `dist/apps/`: Windows installer/portable ZIP, Mac DMG/app ZIP, or Linux AppImage/deb/tar.gz, plus SHA-256 checksums. Re-running rebuilds the current source; update your checkout first for a new version. Building requires Node.js 22.12+, npm, CMake 3.20+ and a C++20 toolchain (`std::jthread`): Visual Studio 2022 C++ tools on Windows, Xcode 26+ on macOS, or GCC 12+ on Linux. Linux packaging uses the tools downloaded by electron-builder. It builds for the computer running the script. The GitHub workflow builds and exercises Windows x64, macOS Intel/Apple silicon, and Linux x64/ARM64 on their respective runners.

These packages do not have commercial Windows signing or Apple Developer ID signing/notarization; wrapping the UI in an app does not remove OS trust warnings. Linux desktop dependencies and sandbox policies depend on the distribution. Mac packages target macOS 13+ and Windows packages target Windows 10/11. Xcode 26 supplies the required standard `std::jthread` support ([Apple release notes](https://developer.apple.com/documentation/xcode-release-notes/xcode-26-release-notes)).

### Native browser-opening package

The smaller, browser-opening native packages remain in `dist/desktop` and in the `AnytimeTreeBuilder-…` Actions artifacts. `./build-desktop.sh --engine-only` builds these without the Electron window. `--ui-ready` reuses the already-built production UI, and `--static` selects static linking for a suitable Linux toolchain (official Linux engine builds use musl).

Headless native usage is available with `AnytimeTreeBuilder --no-browser`; the chosen local URL is printed. `--port 8765` selects a fixed port and `--open-browser` explicitly opens the browser when passing options. Existing server builds and `launch.sh` continue to work as below.

## Build and launch

Requires Node.js 22.12+ and npm, CMake 3.20+, and a C++20 compiler with `std::jthread` support. The combined build and launch scripts use Bash; Linux is tested.

```sh
git clone https://github.com/zakk-h/AnytimeTreeBuilder.git
cd AnytimeTreeBuilder
./build.sh
./launch.sh
```

Open **http://127.0.0.1:8765**, choose **Upload → Upload dataset**, upload a CSV, select the classification target and start enumeration. Features may contain numbers, booleans or text categories; labels may be strings. Empty cells and numeric overflow are rejected. Try `ArborEnum/examples/bike_processed.csv` for an example dataset.

Use `./launch.sh --port 8766` to select another port. Launching without build outputs runs `build.sh` automatically. `BUILD_JOBS=1 ./build.sh` limits native compilation parallelism on machines with less memory.

After building, runtime requires only `bin/arborenum-builder` and `InteractiveTreeBuilder/dist/index.html`. Python and Node.js are not part of the running service.

## CSV feature types

Numeric columns keep their values, including negative values and scientific notation. Case-insensitive `TRUE`/`FALSE` cells map to `1`/`0` and can appear alongside numeric values. Columns containing other text, including mixed numeric/text columns, become one binary indicator per distinct trimmed value, with names such as `segment = "retail"`. Category names are sorted deterministically and generated feature names remain unique. This avoids assigning an arbitrary numeric order to categories. Empty cells remain validation errors rather than silently becoming zero.

Selecting a dataset clears the previous tree, options, history and feature metadata immediately. The view stays empty during parsing, launch and initial loading, until the first node query for the new session succeeds. Late replies from the old session cannot restore its graph. Failed uploads stay empty and can be corrected and retried.

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

With Playwright and Chromium installed, verify early root display and dataset switching (including delayed replies, booleans and categorical text):

```sh
python3 ArborEnum/native/tests/test_initial_preview.py \
  bin/arborenum-builder InteractiveTreeBuilder/dist/index.html
python3 ArborEnum/native/tests/test_dataset_upload.py \
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

## Desktop window checks

The application workflow tests the packaged executable on every supported OS/architecture, including CSV upload, native completion, option refresh, renderer isolation, blocked external requests and engine cleanup on window close. `desktop/app/tests/engine.cjs` also kills a parent process abruptly to verify that its native engine stops without a desktop shutdown handler.

```sh
node desktop/app/tests/engine.cjs dist/desktop/AnytimeTreeBuilder-linux-x64/AnytimeTreeBuilder
# After packaging (substitute the packaged executable path for your OS):
node desktop/app/tests/app.cjs dist/apps/linux-unpacked/anytimetreebuilder
```

The window test requires a graphical session (CI uses Xvfb on Linux). Restricted CI user-namespace policies may require `ATB_TEST_ARGS='["--no-sandbox"]'` for the test process. The application never adds that flag in production. Desktop dependencies are pinned in `desktop/app/package-lock.json`; update Electron regularly for bundled Chromium security fixes.
