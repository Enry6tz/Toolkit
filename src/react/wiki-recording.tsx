'use client';
import { useEffect, useState } from 'react';
import type { ToolbarWiki } from '../core/types.js';
import type { ToolbarLocale } from '../core/locale.js';
import { createTranslator } from '../core/locale.js';
import { fetchOutsideRecording } from '../browser/activity.js';
import { Icon } from './icons.js';
import { WikiSignIn } from './wiki-sign-in.js';

interface SavedRecording { id: string; sourceSessionId: string; canDelete: boolean; canUpdate?: boolean; version?: string }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function readSavedRecording(value: unknown): SavedRecording | null {
  if (!object(value) || typeof value.id !== 'string' || !/^[a-z0-9-]{1,128}$/i.test(value.id) || typeof value.sourceSessionId !== 'string') return null;
  return { id: value.id, sourceSessionId: value.sourceSessionId, canDelete: value.canDelete === true,
    ...(typeof value.canUpdate === 'boolean' ? { canUpdate: value.canUpdate } : {}),
    ...(typeof value.version === 'string' && /^[a-f0-9]{64}$/i.test(value.version) ? { version: value.version } : {}) };
}

export function WikiRecordingSave({ wiki, locale, sessionId, title, getJson, getMarkdown }: { wiki: ToolbarWiki; locale: ToolbarLocale; sessionId: string; title: string; getJson(): Promise<string>; getMarkdown(): Promise<string> }) {
  const t = createTranslator(locale), [saved, setSaved] = useState<SavedRecording | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [canEdit, setCanEdit] = useState(false), [connected, setConnected] = useState(false), [supportsUpdates, setSupportsUpdates] = useState(false);
  useEffect(() => {
    if (!wiki.manageUrl) return;
    const abort = new AbortController();
    const load = async () => {
      try {
        const access = await fetchOutsideRecording(window, wiki.manageUrl!, { credentials: 'include', cache: 'no-store', signal: abort.signal, redirect: 'error', headers: { Accept: 'application/json' } });
        if (!access.ok) { if (!abort.signal.aborted) setConnected(false); return; }
        const auth: unknown = await access.json();
        if (abort.signal.aborted || !object(auth)) return;
        setConnected(true); setCanEdit(auth.canEdit === true); setSupportsUpdates(auth.recordingUpdates === true);
        const response = await fetchOutsideRecording(window, `${wiki.manageUrl}/recordings`, { credentials: 'include', cache: 'no-store', signal: abort.signal, redirect: 'error', headers: { Accept: 'application/json' } });
        if (!response.ok) return;
        const data: unknown = await response.json();
        if (!abort.signal.aborted && object(data) && Array.isArray(data.recordings)) {
          const match = data.recordings.map(readSavedRecording).find(item => item?.sourceSessionId === sessionId) ?? null;
          // A focus refresh must not silently advance the version originally reviewed.
          setSaved(previous => previous?.id === match?.id ? previous : match);
        }
      } catch { if (!abort.signal.aborted) setConnected(false); }
    };
    void load(); window.addEventListener('focus', load); window.addEventListener('ai-context-toolbar:wiki-auth-changed', load);
    return () => { abort.abort(); window.removeEventListener('focus', load); window.removeEventListener('ai-context-toolbar:wiki-auth-changed', load); };
  }, [wiki.manageUrl, sessionId]);
  async function change(remove: boolean) {
    if (!wiki.manageUrl || busy) return;
    setBusy(true); setNotice('');
    try {
      const access = await fetchOutsideRecording(window, wiki.manageUrl, { credentials: 'include', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } });
      if (!access.ok) throw new Error(t('Iniciá sesión en la wiki con permiso para editar este proyecto.'));
      const auth: unknown = await access.json();
      if (!object(auth) || typeof auth.csrfToken !== 'string') throw new Error(t('No se pudo guardar la grabación en la wiki.'));
      if (!remove && saved && (auth.recordingUpdates !== true || !saved.version || saved.canUpdate === false))
        throw new Error(t('Esta grabación no admite actualizar la evidencia desde esta toolbar.'));
      const update = !remove && !!saved;
      const response = await fetchOutsideRecording(window, `${wiki.manageUrl}/recordings${saved && (remove || update) ? `/${saved.id}` : ''}`, {
        method: remove ? 'DELETE' : update ? 'PATCH' : 'POST', credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(12000),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-TOKEN': auth.csrfToken },
        ...(!remove ? { body: JSON.stringify(update ? { recording: JSON.parse(await getJson()), expectedVersion: saved!.version }
          : { title: title.slice(0, 100), recording: JSON.parse(await getJson()), ...(auth.recordingUpdates === true ? { markdown: await getMarkdown() } : {}) }) } : {}),
      });
      if (response.status === 409) throw new Error(t('La grabación cambió en Toolkit. Abrila de nuevo antes de actualizar; tu copia local se conserva.'));
      if (!response.ok) throw new Error(t('No se pudo guardar la grabación en la wiki.'));
      if (remove) { setSaved(null); setNotice(t('Eliminada de la wiki. La copia local se conserva.')); }
      else {
        const result: unknown = await response.json(), acknowledged = object(result) ? readSavedRecording(result.recording) : null;
        if (!acknowledged || acknowledged.sourceSessionId !== sessionId) throw new Error(t('No se pudo guardar la grabación en la wiki.'));
        setSaved(acknowledged); setNotice(t('Grabación compartida con el proyecto.'));
      }
      window.dispatchEvent(new CustomEvent('ai-context-toolbar:wiki-recordings-changed', { detail: { manageUrl: wiki.manageUrl, action: remove ? 'deleted' : 'saved' } }));
    } catch (error) { setNotice(error instanceof Error ? error.message : t('No se pudo guardar la grabación en la wiki.')); }
    finally { setBusy(false); }
  }
  const updateUnavailable = !!saved && (!supportsUpdates || !saved.version || saved.canUpdate === false);
  return <div className="wiki-recording-store">
    {!connected ? <WikiSignIn wiki={wiki} locale={locale} /> : <div><button type="button" className="text-button" disabled={busy || !canEdit || updateUnavailable} onClick={() => void change(false)}><Icon name="cloud" />{t(saved ? 'Actualizar en la wiki' : 'Guardar en la wiki')}</button>
      {saved?.canDelete && <button type="button" className="icon-button" disabled={busy} aria-label={t('Eliminar de la wiki')} title={t('Eliminar de la wiki')} onClick={() => void change(true)}><Icon name="trash" /></button>}
    </div>}
    {saved && <p className="subtle">{t('Compartida en Toolkit. Los cambios locales requieren actualizar.')}</p>}
    {updateUnavailable && <p className="subtle">{t('Esta grabación no admite actualizar la evidencia desde esta toolbar.')}</p>}
    {notice && <p className="subtle" role="status">{notice} <a href={wiki.url} target="_blank" rel="noopener noreferrer">{t('Abrir wiki')}</a></p>}
  </div>;
}
