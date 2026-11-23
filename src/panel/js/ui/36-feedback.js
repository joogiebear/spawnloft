'use strict';
// -------------------------------------------------------------- feedback ---

/** A link out to the real browser: the desktop's https-only bridge, or a new tab. */
function openOutside(url) {
  if (desktop) return desktop.openExternal(url);
  window.open(url, '_blank', 'noopener');
}

/**
 * A bug report, mostly written already.
 *
 * The core builds a new-issue URL carrying the short diagnostics and copies the full bundle to
 * the clipboard first, so the report lands with the facts attached and the person only has to
 * say what they were doing. Called from the Feedback sheet and from the "Report" link beside a
 * crash, which passes a title so the report starts named for what it is about.
 */
async function reportBug({ title = '' } = {}) {
  const q = new URLSearchParams();
  if (state.current) q.set('instance', state.current);
  if (title) q.set('title', title);
  let data;
  try {
    data = await api('/feedback?' + q);
  } catch (e) {
    toast('Could not gather diagnostics: ' + e.message, 'bad');
    return;
  }
  if (!data.bug) {
    toast('This build does not know where its project lives, so it cannot open a report.', 'bad');
    return;
  }
  let copied = false;
  try {
    await navigator.clipboard.writeText(data.full);
    copied = true;
  } catch {
    /* the short form is in the issue already; the browser refusing the clipboard costs the tail */
  }
  openOutside(data.bug);
  toast(copied
    ? 'Bug report opened in your browser. The full diagnostics are on your clipboard - paste them in.'
    : 'Bug report opened in your browser.', 'good');
}

$('#bFeedback').onclick = () => {
  openSheet('feedback', () => {
    $('#fbNote').textContent = state.current
      ? 'A bug report will include the last console lines of ' + state.current + '.'
      : 'Select a server first if the problem is about one - its console lines go into the report.';
  });
};
$('#bFbClose').onclick = back;
$('#dBug').onclick = () => reportBug();
// Each door opens its own category, so nobody has to pick one from GitHub's list first.
for (const [id, key] of [['#dIdea', 'ideas'], ['#dAsk', 'question']]) {
  $(id).onclick = async () => {
    try {
      const data = await api('/feedback');
      if (data[key]) openOutside(data[key]);
    } catch (e) {
      toast(e.message, 'bad');
    }
  };
}

// The bundle is plain text from the core; the page only carries it to the clipboard. A prompt
// with the text selected is the fallback for a browser that refuses clipboard writes.
$('#bDiag').onclick = async () => {
  const b = $('#bDiag');
  b.disabled = true;
  try {
    const q = state.current ? '?instance=' + encodeURIComponent(state.current) : '';
    const res = await fetch('/api/diagnostics' + q);
    if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
    const text = await res.text();
    await navigator.clipboard.writeText(text);
    toast('Diagnostics copied. Paste them into your bug report.', 'good');
  } catch (e) {
    toast('Could not copy diagnostics: ' + e.message, 'bad');
  } finally {
    b.disabled = false;
  }
};

