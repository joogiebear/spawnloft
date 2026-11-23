'use strict';
// ------------------------------------------------------------ prerequisites -

/**
 * Java, said at the top, until it is fixed.
 *
 * <p>Everything else in this panel works without it; nothing actually runs. It is a chip in the
 * header rather than a toast - a toast is for something that just happened, and this is a
 * condition - and a chip rather than the banner it used to be, because "Java 25" needs a word's
 * width, not the window's. The whole sentence is its accessible name and its tooltip.
 */
function renderJavaChip() {
  const chip = $('#javaChip');
  const health = state.health;
  const java = health && health.java;
  if (!java || (java.ok && java.reason === 'ok')) { chip.hidden = true; return; }

  // Which servers it holds up, and the newest Java any of them needs; with none registered, the
  // version the download link is for.
  const have = java.found ? java.major : null;
  const short = state.rows.filter((r) => r.javaNeeds && (have == null || have < r.javaNeeds));
  const linked = Number((/[?&]version=(\d+)/.exec(health.javaDownload || '') || [])[1]) || null;
  const need = short.length ? Math.max(...short.map((r) => r.javaNeeds)) : linked;

  chip.hidden = false;
  chip.dataset.tone = java.found ? 'warn' : 'fault';
  chip.querySelector('span').textContent = 'Java' + (need ? ' ' + need : '');
  const sentence = short.length
    ? (short.length === 1 ? '1 server needs' : short.length + ' servers need') + ' Java ' + need + '.'
    : java.found ? 'Java needs updating.' : 'Java is not installed.';
  chip.setAttribute('aria-label', sentence + ' Get Java.');
  chip.title = java.message + (java.ok ? '' : ' Servers will not start until it is sorted. This checks again by itself once Java is installed.');
}

$('#javaChip').onclick = () => { if (state.health) openOutside(state.health.javaDownload); };

/*
  The chip was drawn from one answer, asked when the page loaded, so it stayed after Java had been
  installed and nothing said a reload was needed. While it shows, the question is asked again when
  the window comes back to the front (from the installer, most likely) and once a minute while
  it is in front. Not otherwise: finding Java starts a process per candidate.
*/
let healthAsked = 0;
async function recheckJava() {
  const mine = ++healthAsked;
  let health;
  try { health = await api('/health'); } catch { return; }
  if (mine !== healthAsked) return;
  const was = state.health && state.health.java;
  state.health = health;
  renderJavaChip();
  if (was && !was.ok && health.java && health.java.ok) toast('Java ' + (health.java.major || '') + ' found. Servers that needed it can start now.', 'good');
}
// Only while no usable Java was found. A Java that runs older versions keeps the chip for good,
// and that is not a reason to start a process per candidate every minute.
const javaMissing = () => Boolean(state.health && state.health.java && !state.health.java.ok);
window.addEventListener('focus', () => { if (javaMissing()) recheckJava(); });
setInterval(() => { if (javaMissing() && document.hasFocus()) recheckJava(); }, 60000);

api('/health').then((health) => {
  state.health = health;
  renderJavaChip();
  // A newer SpawnLoft used this data folder (someone went to 2.0 and came back). Said once per
  // marker in this browser; doctor keeps saying it.
  if (health.dataFormat) {
    let seen = null;
    try { seen = localStorage.getItem('spawnloft.dataFormatSeen'); } catch {}
    if (seen !== health.dataFormat) {
      toast('Note: ' + health.dataFormat.charAt(0).toUpperCase() + health.dataFormat.slice(1), 'bad');
      try { localStorage.setItem('spawnloft.dataFormatSeen', health.dataFormat); } catch {}
    }
  }
}).catch(() => {
  // An unreachable health check is not worth saying anything about; the panel is clearly running.
});

