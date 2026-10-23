import type { CSSProperties } from 'react';
import type { AnnotationContext } from '../core/types.js';

const palette = ['#ff7048', '#ffce38', '#ff62aa', '#b184ff', '#7185ff', '#ff9b38', '#f65c78', '#dd8bff'];
function vividColor(position: number): string {
  const angle = (position * 137.508) % 200, hue = angle <= 65 ? angle : angle + 160;
  const chroma = .648, base = .316;
  const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
  const channels = hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0]
    : hue < 240 ? [0, x, chroma] : hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
  return '#' + channels.map(value => Math.round((value + base) * 255).toString(16).padStart(2, '0')).join('');
}
export function nextMarkColor(used: ReadonlySet<string>): string {
  for (const color of palette) if (!used.has(color)) return color;
  for (let index = 1; ; index++) { const color = vividColor(index); if (!used.has(color)) return color; }
}
export function markColor(mark: AnnotationContext): string { return mark.color ?? palette[0]!; }
export function markStyle(color: string): CSSProperties { return { '--mark-color': color } as CSSProperties; }
/** Retain a mark's assigned color after deleting another mark or changing routes. */
export function assignMarkColors(marks: AnnotationContext[]): AnnotationContext[] {
  const used = new Set(marks.flatMap(mark => mark.color ? [mark.color] : []));
  return marks.map(mark => {
    if (mark.color) return mark;
    const color = nextMarkColor(used); used.add(color); return { ...mark, color };
  });
}
