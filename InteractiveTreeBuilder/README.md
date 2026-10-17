# Interactive Tree Builder

Explore decision-tree Rashomon sets and build a tree interactively.

## Native live enumeration

The live integration can start ArborEnum directly from a CSV, without an input Rashomon graph. Its C++20 service owns the background enumeration worker and reads the native trie directly. Python is not used at runtime.

In the combined checkout, run `../launch.sh`, open `http://127.0.0.1:8765`, and choose **New enumeration**. Upload a CSV, select the classification target, and start ArborEnum. Splits and node selection automatically query the active node directly in C++. **Update options** refreshes that node while retaining your tree, undo history, favorites, custom settings and viewport. Completions run in C++; no whole graph is downloaded. **Stop** cooperatively cancels enumeration.

See `../ArborEnum/native/README.md` for native build instructions, graph identity/ownership design, protocol and tests. Existing embedded graph payloads and JSON uploads remain supported when the builder is opened without the native service.

CSV numbers retain their values, TRUE/FALSE values map to 1/0, and other text columns become named binary category indicators. Empty cells and numeric overflow are reported. Selecting a new CSV clears the previous graph and options until the new session returns a node view; stale replies cannot restore old data.

## Frontend development

```sh
npm ci
npm run typecheck
npm test
npm run build
```

The production output is a single `dist/index.html` served by the native executable. Start the full native service to test live enumeration; Vite alone only hosts the standalone graph builder.
