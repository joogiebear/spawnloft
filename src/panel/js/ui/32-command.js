'use strict';
// -------------------------------------------------------------- command ----

async function send() {
  const box = $('#cmd');
  // A command typed as in the game, "/say hi", goes to the console as "say hi": the slash is the
  // prompt's, and the server's console takes commands without one.
  const line = box.value.trim().replace(/^\/(?=\S)/, '');
  if (!state.current || !line) return;
  box.value = '';
  state.draft = '';
  // The same command twice in a row is one entry, as in a shell.
  if (state.history[state.history.length - 1] !== line) state.history.push(line);
  state.histAt = state.history.length;
  try {
    await post('/instances/' + encodeURIComponent(state.current) + '/command', { line: line });
  } catch (e) {
    toast(e.message, 'bad');
    box.value = line;
  }
}

$('#bSend').onclick = send;
$('#cmd').onkeydown = (e) => {
  // Enter that confirms a word in an input method (Chinese, Japanese, Korean) is not a send.
  if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { send(); return; }
  // Shell muscle memory: a console you type into should remember what you typed. What was being
  // typed when Up was first pressed is kept, and Down past the newest brings it back - the old
  // Down blanked the field, half-typed command and all.
  if (e.key === 'ArrowUp' && state.histAt > 0) {
    if (state.histAt === state.history.length) state.draft = e.target.value;
    state.histAt--;
    e.target.value = state.history[state.histAt];
    e.preventDefault();
  } else if (e.key === 'ArrowDown' && state.histAt < state.history.length) {
    state.histAt++;
    e.target.value = state.histAt === state.history.length ? state.draft : state.history[state.histAt];
    e.preventDefault();
  }
};

