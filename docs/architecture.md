# Package architecture

The package is independent of a platform, database or sibling workspace. Its runtime dependencies are the React and React DOM peer dependencies. The public import map is declared in `package.json`.

## Layers

- `core`: public types, environment checks, context normalization, privacy, locale, documents and optional wiki configuration.
- `browser`: DOM observation, selection geometry, fetch activity, route observation, tab ownership and the read-only context bridge.
- `review`: recording/session state, annotations, persistence, coverage/quality descriptions, import and Markdown/JSON exports. Compatibility case/capture modules remain available without being the default UI workflow.
- `react`: the Shadow DOM toolbar, recording history, marks, document views and dock placement. Font assets are bundled locally and do not style the host application.
- `next`: a server adapter that resolves the environment and forwards serializable public options.
- `config`: Node-side validation and bundling of explicitly declared Markdown documents.

## Recording boundary

Recording is deliberate. Reading context does not begin a recording, execute requests or replay application actions. Route observations and tab persistence keep the recorder attached to the current browser context. Choosing a historical step does not reconstruct application state.

Network collection is optional and scoped to recording. The integrator names resources and chooses limits; unknown, omitted, truncated or incomplete data is not converted into a fabricated diagnosis. Marks retain their route and historical viewport. Review a recording before copying it into another application.

The visible workflow exports text and structured data rather than continuous screenshots or video. Optional legacy capture interfaces remain separate. The package has no built-in model, chat account or platform authentication requirement.

## Build and distribution

TypeScript compiles `src` into ESM JavaScript and declarations under `dist`. `scripts/copy-assets.mjs` then copies the local font and its provenance/license files. The `.mjs` build helper preserves the original Node.js 20.9+ engine range without relying on native execution of TypeScript build scripts.

The npm pack allowlist includes `dist`, the README and this architecture document. Source, tests and build tools remain in Git for reproducible GitHub installation. `prepare` supports Git installs and `prepack` builds local tarballs. The package remains unpublished to the npm registry and retains its original UNLICENSED status.
