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

## Host integration boundary

Remote behavior requires explicit `wiki.manageUrl`, `liveConfig` or host callbacks. With these omitted, the toolbar records and exports locally. `wiki.url` only supplies a user-activated external link. `documentsPath` is an explicit host route, with no implicit document-server fallback.

The host owns authentication and server authorization. Toolkit does not render a login form, iframe or authentication exchange. Configured wiki clients retain cookies, CSRF headers, permission checks, origin restrictions and cancellation. The existing `ai-context-toolbar:wiki-auth-changed` event lets the host refresh mounted integrations after a session change; it grants no permission.

See [host integration](host-integration.md) for the frontend/backend responsibilities and supported opt-ins.

## Build and distribution

The build first cleans only the package-generated `dist` directory, refusing a redirected or non-directory target. TypeScript then compiles `src` into ESM JavaScript and declarations under `dist`. `scripts/copy-assets.mjs` copies the local font and its provenance/license files. Cleaning prevents deleted modules, including the removed login, from surviving a reused build. The `.mjs` helpers preserve the original Node.js 20.9+ engine range without relying on native execution of TypeScript build scripts.

The npm package is `@e6tz/toolkit`. Its pack allowlist includes `dist`, the README, the host integration guide and this architecture document. Source, tests and build tools remain in Git for reproducible GitHub installation. `prepare` supports Git installs and `prepack` builds local tarballs. Public scoped publication is enabled in metadata but requires a separate authorized release. The package is MIT-licensed; bundled font licenses remain separate.

The test-only GitHub Actions workflow runs types, the Node/browser and Vitest suites, and a packed-consumer check on Node.js 22 and 24. It has read-only repository permissions and no publication step. Existing programmatic symbols, browser bridge globals, event identifiers and storage keys remain compatible.
