AnytimeTreeBuilder — portable live enumeration

Unzip the whole download before launching it.

Windows: double-click AnytimeTreeBuilder.exe.
macOS: double-click Open AnytimeTreeBuilder.command.
Linux: run ./AnytimeTreeBuilder (or open the executable in your file manager).

Your default browser opens automatically. Choose Upload > Upload dataset, select
example.csv (or your own CSV), choose the target column and start enumeration.
Keep the application/terminal running while you use the builder. Ctrl+C closes
it and its background enumeration. Closing just the browser does not stop it.
If a browser does not open automatically, copy the printed http://127.0.0.1 URL.

The app contains both the UI and the C++ ArborEnum engine. No Python, Node.js,
compiler, server installation, login, internet connection or precomputed graph
is needed to run it. A browser must already be installed. Your uploaded dataset
is processed locally. Live queries and completions use the actual C++ graph.

Use the download for your operating system and processor. Windows builds target
Windows 10/11; macOS builds target macOS 13+ (Intel and Apple silicon separately).
Official Linux CI packages use musl and static linking to avoid a system C++
runtime dependency. Builds made locally use that machine's toolchain unless
--static is requested.

Downloads do not have a commercial signing certificate or Apple notarization.
Your OS may request approval before first launch. build-info.json records the
source revision and the executable/UI checksums.

Rebuild a new version from the repository:
  Windows: build-desktop.cmd
  macOS:   build-desktop.command
  Linux:   ./build-desktop.sh

Building requires Node.js 22.12+, npm, CMake 3.20+ and a C++20 compiler supporting
std::jthread. On Windows use Visual Studio 2022 C++ build tools. On macOS use
Xcode 26+. On Linux use GCC 12+ or an equivalent Clang/libstdc++ toolchain.
Builds appear in dist/desktop. The scripts rebuild the current checkout; update
the checkout first when you want a newer version. Each OS builds its own binary.

Project: https://github.com/zakk-h/AnytimeTreeBuilder
