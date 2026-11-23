'use strict';
// --------------------------------------------------------------- startup ---

/*
  Escape closes whatever is on top.

  The <dialog> is supposed to handle this itself - a modal dialog fires 'cancel' on Escape - and in
  most browsers it does. Chrome 148 in the desktop pane delivered the keydown to the focused button
  inside the dialog and then did nothing with it, so Manage sat there through any number of
  Escapes. Dismissed here instead, through the same 'cancel' event the browser would have fired,
  so ask() and the edit dialog see exactly what they already listen for. Where the browser does
  close it first, the dialog is no longer open by the time this runs and nothing happens twice.
*/
/**
 * What Escape does, from where it was pressed.
 *
 * In a box someone is typing in it is about the box: a search with something in it is cleared,
 * and from any other field focus steps out to the page around it, so the next Escape is the one
 * that closes. It closed the whole tool or sheet from inside any field, with what was typed.
 */
function escapeMove(at) {
  if (at.dialog) return 'dialog';
  const sheet = at.view === 'add' || at.view === 'settings' || at.view === 'feedback';
  const tool = at.view === 'server' && Boolean(at.tool) && at.inTool;
  if (!sheet && !tool) return null;
  if (at.field) return at.field.search && at.field.value ? 'clear' : 'leave';
  return sheet ? 'back' : 'tool';
}

const TYPED_INPUTS = new Set(['', 'text', 'search', 'number', 'url', 'email', 'password', 'time', 'date', 'tel']);
/** The box Escape was pressed in, if it is one somebody types or chooses in. */
function typedField(el) {
  if (!el || !el.tagName) return null;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return { search: false, value: el.value };
  if (tag !== 'input' || !TYPED_INPUTS.has((el.getAttribute('type') || '').toLowerCase())) return null;
  return { search: el.type === 'search', value: el.value };
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const dlg = $('#dlg');
  const panel = $('#toolPanel');
  const target = document.activeElement;
  const move = escapeMove({
    dialog: dlg.open,
    view: state.view,
    tool: toolView.tool,
    inTool: panel.contains(target),
    field: dlg.open ? null : typedField(target),
  });
  if (!move) return;
  e.preventDefault();
  if (move === 'dialog') dlg.dispatchEvent(new Event('cancel', { cancelable: true }));
  else if (move === 'clear') {
    target.value = '';
    target.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (move === 'leave') {
    // out of the box and onto what holds it: in a tool, Escape only closes from inside the tool
    const around = panel.contains(target) ? panel : target.closest('.view.sheet');
    if (!around) { target.blur(); return; }
    if (!around.hasAttribute('tabindex')) around.setAttribute('tabindex', '-1');
    around.focus({ preventScroll: true });
  } else if (move === 'back') back();
  else if (move === 'tool') closeTool();
});

/*
  Focus after a redraw (X2).

  Every tool draws itself again, whole, after an action: the button that was pressed is gone, and
  focus fell to the page, so the next Tab started from the top. The control is found again by what
  it is (its name, among others of the same name), or failing that by where it stood: a button that
  changed its name (Lock, then Unlock) or whose row went stands where the old one did.
*/
function controlName(el) {
  return el.tagName + '|' + (el.id || el.getAttribute('aria-label') || el.getAttribute('placeholder') || (el.textContent || '').trim().slice(0, 60));
}

/** Which of `names` (the controls now, in order) takes focus for a mark made before the redraw, or -1. */
function focusChoice(names, mark, usable) {
  const ok = (i) => i >= 0 && i < names.length && (!usable || usable[i]);
  const same = [];
  names.forEach((n, i) => { if (n === mark.name) same.push(i); });
  if (ok(same[mark.nth])) return same[mark.nth];
  // not there under that name: what stands where it stood (a row that went hands over to the
  // next, a button that changed its name is still in its place)
  for (let step = 0; step < names.length; step++) {
    if (ok(mark.at + step)) return mark.at + step;
    if (ok(mark.at - step)) return mark.at - step;
  }
  return -1;
}

const FOCUSABLE = 'button, input, select, textarea, a[href], summary, [tabindex]:not([tabindex="-1"])';
let lastInTool = null;
document.addEventListener('focusin', (e) => {
  const panel = $('#toolPanel');
  if (panel && panel.contains(e.target) && e.target !== panel) lastInTool = e.target;
  else if (e.target !== document.body) lastInTool = null;
});
// Focus that left for nowhere (a click on the header, on blank space) was taken away by the
// person. A button turned off under them did not choose to give it up, and is still remembered.
document.addEventListener('focusout', (e) => {
  if (e.target === lastInTool && !e.relatedTarget && e.target.isConnected && !e.target.disabled) lastInTool = null;
});

/**
 * Whether focus is put back after a redraw: only where the redraw is what took it. A control
 * that is still there and can be used kept its focus, or lost it to the person; focus that
 * stands anywhere else was moved on purpose (a dialog, the console, another tool).
 */
function focusLost(was, now) {
  if (!was) return false;
  if (was.connected && !was.disabled) return false;
  return now.nowhere;
}

function focusMark(root) {
  let el = document.activeElement;
  // a button turned off while its request runs gives focus up; it is still where the person was
  if ((!el || el === document.body) && lastInTool && lastInTool.isConnected && lastInTool.offsetParent !== null) el = lastInTool;
  if (!el || el === root || !root.contains(el)) return null;
  const all = [...root.querySelectorAll(FOCUSABLE)];
  const name = controlName(el);
  const typed = typedField(el);
  return {
    el,
    name,
    nth: all.filter((x) => controlName(x) === name).indexOf(el),
    at: all.indexOf(el),
    caret: typed && typeof el.selectionStart === 'number' ? [el.selectionStart, el.selectionEnd] : null,
  };
}

function focusBack(root, mark) {
  if (!mark || root.hidden) return;
  const now = document.activeElement;
  const nowhere = !now || now === document.body || !now.isConnected || now === mark.el;
  if (!focusLost({ connected: mark.el.isConnected, disabled: Boolean(mark.el.disabled) }, { nowhere })) return;
  const all = [...root.querySelectorAll(FOCUSABLE)];
  const pick = focusChoice(all.map(controlName), mark, all.map((x) => !x.disabled && x.offsetParent !== null));
  const to = all[pick];
  if (!to) return;
  to.focus({ preventScroll: true });
  if (mark.caret && controlName(to) === mark.name) { try { to.setSelectionRange(mark.caret[0], mark.caret[1]); } catch { /* not a text box */ } }
}

/** A tool's draw function that puts focus back where it was. */
function holdingFocus(draw) {
  return async function (...args) {
    const root = $('#toolPanel');
    const mark = focusMark(root);
    try {
      return await draw.apply(this, args);
    } finally {
      focusBack(root, mark);
    }
  };
}
renderPlayers = holdingFocus(renderPlayers);
renderPlugins = holdingFocus(renderPlugins);
renderWorlds = holdingFocus(renderWorlds);
renderFiles = holdingFocus(renderFiles);
renderScheduler = holdingFocus(renderScheduler);
renderBackups = holdingFocus(renderBackups);
renderActivity = holdingFocus(renderActivity);
paintPerformance = holdingFocus(paintPerformance);

