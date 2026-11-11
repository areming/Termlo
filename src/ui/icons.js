/*
 * Termlo 2.0 icon set.
 *
 * Rules: 24×24 grid, 2px keyline padding, single 1.75 stroke, round caps and
 * joins, no fills except the few dot glyphs (r = 1). Color always follows
 * currentColor, size follows the .icon class (tokens --icon-sm/md/lg).
 */

const SHAPES = {
  // Navigation
  host:
    '<rect x="3" y="4" width="18" height="7" rx="2"/>' +
    '<rect x="3" y="13" width="18" height="7" rx="2"/>' +
    '<path d="M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6"/>',
  terminal:
    '<rect x="3" y="4" width="18" height="16" rx="2"/>' +
    '<path d="M7 9l3 3-3 3M13 15h4"/>',
  folder:
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  assistant:
    '<path d="M11 4l1.8 4.7L17.5 10.5l-4.7 1.8L11 17l-1.8-4.7L4.5 10.5l4.7-1.8z"/>' +
    '<path d="M18.5 15v5M16 17.5h5"/>',
  settings:
    '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/>' +
    '<circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',

  // Top bar
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.4-4.4"/>',
  sun:
    '<circle cx="12" cy="12" r="4"/>' +
    '<path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
  moon: '<path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z"/>',

  // Actions
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  'chevron-down': '<path d="M6 9l6 6 6-6"/>',
  'chevron-up': '<path d="M6 15l6-6 6 6"/>',
  'chevron-right': '<path d="M9 6l6 6-6 6"/>',
  'chevron-left': '<path d="M15 6l-6 6 6 6"/>',
  'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
  send: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  more:
    '<circle cx="6" cy="12" r="1" fill="currentColor"/>' +
    '<circle cx="12" cy="12" r="1" fill="currentColor"/>' +
    '<circle cx="18" cy="12" r="1" fill="currentColor"/>',
  edit: '<path d="M4 20h4L18.5 9.5a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  trash:
    '<path d="M4 7h16M10 11v6M14 11v6"/>' +
    '<path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/>' +
    '<path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  copy:
    '<rect x="9" y="9" width="11" height="11" rx="2"/>' +
    '<path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/>',
  refresh:
    '<path d="M19.5 10A8 8 0 0 0 5.2 7.5M4.5 14a8 8 0 0 0 14.3 2.5"/>' +
    '<path d="M4.5 4v4h4M19.5 20v-4h-4"/>',
  upload: '<path d="M12 15V4M7 9l5-5 5 5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  clipboard:
    '<rect x="6" y="4" width="12" height="17" rx="2"/>' +
    '<path d="M9.5 4V3.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V4M9 10h6M9 14h4"/>',
  'folder-plus':
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>' +
    '<path d="M12 10.5v5M9.5 13h5"/>',
  power: '<path d="M12 3v8"/><path d="M7 6.3a7.5 7.5 0 1 0 10 0"/>',
  import:
    '<path d="M14 3H7a2 2 0 0 0-2 2v3M5 16v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5v5h5"/>' +
    '<path d="M2 12h10M9 9l3 3-3 3"/>',
  'folder-upload':
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>' +
    '<path d="M12 16v-5.5M9.5 13l2.5-2.5 2.5 2.5"/>',
  jump:
    '<circle cx="5" cy="18" r="2"/><circle cx="19" cy="6" r="2"/>' +
    '<path d="M7 18h2.5a3.5 3.5 0 0 0 3.5-3.5v-5A3.5 3.5 0 0 1 16.5 6H17"/>',
  play: '<path d="M7 5v14l11-7z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  external:
    '<path d="M14 4h6v6M20 4l-9 9"/>' +
    '<path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  link:
    '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/>' +
    '<path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  'view-grid':
    '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/>' +
    '<rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  'view-list': '<path d="M9 6h11M9 12h11M9 18h11M4 6h1M4 12h1M4 18h1"/>',

  // Status
  'status-success': '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
  'status-error': '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
  'status-warning':
    '<path d="M10.3 4.9L2.8 18a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.9a2 2 0 0 0-3.4 0z"/>' +
    '<path d="M12 10v4M12 17.5h.01"/>',
  'status-info': '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5h.01"/>',
  question:
    '<circle cx="12" cy="12" r="9"/>' +
    '<path d="M9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.9-.9 1.5v.4M12 16.8h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',

  // Objects
  plan:
    '<rect x="5" y="4" width="14" height="17" rx="2"/>' +
    '<path d="M9 3h6v3H9zM9 11h6M9 15h4"/>',
  file:
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>' +
    '<path d="M14 3v5h5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8.5-8.5M16 7l3 3M14 9l2 2"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  eye:
    '<path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7S2.5 12 2.5 12z"/>' +
    '<circle cx="12" cy="12" r="3"/>',
  activity: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  attach:
    '<path d="M20 11.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8-8a3.3 3.3 0 0 1 4.7 4.7l-8 8a1.7 1.7 0 0 1-2.4-2.4L14.8 7"/>',
};

const SIZE_CLASS = { sm: 'icon-sm', md: '', lg: 'icon-lg' };

/**
 * Returns an inline SVG string.
 * Decorative by default (aria-hidden). Pass { label } when the icon is the
 * only carrier of meaning and there is no surrounding text or aria-label.
 */
export function icon(name, { size = 'md', label = '', className = '' } = {}) {
  const shape = SHAPES[name];
  if (!shape) throw new Error(`Unknown icon: ${name}`);
  const classes = ['icon', SIZE_CLASS[size] || '', className].filter(Boolean).join(' ');
  const a11y = label
    ? `role="img" aria-label="${escapeAttribute(label)}"`
    : 'aria-hidden="true" focusable="false"';
  return (
    `<svg class="${classes}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ${a11y}>${shape}</svg>`
  );
}

export function iconNames() {
  return Object.keys(SHAPES);
}

/** Replaces every <span data-icon="name" data-icon-size="sm"> under root. */
export function hydrateIcons(root = document) {
  for (const slot of root.querySelectorAll('[data-icon]')) {
    slot.outerHTML = icon(slot.dataset.icon, {
      size: slot.dataset.iconSize || 'md',
      className: slot.className,
    });
  }
}

function escapeAttribute(value) {
  return String(value).replace(/[&"<>]/g, (char) => `&#${char.charCodeAt(0)};`);
}
