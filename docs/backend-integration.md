# Connect Toolkit to an existing backend

Toolkit 0.9.4 is a client library, not a hosted service. Start locally, then implement only the remote features your application needs. Next.js, NestJS and other servers can implement the same HTTP contract.

## Start without a server

```sh
npm install @e6tz/toolkit
```

```tsx
import { AIToolbar } from '@e6tz/toolkit/react';

export function HostTools() {
  return <AIToolbar environment="development" locale="en" />;
}
```

Mount once near the application root. For Next.js, use `@e6tz/toolkit/next` in a server layout, or the React adapter in a client component when callbacks are needed. Production requires explicit `allowProduction`; visibility is not authorization.

Recording, marks, history, import and Markdown/JSON export need no login or backend. Imports do not execute recorded actions. Omit `wiki`, `liveConfig`, `loadKnowledge`, document-editor `onSave` and `documentsPath` until their integrations exist. There is no additional master remote flag.

## Choose the persistence path

| Need | Host implementation |
| --- | --- |
| Local recording/export | No server route. Toolkit has its own local history. |
| Separate browser-local library | Explicitly copy Toolkit JSON, validate with the public importer and save using your storage adapter. Do not access undocumented SDK storage keys. |
| Shared project recordings | Implement the wiki project routes below, then supply `wiki.manageUrl`. |
| Document loading/editing | Provide `loadKnowledge`, your editor route and an authenticated `onSave` callback as needed. |
| Runtime settings | Implement same-origin live configuration before supplying `liveConfig`. |

A `localStorage` reference is not server persistence. It belongs to one origin/browser profile, can be cleared and provides no multiuser authorization or database transaction across tabs. Handle corrupt JSON, quota and denied writes visibly. Do not store secrets there or acknowledge a failed write as successful.

## Enable project controls explicitly

The illustrative host below must be implemented by your application:

```tsx
'use client';
import { AIToolbar } from '@e6tz/toolkit/react';

export function HostTools({ enabled = false }: { enabled?: boolean }) {
  if (!enabled) return <AIToolbar environment="development" />;
  return <AIToolbar environment="development" wiki={{
    url: 'https://host.example/wiki',
    manageUrl: 'https://host.example/toolkit/toolbar/projects/project-one',
  }} />;
}
```

`manageUrl` must be absolute HTTP(S), with path `/toolkit/toolbar/projects/<project-id>` and optional trailing slash, without credentials, query or fragment. Derive project membership and permission on the server, not from client claims.

Mounting remote panels can load immediately. Configured wiki requests use `credentials: 'include'`, uncached JSON and rejected redirects. Apply the host's authentication, authorization, origin policy and CSRF protection. Cross-origin cookies require compatible explicit CORS/cookie policies. Reports and Flags HTTP adapters instead omit cookies by default.

## Route map and control projection

Let `M` be the configured management URL. Installing Toolkit creates none of these routes:

| Request | Contract |
| --- | --- |
| `GET M` | Control projection shown below. |
| `POST M/associations` | JSON `{pageId, path, action}`; action is `add` or `remove`. Validate document/project scope and fresh `X-CSRF-TOKEN`; acknowledge only after storing. |
| `GET M/recordings` | JSON `{recordings: [...]}` containing only authorized project recordings. |
| `GET M/recordings/<uuid>` | Raw SDK recording JSON, not HTML or `{data: recording}`. |
| `POST M/recordings` | JSON `{title, recording}`; optional `markdown` when evidence updates are supported. Return `{recording: acknowledgement}` after persistence. |
| `PATCH M/recordings/<uuid>` | Evidence update `{recording, expectedVersion}`. Compare versions atomically; return 409 on conflict. Return `{recording: acknowledgement}` with a new version. |
| `DELETE M/recordings/<uuid>` | Authorized removal with fresh CSRF header and no request body. A successful HTTP status confirms removal; local evidence remains separate. |

Mutations use `X-CSRF-TOKEN`. Never trust client `canEdit`, ownership, author or project fields. Return 401/403 rather than an HTML login redirect. JSON response content type is required for recording reads.

Control response example, with illustrative identity and a token the host must generate:

```json
{
  "user": {"id": 7, "name": "Reviewer"},
  "canEdit": true,
  "csrfToken": "fresh-host-issued-token",
  "recordingUpdates": true,
  "pages": [{"path": "/checkout", "label": "Checkout"}],
  "documents": []
}
```

Document entries use `{id, label, url, general, canEdit}`. The numeric document ID becomes `pageId` in association writes. Supply at most 200 pages and 100 documents; the controls reader bounds response text to 131072 characters. Only advertise `recordingUpdates: true` after implementing evidence updates and their version contract. UI restrictions do not enforce server permissions.

## Recording list, acknowledgement and limits

```json
{
  "recordings": [{
    "id": "a781a9c6-f0ad-49d8-b18b-9bc5fa91d331",
    "sourceSessionId": "session-original-id",
    "title": "Checkout review",
    "author": "Reviewer",
    "updatedAt": "2026-10-26T12:00:00.000Z",
    "canDelete": true,
    "canUpdate": true,
    "version": "1111111111111111111111111111111111111111111111111111111111111111"
  }]
}
```

