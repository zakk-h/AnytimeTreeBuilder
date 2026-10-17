# Source provenance

AnytimeTreeBuilder combines these projects by Zakk Heile:

| Component | Upstream | Original base | Integrated source revision |
| --- | --- | --- | --- |
| ArborEnum | https://github.com/zakk-h/ArborEnum | `35c5bc4` | `583382a75db7a8151ca29a60bbb11dfc28f915ad` |
| InteractiveTreeBuilder | https://github.com/zakk-h/InteractiveTreeBuilder | `e1fd88f` | `7a2ac2ded8e0ba35c97e7804969348af9b633780` |

The integrated revisions were committed in local feature branches during development. This repository imports their source into one checkout; those local revision IDs are recorded for provenance and are not assumed to exist in the upstream GitHub repositories.

The import retains source, documentation, examples and tests. Local compiled extensions, NFS temporary files, Python bytecode/egg metadata, dependency installations, toolchains and build directories are excluded. Neither component is a Git submodule. The original Python wheel workflow remains nested under `ArborEnum/.github/` as upstream source; the root workflow validates the combined native application.

Vendored native dependencies retain their license files:

- cpp-httplib 0.18.7: [MIT license](ArborEnum/native/vendor/httplib.LICENSE).
- nlohmann/json 3.11.3: [MIT license](ArborEnum/native/vendor/json.LICENSE).

JavaScript dependency versions are recorded in `InteractiveTreeBuilder/package-lock.json` and installed with `npm ci`.
