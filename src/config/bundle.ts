import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { MAX_DOCUMENT_BYTES, MAX_DOCUMENTS, MAX_KNOWLEDGE_BYTES, validateDocumentModes, validateDocumentRoutes, validateKnowledgeBundle } from '../core/knowledge.js';
import { validateWikiLinks } from '../core/wiki.js';
import type { BundledDocument, KnowledgeBundle } from '../core/types.js';
import type { BundleKnowledgeOptions, NextKnowledgeOptions, ToolbarConfig, ToolbarDocument, WriteKnowledgeOptions } from './types.js';

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return undefined;
}

function withinRoot(root: string, file: string): boolean {
  const local = relative(root, file);
  return local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

function limit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > fallback) throw new Error(`${name} debe ser un entero entre 1 y ${fallback}.`);
  return value;
}

function validateDocument(document: ToolbarDocument, ids: Set<string>, labels: Set<string>): void {
  if (!document || typeof document.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(document.id)) {
    throw new Error('Cada documento necesita un identificador válido en minúsculas.');
  }
  if (typeof document.label !== 'string' || !document.label.trim() || document.label.length > 100 || /[\r\n\u0000-\u001F]/.test(document.label)) {
    throw new Error(`La etiqueta del documento “${document.id}” no es válida.`);
  }
  const label = document.label.trim().normalize('NFKC').toLowerCase();
  if (ids.has(document.id) || labels.has(label)) throw new Error('Los identificadores y las etiquetas de documentos deben ser únicos.');
  ids.add(document.id);
  labels.add(label);
  if (typeof document.path !== 'string' || !document.path || document.path.length > 500 || document.path.includes('\0')
    || isAbsolute(document.path) || !['.md', '.mdx'].includes(extname(document.path).toLowerCase()) || /[*?{}]/.test(document.path)) {
    throw new Error(`Usá una ruta relativa a un archivo .md o .mdx para “${document.id}”.`);
  }
  if (document.required !== undefined && typeof document.required !== 'boolean') throw new Error(`El campo required de “${document.id}” debe ser booleano.`);
  validateDocumentModes(document.modes);
  validateDocumentRoutes(document.routes);
}

function declaredDocuments(config: ToolbarConfig): ToolbarDocument[] {
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || (config.context !== undefined && (!config.context || typeof config.context !== 'object' || Array.isArray(config.context)))
    || (config.context?.documents !== undefined && !Array.isArray(config.context.documents))
    || (config.rules !== undefined && !Array.isArray(config.rules)))
    throw new Error('Declará documentos explícitos en context.documents o reglas con título y Markdown en rules.');
  const documents = [...(config.context?.documents ?? [])];
  for (const rule of config.rules ?? []) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error('Cada regla necesita id, title y path.');
    documents.push({ id: rule.id, label: rule.title, path: rule.path,
      ...(rule.routes ? { routes: rule.routes } : {}),
      ...(rule.modes !== undefined ? { modes: rule.modes } : {}) });
  }
  if (documents.length > MAX_DOCUMENTS) throw new Error(`Declará hasta ${MAX_DOCUMENTS} documentos y reglas en total.`);
  return documents;
}