The list reader accepts at most 200 distinct UUIDs and 512 KiB. `title` is nonempty text up to 300 Unicode code points, without control characters; optional `fullTitle` has the same bound. `author` is null or text up to 255 code points; `updatedAt` is a valid ISO timestamp. Save controls additionally use `sourceSessionId`, `canDelete`, optional `canUpdate` and `version`. Version tokens must be exactly 64 hexadecimal characters. Copy the received token unchanged into `expectedVersion`; issue a different valid token after an update. These illustrative tokens are not credentials.

After create or update, return:

```json
{
  "recording": {
    "id": "a781a9c6-f0ad-49d8-b18b-9bc5fa91d331",
    "sourceSessionId": "session-original-id",
    "canDelete": true,
    "canUpdate": true,
    "version": "2222222222222222222222222222222222222222222222222222222222222222"
  }
}
```

Repeat the source session ID from the submitted recording. Create controls send a title bounded to 100 JavaScript string units. Assign trusted server author/timestamps. Use raw JSON exported by the installed SDK: `schemaVersion`, `session`, `steps`, `events`, `annotations`, `partial`. The importer accepts versions 1.0 and 1.1; do not invent another schema.

Raw wiki downloads are limited to 2 MiB; the list is limited to 512 KiB. The standalone importer has a separate 8,388,608-character input ceiling. Enforce compatible write limits so saved records remain readable. Export sanitization does not replace server validation, privacy or retention policy.

## Persistence and reference data model

This is design pseudocode, not a shipped backend:

```text
authenticate request -> 401 if absent
authorize project and operation -> 403 if forbidden
validate origin/CSRF, identifiers, body size and recording schema
begin transaction
  locate recording inside the authorized project
  if updating, atomically compare version with expectedVersion
    mismatch -> rollback and 409; previous data stays unchanged
  persist evidence and trusted metadata; assign a new version
commit
return acknowledgement of the committed version
```

Use a database transaction or conditional update, not a separate check followed by an unconditional write. Define a create-retry uniqueness policy; the wiki transport does not implement Reports' `submissionId` delivery contract.

| Optional reference record | Suggested fields / invariant |
| --- | --- |
| Existing host membership | Reuse current user/project/operation permissions; no parallel Toolkit accounts. |
| Recording | UUID, project, source session ID, title, validated JSON, optional Markdown, server author, version and timestamps. Scope every lookup by project. |
| Existing document | Document ID, project, label and Markdown with server-controlled permissions. |
| Association | Project, document ID, route path and a suitable uniqueness constraint. |

These are examples, not required SQL tables or supplied migrations. Use existing entities, JSON columns or object storage as appropriate. Define retention, backups and recovery according to the host's needs.

## Documents and live configuration

`AIContextDocumentEditor.onSave(documentId, markdown)` resolves only after the host save succeeds and rejects on failure. Failed saves leave the draft available for copying/downloading. `loadKnowledge` returns the published KnowledgeBundle shape; use the SDK validator. Bundled documents and client props are visible to recipients of application assets.

Mount your same-origin editor route before supplying `documentsPath`. It receives `?document=<id>`; the SDK does not create that route.

A live-config endpoint returns a raw object, not an envelope:

```json
{"locale":"en","maxBodyChars":4000,"recordNetwork":false,"wiki":null}
```

`locale` is `en` or `es`, `maxBodyChars` is an integer 1–64000, `recordNetwork` is boolean and `wiki` is null or valid ToolbarWiki. The same-origin HTTP(S) reader uses same-origin cookies, no-store, rejected redirects, an 8-second timeout and a 128 KiB limit.

Supplying `liveConfig` enables initial loading, focus/online refresh and visible-tab polling: 5 seconds by default, bounded to 2–60 seconds with failure backoff. Omit it when unwanted. Configuration never carries secrets or grants permissions.

## Framework mapping and lifecycle

In Next.js, Route Handlers map HTTP requests to host-authorized operations. In NestJS, controllers map routes, guards resolve permissions and services/repositories persist data. Other frameworks implement the same JSON contract. These are integration directions, not framework modules already included in Toolkit.

On logout or permission loss, remove remote configuration or unmount the integration. Re-key on user/project/environment changes. `ai-context-toolbar:wiki-auth-changed` is a refresh signal, not proof of identity. Aborting a browser request cannot undo a committed mutation.

Use private/no-store caching for sensitive project data. Treat Markdown and imported evidence as untrusted text; sanitize rendered HTML and never execute recorded actions.

## Acceptance checks

- With remote options omitted, local recording, marks, import and JSON/Markdown export need no login or control-plane requests.
- Anonymous requests return 401; identities without project permission receive 403, including forged ownership fields.
- Invalid CSRF, malformed evidence, oversized bodies and stale versions leave stored data unchanged.
- Concurrent updates sharing one expectedVersion cannot both overwrite the same version; the loser receives 409 and keeps its local copy.
- List IDs, envelopes, limits and raw recording downloads match the installed SDK reader.
- Failed storage never returns false success; logout/project changes cannot expose another context's records.
- Remote failure leaves local recording/export usable; imported evidence is not replayed.

See [host lifecycle](host-integration.md), [website documentation](https://toolkit.6tz.tech/docs/) and [npm](https://www.npmjs.com/package/@e6tz/toolkit). Wire references: [recording reader](../src/browser/wiki-recordings.ts), [save controls](../src/react/wiki-recording.tsx), [document controls](../src/react/wiki-documents.tsx), [runtime schema](../src/core/runtime-config.ts).
