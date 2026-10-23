'use client';
import { useEffect, useRef, useState } from 'react';
import type { ToolbarWiki } from '../core/types.js';
import type { ToolbarLocale } from '../core/locale.js';
import { createTranslator } from '../core/locale.js';
import { Icon } from './icons.js';

export function WikiSignIn({ wiki, locale }: { wiki: ToolbarWiki; locale: ToolbarLocale }) {
  const t = createTranslator(locale), dialog = useRef<HTMLDialogElement>(null), frame = useRef<HTMLIFrameElement>(null);
  const [nonce, setNonce] = useState('');
  useEffect(() => {
    if (!nonce || !wiki.manageUrl) return;
    const current = dialog.current;
    current?.showModal();
    const receive = (event: MessageEvent) => {
      if (event.origin !== new URL(wiki.manageUrl!).origin || event.source !== frame.current?.contentWindow
        || event.data?.type !== 'toolkit:wiki-authenticated' || event.data.nonce !== nonce) return;
      current?.close(); setNonce('');
      window.dispatchEvent(new Event('ai-context-toolbar:wiki-auth-changed'));
    };
    window.addEventListener('message', receive);
    return () => { window.removeEventListener('message', receive); if (current?.open) current.close(); };
  }, [nonce, wiki.manageUrl]);
  if (!wiki.manageUrl) return null;
  const url = `${wiki.manageUrl}/login?${new URLSearchParams({ app_origin: typeof window === 'undefined' ? '' : window.location.origin, nonce })}`;
  return <>
    <button className="text-button" type="button" onClick={() => setNonce(Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''))}>{t('Iniciar sesión en Aside')}</button>
    {nonce && <dialog className="wiki-sign-in" ref={dialog} aria-label={t('Iniciar sesión en Aside')} onCancel={() => setNonce('')}>
      <header><span>Aside</span><button className="icon-button" type="button" aria-label={t('Cerrar')} onClick={() => setNonce('')}><Icon name="close" /></button></header>
      <iframe ref={frame} title={t('Formulario de inicio de sesión de la wiki')} src={url} referrerPolicy="no-referrer" />
    </dialog>}
  </>;
}
