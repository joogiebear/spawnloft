'use strict';
/*
  Kit: makers for the shared building blocks (src/panel/tailwind/components.css).

  Each maker returns an element with the classes, the roles and the ARIA already on it, so a page
  says what it wants ("a primary button that says Start") and not how one is drawn. Plain DOM, no
  framework, one global; the page scripts after it can use it as they use $ and icon().

  /components in a development build shows every block made here, in every state.
*/
const Kit = (() => {
  /** An element: h('div', { class: 'x', onclick: fn, 'aria-label': 'y' }, child, 'text', ...). */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key.startsWith('on')) {
        // Only a function: a string here would become an inline handler, which is code from data.
        if (typeof value === 'function') el.addEventListener(key.slice(2), value);
      } else if (key in el && typeof value !== 'string') el[key] = value;
      // aria-* and data-* read "true"; a bare attribute (disabled, hidden) is present or not.
      else el.setAttribute(key, value === true ? (/^(aria|data)-/.test(key) ? 'true' : '') : String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child == null || child === false) continue;
      el.append(child instanceof Node ? child : String(child));
    }
    return el;
  }

  const classes = (...names) => names.filter(Boolean).join(' ');

  /** A glyph from the page's sprite (<symbol id="i-name">). Decoration: its words are beside it. */
  function icon(name, extra) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', classes('sl-ico', extra));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
  }

  /**
   * A button. kind: primary | secondary (the default) | ghost | danger | link.
   * size: sm | md | lg. With no label it is an icon button, and `title` names it.
   */
  function button({ label, icon: glyph, kind = 'secondary', size = 'md', title, onClick, type = 'button', disabled, id, pressed } = {}) {
    const iconOnly = !label;
    if (iconOnly && !title) console.warn('Kit.button: an icon button needs a title to be named');
    const el = h('button', {
      type,
      id,
      class: classes('sl-btn', kind !== 'secondary' && 'sl-btn-' + kind, size !== 'md' && 'sl-btn-' + size, iconOnly && 'sl-btn-icon'),
      title: title || null,
      'aria-label': iconOnly ? title : null,
      'aria-pressed': pressed == null ? null : String(Boolean(pressed)),
      disabled: Boolean(disabled),
      onclick: onClick,
    }, glyph ? icon(glyph) : null, label);
    return el;
  }

  /** Working, or done: the label stays and a spinner stands in for the icon. */
  function busy(el, on) {
    if (on) {
      el.setAttribute('aria-busy', 'true');
      // Twice in a row must not record the first call's own disabling.
      if (!('wasDisabled' in el.dataset)) el.dataset.wasDisabled = el.disabled ? '1' : '';
      el.disabled = true;
    } else {
      el.removeAttribute('aria-busy');
      el.disabled = el.dataset.wasDisabled === '1';
      delete el.dataset.wasDisabled;
    }
    return el;
  }

  let ids = 0;
  const nextId = (stem) => stem + '-' + (++ids);

  /**
   * A label, its control, and one line under it: the hint, or the reason the value was refused.
   * The control is described by whichever line is showing.
   */
  function field({ label, control, hint, error, id } = {}) {
    // a box inside a group (a glyph before it, a caret after) is the control the label names
    const box = control.matches('input, select, textarea') ? control : control.querySelector('input, select, textarea') || control;
    const controlId = box.id || (box.id = id || nextId('sl-field'));
    const hintEl = hint ? h('p', { class: 'sl-hint', id: controlId + '-hint', text: hint }) : null;
    const errorEl = h('p', { class: 'sl-error', id: controlId + '-error', role: 'alert', text: error || '', hidden: !error });
    const el = h('div', { class: 'sl-field' }, h('label', { class: 'sl-label', for: controlId, text: label }), control, hintEl, errorEl);
    const describe = () => {
      const by = [hintEl && !hintEl.hidden && hintEl.id, !errorEl.hidden && errorEl.id].filter(Boolean).join(' ');
      if (by) box.setAttribute('aria-describedby', by);
      else box.removeAttribute('aria-describedby');
    };
    /** Say why the value was refused, or clear it with nothing. */
    el.setError = (message) => {
      errorEl.textContent = message || '';
      errorEl.hidden = !message;
      if (hintEl) hintEl.hidden = Boolean(message);
      if (message) box.setAttribute('aria-invalid', 'true');
      else box.removeAttribute('aria-invalid');
      describe();
    };
    el.setError(error);
    return el;
  }

  /** A one-line text box. mono for paths, addresses and commands; lead is a glyph or a word inside it. */
  function input({ value = '', placeholder, mono, type = 'text', name, id, lead, disabled, label } = {}) {
    const box = h('input', {
      class: classes('sl-input', mono && 'sl-input-mono'), type, name, id, placeholder,
      value, disabled: Boolean(disabled), autocomplete: 'off', spellcheck: mono ? 'false' : null,
      'aria-label': label || null,
    });
    if (!lead) return box;
    const leadEl = h('span', { class: 'sl-input-lead', 'aria-hidden': 'true' }, typeof lead === 'string' && lead.length > 1 ? icon(lead) : lead);
    return h('span', { class: 'sl-input-group' }, leadEl, box);
  }

  function textarea({ value = '', placeholder, mono, rows = 4, id, name } = {}) {
    return h('textarea', { class: classes('sl-input', mono && 'sl-input-mono'), placeholder, rows, id, name, text: value });
  }

  /** A drop-down. options: [{ value, label }] or plain strings. */
  function select({ options = [], value, id, name, label } = {}) {
    const box = h('select', { class: 'sl-input', id, name, 'aria-label': label || null },
      options.map((o) => {
        const opt = typeof o === 'string' ? { value: o, label: o } : o;
        return h('option', { value: opt.value, text: opt.label, selected: opt.value === value });
      }));
    return h('span', { class: 'sl-input-group' }, box, h('span', { class: 'sl-input-caret', 'aria-hidden': 'true' }, icon('caret')));
  }

  /** A check box, a radio or a switch, with its words: { label, note } makes the label two lines. */
  function choice(kind, { label, note, checked, name, value, disabled, onChange } = {}) {
    const box = h('input', {
      type: kind === 'radio' ? 'radio' : 'checkbox',
      class: 'sl-' + kind,
      role: kind === 'switch' ? 'switch' : null,
      name, value, checked: Boolean(checked), disabled: Boolean(disabled),
      onchange: onChange,
    });
    const words = note
      ? h('span', { class: 'sl-choice-text' }, h('span', { text: label }), h('small', { text: note }))
      : h('span', { class: 'sl-choice-text', text: label });
    return h('label', { class: 'sl-choice' }, box, words);
  }
  const checkbox = (o) => choice('check', o);
  const radio = (o) => choice('radio', o);
  const toggle = (o) => choice('switch', o);

  /**
   * One of a few, all in view: { label, options: [{ value, label, count, tone }], value, onChange }.
   * Each is a button with aria-pressed; the group is named for a screen reader.
   */
  function segmented({ label, options, value, onChange } = {}) {
    const el = h('span', { class: 'sl-seg', role: 'group', 'aria-label': label });
    const draw = (picked) => {
      for (const b of el.children) b.setAttribute('aria-pressed', String(b.dataset.value === String(picked)));
    };
    for (const o of options) {
      el.append(h('button', {
        type: 'button', dataset: { value: o.value },
        onclick: () => { draw(o.value); if (onChange) onChange(o.value); },
      }, o.label, o.count != null ? count(o.count, o.tone) : null));
    }
    draw(value);
    el.setValue = draw;
    return el;
  }

  /** A state in a word: tone live | warn | fault | accent | (none, idle). busy makes its dot breathe. */
  function pill({ text, tone, busy: working } = {}) {
    return h('span', { class: 'sl-pill', dataset: tone ? { tone } : null }, dot({ tone, busy: working }), text);
  }

  /**
   * A state as a dot. With a label it is announced; without, it is decoration beside words.
   * hollow is a ring: stopped, so that stopped and running differ in shape and not only in colour.
   */
  function dot({ tone, label, busy: working, hollow } = {}) {
    const el = h('span', { class: 'sl-dot', dataset: tone ? { tone } : null });
    if (working) el.dataset.busy = '';
    if (hollow) el.dataset.hollow = '';
    if (label) { el.setAttribute('role', 'img'); el.setAttribute('aria-label', label); } else el.setAttribute('aria-hidden', 'true');
    return el;
  }

  function count(n, tone) {
    return h('span', { class: 'sl-count', dataset: tone ? { tone } : null, text: String(n) });
  }

  /**
   * Which of the six tile colours a key gets: the same one everywhere, every time. Pass a
   * server's id (its folder name), not its label, so renaming it does not change its colour.
   */
  function tileTone(key) {
    // FNV-1a: spreads short, similar names across the six better than a plain sum does
    let hash = 0x811c9dc5;
    for (const ch of String(key || '')) hash = Math.imul(hash ^ ch.codePointAt(0), 0x01000193) >>> 0;
    return (hash % 6) + 1;
  }

  /** The letter on a tile: the first letter or digit of the name, else "?". */
  function initial(name) {
    const m = /[\p{L}\p{N}]/u.exec(String(name || ''));
    return m ? m[0].toLocaleUpperCase() : '?';
  }

  /**
   * A server's face: { name, key, image, icon, size: sm | md | lg, plain }. image is its own
   * server-icon.png; else an icon (a database's glyph) or its initial, on its own colour. Always
   * decoration: the name is written beside it.
   */
  function tile({ name, key, image, icon: glyph, size = 'md', plain } = {}) {
    const el = h('span', {
      class: classes('sl-tile', size !== 'md' && 'sl-tile-' + size),
      'aria-hidden': 'true',
      dataset: { tone: plain || glyph ? 'plain' : String(tileTone(key || name)) },
    });
    if (image) {
      const img = h('img', { src: image, alt: '' });
      // a broken image is the initial again, not a broken-image glyph
      img.onerror = () => { img.remove(); el.textContent = initial(name); };
      el.append(img);
    } else if (glyph) el.append(icon(glyph));
    else el.textContent = initial(name);
    return el;
  }

  /** A box for a group: { compact, tone, children }. */
  function card({ compact, tone, label } = {}, ...children) {
    return h('section', { class: classes('sl-card', compact && 'sl-card-compact'), dataset: tone ? { tone } : null, 'aria-label': label || null }, ...children);
  }

  /** A live number: { label, value, unit, small }. */
  function stat({ label, value, unit, small } = {}) {
    return h('div', { class: classes('sl-stat', small && 'sl-stat-sm') },
      h('span', { class: 'sl-eyebrow', text: label }),
      h('span', { class: 'sl-stat-value' }, value == null ? '—' : String(value), unit ? h('span', { class: 'sl-stat-unit', text: unit }) : null));
  }

  const eyebrow = (text, tag = 'h2') => h(tag, { class: 'sl-eyebrow', text });

  /** A page's head: { title, lede, actions: [elements] }. */
  function pageHead({ title, lede, actions } = {}) {
    return h('div', { class: 'sl-page-head' },
      h('div', null, h('h1', { class: 'sl-page-title', text: title }), lede ? h('p', { class: 'sl-page-lede', text: lede }) : null),
      actions && actions.length ? h('div', { class: 'sl-page-actions' }, actions) : null);
  }

  /**
   * A row: { lead (a tile or icon), title, meta, end (elements), onClick, href }. With onClick or
   * href the whole row is the control.
   */
  function row({ lead, title, meta, end, onClick, href } = {}) {
    const tag = href ? 'a' : onClick ? 'button' : 'div';
    return h(tag, { class: 'sl-row', href, type: tag === 'button' ? 'button' : null, onclick: onClick },
      lead || null,
      h('span', { class: 'sl-row-main' }, h('span', { class: 'sl-row-title', text: title }), meta ? h('span', { class: 'sl-row-meta', text: meta }) : null),
      end ? h('span', { class: 'sl-row-end' }, end) : null);
  }

  /** Rows in a box. */
  function list(rows, label) {
    // A row that is a button or a link keeps its own role: the list item wraps it.
    if (!label) return h('div', { class: 'sl-list' }, rows);
    return h('div', { class: 'sl-list', role: 'list', 'aria-label': label },
      rows.map((r) => (r.matches('button, a') ? h('div', { role: 'listitem' }, r) : (r.setAttribute('role', 'listitem'), r))));
  }

  /** columns: [{ key, label, num }]; rows: [{ key: text or element }]. */
  function table({ columns, rows, caption } = {}) {
    return h('table', { class: 'sl-table' },
      caption ? h('caption', { class: 'sl-sr', text: caption }) : null,
      h('thead', null, h('tr', null, columns.map((c) => h('th', { scope: 'col', class: c.num ? 'sl-num' : null, text: c.label })))),
      h('tbody', null, rows.map((r) => h('tr', null, columns.map((c) => h('td', { class: c.num ? 'sl-num' : null }, r[c.key] instanceof Node ? r[c.key] : String(r[c.key] ?? '')))))));
  }

  /**
   * Tabs that choose what one panel shows: { label, items: [{ id, label, icon, count, tone }],
   * current, panel (the element they control), onSelect }. One Tab stop; Left and Right (and Home,
   * End) move along them and choose as they go, as tabs do.
   */
  function tabs({ label, items, current, panel, onSelect } = {}) {
    const el = h('div', { class: 'sl-tabs', role: 'tablist', 'aria-label': label });
    const buttons = items.map((item) => h('button', {
      type: 'button', role: 'tab', class: 'sl-tab', id: item.tabId || null,
      dataset: { tab: item.id },
      'aria-controls': panel ? (panel.id || (panel.id = nextId('sl-panel'))) : null,
      onclick: () => choose(item.id, true),
    }, item.icon ? icon(item.icon) : null, item.label, item.count ? count(item.count, item.tone) : null));
    el.append(...buttons);
    if (panel) panel.setAttribute('role', 'tabpanel');
    function draw(id) {
      // Something always holds the Tab stop: an id that matches nothing falls back to the first tab.
      const visible = buttons.filter((b) => !b.hidden);
      if (!visible.some((b) => b.dataset.tab === String(id))) id = visible[0] ? visible[0].dataset.tab : id;
      id = String(id);
      for (const b of buttons) {
        const on = b.dataset.tab === id;
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
      }
      if (panel) {
        const on = buttons.find((b) => b.dataset.tab === id);
        if (on) panel.setAttribute('aria-labelledby', on.id || (on.id = nextId('sl-tab')));
      }
    }
    function choose(id, said) {
      draw(id);
      if (said && onSelect) onSelect(id);
    }
    el.addEventListener('keydown', (e) => {
      const shown = buttons.filter((b) => !b.hidden);
      const at = shown.indexOf(document.activeElement);
      if (at < 0 || e.altKey || e.ctrlKey || e.metaKey) return;
      let to = null;
      if (e.key === 'ArrowRight') to = shown[(at + 1) % shown.length];
      else if (e.key === 'ArrowLeft') to = shown[(at - 1 + shown.length) % shown.length];
      else if (e.key === 'Home') to = shown[0];
      else if (e.key === 'End') to = shown[shown.length - 1];
      else return;
      e.preventDefault();
      to.focus();
      choose(to.dataset.tab, true);
    });
    draw(current);
    el.select = (id) => choose(id, false);
    return el;
  }

  /**
   * A sidebar row: { label, icon, tile, meta, status: { tone, label, busy }, current, onClick, href }.
   * With a tile it is the two-line row of a server or a database.
   */
  function navItem({ label, icon: glyph, tile: face, meta, status, current, onClick, href, id } = {}) {
    const rich = Boolean(face);
    return h(href ? 'a' : 'button', {
      class: classes('sl-nav-item', rich && 'sl-nav-item-rich'), id, href,
      type: href ? null : 'button',
      'aria-current': current ? 'page' : null,
      onclick: onClick,
    },
    glyph ? icon(glyph) : null,
    face || null,
    rich
      ? h('span', { class: 'sl-nav-text' }, h('span', { class: 'sl-nav-name', text: label }), meta ? h('span', { class: 'sl-nav-meta', text: meta }) : null)
      : h('span', { class: 'sl-nav-name', text: label }),
    status ? dot(status) : null);
  }

  /** A group heading in the sidebar, with an optional control at its end (a + button). */
  const navHead = (text, end) => h('div', { class: 'sl-nav-head' }, h('span', { text }), end || null);

  /**
   * A menu under a button: { label (the button's words), icon, kind, items: [{ label, note, tone,
   * onSelect, disabled } | 'sep'] }. Returns the wrapper; the button opens it, the arrow keys
   * walk it, Escape or a click outside closes it and gives focus back to the button.
   */
  function menu({ label, icon: glyph, kind = 'secondary', title, items } = {}) {
    const menuId = nextId('sl-menu');
    const opener = button({ label, icon: glyph, kind, title, size: 'md' });
    opener.setAttribute('aria-haspopup', 'menu');
    opener.setAttribute('aria-expanded', 'false');
    opener.setAttribute('aria-controls', menuId);
    const list = h('div', { class: 'sl-menu', role: 'menu', id: menuId, hidden: true });
    for (const item of items) {
      if (item === 'sep') { list.append(h('div', { class: 'sl-menu-sep', role: 'separator' })); continue; }
      list.append(h('button', {
        type: 'button', role: 'menuitem', class: 'sl-menu-item', tabindex: '-1',
        dataset: item.tone ? { tone: item.tone } : null,
        'aria-disabled': item.disabled ? 'true' : null,
        onclick: () => { if (item.disabled) return; close(true); if (item.onSelect) item.onSelect(); },
      }, h('span', { text: item.label }), item.note ? h('small', { text: item.note }) : null));
    }
    const wrap = h('span', { class: 'sl-menu-wrap' }, opener, list);
    const entries = () => [...list.querySelectorAll('[role="menuitem"]')];
    function open() {
      list.hidden = false;
      opener.setAttribute('aria-expanded', 'true');
      entries()[0]?.focus();
      document.addEventListener('pointerdown', outside, true);
    }
    function close(refocus) {
      list.hidden = true;
      opener.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', outside, true);
      if (refocus) opener.focus();
    }
    function outside(e) { if (!wrap.contains(e.target)) close(false); }
    opener.addEventListener('click', () => (list.hidden ? open() : close(true)));
    list.addEventListener('keydown', (e) => {
      const all = entries();
      if (!all.length && e.key !== 'Escape' && e.key !== 'Tab') return;
      const at = all.indexOf(document.activeElement);
      let to = null;
      if (e.key === 'ArrowDown') to = all[(at + 1) % all.length];
      else if (e.key === 'ArrowUp') to = all[(at - 1 + all.length) % all.length];
      else if (e.key === 'Home') to = all[0];
      else if (e.key === 'End') to = all[all.length - 1];
      else if (e.key === 'Escape' || e.key === 'Tab') { if (e.key === 'Escape') e.preventDefault(); close(e.key === 'Escape'); return; }
      else return;
      e.preventDefault();
      to.focus();
    });
    wrap.open = open;
    wrap.close = close;
    return wrap;
  }

  /**
   * A dialog: { title, body (elements or text), actions: [buttons], sheet }. Returned closed; call
   * .showModal(). The head's close button closes it, as does Escape.
   */
  function dialog({ title, body, actions, sheet, label } = {}) {
    const titleId = nextId('sl-dialog');
    const close = button({ icon: 'close', kind: 'ghost', size: 'sm', title: 'Close', onClick: () => el.close() });
    const el = h('dialog', { class: classes('sl-dialog', sheet && 'sl-sheet'), 'aria-labelledby': titleId, 'aria-label': label || null },
      h('div', { class: 'sl-dialog-head' }, h('h2', { class: 'sl-dialog-title', id: titleId, text: title }), close),
      h('div', { class: 'sl-dialog-body' }, (Array.isArray(body) ? body : [body]).map((b) => (typeof b === 'string' ? h('p', { text: b }) : b))),
      actions && actions.length ? h('div', { class: 'sl-dialog-foot' }, actions) : null);
    return el;
  }

  /** A short message at the bottom right: tone live | fault | (none). Goes by itself unless stay. */
  function toast(message, { tone, stay } = {}) {
    let stack = document.querySelector('.sl-toasts');
    if (!stack) {
      stack = h('div', { class: 'sl-toasts', role: 'status', 'aria-live': 'polite' });
      document.body.append(stack);
    }
    const el = h('div', { class: 'sl-toast', dataset: tone ? { tone } : null },
      icon(tone === 'fault' ? 'alert' : tone === 'live' ? 'check' : 'bolt'),
      h('div', { class: 'sl-toast-text', text: message }),
      button({ icon: 'close', kind: 'ghost', size: 'sm', title: 'Dismiss', onClick: () => el.remove() }));
    stack.append(el);
    if (!stay && tone !== 'fault') setTimeout(() => el.remove(), 5200);
    return el;
  }

  /** Something that needs someone: { tone warn | fault | live | (none), icon, title, text, actions }. */
  function banner({ tone, icon: glyph, title, text, actions } = {}) {
    return h('div', { class: 'sl-banner', role: tone === 'fault' ? 'alert' : 'status', dataset: tone ? { tone } : null },
      icon(glyph || (tone === 'warn' || tone === 'fault' ? 'alert' : 'bolt')),
      h('div', { class: 'sl-banner-text' }, h('div', { class: 'sl-banner-title', text: title }), text ? h('div', { class: 'sl-banner-body', text }) : null),
      actions && actions.length ? h('div', { class: 'sl-banner-actions' }, actions) : null);
  }

  /** Nothing here yet: { icon, title, text, actions }. */
  function empty({ icon: glyph, title, text, actions } = {}) {
    return h('div', { class: 'sl-empty' },
      glyph ? icon(glyph) : null,
      h('h3', { class: 'sl-empty-title', text: title }),
      text ? h('p', { class: 'sl-empty-text', text }) : null,
      actions && actions.length ? h('div', { class: 'sl-empty-actions' }, actions) : null);
  }

  /** How far: { value 0..1 (none: unknown), label, tone }. setValue() moves it. */
  function progress({ value, label, tone } = {}) {
    const el = h('div', { class: 'sl-progress', role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', dataset: tone ? { tone } : null });
    el.setValue = (v) => {
      if (v == null) { el.removeAttribute('aria-valuenow'); el.style.removeProperty('--value'); return; }
      const share = Math.max(0, Math.min(1, v));
      el.setAttribute('aria-valuenow', String(Math.round(share * 100)));
      el.style.setProperty('--value', String(share));
    };
    el.setValue(value);
    return el;
  }

  const spinner = (label) => h('span', { class: 'sl-spinner', role: 'status', 'aria-label': label || 'Working' });

  /** Grey bars where lines of text are coming: widths as fractions. */
  const skeleton = (widths = [1, 0.7, 0.85]) => h('div', { 'aria-hidden': 'true' },
    widths.map((w) => h('span', { class: 'sl-skeleton', style: { width: Math.round(w * 100) + '%', marginBottom: '8px' } })));

  /** The longer story behind a "?": { label (what it explains, for a screen reader), text }. */
  function help({ label, text } = {}) {
    return h('details', { class: 'sl-help' },
      h('summary', { 'aria-label': label ? 'About ' + label : 'More about this' }, '?'),
      (Array.isArray(text) ? text : [text]).map((t) => h('p', { text: t })));
  }

  return {
    h, icon, button, busy, field, input, textarea, select, checkbox, radio, toggle, segmented,
    pill, dot, count, tileTone, initial, tile, card, stat, eyebrow, pageHead, row, list, table,
    tabs, navItem, navHead, menu, dialog, toast, banner, empty, progress, spinner, skeleton, help,
  };
})();
