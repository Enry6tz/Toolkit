'use client';
import { useId, useState } from 'react';
import type { ToolbarLocale } from '../core/locale.js';
import { recordingQuality, recordingQualityText } from '../review/recording-quality.js';

/** Counters only: no request URLs, body text or inferred application outcome. */
export function RecordingQualityNotice({ source, locale }: { source: unknown; locale: ToolbarLocale }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const quality = recordingQuality(source);
  const text = quality && recordingQualityText(quality, locale);
  if (!text?.limited) return null;
  return <span className="recording-quality" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
  }}>
    <button type="button" className="recording-quality-trigger" aria-expanded={open} aria-controls={id}
      aria-describedby={open ? id : undefined} onClick={() => setOpen(value => !value)}>
      <span className="recording-quality-symbol" aria-hidden="true">i</span>
      {text.summary.charAt(0).toLocaleUpperCase(locale) + text.summary.slice(1)}
    </button>
    <span id={id} className="recording-quality-detail" hidden={!open}>
      <strong>{text.label}</strong><span>{text.detail}</span>
    </span>
  </span>;
}
