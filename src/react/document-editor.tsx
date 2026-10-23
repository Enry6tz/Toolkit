'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { validateKnowledgeBundle } from '../core/index.js';
import type { KnowledgeBundle } from '../core/index.js';
import { createTranslator, resolveLocale } from '../core/locale.js';
import type { ToolbarLocale } from '../core/locale.js';

export interface AIContextDocumentEditorProps {
  locale?: ToolbarLocale;
  knowledge?: KnowledgeBundle;
  loadKnowledge?: () => Promise<KnowledgeBundle>;
  /** Defaults to the same-origin page's ?document= identifier, or the first document. */
  documentId?: string;
  /** Public short rules are available as the virtual document project-rules. */
  rules?: readonly string[];
  /** Only this callback can persist to the integrator's source or service. */
  onSave?: (documentId: string, markdown: string) => Promise<void>;
  nonce?: string;
}

/** A separate, editable document surface. Markdown remains plain text. */
export function AIContextDocumentEditor(props: AIContextDocumentEditorProps) {
  const locale = resolveLocale(props.locale), t = createTranslator(locale);
  const [knowledge, setKnowledge] = useState<KnowledgeBundle | null>(null);
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState('');
  const [queryId, setQueryId] = useState<string | null>(null), [markdown, setMarkdown] = useState('');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const field = useRef<HTMLTextAreaElement>(null), mounted = useRef(true), fieldId = useId();
  useEffect(() => { mounted.current = true; setQueryId(new URLSearchParams(window.location.search).get('document'));
    return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true; setLoading(true); setLoadError('');
    const input = Promise.resolve().then(() => props.knowledge ?? props.loadKnowledge?.() ?? null);
    void input.then(value => { if (active) setKnowledge(value ? validateKnowledgeBundle(value) : null); })
      .catch(() => { if (active) { setKnowledge(null); setLoadError(t("No se pudo cargar la documentación. Recargá la página para volver a intentar.")); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [props.knowledge, props.loadKnowledge]);
  const documents = useMemo(() => [
    ...(knowledge?.documents.map(document => ({ id: document.id, title: document.label, markdown: document.content })) ?? []),
    ...(props.rules?.length ? [{ id: 'project-rules', title: t("Reglas del proyecto"), markdown: '# ' + t('Reglas del proyecto') + '\n\n' + props.rules.map(rule => '- ' + rule).join('\n') + '\n' }] : []),
  ], [knowledge, props.rules, locale]);
  const requested = props.documentId ?? queryId;
  const document = requested ? documents.find(item => item.id === requested) : documents[0];
  useEffect(() => { setMarkdown(document?.markdown ?? ''); setMessage(''); setError(''); }, [document?.id, document?.markdown]);
  async function copy() {
    setError(''); setMessage(''); let timer: number | undefined;
    try {
      await Promise.race([navigator.clipboard.writeText(markdown), new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error('Clipboard timeout')), 4000);
      })]);
      if (mounted.current) setMessage(t("Markdown copiado."));
    } catch { if (mounted.current) { setError(t("No se pudo copiar. Seleccioná el Markdown y copialo manualmente.")); field.current?.focus(); field.current?.select(); } }
    finally { window.clearTimeout(timer); }
  }
  function download() {
    if (!document) return;
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
    const link = window.document.createElement('a'); link.href = url;
    link.download = (document.id.replace(/[^a-zA-Z0-9_-]/g, '-') || 'documento') + '.md';
    link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); setMessage(t("Markdown descargado."));
  }
  async function save() {
    if (!document || !props.onSave || busy) return;
    setBusy(true); setError(''); setMessage('');
    try { await props.onSave(document.id, markdown); if (mounted.current) setMessage(t("Documento guardado.")); }
    catch { if (mounted.current) setError(t("No se pudo guardar el documento. El borrador sigue abierto; copiá o descargá los cambios.")); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <section className="ai-context-document-editor" lang={locale} aria-label={t("Editor de documentación")}>
    <style nonce={props.nonce}>{editorStyles}</style>
    {loading ? <p role="status">{t("Cargando documento…")}</p> : loadError ? <p role="alert">{t(loadError)}</p> : !document ? <>
      <h1>{t("Documento no encontrado")}</h1><p>{t("Este documento no está publicado en el build actual. Volvé al menú Documentos de la aplicación.")}</p>
    </> : <>
      <header><div><h1>{document.title}</h1><p>{props.onSave ? t("Editá el Markdown y guardá los cambios.") : t("Borrador local. Copialo o descargalo para conservar los cambios; el archivo del proyecto sigue igual.")}</p></div>
        <div className="ai-context-document-actions"><button type="button" disabled={busy} onClick={() => void copy()}>{t("Copiar Markdown")}</button><button type="button" disabled={busy} onClick={download}>{t("Descargar Markdown")}</button>
          {props.onSave && <button type="button" className="ai-context-document-save" disabled={busy} onClick={() => void save()}>{busy ? t("Guardando…") : t("Guardar documento")}</button>}</div></header>
      <label htmlFor={fieldId}>Markdown</label><textarea id={fieldId} ref={field} spellCheck={false} value={markdown} disabled={busy} onChange={event => { setMarkdown(event.currentTarget.value); setMessage(''); }} />
      {message && <p role="status">{t(message)}</p>}{error && <p role="alert">{t(error)}</p>}
    </>}
  </section>;
}

const editorStyles = `
.ai-context-document-editor{box-sizing:border-box;width:min(1120px,100%);margin:0 auto;padding:40px 32px 32px;color:#24202d;font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color-scheme:light}
.ai-context-document-editor *{box-sizing:border-box}.ai-context-document-editor header{display:flex;align-items:flex-start;justify-content:space-between;gap:28px;margin-bottom:28px}.ai-context-document-editor h1{margin:0;font-size:28px;line-height:1.25;font-weight:600;letter-spacing:-.025em}.ai-context-document-editor p{max-width:72ch;margin:10px 0 0;color:#625a72}.ai-context-document-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex-shrink:0}.ai-context-document-editor button{font:inherit;font-size:13px;line-height:1.4;padding:9px 12px;min-height:38px;border:1px solid #d8d5e2;border-radius:8px;background:#fff;color:#514b5c;cursor:pointer}.ai-context-document-editor button:hover:not(:disabled){background:#f1effa;border-color:#b3aecb}.ai-context-document-editor button:disabled{cursor:wait;opacity:.65}.ai-context-document-editor button:focus-visible{outline:2px solid #6965db;outline-offset:3px}.ai-context-document-editor button.ai-context-document-save{border-color:#6965db;background:#6965db;color:#fff}.ai-context-document-editor button.ai-context-document-save:hover:not(:disabled){background:#5752c7;border-color:#5752c7}.ai-context-document-editor label{display:block;margin-bottom:8px;color:#514b5c;font-size:13px;font-weight:600}.ai-context-document-editor textarea{display:block;width:100%;min-height:calc(100dvh - 230px);resize:vertical;margin:0;padding:20px;border:1px solid #d8d5e2;border-radius:10px;background:#fff;color:#24202d;font:13px/1.75 ui-monospace,SFMono-Regular,Consolas,monospace;tab-size:2;caret-color:#6965db;scrollbar-color:#bcb5ce #f7f5fc}.ai-context-document-editor textarea:focus{outline:2px solid #6965db;outline-offset:2px}.ai-context-document-editor textarea:disabled{background:#f7f5fc}.ai-context-document-editor textarea::selection{background:#e9e7fc;color:#342d53}.ai-context-document-editor [role=alert]{color:#9e2535}.ai-context-document-editor [role=status]{font-size:13px}
@media(max-width:760px){.ai-context-document-editor{padding:26px 16px 20px}.ai-context-document-editor header{flex-direction:column;gap:18px;margin-bottom:24px}.ai-context-document-editor h1{font-size:24px}.ai-context-document-actions{gap:8px}.ai-context-document-editor textarea{padding:14px;min-height:62dvh}}
@media(prefers-contrast:more){.ai-context-document-editor p{color:#40394b}.ai-context-document-editor button,.ai-context-document-editor textarea{border-color:#7c738e}}
`;
