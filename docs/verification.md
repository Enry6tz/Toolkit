# Standalone extraction verification

This repository contains Toolkit, packaged as `@e6tz/toolkit` version 0.9.4. The export map, original runtime engine range, React peer ranges and UNLICENSED status are preserved. The identity and product-facing copy changed for npm readiness; existing storage, event and bridge identifiers remain unchanged.

## Repeat the readiness checks

```sh
npm ci
npx --no-install playwright install chromium
npm run typecheck
npm test
npm run check:package
```

The GitHub Actions workflow repeats these checks on Node.js 22 and 24, with Chromium system dependencies on Linux. The package check creates a real tarball, verifies allowlisted files and font notices, installs the archive into an independent temporary consumer, imports every entrypoint, compiles strict NodeNext declarations, and exercises server rendering, recording authorization and browser isolation. Its temporary directory is printed and retained for inspection or cleanup.

Public scoped publication is enabled in metadata; scope ownership and the release credential/session still need confirmation. No command above publishes, and CI contains no publication or deployment step.

Locally verified on Windows with Node.js 24.20.0: dependency installation and typecheck passed; 277 Node tests and 47 Vitest tests passed without failures or skips. The independent consumer passed with 267 packed files. Linux CI and its Node.js 22 matrix have not run remotely yet.

## Historical extraction evidence

The remaining sections describe verification performed before the npm-readiness rename, not fresh results for every subsequent revision.

## Scope

- All 69 files under the source package's `src` directory are copied verbatim, including the bundled font and its three provenance/license notices. A SHA-256 comparison found zero mismatches.
- The build uses the equivalent `copy-assets.mjs` helper so the original Node.js 20.9+ range does not require native execution of a TypeScript build script.
- The standalone package includes 34 existing Node test files from the preceding SDK checkout, five current unit-test files and their synthetic fixture.
- Platform applications, platform integration tests, private documentation, environments, credentials, databases, dependency folders, generated output and prior Git history are excluded.
- Repository metadata, standalone development dependencies, lockfile, prepare/prepack hooks and public package documentation are local to this repository.

## Test compatibility

The preceding SDK test harness was adapted to the existing 0.9.4 contracts while retaining all tests and their assertions:

- Browser doubles provide and flush the microtask queue used by deferred navigation observation. The current navigation tests separately verify that observation does not execute during a framework commit.
- Tests expecting Spanish change labels explicitly request Spanish instead of relying on the default locale.
- Resource-limit tests assert the current 100-resource boundary and still test truncation beyond it.
- Wiki-title tests assert the current 300-character Unicode boundary and still reject 301 characters.
- Persistence tests address the actual tab-scoped draft alias, including their quota-failure injection. They retain the atomicity, integrity, recovery and deletion checks.

No runtime source changes or test removals were needed during the original extraction.

## Results

Verified on Windows with Node.js 24.20:

- `npm install`: prepare/build completed.
- `npm run typecheck`: passed.
- `npm run build`: passed; ESM, declarations and font assets generated.
- `npm test`: 273 Node tests and 47 Vitest tests passed, with zero failures or skips.
- `npm audit`: zero vulnerabilities. The standalone test tool is pinned to the patched Vitest 4.1.12.
- `npm pack --dry-run` and `npm pack`: 267 allowlisted files, 1,618,536 unpacked bytes. Only `dist`, README, architecture documentation and package metadata are packed.
- A separate consumer installed the generated tarball and passed all seven public imports, React server rendering, the Next adapter, production gating and a synthetic recording-engine lifecycle.
- The same consumer passed strict TypeScript NodeNext resolution against the installed package declarations.
- Filename checks and high-confidence credential-pattern checks found no sensitive files or credential payloads in the copied source. The package contains no workspace/file dependencies.

The consumer and raw local test/pack output live only in ignored artifacts. The README's GitHub installation uses this repository's prepare hook; the package is not published to the npm registry. No release or npm publication is part of this extraction.
