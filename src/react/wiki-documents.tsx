'use client';
import { Fragment, useEffect, useState } from 'react';
import type { ToolbarWiki } from '../core/types.js';
import type { ToolbarLocale } from '../core/locale.js';
import { createTranslator } from '../core/locale.js';
import { documentMatchesRoute } from '../core/knowledge.js';
import { fetchOutsideRecording } from '../browser/activity.js';
import { Icon } from './icons.js';
import { WikiSignIn } from './wiki-sign-in.js';

interface WikiEditor {
  user: { id: number; name: string };
  canEdit: boolean;
  csrfToken: string;
  pages: Array<{ path: string; label: string }>;
  documents: Array<{ id: number; label: string; url: string; general: boolean; canEdit: boolean }>;
}

export function WikiDocuments({ wiki, locale, pathname, copy }: { wiki: ToolbarWiki; locale: ToolbarLocale; pathname: string; copy(text: string): Promise<void> }) {
  const t = createTranslator(locale);
  const [editor, setEditor] = useState<WikiEditor | null>(null), [adding, setAdding] = useState(false), [busy, setBusy] = useState(false);
  const [documentId, setDocumentId] = useState(''), [page, setPage] = useState(pathname), [notice, setNotice] = useState('');
  const [connected, setConnected] = useState(false);
  const documentFingerprint = JSON.stringify(wiki.documents);
  useEffect(() => {
    if (!wiki.manageUrl) return;
    const abort = new AbortController();
    const load = async () => {
      try {
        const response = await fetchOutsideRecording(window, wiki.manageUrl!, { credentials: 'include', cache: 'no-store', signal: abort.signal, redirect: 'error', headers: { Accept: 'application/json' } });
        if (!response.ok) { setEditor(null); setConnected(false); return; }
        const text = await response.text();
        if (text.length > 131072) throw new Error('Invalid wiki controls.');
        const value = JSON.parse(text) as WikiEditor;
        if (typeof value.csrfToken !== 'string' || !Array.isArray(value.pages) || value.pages.length > 200 || !Array.isArray(value.documents) || value.documents.length > 100) throw new Error('Invalid wiki controls.');
        if (!abort.signal.aborted) { setEditor(value); setConnected(true); }
      } catch { if (!abort.signal.aborted) { setEditor(null); setConnected(false); } }
    };
    void load(); window.addEventListener('focus', load); window.addEventListener('ai-context-toolbar:wiki-auth-changed', load);
    return () => { abort.abort(); window.removeEventListener('focus', load); window.removeEventListener('ai-context-toolbar:wiki-auth-changed', load); };
  }, [wiki.manageUrl, documentFingerprint]);
  async function associate(id: number, path: string, action: 'add' | 'remove') {
    if (!editor || !wiki.manageUrl || busy) return;
    setBusy(true); setNotice('');
    try {
      const response = await fetchOutsideRecording(window, `${wiki.manageUrl}/associations`, { method: 'POST', credentials: 'include', redirect: 'error',
        signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-TOKEN': editor.csrfToken }, body: JSON.stringify({ pageId: id, path, action }) });
      if (!response.ok) throw new Error(t('No se pudo guardar el vínculo. Revisá tu sesión y permisos en la wiki.'));
      setAdding(false); setDocumentId(''); setNotice(t('Vínculo guardado.'));
      window.dispatchEvent(new Event('ai-context-toolbar:config-changed'));
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  }
  const available = editor?.documents.filter(doc => !doc.general && doc.canEdit) ?? [];
  if (wiki.manageUrl && !connected) return <div className="wiki-associations"><WikiSignIn wiki={wiki} locale={locale} /></div>;
  return <>
    <ul className="recording-document-list">{[false, true].map(scoped => {
      const links = (wiki.documents ?? []).filter(link => Boolean(link.routes) === scoped && documentMatchesRoute(link, pathname));
      if (scoped && !links.length) return null;
      return <Fragment key={String(scoped)}>
        <li className="document-group" role="presentation">{t(scoped ? 'Esta página' : 'General')}</li>
        {!scoped && <li><a href={wiki.url} target="_blank" rel="noopener noreferrer">{t('Wiki general')}</a><button type="button" className="icon-button" aria-label={t('Copiar enlace a la wiki')} onClick={() => void copy(wiki.url)}><Icon name="copy" /></button></li>}
        {links.map(link => {
          const editable = scoped && editor?.pages.some(item => item.path === pathname) && editor.documents.find(doc => doc.url === link.url && doc.canEdit);
          return <li key={link.url}><a href={link.url} target="_blank" rel="noopener noreferrer">{link.label}</a><button type="button" className="icon-button" aria-label={t('Copiar enlace: {label}', { label: link.label })} onClick={() => void copy(link.url)}><Icon name="copy" /></button>
            {editable && <button type="button" className="icon-button" disabled={busy} aria-label={t('Quitar de esta página: {label}', { label: link.label })} title={t('Quitar de esta página')} onClick={() => void associate(editable.id, pathname, 'remove')}><Icon name="minus" /></button>}
          </li>;
        })}
      </Fragment>;
    })}</ul>
    {wiki.manageUrl && <div className="wiki-associations">
      {!connected ? <WikiSignIn wiki={wiki} locale={locale} />
        : editor?.canEdit ? <button type="button" className="text-button" aria-label={t('Agregar documento a una página')} onClick={() => { setAdding(!adding); setNotice(''); }}><Icon name="plus" />{t('Agregar documento')}</button>
          : <p className="subtle">{t('Acceso de lectura a la wiki.')}</p>}
      {adding && (editor ? available.length && editor.pages.length ? <form onSubmit={event => { event.preventDefault(); void associate(Number(documentId), page, 'add'); }}>
        <label className="field">{t('Documento')}<select required value={documentId} onChange={event => setDocumentId(event.target.value)}><option value="">{t('Elegí un documento')}</option>{available.map(doc => <option key={doc.id} value={doc.id}>{doc.label}</option>)}</select></label>
        <label className="field">{t('Página')}<select required value={page} onChange={event => setPage(event.target.value)}><option value="">{t('Elegí una página')}</option>{editor.pages.map(item => <option key={item.path} value={item.path}>{item.label} · {item.path}</option>)}</select></label>
        <button className="secondary" type="submit" disabled={busy || !documentId || !page}>{t('Agregar a la página')}</button>
      </form> : <p className="subtle">{t('No hay documentos por página editables o páginas publicadas por el build.')}</p> : <p className="subtle">{t('Iniciá sesión en la wiki con permiso para editar este proyecto.')} <a href={wiki.url} target="_blank" rel="noopener noreferrer">{t('Abrir wiki')}</a></p>)}
      {notice && <p className="subtle" role="status">{notice}</p>}
    </div>}
  </>;
}
