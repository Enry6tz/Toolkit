import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { bundleKnowledge, defineConfig, withAIContextToolbar, writeKnowledgeBundle } from '../dist/config/index.js';
import { createArtifact, validateKnowledgeBundle } from '../dist/core/index.js';

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), 'ai-toolbar-knowledge-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'docs'));
  return root;
}

function config(documents = [{ id: 'ux-rules', path: './docs/ux.md', label: 'Reglas UX' }], limits = {}) {
  return defineConfig({ enabled: { development: true, preview: true, production: false }, context: { documents, ...limits } });
}

test('document editor routes stay inside the app and cannot redirect menu links outside its origin', () => {
  assert.equal(defineConfig({ documentsPath: '/internal/project-docs' }).documentsPath, '/internal/project-docs');
  for (const documentsPath of ['https://outside.test/docs', '//outside.test/docs', '/docs?token=secret', '/docs#x', '/docs/../elsewhere', '/docs/%2e%2e/admin', '/docs\\admin'])
    assert.throws(() => defineConfig({ documentsPath }), /documentsPath/);
});

test('build embeds exact UTF-8 documents and stable content hashes without source paths', async t => {
  const root = await project(t);
  const original = '# Diseño\nUna acción principal.\n<script>notExecuted()</script>\n';
  await writeFile(join(root, 'docs', 'ux.md'), original, 'utf8');
  const result = await bundleKnowledge(config(), { rootDir: root });
  assert.deepEqual(result, { schemaVersion: '1.0', documents: [{ id: 'ux-rules', label: 'Reglas UX', content: original, checksum: createHash('sha256').update(original).digest('hex') }] });
  assert.equal(JSON.stringify(result).includes(root), false);
  assert.equal(JSON.stringify(result).includes('docs/ux.md'), false);
  const repeated = await bundleKnowledge(config(), { rootDir: root });
  assert.deepEqual(result, repeated);
  await unlink(join(root, 'docs', 'ux.md'));
  assert.equal(result.documents[0].content, original, 'runtime document is independent from the source filesystem');
});

test('required missing files fail and only optional missing files are skipped', async t => {
  const root = await project(t);
  await assert.rejects(bundleKnowledge(config(), { rootDir: root }), error => /documento requerido “ux-rules”/.test(error.message) && !error.message.includes(root));
  const result = await bundleKnowledge(config([{ id: 'optional', path: './docs/missing.md', label: 'Opcional', required: false }]), { rootDir: root });
  assert.deepEqual(result.documents, []);
});

test('configuration rejects globs, duplicate IDs/labels, non-Markdown and invalid limits', () => {
  assert.throws(() => config([{ id: 'ux', label: 'UX', path: './docs/**/*.md' }]), /ruta relativa/);
  assert.throws(() => config([{ id: 'ux', label: 'UX', path: './docs/code.js' }]), /ruta relativa/);
  assert.throws(() => config([{ id: 'ux', label: 'UX', path: resolve('docs/ux.md') }]), /ruta relativa/);
  assert.throws(() => config([{ id: 'ux', label: 'UX', path: './a.md' }, { id: 'ux', label: 'Otra', path: './b.md' }]), /únicos/);
  assert.throws(() => config([{ id: 'ux', label: 'UX', path: './a.md' }, { id: 'design', label: ' ux ', path: './b.md' }]), /únicos/);
  assert.throws(() => config([], { maxDocumentBytes: 65_537 }), /maxDocumentBytes/);
  assert.throws(() => config([], { maxTotalBytes: 0 }), /maxTotalBytes/);
});

test('paths outside the project fail even when they are marked optional', async t => {
  const root = await project(t);
  const outside = config([{ id: 'outside', path: '../outside.md', label: 'Exterior', required: false }]);
  await assert.rejects(bundleKnowledge(outside, { rootDir: root }), /sale de la raíz/);
});

test('symlinks to directories inside the root are rejected conservatively', async t => {
  const root = await project(t);
  await writeFile(join(root, 'docs', 'ux.md'), 'Public rules');
  try { await symlink(join(root, 'docs'), join(root, 'linked'), 'junction'); }
  catch (error) {
    if (error.code === 'EPERM' || error.code === 'ENOTSUP') { t.skip('Host does not allow creating symlinks'); return; }
    throw error;
  }
  await assert.rejects(bundleKnowledge(config([{ id: 'linked', path: './linked/ux.md', label: 'Enlace' }]), { rootDir: root }), /enlaces simbólicos/);
});

