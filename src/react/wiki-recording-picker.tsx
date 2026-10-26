'use client';
import { useEffect, useState } from 'react';
import type { ToolbarWiki } from '../core/types.js';
import { createTranslator, dateLocale } from '../core/locale.js';
import type { ToolbarLocale } from '../core/locale.js';
import { listWikiRecordings, WikiRecordingError } from '../browser/wiki-recordings.js';
import type { WikiRecordingSummary } from '../browser/wiki-recordings.js';
import { Icon } from './icons.js';
import { WikiSignIn } from './wiki-sign-in.js';

export function wikiRecordingErrorMessage(error: unknown, locale: ToolbarLocale): string {
  const t = createTranslator(locale);
  const code = error instanceof WikiRecordingError ? error.code : 'unavailable';
  return t({
    auth: 'Iniciá sesión en Toolkit para ver las grabaciones del proyecto.',
    forbidden: 'No tenés acceso a las grabaciones de este proyecto.',
    unavailable: 'No se pudieron cargar las grabaciones. Volvé a intentar.',
    invalid: 'Toolkit devolvió datos de grabación no válidos.',
    'too-large': 'La grabación supera el tamaño permitido.',
  }[code]);
}

export function WikiRecordingPicker({ wiki, locale, disabled, onChoose }: {
  wiki: ToolbarWiki; locale: ToolbarLocale; disabled: boolean; onChoose(recording: WikiRecordingSummary): void;
}) {
  const t = createTranslator(locale);
  const [items, setItems] = useState<WikiRecordingSummary[]>([]), [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null), [retry, setRetry] = useState(0), [query, setQuery] = useState('');
  useEffect(() => {
    if (!wiki.manageUrl) return;
    const abort = new AbortController();
    let revision = 0;
    const load = async () => {
      const current = ++revision;
      setLoading(true); setItems([]); setError(null);
      try {
        const list = await listWikiRecordings(window, wiki.manageUrl!, AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]));
        if (!abort.signal.aborted && current === revision) setItems(list);
      } catch (cause) {
        if (!abort.signal.aborted && current === revision) setError(cause);
      } finally {
        if (!abort.signal.aborted && current === revision) setLoading(false);
      }
    };
    void load();
    window.addEventListener('focus', load); window.addEventListener('ai-context-toolbar:wiki-auth-changed', load);
    return () => { abort.abort(); window.removeEventListener('focus', load); window.removeEventListener('ai-context-toolbar:wiki-auth-changed', load); };
  }, [wiki.manageUrl, retry]);
  const visible = items.filter(item => item.title.toLocaleLowerCase(dateLocale(locale)).includes(query.trim().toLocaleLowerCase(dateLocale(locale))));
  return <div className="wiki-recording-picker" aria-busy={loading}>
    {loading ? <p className="empty" role="status">{t('Cargando grabaciones…')}</p>
      : error ? <>
        <p className="empty" role={error instanceof WikiRecordingError && error.code === 'auth' ? 'status' : 'alert'}>{wikiRecordingErrorMessage(error, locale)}</p>
        {error instanceof WikiRecordingError && error.code === 'auth' ? <WikiSignIn wiki={wiki} locale={locale} />
          : <button type="button" className="text-button" disabled={disabled} onClick={() => setRetry(value => value + 1)}>{t('Volver a intentar')}</button>}
      </> : <>
        {items.length > 5 && <label className="field">{t('Buscar grabaciones')}<input type="search" value={query} maxLength={100} onChange={event => setQuery(event.target.value)} /></label>}
        {visible.length ? <ul className="wiki-recording-list" aria-label={t('Grabaciones disponibles')}>
          {visible.map(item => <li key={item.id}><button type="button" className="wiki-recording-choice" disabled={disabled} aria-label={t('Cargar grabación: {title}', { title: item.title })} onClick={() => onChoose(item)}>
            <Icon name="record" /><span><strong>{item.title}</strong><small>{item.author && <>{item.author} · </>}<time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleString(dateLocale(locale), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></small></span><Icon name="arrow" />
          </button></li>)}
        </ul> : <p className="empty">{t(items.length ? 'Ninguna grabación coincide con la búsqueda.' : 'Todavía no hay grabaciones guardadas en este proyecto.')}</p>}
        {items.length > 0 && <p className="subtle wiki-recording-copy-note">{t('Se añade una copia local con fechas de importación. La original de Toolkit no cambia.')}</p>}
      </>}
  </div>;
}