/** Validation is repeated at build time so later config mutations cannot bypass it. */
export function defineConfig<T extends ToolbarConfig>(config: T): T {
  const documents = declaredDocuments(config);
  validateWikiLinks(config.wiki);
  if (config.liveConfig && (typeof config.liveConfig.url !== 'string' || !/^\/(?!\/)[^\\#?\s]{1,2000}$/.test(config.liveConfig.url)
    || (config.liveConfig.intervalMs !== undefined && !Number.isFinite(config.liveConfig.intervalMs)))) throw new Error('liveConfig needs a same-origin endpoint path and a finite interval.');
  if (config.locale !== undefined && config.locale !== 'en' && config.locale !== 'es') throw new Error('locale must be "en" or "es".');
  if (config.documentsPath !== undefined && (typeof config.documentsPath !== 'string' || config.documentsPath.length > 2000
    || !config.documentsPath.startsWith('/') || config.documentsPath.startsWith('//') || /[\\?#\u0000-\u0020]/.test(config.documentsPath)
    || /%(?:2f|5c|2e)/i.test(config.documentsPath) || config.documentsPath.split('/').some(segment => segment === '.' || segment === '..')))
    throw new Error('documentsPath debe ser una ruta local de la aplicación, sin dominio, parámetros ni fragmentos.');
  limit(config.context?.maxDocumentBytes, MAX_DOCUMENT_BYTES, 'maxDocumentBytes');
  limit(config.context?.maxTotalBytes, MAX_KNOWLEDGE_BYTES, 'maxTotalBytes');
  if (config.enabled) {
    for (const value of Object.values(config.enabled)) {
      if (value !== undefined && typeof value !== 'boolean') throw new Error('Las opciones enabled deben ser booleanas.');
    }
  }
  const ids = new Set<string>();
  const labels = new Set<string>();
  for (const document of documents) validateDocument(document, ids, labels);
  return config;
}

async function projectRoot(rootDir: string): Promise<string> {
  try {
    const root = await realpath(resolve(rootDir));
    if (!(await lstat(root)).isDirectory()) throw new Error();
    return root;
  } catch { throw new Error('La raíz del proyecto no está disponible.'); }
}

/** Reject every symlink component, including links that remain inside the root. */
async function noSymlinks(root: string, file: string, allowMissing = false): Promise<void> {
  if (!withinRoot(root, file)) throw new Error('La ruta sale de la raíz permitida del proyecto.');
  let cursor = root;
  for (const segment of relative(root, file).split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error('No se admiten enlaces simbólicos para la documentación generada.');
    } catch (error) {
      if (allowMissing && errorCode(error) === 'ENOENT') return;
      throw error;
    }
  }
}

export async function bundleKnowledge(config: ToolbarConfig, options: BundleKnowledgeOptions): Promise<KnowledgeBundle> {
  defineConfig(config);
  const sources = declaredDocuments(config).map(document => ({ ...document,
    ...(document.modes ? { modes: [...document.modes] } : {}) }));
  const maxDocument = limit(config.context?.maxDocumentBytes, MAX_DOCUMENT_BYTES, 'maxDocumentBytes');
  const maxTotal = limit(config.context?.maxTotalBytes, MAX_KNOWLEDGE_BYTES, 'maxTotalBytes');
  const root = await projectRoot(options.rootDir);
  const documents: BundledDocument[] = [];
  let total = 0;
  for (const document of sources) {
    const path = resolve(root, document.path);
    if (!withinRoot(root, path)) throw new Error(`La ruta de “${document.id}” sale de la raíz permitida.`);
    try {
      await noSymlinks(root, path);
      const canonical = await realpath(path);
      if (!withinRoot(root, canonical)) throw new Error('La ruta resuelta sale de la raíz permitida.');
      const file = await open(canonical, 'r');
      let bytes: Buffer;
      try {
        const info = await file.stat();
        if (!info.isFile()) throw new Error(`“${document.id}” debe ser un archivo Markdown.`);
        if (info.size > maxDocument) throw new Error(`“${document.id}” supera maxDocumentBytes.`);
        // Bound the read even if the source changes after its stat call.
        const buffer = Buffer.alloc(maxDocument + 1);
        let read = 0;
        while (read < buffer.length) {
          const result = await file.read(buffer, read, buffer.length - read, read);
          if (!result.bytesRead) break;
          read += result.bytesRead;
        }
        if (read > maxDocument) throw new Error(`“${document.id}” supera maxDocumentBytes.`);
        bytes = buffer.subarray(0, read);
      } finally { await file.close(); }
      total += bytes.byteLength;
      if (total > maxTotal) throw new Error('La documentación supera maxTotalBytes.');
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new Error(`“${document.id}” debe contener texto UTF-8 válido.`); }
      if (content.includes('\0')) throw new Error(`“${document.id}” contiene datos binarios.`);
      documents.push({
        id: document.id, label: document.label.trim(), content,
        checksum: createHash('sha256').update(content, 'utf8').digest('hex'),
        ...(document.modes ? { modes: [...document.modes] } : {}),
        ...(document.routes ? { routes: [...document.routes] } : {}),
      });
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        if (document.required === false) continue;
        throw new Error(`No se encontró el documento requerido “${document.id}”.`);
      }
      // Native filesystem messages may reveal absolute source paths.
      if (errorCode(error)) throw new Error(`No se pudo leer el documento “${document.id}”.`);
      throw error;
    }
  }
  return validateKnowledgeBundle({ schemaVersion: '1.0', documents });
}

export async function writeKnowledgeBundle(bundle: KnowledgeBundle, options: WriteKnowledgeOptions): Promise<void> {
  const knowledge = validateKnowledgeBundle(bundle);
  const root = await projectRoot(options.rootDir);
  const output = options.output ?? '.ai-toolbar/knowledge.json';
  const directory = resolve(root, '.ai-toolbar');
  const file = resolve(root, output);
  if (isAbsolute(output) || !withinRoot(directory, file) || file === directory || extname(file).toLowerCase() !== '.json') {
    throw new Error('El archivo generado debe ser un JSON dentro de .ai-toolbar.');
  }
  let temporary: string | undefined;
  try {
    await noSymlinks(root, file, true);
    await mkdir(dirname(file), { recursive: true });
    await noSymlinks(root, file, true);
    const parent = await realpath(dirname(file));
    if (!withinRoot(root, parent)) throw new Error('El destino generado sale de la raíz permitida.');
    temporary = join(parent, `.knowledge-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(knowledge, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
    temporary = undefined;
  } catch (error) {
    if (errorCode(error)) throw new Error('No se pudo escribir la documentación generada.');
    throw error;
  } finally {
    if (temporary) await unlink(temporary).catch(() => undefined);
  }
}

/** Async Next config wrapper: generation runs before Next compiles the client. */
export function withAIContextToolbar<T extends object, Args extends unknown[]>(
  nextConfig: T | ((...args: Args) => T | Promise<T>),
  toolbarConfig: ToolbarConfig,
  options: NextKnowledgeOptions = {},
): (...args: Args) => Promise<T> {
  defineConfig(toolbarConfig);
  return async (...args: Args): Promise<T> => {
    // Next also loads next.config during `next start`. The deployed application
    // uses its compiled document bundle and must not need the source files.
    if (args[0] !== 'phase-production-server') {
      const rootDir = options.rootDir ?? process.cwd();
      const bundle = await bundleKnowledge(toolbarConfig, { rootDir });
      const writeOptions: WriteKnowledgeOptions = { rootDir };
      if (options.output !== undefined) writeOptions.output = options.output;
      await writeKnowledgeBundle(bundle, writeOptions);
    }
    return typeof nextConfig === 'function'
      ? (nextConfig as (...args: Args) => T | Promise<T>)(...args)
      : nextConfig;
  };
}
