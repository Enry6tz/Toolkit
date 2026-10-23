'use client';
import { useEffect, useState } from 'react';
import type { ToolbarLocale } from '../core/locale.js';
import { createTranslator } from '../core/locale.js';
import { listWikiRecordings } from '../browser/wiki-recordings.js';
import { recordingOrigin } from '../browser/recording-origin.js';

export function WikiRecordingAuthor({ sessionId, manageUrl, locale }: { sessionId: string; manageUrl: string; locale: ToolbarLocale }) {
  const [author, setAuthor] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const t = createTranslator(locale);
  useEffect(() => {
    const abort = new AbortController();
    async function load() {
      const origin = recordingOrigin(window, sessionId, manageUrl);
      if (!origin) { setAuthor(null); setUnavailable(false); return; }
      try {
        const records = await listWikiRecordings(window, manageUrl, AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]));
        if (abort.signal.aborted) return;
        const value = records.find(item => item.id === origin.recordingId);
        setAuthor(value?.author ?? null); setUnavailable(!value?.author);
      } catch { if (!abort.signal.aborted) { setAuthor(null); setUnavailable(true); } }
    }
    void load();
    window.addEventListener('ai-context-toolbar:recording-origin', load);
    window.addEventListener('ai-context-toolbar:wiki-auth-changed', load);
    return () => { abort.abort(); window.removeEventListener('ai-context-toolbar:recording-origin', load); window.removeEventListener('ai-context-toolbar:wiki-auth-changed', load); };
  }, [sessionId, manageUrl]);
  if (!author && !unavailable) return null;
  return <p className="subtle recording-author" data-recording-author="">{author ? t('Creada por {name}', { name: author }) : t('Autor no disponible')}</p>;
}
