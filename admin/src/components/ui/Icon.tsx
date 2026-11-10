import type { IconName } from "../../lib/icon-names";
export type { IconName } from "../../lib/icon-names";


interface IconProps {
  className?: string;
  // Local preview controls do not extend the persisted navigation icon vocabulary.
  name: IconName | "smartphone";
}

const paths: Record<IconProps["name"], JSX.Element> = {
  refresh: <><path d="M20 7a9 9 0 0 0-15-2L2 8m0-5v5h5M4 17a9 9 0 0 0 15 2l3-3m0 5v-5h-5" /></>,
  "page": <><rect x="5" y="3" width="14" height="18" rx="1" /><path d="M8 7h8M8 11h8M8 15h5" /></>,
  "pen-square": <><path d="M12 4H4v16h16v-8M14 5l5-3 3 3-12 12-4 1 1-4Z" /></>,
  "stack": <><rect x="3" y="7" width="14" height="14" rx="1" /><path d="M7 3h14v14M7 11h6M7 15h6" /></>,
  "history": <><path d="M3 11a9 9 0 1 1 2 7M3 5v6h6M12 7v5l3 2" /></>,
  "book": <><path d="M12 6c-3-3-7-3-10-2v15c4-1 7 0 10 2 3-2 6-3 10-2V4c-3-1-7-1-10 2Zm0 0v15" /></>,
  save: <><path d="M4 3h13l4 4v14H3V3h1Z" /><path d="M7 3v6h10V3M7 21v-8h10v8" /></>,
  monitor: <><rect x="2" y="3" width="20" height="14" rx="1" /><path d="M12 17v4M7 21h10" /></>,
  smartphone: <><rect x="6" y="2" width="12" height="20" rx="2" /><path d="M11 18h2" /></>,
  outline: <><path d="M8 5h13M8 12h13M8 19h13" /><rect x="2" y="3" width="3" height="4" /><rect x="2" y="10" width="3" height="4" /><rect x="2" y="17" width="3" height="4" /></>,
  chart: <><path d="M3 3v18h19M7 17v-6M12 17V7M17 17V4" /></>,
  "table-row": <><rect x="3" y="3" width="18" height="12" rx="1" /><path d="M3 9h18M9 3v12M15 3v12M9 20h6m-3-3v6" /></>,
  "table-column": <><rect x="3" y="3" width="12" height="18" rx="1" /><path d="M9 3v18M3 9h12M3 15h12M20 9v6m-3-3h6" /></>,
  upload: <path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6" />,
  download: <path d="M12 3v13m-5-5 5 5 5-5M4 15v6h16v-6" />,
  home: <path d="m3 10 9-7 9 7v11h-6v-7H9v7H3z" />,
  play: <path d="m7 3 14 9-14 9z" />,
  video: <><rect x="3" y="5" width="12" height="14" rx="2" /><path d="m15 9 6-4v14l-6-4" /></>,
  heart: <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" />,
  "heart-off": (
    <>
      <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" />
      <path d="M4 4 20 20" />
    </>
  ),
  "external-link": <><path d="M14 3h7v7M21 3l-11 11M10 3H3v18h18v-7" /></>,
  "help-circle": <><circle cx="12" cy="12" r="9" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4M12 17h.01" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></>,
  flag: <path d="M4 22V3c5-4 11 4 16 0v12c-5 4-11-4-16 0" />,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>,
  activity: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2M7 4.5 4.5 7" />
    </>
  ),
  "arrow-down": <path d="M12 5v14m-6-6 6 6 6-6" />,
  "arrow-left": <path d="m14 7-5 5 5 5M9 12h10" />,
  "arrow-right": <path d="m10 7 5 5-5 5M5 12h10" />,
  "arrow-up": <path d="M12 19V5m-6 6 6-6 6 6" />,
  bold: (
    <>
      <path d="M7 5h6a4 4 0 0 1 0 8H7z" />
      <path d="M7 13h7a3 3 0 0 1 0 6H7z" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M7 3v4M17 3v4M3 10h18M7 14h2M11 14h2M15 14h2M7 18h2M11 18h2" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  "chevron-left": <path d="m14 7-5 5 5 5" />,
  "chevron-right": <path d="m10 7 5 5-5 5" />,
  "chevron-down": <path d="m7 10 5 5 5-5" />,
  "chevron-up": <path d="m7 14 5-5 5 5" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  code: <path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14" />,
  content: (
    <>
      <path d="M5 4h14v16H5z" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </>
  ),
  dashboard: (
    <>
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
      <rect x="14" y="14" width="6" height="6" rx="1" />
    </>
  ),
  file: (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v5h4M9 12h6M9 16h6" />
    </>
  ),
  folder: <path d="M3 6.5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  grip: (
    <>
      <circle cx="9" cy="6" r="1.1" />
      <circle cx="15" cy="6" r="1.1" />
      <circle cx="9" cy="12" r="1.1" />
      <circle cx="15" cy="12" r="1.1" />
      <circle cx="9" cy="18" r="1.1" />
      <circle cx="15" cy="18" r="1.1" />
    </>
  ),
  image: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m5 17 5-5 4 4 2-2 3 3" />
    </>
  ),
  italic: <path d="M10 5h7M7 19h7M14 5 10 19" />,
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" />
      <path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1" />
    </>
  ),
  list: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="M4 6h.01M4 12h.01M4 18h.01" />
    </>
  ),
  "list-ordered": (
    <>
      <path d="M10 6h10M10 12h10M10 18h10" />
      <path d="M4 5h2v3M4 11h2l-2 3h2M4 17h2l-2 3h2" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  media: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8" cy="9" r="1.5" />
      <path d="m4 17 5-5 4 4 2-2 5 4" />
    </>
  ),
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 6 9 7 9-7" /></>,
  microphone: (
    <>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
    </>
  ),
  pause: <><path d="M9 5v14M15 5v14" /></>,
  pin: <><path d="M8 3h8l-1 6 3 3v2H6v-2l3-3z" /><path d="M12 14v7" /></>,
  "panel-left": (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </>
  ),
  "panel-right": (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </>
  ),
  pencil: (
    <>
      <path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10z" />
      <path d="m14.5 7.5 3 3M4 20l1-4" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  quote: <path d="M6 8h5v5H7a4 4 0 0 1-4 4M15 8h5v5h-4a4 4 0 0 1-4 4" />,
  queue: (
    <>
      <path d="M8 6h12M8 12h12M8 18h12" />
      <path d="M4 6h.01M4 12h.01M4 18h.01" />
    </>
  ),
  redo: <path d="m16 7 4 4-4 4M20 11h-8a7 7 0 0 0-7 7" />,
  remove: <path d="M5 12h14" />,
  // A gear: hub, rim, and six teeth on the rim. The earlier drawing was a hub with eight free
  // rays and no rim, which reads as a sun at toolbar size and left the control leaning on its
  // tooltip (issue #1043). The rim is what separates a gear from a sun at 20 pixels.
  settings: (
    <>
      <circle cx="12" cy="12" r="2.6" />
      <circle cx="12" cy="12" r="6.4" />
      <path d="M18.4 12h2.8M5.6 12H2.8M15.2 17.54l1.4 2.43M8.8 17.54l-1.4 2.43M15.2 6.46l1.4-2.43M8.8 6.46l-1.4-2.43" />
    </>
  ),
  "sign-out": (
    <>
      <path d="M10 5H5v14h5M14 8l4 4-4 4M8 12h10" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7h6M14 7h6M4 17h10M18 17h2" />
      <circle cx="12" cy="7" r="2" />
      <circle cx="16" cy="17" r="2" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13" />
      <path d="M10 11v5M14 11v5" />
    </>
  ),
  undo: <path d="m8 7-4 4 4 4M4 11h8a7 7 0 0 1 7 7" />,
  eye: (
    <>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  "eye-off": (
    <>
      <path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.8 5.2A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-2 2.8M6.2 6.2C3.5 8 2 12 2 12s4 7 10 7a10 10 0 0 0 4.2-.9" />
    </>
  ),
  users: (
    <>
      <path d="M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 20v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  // Media library controls.
  grid: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </>
  ),
  tag: <><path d="M3 11.5V4h7.5l9.5 9.5-7.5 7.5z" /><path d="M7.5 8.5h.01" /></>,
  "check-square": <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="m8 12 3 3 5-6" /></>,
  ellipsis: (
    <>
      <circle cx="5" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="19" cy="12" r="1.2" />
    </>
  ),
  filter: <path d="M3 5h18l-7 8v6l-4 2v-8z" />,
  "folder-plus": (
    <>
      <path d="M3 6.5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M12 10v6M9 13h6" />
    </>
  ),
  columns: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9.5h18M3 14.5h18M9 9.5V20" /></>,
  sort: <path d="M8 4v16m-4-4 4 4 4-4M16 20V4m-4 4 4-4 4 4" />,
  maximize: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  resize: (
    <>
      <circle cx="12" cy="6" r="1.1" />
      <circle cx="12" cy="12" r="1.1" />
      <circle cx="12" cy="18" r="1.1" />
    </>
  ),
};

export function Icon({ className, name }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className ? `icon ${className}` : "icon"}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
    >
      {paths[name]}
    </svg>
  );
}
