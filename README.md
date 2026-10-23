# ai-context-toolbar

Record a walkthrough, mark what matters, and take the context to your next chat.

`ai-context-toolbar` is a standalone React and Next.js package. This repository preserves version **0.9.4**, its public entrypoints and the original **UNLICENSED** status. It is not published to the npm registry. GitHub source availability does not grant an open-source license.

## Install

Requires Node.js 20.9+ and React / React DOM 18.3 or 19.

Install from this GitHub repository:

```sh
npm install git+https://github.com/Enry6tz/Toolkit.git
```

The Git install runs `prepare` to compile the package. To build a local tarball instead:

```sh
git clone https://github.com/Enry6tz/Toolkit.git
cd Toolkit
npm install
npm pack
```

Then, from your application, install the actual generated file:

```sh
npm install /actual/path/to/ai-context-toolbar-0.9.4.tgz
```

There is no supported public-registry `npm install ai-context-toolbar` release yet. The package retains `private: true` to prevent accidental registry publication.

## React

Mount the toolbar once near the application root so client-side navigation keeps the recorder alive:

```tsx
import { AIToolbar } from 'ai-context-toolbar/react';

export function App() {
  return (
    <>
      <YourApplication />
      <AIToolbar environment="development" locale="es" />
    </>
  );
}
```

Use `environment="preview"` for a preview deployment. Production is off by default and requires explicit opt-in. The toolbar isolates its interface with Shadow DOM.

## Next.js

The server adapter derives the environment and passes serializable options to the client toolbar:

```tsx
import { AIToolbar } from 'ai-context-toolbar/next';

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <body>
        {children}
        <AIToolbar />
      </body>
    </html>
  );
}
```

The adapter does not require a platform backend. React and React DOM are peer dependencies; this package does not depend on a local workspace or another project.

## What it records

Start a recording, walk through your application, add marks and comments, stop, then copy the context. A recording contains ordered steps, routes, observations and optional network context. A selected step is a view of the recording; it does not replay business actions or restore historical application state.

Network recording is an explicit preference and observes fetch activity only while recording. Resource aliases and bounded request/response previews are configured by the integrator. Omitted or truncated detail remains explicit; review the result before sharing it. The visible workflow does not record video, request screen sharing or create continuous screenshots.

Markdown and JSON exporters are available from `ai-context-toolbar/review`. Project documents can be explicitly bundled through `ai-context-toolbar/config`; all documents shipped to the client are public to recipients of those assets. Optional wiki and live-configuration integrations are configuration-driven, not prerequisites.

The package includes no AI model, chat login, token/key flow, server synchronization or automatic message sending. The conversation and the decision about what to do next belong in your own chat.

## Entrypoints

| Import | Purpose |
| --- | --- |
| `ai-context-toolbar` / `/react` | Toolbar and React document editor |
| `/next` | Server adapter for Next.js |
| `/core` | Types, privacy, documents and context normalization |
| `/browser` | Browser observation and read-only context integration |
| `/review` | Recording state, persistence and exports |
| `/config` | Node-side configuration and document bundling |

Legacy programmatic case/capture APIs remain part of the source for compatibility. They do not define the visible recording workflow.

## Development and verification

```sh
npm install
npm run typecheck
npm run build
npm test
npm pack --dry-run
```

`test:node` runs the existing standalone SDK tests, including browser-backed tests. They need Chromium from the matching Playwright version; if absent, provision it in your environment with `npx playwright install chromium`. `test:unit` runs the isolated navigation, persistence, dock, network-policy and recording-quality tests from the current source. Fixtures are synthetic and do not need an account, database, platform, `.env` file or existing application server.

The build copies the bundled Cascadia Code font and its original license notices into `dist`. Generated output, tarballs, dependency folders and local artifacts are ignored by Git.

See [the architecture](docs/architecture.md) for the package boundaries. Font provenance and license notices remain in `src/react/assets`. The package itself remains **UNLICENSED**.
