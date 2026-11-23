'use strict';
// ---------------------------------------------- tools that follow the server ----
// Each tool draws its page once and keeps it. Five of them draw it differently for a running
// server than a stopped one: Worlds offers Delete only when stopped, Players says whether a change
// goes through the console or the files. A page drawn before Start was pressed went on offering
// what a stopped server allows, and nothing short of choosing another server redrew it.

/** The tools whose page says something that depends on whether the server is up. */
const FOLLOWS_SERVER = ['players', 'plugins', 'worlds', 'files', 'scheduler'];
/** How long an open Players list is trusted while people can still join and leave. */
const PLAYERS_EVERY_MS = 20000;
/** After "Run now": when to look for the run's line. A backup takes longer than a restart. */
const RUN_CHECKS_MS = [2500, 10000, 30000, 60000];

const followed = { name: null, status: null, stale: new Set(), playersAt: 0 };

/**
 * Which tools to redraw now, which to redraw the next time they are opened, and which to leave
 * marked for the next look.
 *
 * Only the open tool is redrawn: a hidden one is forgotten instead, so it reads afresh when it is
 * opened. One that holds something half done, open or hidden, is left alone and tried again on
 * the next poll, since a redraw rebuilds the page and takes the typing with it.
 */
function followPlan(stale, open, holds) {
  const plan = { redraw: null, forget: [], keep: [] };
  for (const tool of stale) {
    if (holds(tool)) plan.keep.push(tool);
    else if (tool !== open) plan.forget.push(tool);
    else plan.redraw = tool;
  }
  return plan;
}

/** Whether an open Players list is due another read: only a running server changes by itself. */
function playersDue(row, open, readAt, now) {
  return open === 'players' && Boolean(row) && row.status === 'running' && now - readAt >= PLAYERS_EVERY_MS;
}

/** Whether redrawing this pane now would throw away something half done. */
function paneHolds(body) {
  if (document.querySelector('dialog[open]')) return true;
  const at = document.activeElement;
  if (at && body.contains(at) && /^(INPUT|TEXTAREA|SELECT)$/.test(at.tagName)) return true;
  if (body.querySelector('.task-form, [data-holding]')) return true;
  // Something typed and not yet sent: an import path, a search with its results under it. A box
  // the page fills back in by itself after a redraw is marked data-kept and does not count.
  for (const box of body.querySelectorAll('input, textarea')) {
    if (box.dataset.kept || /^(checkbox|radio|file|hidden|button|submit)$/.test(box.type)) continue;
    if (box.value.trim()) return true;
  }
  return false;
}

/** Redraw one tool where it stands: the same scroll position, since the page is rebuilt whole. */
async function redrawTool(tool) {
  const body = $('#' + tool + 'Body');
  const pane = body.closest('.pane');
  const top = pane ? pane.scrollTop : 0;
  const draw = { players: renderPlayers, plugins: renderPlugins, worlds: renderWorlds, files: renderFiles, scheduler: renderScheduler }[tool];
  await draw({ force: true });
  if (pane) pane.scrollTop = top;
}

/** A server has just been chosen: this is the state its tools are about to be drawn for. */
function followFrom(row) {
  followed.name = row.name;
  followed.status = row.status;
  followed.stale.clear();
  followed.playersAt = Date.now();
}

/** Called on every poll with the open server's row. */
function followServer(row) {
  if (!row || isDb(row)) return;
  if (followed.name !== row.name) return followFrom(row);
  if (followed.status !== row.status) {
    followed.status = row.status;
    for (const tool of FOLLOWS_SERVER) followed.stale.add(tool);
  }
  const open = toolView.tool;
  if (playersDue(row, open, followed.playersAt, Date.now())) {
    // Counted from the asking, not the answer: a slow answer must not be asked for again on
    // every poll while it is on its way.
    followed.playersAt = Date.now();
    followed.stale.add('players');
  }
  if (!followed.stale.size) return;
  const plan = followPlan([...followed.stale], open, (tool) => paneHolds($('#' + tool + 'Body')));
  // An open file is its own page and is never re-read from under its editor. The list behind it
  // is read again when the editor closes.
  const editing = Boolean(filesStateFor(row.name).editing);
  for (const tool of plan.forget) {
    followed.stale.delete(tool);
    if (tool !== 'files' || !editing) $('#' + tool + 'Body').dataset.for = '';
  }
  if (plan.redraw) {
    followed.stale.delete(plan.redraw);
    if (plan.redraw !== 'files' || !editing) redrawTool(plan.redraw);
  }
}

// Uptime ticks on its own second rather than waiting for the four-second poll, so a running server
// visibly runs.
setInterval(() => {
  for (const el of $$('[data-since]')) {
    const since = Number(el.dataset.since);
    if (!since) continue;
    const text = duration(Date.now() - since);
    el.textContent = el.classList.contains('spill') ? 'Running \u00b7 ' + text : text;
  }
}, 1000);

