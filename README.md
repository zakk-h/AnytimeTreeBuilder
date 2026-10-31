# AnytimeTreeBuilder

Build decision trees interactively while [ArborEnum](https://github.com/zakk-h/ArborEnum) enumerates alternatives in the background. Start with a CSV or an existing Rashomon graph. Live enumeration and completions run in C++; datasets stay on your computer.

## Download

Open the latest successful [Desktop applications build](https://github.com/zakk-h/AnytimeTreeBuilder/actions/workflows/desktop.yml) and download an **AnytimeTreeBuilder-App-…** artifact for your system. Extract the download, then:

| System | Open |
| --- | --- |
| Windows | The `.exe` installer |
| macOS | The `.dmg`, then drag the app into Applications |
| Linux | The `.deb` installer or executable `.AppImage` |

Mac and Linux builds are available for x64 and ARM64. On Mac, choose ARM64 for Apple silicon and x64 for Intel. Downloads are unsigned, so your OS may ask for approval on first launch.

## Use

Choose **Upload → Upload dataset**, select a CSV and its target column, then start ArborEnum. Numeric, boolean and categorical features are supported. Try [bike_processed.csv](ArborEnum/examples/bike_processed.csv).

Select nodes to explore splits, use **Update options** to see new alternatives, or choose **Optimal**, **Random** or **Constrained** to complete a subtree. **Stop** ends enumeration and keeps the graph available. Closing the app shuts down the engine.

**Allow Abstain leaves** lets a leaf use the exact training labels, with an adjustable cost per abstained sample. **Advanced training settings** exposes search, refinement, threshold and cache controls.

**Upload → Upload graph** opens an existing JSON graph.

## Build

Clone this repository and run the launcher for your system:

| System | Command |
| --- | --- |
| Windows | `build-desktop.cmd` |
| macOS | `./build-desktop.command` |
| Linux | `./build-desktop.sh` |

Requires Node.js 22.12+, npm, CMake 3.20+ and a C++20 compiler: Visual Studio 2022 C++ tools, Xcode 26+, or GCC 12+. Packages are written to `dist/apps`. Update your checkout and rerun to build a new version.

For the smaller browser-based version, run `./build.sh` and `./launch.sh`, then open `http://127.0.0.1:8765`.

[Native engine and tests](ArborEnum/native/README.md) · [Frontend development](InteractiveTreeBuilder/README.md) · [Source provenance](PROVENANCE.md)
