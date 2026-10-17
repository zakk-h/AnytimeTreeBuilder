# Interactive Tree Builder

Explore decision-tree Rashomon sets and build a tree interactively.

## Native live enumeration

The live integration can start ArborEnum directly from a CSV, without an input Rashomon graph. Its C++20 service owns the background enumeration worker and reads the native trie directly. Python is not used at runtime.

In the combined checkout, run `../launch.sh`, open `http://127.0.0.1:8765`, and choose **Upload → Upload dataset**. Upload a CSV, select the classification target, and start ArborEnum. Splits and node selection automatically query the active node directly in C++. **Update options** refreshes that node while retaining your tree, undo history, favorites, custom settings and viewport. Completions run in C++; no whole graph is downloaded. **Stop** cooperatively cancels enumeration.

See `../ArborEnum/native/README.md` for native build instructions, graph identity/ownership design, protocol and tests. Existing embedded graph payloads and JSON uploads remain supported when the builder is opened without the native service.

**Upload → Upload graph** opens an existing JSON graph. Labels use measured text widths: short names grow up to 56px in the tree and 18px in options, while long names wrap without truncation. Cards occupy only the width their label needs (280–440px); the layout accounts for each card’s measured width and height. A compact toolbar leaves the canvas at full workspace height. Rounded branch connectors have stronger strokes and more vertical separation; the canvas refits when its size changes.

CSV numbers retain their values, TRUE/FALSE values map to 1/0, and other text columns become named binary category indicators. Empty cells and numeric overflow are reported. Selecting a new CSV clears the previous graph and options until the new session returns a node view; stale replies cannot restore old data.

## Frontend development

```sh
npm ci
npm run typecheck
npm test
npm run build
```

The production output is a single `dist/index.html` served by the native executable. Start the full native service to test live enumeration; Vite alone only hosts the standalone graph builder.

Browser regression checks (Playwright required):

```sh
python3 tests/browser_redesign.py ../build/native/arborenum-builder dist/index.html
python3 tests/browser_readability.py ../build/native/arborenum-builder dist/index.html
```

These check both upload paths, keyboard navigation, full long feature names, card spacing, favorites/export, and the mobile layout. The readability check also verifies the actual on-screen text size after diagram zoom in a nine-node tree with short names.