test('size limits apply to UTF-8 bytes, individual files and the total bundle', async t => {
  const root = await project(t);
  await writeFile(join(root, 'docs', 'ux.md'), '😀');
  await assert.rejects(bundleKnowledge(config(undefined, { maxDocumentBytes: 3 }), { rootDir: root }), /maxDocumentBytes/);
  await writeFile(join(root, 'docs', 'ux.md'), '123');
  await writeFile(join(root, 'docs', 'two.mdx'), '456');
  const documents = [{ id: 'one', path: './docs/ux.md', label: 'Uno' }, { id: 'two', path: './docs/two.mdx', label: 'Dos' }];
  await assert.rejects(bundleKnowledge(config(documents, { maxTotalBytes: 5 }), { rootDir: root }), /maxTotalBytes/);
  await writeFile(join(root, 'docs', 'ux.md'), 'x'.repeat(65_537));
  await assert.rejects(bundleKnowledge(config(), { rootDir: root }), /maxDocumentBytes/);
});

test('binary and invalid UTF-8 documents fail without exposing absolute paths', async t => {
  const root = await project(t);
  await writeFile(join(root, 'docs', 'ux.md'), Buffer.from([0xc3, 0x28]));
  await assert.rejects(bundleKnowledge(config(), { rootDir: root }), /UTF-8 válido/);
  await writeFile(join(root, 'docs', 'ux.md'), 'text\0binary');
  await assert.rejects(bundleKnowledge(config(), { rootDir: root }), /datos binarios/);
});

test('generated JSON replaces atomically in .ai-toolbar and cannot overwrite other project files', async t => {
  const root = await project(t);
  await writeFile(join(root, 'docs', 'ux.md'), 'First build');
  const first = await bundleKnowledge(config(), { rootDir: root });
  await writeKnowledgeBundle(first, { rootDir: root });
  await writeFile(join(root, 'docs', 'ux.md'), 'Second build');
  const second = await bundleKnowledge(config(), { rootDir: root });
  await writeKnowledgeBundle(second, { rootDir: root });
  assert.deepEqual(JSON.parse(await readFile(join(root, '.ai-toolbar', 'knowledge.json'), 'utf8')), second);
  assert.deepEqual(await readdir(join(root, '.ai-toolbar')), ['knowledge.json']);
  await assert.rejects(writeKnowledgeBundle(second, { rootDir: root, output: './package.json' }), /dentro de .ai-toolbar/);
  assert.equal(dirname(join(root, '.ai-toolbar', 'knowledge.json')), join(root, '.ai-toolbar'));
});

test('Next wrapper prepares documentation before returning object or function config', async t => {
  const root = await project(t);
  await writeFile(join(root, 'docs', 'ux.md'), 'Frozen preview rules');
  const nextConfig = { reactStrictMode: true };
  assert.equal(await withAIContextToolbar(nextConfig, config(), { rootDir: root })(), nextConfig);
  const wrapped = withAIContextToolbar(async (phase, context) => {
    const generated = JSON.parse(await readFile(join(root, '.ai-toolbar', 'knowledge.json'), 'utf8'));
    assert.equal(generated.documents[0].content, 'Frozen preview rules');
    return { phase, ...context };
  }, config(), { rootDir: root });
  assert.deepEqual(await wrapped('phase-production-build', { poweredByHeader: false }), { phase: 'phase-production-build', poweredByHeader: false });
});

test('next start works without the source root and forwards phase arguments to function configs', async t => {
  const root = await project(t);
  const missingRoot = join(root, 'deployment-without-sources');
  const nextConfig = { reactStrictMode: true };
  const options = { rootDir: missingRoot };
  assert.equal(await withAIContextToolbar(nextConfig, config(), options)('phase-production-server'), nextConfig);
  const context = { defaultConfig: { poweredByHeader: false } };
  const wrapped = withAIContextToolbar((phase, receivedContext) => {
    assert.equal(phase, 'phase-production-server');
    assert.equal(receivedContext, context);
    return nextConfig;
  }, config(), options);
  assert.equal(await wrapped('phase-production-server', context), nextConfig);
  await assert.rejects(withAIContextToolbar(nextConfig, config(), options)('phase-production-build'), /raíz del proyecto/);
});

