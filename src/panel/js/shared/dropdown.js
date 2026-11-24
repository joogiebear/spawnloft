'use strict';
/*
  SlSelect: the drop-down list for every <select class="sl-input"> on a page.

  A native select opens the operating system's own menu: it cannot be searched, grouped under
  headings, or given a second line, and it looks different on each machine. This keeps the select
  (it stays the source of the value, the name, the form and the change event, so the page's own
  code is untouched) and draws a button and a list in its place:

    - a button in the shared field look that says the chosen option,
    - a list that opens under it (above when there is no room), in the top layer so a dialog or a
      sheet never clips it,
    - a search box on top of a long list (ten options or more; data-search="on" or "off" forces it),
    - <optgroup> as headings, and a muted note at the right of an option (data-note="Java 21", or
      the old "label  · note" text, which is split on the dot),
    - the keyboard of a listbox: Up, Down, Home, End, Page Up, Page Down, Enter, Escape, Tab, and
      typing to jump when there is no search box.

  Every select that is added to the page is picked up (a MutationObserver), and every select that
  changes (options added, `.value =` set from code, disabled) is redrawn. data-native on a
  select opts out and leaves the system's own.
*/
const SlSelect = (() => {
  const SEARCH_AT = 10;
  const MAX_LIST = 320;
  const popover = typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.showPopover === 'function';
  const nativeValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  const nativeIndex = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
  const made = new WeakMap();
  let serial = 0;
  let openNow = null;

  const make = (tag, cls, attrs) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) node.setAttribute(k, v);
    return node;
  };

  /** The words and the note of an option: "1.21.4  · Java 21" is "1.21.4" and "Java 21". */
  function words(option) {
    let label = option.label || option.textContent || '';
    let note = option.dataset.note || '';
    if (!note) {
      const at = label.search(/\s+·\s+/);
      if (at > 0) { note = label.slice(at).replace(/^\s*·\s*/, '').trim(); label = label.slice(0, at); }
    }
    return { label: label.trim(), note };
  }

  /** The select's options as a flat list of rows and group headings. */
  function readItems(select) {
    const items = [];
    const take = (option, group) => {
      const w = words(option);
      items.push({ kind: 'option', option, value: option.value, label: w.label, note: w.note, disabled: option.disabled || Boolean(group && group.disabled), group });
    };
    for (const child of select.children) {
      if (child.tagName === 'OPTGROUP') {
        const group = { label: child.label, disabled: child.disabled };
        items.push({ kind: 'group', label: child.label, group });
        for (const o of child.children) if (o.tagName === 'OPTION') take(o, group);
      } else if (child.tagName === 'OPTION') take(child, null);
    }
    return items;
  }

  function enhance(select) {
    if (made.has(select)) {
      const have = made.get(select);
      if (select.isConnected && have.btn.previousElementSibling !== select) select.after(have.btn, have.pop);
      return;
    }
    if (select.multiple || select.size > 1 || select.hasAttribute('data-native')) return;

    const id = ++serial;
    const btn = make('button', 'sl-input sl-select-btn', {
      type: 'button', id: select.id ? `${select.id}-pick` : `sl-select-${id}`, 'aria-haspopup': 'listbox', 'aria-expanded': 'false',
    });
    const text = make('span', 'sl-select-text');
    const note = make('span', 'sl-select-note');
    btn.append(text, note);
    const pop = make('div', 'sl-select-pop');
    pop.hidden = true;
    if (popover) pop.setAttribute('popover', 'manual');
    const list = make('div', 'sl-select-list', { id: `sl-select-list-${id}`, tabindex: '-1' });
    list.setAttribute('role', 'listbox');
    const find = make('input', 'sl-select-find', {
      type: 'text', role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'true', 'aria-controls': list.id,
      'aria-label': 'Search', placeholder: 'Search…', autocomplete: 'off', spellcheck: 'false',
    });
    const findWrap = make('div', 'sl-select-findwrap');
    findWrap.append(find);
    const none = make('div', 'sl-select-none', { role: 'status' });
    none.textContent = 'Nothing matches';
    none.hidden = true;
    pop.append(findWrap, list, none);

    select.classList.add('sl-select-native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    select.after(btn, pop);

    const state = { btn, pop, list, find, rows: [], at: -1, open: false, typed: '', typedAt: 0, searchable: false };
    made.set(select, state);

    // the name of the button: the select's own label (a <label for>, aria-labelledby or aria-label) and the choice
    const name = () => {
      const labelled = select.getAttribute('aria-labelledby');
      const ids = [];
      if (labelled) ids.push(...labelled.split(/\s+/));
      else for (const l of select.labels || []) { if (!l.id) l.id = `sl-select-label-${id}-${ids.length}`; ids.push(l.id); }
      if (ids.length) { btn.setAttribute('aria-labelledby', [...ids, btn.id].join(' ')); btn.removeAttribute('aria-label'); }
      else { btn.removeAttribute('aria-labelledby'); btn.setAttribute('aria-label', (select.getAttribute('aria-label') || 'Choose') + ': ' + (text.textContent || 'nothing')); }
    };

    function paintButton() {
      const o = select.options[select.selectedIndex];
      const w = o ? words(o) : { label: '', note: '' };
      text.textContent = w.label;
      note.textContent = w.note;
      note.hidden = !w.note;
      btn.toggleAttribute('data-empty', !o || o.value === '');
      btn.disabled = select.disabled;
      if (select.disabled && state.open) close(false);
      if (select.title) btn.title = select.title; else btn.removeAttribute('title');
      btn.hidden = select.hidden;
      if (select.getAttribute('aria-invalid') === 'true') btn.setAttribute('aria-invalid', 'true');
      else btn.removeAttribute('aria-invalid');
      for (const attr of ['aria-describedby']) {
        if (select.hasAttribute(attr)) btn.setAttribute(attr, select.getAttribute(attr)); else btn.removeAttribute(attr);
      }
      name();
    }

    const visibleRows = () => state.rows.filter((r) => !r.hidden && !r.disabled);

    function setActive(row, scroll = true) {
      for (const r of state.rows) r.el.toggleAttribute('data-active', r === row);
      const target = state.searchable ? find : list;
      if (row) { target.setAttribute('aria-activedescendant', row.el.id); if (scroll) row.el.scrollIntoView({ block: 'nearest' }); }
      else target.removeAttribute('aria-activedescendant');
      state.at = row ? state.rows.indexOf(row) : -1;
    }

    function draw() {
      const items = readItems(select);
      state.searchable = select.dataset.search === 'on' || (select.dataset.search !== 'off' && items.filter((i) => i.kind === 'option').length >= SEARCH_AT);
      findWrap.hidden = !state.searchable;
      list.textContent = '';
      state.rows = [];
      let box = list;
      let n = 0;
      for (const item of items) {
        if (item.kind === 'group') {
          const wrap = make('div', 'sl-select-group', { role: 'group' });
          const head = make('div', 'sl-select-head', { id: `sl-select-${id}-g${n++}`, 'aria-hidden': 'true' });
          head.textContent = item.label;
          wrap.setAttribute('aria-label', item.label);
          wrap.append(head);
          list.append(wrap);
          box = wrap;
          continue;
        }
        if (!item.group) box = list;
        const row = make('div', 'sl-select-opt', { role: 'option', id: `sl-select-${id}-o${n++}`, 'aria-selected': String(item.option.selected) });
        if (item.disabled) row.setAttribute('aria-disabled', 'true');
        const t = make('span', 'sl-select-opt-text');
        t.textContent = item.label || ' ';
        row.append(t);
        if (item.note) { const nt = make('span', 'sl-select-opt-note'); nt.textContent = item.note; row.append(nt); }
        row.dataset.i = String(state.rows.length);
        box.append(row);
        state.rows.push({ el: row, item, option: item.option, disabled: item.disabled, hidden: false, text: (item.label + ' ' + item.note + ' ' + item.value).toLowerCase() });
      }
      filter();
    }

    function filter() {
      const q = state.searchable ? find.value.trim().toLowerCase() : '';
      const words_ = q ? q.split(/\s+/) : [];
      for (const r of state.rows) {
        r.hidden = words_.length > 0 && !words_.every((w) => r.text.includes(w));
        r.el.hidden = r.hidden;
      }
      for (const g of list.querySelectorAll('.sl-select-group')) g.hidden = ![...g.querySelectorAll('.sl-select-opt')].some((o) => !o.hidden);
      none.hidden = state.rows.some((r) => !r.hidden);
      const picked = state.rows.find((r) => !r.hidden && !r.disabled && r.option.selected);
      setActive(picked || visibleRows()[0] || null, false);
    }

    function place() {
      const r = btn.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      pop.style.minWidth = r.width + 'px';
      pop.style.maxWidth = Math.max(r.width, Math.min(480, vw - 16)) + 'px';
      list.style.maxHeight = '';
      const chrome = pop.offsetHeight - list.offsetHeight;
      const below = vh - r.bottom - 10;
      const above = r.top - 10;
      const want = Math.min(MAX_LIST, list.scrollHeight) + chrome;
      const down = below >= want || below >= above;
      const room = Math.max(120, (down ? below : above) - chrome);
      list.style.maxHeight = Math.min(MAX_LIST, room) + 'px';
      const h = pop.offsetHeight;
      const left = Math.min(Math.max(8, r.left), Math.max(8, vw - pop.offsetWidth - 8));
      pop.style.left = left + 'px';
      pop.style.top = Math.max(4, down ? r.bottom + 4 : r.top - h - 4) + 'px';
    }

    function onOutside(e) { if (!pop.contains(e.target) && !btn.contains(e.target)) close(false); }
    function onMove(e) { if (e && e.target instanceof Node && pop.contains(e.target)) return; if (state.open) place(); }

    function open() {
      if (state.open || select.disabled) return;
      if (openNow && openNow !== api) openNow.close(false);
      draw();
      state.open = true;
      openNow = api;
      pop.hidden = false;
      if (popover) { try { pop.showPopover(); } catch { /* shown by `hidden` alone */ } }
      btn.setAttribute('aria-expanded', 'true');
      find.value = '';
      place();
      const picked = state.rows.find((r) => r.option.selected && !r.disabled);
      if (picked) setActive(picked, true);
      (state.searchable ? find : list).focus({ preventScroll: true });
      document.addEventListener('pointerdown', onOutside, true);
      window.addEventListener('scroll', onMove, true);
      window.addEventListener('resize', onMove);
    }

    function close(refocus) {
      if (!state.open) return;
      state.open = false;
      if (openNow === api) openNow = null;
      if (popover) { try { pop.hidePopover(); } catch { /* already hidden */ } }
      pop.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', onOutside, true);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
      if (refocus) btn.focus({ preventScroll: true });
    }

    function choose(row) {
      if (!row || row.disabled || select.disabled) return;
      const changed = !row.option.selected;
      row.option.selected = true;
      paintButton();
      close(true);
      if (changed) {
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    function move(by, to) {
      const rows = visibleRows();
      if (!rows.length) return;
      const cur = rows.indexOf(state.rows[state.at]);
      let next;
      if (to === 'first') next = 0;
      else if (to === 'last') next = rows.length - 1;
      else next = Math.min(rows.length - 1, Math.max(0, (cur < 0 ? (by > 0 ? -1 : rows.length) : cur) + by));
      setActive(rows[next]);
    }

    function jump(ch) {
      const now = Date.now();
      state.typed = (now - state.typedAt > 700 ? '' : state.typed) + ch.toLowerCase();
      state.typedAt = now;
      const rows = visibleRows();
      const from = Math.max(0, rows.indexOf(state.rows[state.at]));
      const order = [...rows.slice(from + (state.typed.length === 1 ? 1 : 0)), ...rows.slice(0, from + 1)];
      const hit = order.find((r) => r.item.label.toLowerCase().startsWith(state.typed));
      if (hit) setActive(hit);
    }

    function onKey(e) {
      if (e.isComposing) return;
      const page = Math.max(1, Math.floor(list.clientHeight / 34) - 1);
      switch (e.key) {
        case 'ArrowDown': move(1); break;
        case 'ArrowUp': move(-1); break;
        case 'PageDown': move(page); break;
        case 'PageUp': move(-page); break;
        case 'Home': if (state.searchable) return; move(0, 'first'); break;
        case 'End': if (state.searchable) return; move(0, 'last'); break;
        case 'Enter': choose(state.rows[state.at]); break;
        case ' ': if (state.searchable) return; choose(state.rows[state.at]); break;
        case 'Escape': close(true); break;
        case 'Tab': close(false); return;
        default:
          if (!state.searchable && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { jump(e.key); break; }
          return;
      }
      e.preventDefault();
      // Escape belongs to the list while it is open: it must not also close the dialog under it
      e.stopPropagation();
    }

    btn.addEventListener('click', () => (state.open ? close(true) : open()));
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); }
    });
    pop.addEventListener('keydown', onKey);
    find.addEventListener('input', filter);
    pop.addEventListener('pointerdown', (e) => { if (e.target !== find) e.preventDefault(); });
    list.addEventListener('pointermove', (e) => {
      const row = e.target.closest && e.target.closest('.sl-select-opt');
      if (row) { const r = state.rows[Number(row.dataset.i)]; if (r && !r.disabled && state.at !== state.rows.indexOf(r)) setActive(r, false); }
    });
    list.addEventListener('click', (e) => {
      const row = e.target.closest && e.target.closest('.sl-select-opt');
      if (row) choose(state.rows[Number(row.dataset.i)]);
    });
    pop.addEventListener('focusout', (e) => { if (state.open && !(e.relatedTarget instanceof Node && (pop.contains(e.relatedTarget) || btn.contains(e.relatedTarget)))) close(false); });
    // the page changed the choice without a script write (keyboard on the hidden select, a form reset)
    select.addEventListener('change', paintButton);
    select.addEventListener('input', paintButton);
    if (select.form) select.form.addEventListener('reset', () => setTimeout(paintButton, 0));
    // a label (or a script) that focuses the select lands on the button
    select.addEventListener('focus', () => { if (!btn.hidden && !btn.disabled) btn.focus({ preventScroll: true }); });

    // value and selectedIndex set from code do not fire an event: redraw when they are written
    Object.defineProperty(select, 'value', { configurable: true, get() { return nativeValue.get.call(this); }, set(v) { nativeValue.set.call(this, v); paintButton(); if (state.open) draw(); } });
    Object.defineProperty(select, 'selectedIndex', { configurable: true, get() { return nativeIndex.get.call(this); }, set(v) { nativeIndex.set.call(this, v); paintButton(); if (state.open) draw(); } });

    const watch = new MutationObserver(() => { paintButton(); if (state.open) draw(); });
    watch.observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'aria-invalid', 'aria-describedby', 'aria-labelledby', 'aria-label', 'selected', 'label', 'data-note'] });

    const api = { close, destroy() { close(false); watch.disconnect(); btn.remove(); pop.remove(); made.delete(select); } };
    state.api = api;
    paintButton();
    // focus that was on the select (or on its button before a re-render) moves to the new button
    const active = document.activeElement;
    if (active === select || (select.id && lastPick === select.id && (!active || active === document.body))) btn.focus({ preventScroll: true });
  }

  let lastPick = '';
  window.addEventListener('focusin', (e) => {
    const t = e.target;
    lastPick = t instanceof Element && t.classList.contains('sl-select-btn') && t.id.endsWith('-pick') ? t.id.slice(0, -5) : '';
  }, true);

  function scan(root) {
    if (root.nodeType !== 1) return;
    if (root.matches('select.sl-input')) enhance(root);
    for (const s of root.querySelectorAll('select.sl-input')) enhance(s);
  }

  function sweep(root) {
    if (root.nodeType !== 1) return;
    const gone = root.matches('select') ? [root] : [];
    gone.push(...root.querySelectorAll('select'));
    for (const s of gone) {
      const state = made.get(s);
      if (state && !s.isConnected) {
        // a select that was moved is added again in the same turn: wait to see
        queueMicrotask(() => { if (!s.isConnected && made.has(s)) state.api.destroy(); });
      }
    }
  }

  function start() {
    scan(document.body);
    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.removedNodes) sweep(n);
        for (const n of r.addedNodes) scan(n);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);

  return { enhance, scan };
})();
