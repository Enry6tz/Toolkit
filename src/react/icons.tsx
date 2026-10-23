import type { CSSProperties } from 'react';

export type IconName =
  | 'menu'
  | 'context'
  | 'select'
  | 'capture'
  | 'test'
  | 'design'
  | 'report'
  | 'arrow'
  | 'back'
  | 'close'
  | 'guide'
  | 'check'
  | 'copy'
  | 'download'
  | 'shield'
  | 'record'
  | 'stop'
  | 'history'
  | 'edit'
  | 'trash'
  | 'network'
  | 'network-off'
  | 'pin'
  | 'pin-off'
  | 'more'
  | 'move'
  | 'play'
  | 'plus'
  | 'minus'
  | 'cloud'
  | 'chat';
const paths: Record<IconName, string> = {
  minus: 'M5 12h14',
  cloud: 'M7 18h10a4 4 0 0 0 .6-8A6 6 0 0 0 6 8.5 4.8 4.8 0 0 0 7 18Zm5-4V8m-3 3 3-3 3 3',
  menu: 'M5 7h14M5 12h14M5 17h14',
  context:
    'M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3M8 8h8v8H8z',
  select: 'm5 3 14 10-7 1-3 7L5 3Z',
  capture:
    'M4 6h4l2-3h4l2 3h4a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Zm12 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  test: 'm9 3 6 0M10 3v6L4 19a1.3 1.3 0 0 0 1 2h14a1.3 1.3 0 0 0 1-2L14 9V3M8 14h8',
  design: 'm15 3 6 6-11 11-7 1 1-7L15 3ZM12 6l6 6M4 14l6 6',
  report: 'M6 21V3h13l-3 5 3 5H6',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  back: 'M19 12H5m5-5-5 5 5 5',
  close: 'm6 6 12 12M6 18 18 6',
  guide: 'M4 4h6l2 2 2-2h6v15h-6l-2 2-2-2H4V4Zm8 2v15',
  check: 'm5 12 4 4L19 6',
  copy: 'M9 9h12v12H9V9ZM15 5V3H3v12h2',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  shield: 'm12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6l8-3Zm-4 9 3 3 5-6',
  record:
    'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  stop: 'M5 5h14v14H5V5Z',
  history: 'M3 11a9 9 0 1 1 2 7M3 4v7h7m2-4v6l4 2',
  edit: 'm15 4 5 5M4 20l4-1L20 7a2 2 0 0 0-4-4L4 16v4Z',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6',
  network: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c4 5 4 13 0 18-4-5-4-13 0-18Z',
  'network-off': 'M9.5 3.4A9 9 0 0 1 20.6 14.5M18.4 18.4A9 9 0 0 1 5.6 5.6M3 12h9m4 0h5M12 3c2 2.5 3 5.5 3 9m-3 9c-3.5-4.4-3.9-10.1-1.2-14.7M3 3l18 18',
  pin: 'M12 17v5M9 3h6M10 3v7l-3 3v3h10v-3l-3-3V3',
  'pin-off': 'M12 17v5M9 3h6m-1 0v6M10 10l-3 3v3h9M3 3l18 18',
  more: 'M13 5a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM13 12a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM13 19a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z',
  move: 'M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3',
  play: 'm8 4 12 8-12 8V4Z',
  plus: 'M12 5v14M5 12h14',
  chat: 'M21 12a8 8 0 0 1-8 8H7l-4 2V6a3 3 0 0 1 3-3h7a8 8 0 0 1 8 9ZM7 8h9M7 12h7',
};
export function Icon({
  name,
  style,
}: {
  name: IconName;
  style?: CSSProperties;
}) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}