test('artifacts preserve published knowledge and its hash while rendering its markdown as untrusted data', async t => {
  const root = await project(t);
  const content = '# Reglas\n<script>example()</script>\n![tracking](https://example.test)';
  await writeFile(join(root, 'docs', 'ux.md'), content);
  const knowledge = await bundleKnowledge(config(), { rootDir: root });
  const context = {
    schemaVersion: '1.0', capturedAt: '2026-10-14T12:00:00.000Z',
    page: { url: 'https://example.test/', pathname: '/', title: 'Demo', viewport: { width: 1200, height: 800 } },
    build: { environment: 'preview' }, target: null, rules: [], privacy: { redactions: [] }, knowledge,
  };
  const artifact = createArtifact({ mode: 'design', title: 'Propuesta', detail: 'Mejorar jerarquía' }, context);
  assert.equal(artifact.json.context.knowledge.documents[0].content, content);
  assert.equal(artifact.json.context.knowledge.documents[0].checksum, createHash('sha256').update(content).digest('hex'));
  assert.equal(artifact.markdown.includes('<script>'), false);
  assert.equal(artifact.markdown.includes('![tracking]'), false);
  assert.match(artifact.markdown, /sin redacción automática/);
  knowledge.documents[0].content = 'Changed';
  assert.equal(artifact.json.context.knowledge.documents[0].content, content);
});

test('client knowledge validation rejects oversized content and unknown schema versions', () => {
  assert.throws(() => validateKnowledgeBundle({ schemaVersion: '2.0', documents: [] }), /no es válido/);
  assert.throws(() => validateKnowledgeBundle({ schemaVersion: '1.0', documents: [{ id: 'rules', label: 'Reglas', content: 'x'.repeat(65_537), checksum: 'a'.repeat(64) }] }), /tamaño/);
});

