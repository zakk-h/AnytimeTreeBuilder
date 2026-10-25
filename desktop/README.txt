AnytimeTreeBuilder — browser version

Extract the download, then open:
  Windows: AnytimeTreeBuilder.exe
  Mac: Open AnytimeTreeBuilder.command
  Linux: ./AnytimeTreeBuilder

Your browser opens automatically. Choose Upload > Upload dataset and select
example.csv or your own CSV. Keep the application running; Ctrl+C stops it.
Closing the browser alone does not stop enumeration.

The C++ engine and UI are included. Data stays local. No Python or Node.js
installation is needed. Downloads are unsigned, so your OS may ask for approval.

To rebuild this version, run the repository's build-desktop launcher with
--engine-only. Output: dist/desktop. Without that flag, it also builds the
windowed desktop app in dist/apps.

https://github.com/zakk-h/AnytimeTreeBuilder
