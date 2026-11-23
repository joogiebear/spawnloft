'use strict';
// ------------------------------------------------------------------ sheets ---

/*
  Where each sheet was opened from, so closing it goes back there - and focus with it.

  A modal <dialog> does this on its own; the sheets - Add a server, Preferences, Feedback - are views
  in the stage, not dialogs, and when one closed the element that had focus was gone with it. Focus
  fell to the body, and the next Tab started from the top of the page. Feedback opens from inside
  Preferences, so this is a stack: closing Feedback returns to Preferences, not past it.
*/
const sheetStack = [];

function openSheet(view, prepare) {
  if (state.view !== view) {
    sheetStack.push({ from: state.view, opener: document.activeElement instanceof HTMLElement ? document.activeElement : null });
  }
  if (prepare) prepare();
  show(view);
}

// Play is here too: it covers the stage like a sheet, and a sheet opened over it (Preferences from
// the header) comes back to it.
const SHEETS = new Set(['add', 'settings', 'feedback', 'play']);

/** Back out of a sheet to wherever the person was. */
function back() {
  const entry = sheetStack.pop() || { from: null, opener: null };
  if (SHEETS.has(entry.from)) {
    show(entry.from);
  } else if (!state.current) {
    showHome();
  } else if (state.streamName === state.current) {
    show('server');
    renderServer(rowOf(state.current));
  } else {
    select(state.current);
  }
  if (entry.opener && entry.opener.isConnected) entry.opener.focus();
}

