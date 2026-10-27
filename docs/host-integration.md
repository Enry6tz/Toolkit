# Integrate Toolkit into your application

Toolkit is a library. Your application supplies the interface around it, authentication, permissions and any backend. No Toolkit account, login service, database or remote endpoint is required for local recording and export.

This guide covers Toolkit's host contract. Reports and Flags follow the same ownership model, with their own transport interfaces and endpoint contracts. For complete response shapes, reference storage records and server acceptance checks, see the [backend implementation guide](backend-integration.md).

## Start locally

Install the published `@e6tz/toolkit` package from npm, or use the repository/tarball installation described in the [README](../README.md). Requires Node.js 20.9+ and React / React DOM 18.3 or 19.

```tsx
import { AIToolbar } from '@e6tz/toolkit/react';

export function HostTools() {
  return <AIToolbar environment="development" locale="en" />;
}
```

No integration URL or remote callback is supplied. Recording, annotations, local history, import and Markdown/JSON export work without login. Local storage is browser-local, not synchronized storage. Review exported content before sharing it.

For Next.js App Router, mount the server adapter inside your layout's body:

```tsx
import type { ReactNode } from 'react';
import { AIToolbar } from '@e6tz/toolkit/next';

export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}<AIToolbar /></body></html>;
}
```

The adapter derives the environment. Production remains disabled unless the host opts in with `allowProduction`; do not use toolbar visibility as backend authorization. The React adapter accepts callbacks; the Next server adapter only forwards serializable public configuration. Keep callback integrations in a client component.

## Enable only the integrations you implement

| Option | Default when omitted | Host responsibility |
| --- | --- | --- |
| `wiki.url` / document links | No external wiki links | Supply public HTTP(S) links; navigation requires a user action. |
| `wiki.manageUrl` | No wiki control or recording requests | Implement authenticated project controls and recording routes. Mounting the relevant panel can read immediately. |
| `liveConfig` | No remote configuration fetch or polling | Supply a same-origin endpoint. Mounting starts loading; later visibility/focus/online refresh and polling are intentional opt-in behavior. |
| `loadKnowledge` | No remote document loader | Supply a callback and choose its transport; toolbar document loading is lazy. A mounted document editor can load immediately. |
| `AIContextDocumentEditor.onSave` | No document persistence | Authenticate, authorize and persist in the callback's backend. |
| `documentsPath` | Labels and copy actions only | Mount your own same-origin editor route accepting `?document=<id>`. Invalid/non-local paths do not fall back to an invented route. |

Supplying a URL or callback is the opt-in for that integration. To keep remote features disabled, omit these options. Do not pass a sample endpoint and assume a service exists. Package-local font loading is separate from remote control requests. Recording host fetch activity observes the host application; it does not replay its requests.

For example, after implementing your host's project controls:

```tsx
'use client';
import { AIToolbar } from '@e6tz/toolkit/react';

export function IntegratedTools({ enabled = false }: { enabled?: boolean }) {
  if (!enabled) return <AIToolbar environment="development" />;
  return <AIToolbar environment="development" wiki={{
    url: 'https://host.example/wiki',
    manageUrl: 'https://host.example/toolkit/toolbar/projects/project-one',
  }} />;
}
```

The URLs illustrate a host you must implement, not a provided service. Choose a trusted origin and project from authorized host context. Remount the integration with a new React `key` when the user, project or environment changes; do not retain another context's client state.

## Implement host authentication and authorization

Toolkit does not issue, store, renew or revoke authentication credentials. It provides no login iframe, form, redirect or message-based authentication exchange. Authenticate through your application's own flow. Do not embed administrative secrets in client props, public configuration, bundled documents or the browser bundle.

Configured wiki requests use session cookies (`credentials: 'include'`), uncached JSON and rejected redirects. Cross-origin use therefore needs the host's explicit credentialed CORS policy and compatible cookie policy. Browser cookie restrictions still apply. Never forward session credentials to arbitrary origins. Reports and Flags use different adapters that omit cookies by default; do not assume identical transport behavior across the three libraries.

The backend must authenticate each request, derive trusted identity server-side and authorize the selected project and operation. Origin checks, CORS, CSRF tokens, `canEdit` and UI visibility do not replace authorization. Keep read-only and forbidden responses distinct. Toolkit shows host-auth guidance for unavailable authentication and does not start its own login. Remote failures must not prevent local recording/export.

After your host session changes, refresh the mounted integration:

```ts
window.dispatchEvent(new Event('ai-context-toolbar:wiki-auth-changed'));
```

Focus also refreshes configured wiki panels. The event is only a refresh signal, not proof of authentication. On logout or permission loss, remove remote configuration or unmount the integration; use a new key before enabling another authorized context. Aborting a client request cannot undo a mutation the server already accepted.

## Supply the optional backend contracts

`manageUrl` must identify `/toolkit/toolbar/projects/<project-id>` on the configured wiki origin. Toolkit validates the declared origin; recording clients reject unscoped management URLs.

- `GET manageUrl`: return the authenticated control projection, including `canEdit`, a CSRF token, available pages and editable document links. Enable recording updates only when your backend implements their contract.
- `POST manageUrl/associations`: authorize document/page association changes and validate the `X-CSRF-TOKEN` header.
- `GET manageUrl/recordings` and `GET manageUrl/recordings/<id>`: return only recordings the authenticated identity may read, with bounded valid JSON.
- Recording `POST`, `PATCH` and `DELETE` routes must authorize the operation and validate fresh CSRF credentials. Updates use `expectedVersion`; return `409` for an optimistic-version conflict. Never trust client `canEdit` or ownership fields.

These routes are not created by installing the package. The existing wiki clients retain response limits, cancellation, origin validation and permission-related error handling. Authentication failure must remain an HTTP failure, not an HTML login redirect disguised as JSON.

`liveConfig` is a separate optional, same-origin JSON endpoint. Its existing bounded schema controls locale, wiki links and recording preferences; it does not deliver credentials or grant permissions. Omit it when the host does not implement it.

## Verify the integration

Start with remote options omitted. Record a marked walkthrough, stop, copy JSON/Markdown and copy a bundled document. No login or control-plane request should be needed.

Then enable one implemented integration. Check unauthenticated `401`, forbidden `403`, read-only and authorized states. Verify authorization and CSRF independently on the server; browser tests cannot prove identity-provider or backend policy correctness. Confirm a remote error leaves local recording/export available.

The repository tests exercise the public React toolbar in Chromium, the Next configuration interface and a genuinely installed npm tarball. Packing also checks that deleted login artifacts are absent and this guide is included. A combined self-hosted host repository is a separate future deliverable, not a dependency of these packages.
