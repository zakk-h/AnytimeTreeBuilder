# Interactive Tree Builder

The React interface for [AnytimeTreeBuilder](../README.md). Upload a CSV for live ArborEnum enumeration or a JSON Rashomon graph to explore an existing set.

Live queries and completions use the native C++ service. **Update options** refreshes the selected node without resetting the tree. CSV features can be numeric, boolean or categorical; blank cells are rejected.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
```

The build produces a single `dist/index.html`. From the repository root, run `./build.sh` and `./launch.sh` to use the native service. Vite alone supports uploaded graphs but cannot start enumeration.

See [native documentation](../ArborEnum/native/README.md) for the API and integration tests. Browser tests in `tests/` use Playwright.
