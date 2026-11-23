'use strict';
// ------------------------------------------------------------ lifecycle ----

const ACTION_ING = { start: 'Starting', stop: 'Stopping', restart: 'Restarting' };
const ACTION_DONE = { start: 'started', stop: 'stopped', restart: 'restarted' };

/**
 * The question before a stop or a restart that takes something from somebody: players who are
 * online, or running servers that keep their data in this database. Null when there is nobody to
 * ask about, and the button then acts at once as it always did.
 */
function stopQuestion(what, row, rows) {
  if (!row || (what !== 'stop' && what !== 'restart')) return null;
  const stop = what === 'stop';
  const title = (stop ? 'Stop ' : 'Restart ') + (row.label || row.name) + '?';
  const confirmLabel = stop ? 'Stop' : 'Restart';
  if (row.kind === 'database') {
    const users = Object.keys(row.attachments || {})
      .map((name) => rows.find((r) => r.name === name))
      .filter((r) => r && r.status === 'running')
      .map((r) => r.label || r.name);
    if (!users.length) return null;
    const who = users.length === 1 ? users[0] + ' is running and keeps'
      : users.slice(0, -1).join(', ') + ' and ' + users[users.length - 1] + ' are running and keep';
    return {
      title, confirmLabel,
      text: who + ' data in this database. ' + (stop ? 'Until it is started again' : 'While it restarts')
        + ', whatever reads or writes it there will fail.',
    };
  }
  const online = row.status === 'running' && row.latest ? Number(row.latest.players) || 0 : 0;
  if (!online) return null;
  return {
    title, confirmLabel,
    text: (online === 1 ? '1 player is online and will be disconnected.' : online + ' players are online and will be disconnected.')
      + (stop ? '' : ' They can join again once it is back.'),
  };
}

/** Whether the thing a stop was confirmed for is still there to stop. */
function stillUp(row) {
  return Boolean(row) && (row.status === 'running' || row.status === 'reachable');
}

/** Whether running this scheduled task now stops or restarts the server. */
function taskDisconnects(task) {
  const a = (task && task.action) || {};
  // The console's own "stop" and "restart" do the same thing as the steps named for them.
  const typed = (line) => {
    const word = String(line || '').trim().replace(/^\//, '').split(/\s+/)[0].toLowerCase();
    return word === 'stop' || word === 'restart' ? word : null;
  };
  if (a.type === 'restart' || a.type === 'stop') return a.type;
  if (a.type === 'command') return typed(a.line);
  if (a.type === 'steps') {
    for (const st of a.steps || []) {
      if (st.do === 'restart' || st.do === 'stop') return st.do;
      if (st.do === 'command' && typed(st.line)) return typed(st.line);
    }
  }
  return null;
}

// `sure` is for a caller that has already asked: a second question about the same stop would be
// answered without being read.
const act = (what, { sure = false } = {}) => async () => {
  const name = state.current;
  if (!name || state.busy) return;
  if (!sure) {
    const question = stopQuestion(what, rowOf(name), state.rows);
    if (question && !(await ask(question))) return;
    if (state.current !== name || state.busy) return;
    // The answer was to what the question said. A server that stopped while it was being read is
    // not stopped again, and not started by a restart nobody would now ask for.
    if (question && !stillUp(rowOf(name))) return toast((rowOf(name)?.label || name) + ' is no longer running.');
  }
  state.busy = true;
  // What is under way, so the state pill can say "Starting…" through the wait rather than
  // "Stopped" while the button that started it is already greyed out.
  state.acting = what;
  renderServer(rowOf(name));
  const note = toast(ACTION_ING[what] + ' ' + name + '…');
  try {
    await post('/instances/' + encodeURIComponent(name) + '/' + what);
    note.remove();
    toast(name + ' ' + ACTION_DONE[what] + '.', 'good');
  } catch (e) {
    note.remove();
    toast(e.message, 'bad');
  } finally {
    state.busy = false;
    state.acting = null;
    await refresh();
  }
};

$('#bStart').onclick = act('start');
$('#bCmdStart').onclick = act('start');
$('#bStop').onclick = act('stop');
$('#bRestart').onclick = act('restart');