test('named public rules work without context.documents and retain titles, modes and exact Markdown hashes', async t => {
  const root = await project(t);
  const ux = '# UX\nUn control principal por pantalla.\n';
  const domain = '# Dominio\nUn animal pertenece a un lote.\n';
  await writeFile(join(root, 'docs', 'ux.md'), ux);
  await writeFile(join(root, 'docs', 'domain.mdx'), domain);
  const input = { rules: [
    { id: 'ux', title: 'Criterios de interacción', path: './docs/ux.md', modes: ['design'] },
    { id: 'domain', title: 'Dominio de mi aplicación', path: './docs/domain.mdx' },
  ] };
  assert.equal(defineConfig(input), input, 'the helper preserves caller configuration and its inferred shape');
  const result = await bundleKnowledge(input, { rootDir: root });
  assert.deepEqual(result.documents, [
    { id: 'ux', label: 'Criterios de interacción', content: ux, checksum: createHash('sha256').update(ux).digest('hex'), modes: ['design'] },
    { id: 'domain', label: 'Dominio de mi aplicación', content: domain, checksum: createHash('sha256').update(domain).digest('hex') },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /docs\/ux\.md|docs\/domain\.mdx|"path"|"title"/);
  await writeKnowledgeBundle(result, { rootDir: root });
  assert.deepEqual(JSON.parse(await readFile(join(root, '.ai-toolbar', 'knowledge.json'), 'utf8')), result);
  await unlink(join(root, 'docs', 'ux.md'));
  assert.equal(result.documents[0].content, ux, 'published rules remain available without source files');
});

test('legacy documents and arbitrary named rules share identity, size and file-safety constraints', async t => {
  const root = await project(t);
  await writeFile(join(root, 'docs', 'legacy.md'), '# Compatibilidad');
  await writeFile(join(root, 'docs', 'custom.md'), '# Convención propia');
  const input = { context: { documents: [{ id: 'legacy', label: 'Guía anterior', path: './docs/legacy.md', modes: ['test', 'report'] }] },
    rules: [{ id: 'custom', title: 'Cualquier convención del equipo', path: './docs/custom.md', modes: ['design'] }] };
  const result = await bundleKnowledge(input, { rootDir: root });
  assert.deepEqual(result.documents.map(document => ({ id: document.id, label: document.label, modes: document.modes })), [
    { id: 'legacy', label: 'Guía anterior', modes: ['test', 'report'] },
    { id: 'custom', label: 'Cualquier convención del equipo', modes: ['design'] },
  ]);
  assert.throws(() => defineConfig({ ...input, rules: [{ id: 'legacy', title: 'Otro título', path: './docs/custom.md' }] }), /únicos/);
  assert.throws(() => defineConfig({ ...input, rules: [{ id: 'other', title: ' guía anterior ', path: './docs/custom.md' }] }), /únicos/);
  assert.throws(() => defineConfig({ rules: [{ id: 'glob', title: 'Explorar carpetas', path: './docs/*.md' }] }), /ruta relativa/);
  await assert.rejects(bundleKnowledge({ rules: [{ id: 'outside', title: 'Fuera del proyecto', path: '../outside.md' }] }, { rootDir: root }), /sale de la raíz/);
  await assert.rejects(bundleKnowledge({ rules: [{ id: 'missing', title: 'Falta el archivo', path: './docs/missing.md' }] }, { rootDir: root }), /documento requerido/);
  await assert.rejects(bundleKnowledge({ ...input, context: { ...input.context, maxTotalBytes: 1 } }, { rootDir: root }), /maxTotalBytes/);
  const rules = Array.from({ length: 30 }, (_, index) => ({ id: `rule-${index}`, title: `Regla ${index}`, path: './docs/custom.md' }));
  assert.throws(() => defineConfig({ ...input, rules }), /30.*total/);
});

test('mode metadata rejects empty, duplicate or unknown modes in configuration and public client bundles', () => {
  const document = { id: 'custom', label: 'Regla propia', content: '# Texto público', checksum: 'a'.repeat(64) };
  for (const modes of [[], ['design', 'design'], ['test', 'design', 'report', 'test'], ['unknown'], 'design', null]) {
    assert.throws(() => defineConfig({ rules: [{ id: 'custom', title: 'Regla propia', path: './docs/custom.md', modes }] }), /modos/);
    assert.throws(() => config([{ id: 'custom', label: 'Regla propia', path: './docs/custom.md', modes }]), /modos/);
    assert.throws(() => validateKnowledgeBundle({ schemaVersion: '1.0', documents: [{ ...document, modes }] }), /modos/);
  }
  const input = { schemaVersion: '1.0', documents: [{ ...document, modes: ['report', 'test'] }] };
  const checked = validateKnowledgeBundle(input);
  input.documents[0].modes[0] = 'design';
  assert.deepEqual(checked.documents[0].modes, ['report', 'test'], 'validated mode metadata is an independent copy');
  assert.equal(Object.hasOwn(validateKnowledgeBundle({ schemaVersion: '1.0', documents: [document] }).documents[0], 'modes'), false);
});

test('build revalidates rule metadata after defineConfig and the Next wrapper supports rules-only configuration', async t => {
  const root = await project(t);
  await writeFile(join(root, 'docs', 'custom.md'), '# Regla del integrador');
  const input = defineConfig({ rules: [{ id: 'custom', title: 'Regla del integrador', path: './docs/custom.md', modes: ['design'] }] });
  input.rules[0].modes = ['unknown'];
  await assert.rejects(bundleKnowledge(input, { rootDir: root }), /modos/);
  input.rules[0].modes = ['design'];
  const nextConfig = { reactStrictMode: true };
  assert.equal(await withAIContextToolbar(nextConfig, input, { rootDir: root })('phase-production-build'), nextConfig);
  const generated = JSON.parse(await readFile(join(root, '.ai-toolbar', 'knowledge.json'), 'utf8'));
  assert.deepEqual(generated.documents[0].modes, ['design']);
  assert.equal(generated.documents[0].label, 'Regla del integrador');
  const reading = bundleKnowledge(input, { rootDir: root });
  input.rules[0].path = './docs/unpublished.env';
  input.rules[0].modes[0] = 'report';
  const stable = await reading;
  assert.equal(stable.documents[0].content, '# Regla del integrador');
  assert.deepEqual(stable.documents[0].modes, ['design'], 'an async build uses its validated declaration snapshot');
});
