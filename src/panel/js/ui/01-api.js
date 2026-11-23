'use strict';
// ------------------------------------------------------------------ api ----

/**
 * One plain sentence for a request that failed without the panel saying why: the browser's own
 * "Failed to fetch" for no answer at all (status 0), or a bare status code.
 */
function plainFailure(status) {
  if (!status) return 'SpawnLoft did not answer. Check that it is still running, then try again.';
  if (status === 401 || status === 403) return 'This page is no longer signed in to SpawnLoft. Reload it to sign in again.';
  if (status === 404) return 'SpawnLoft has no such thing any more. It may have been renamed or removed; reload the page.';
  if (status === 413) return 'That is too large to send in one go.';
  if (status >= 500) return 'SpawnLoft hit a problem doing that (error ' + status + '). Try again; if it keeps happening, send a report from Feedback.';
  return 'SpawnLoft refused that without saying why (error ' + status + ').';
}

/**
 * The core's "could not reach X: getaddrinfo ENOTFOUND api.x.com", said for someone who has never
 * seen a resolver error. Everything else the core says is passed on as it is.
 */
function plainMessage(message) {
  const text = String(message);
  // Two refusals about databases that point at the terminal, said for the page they arrive on.
  if (/^a version is required - see: spawnloft db versions$/.test(text)) return 'Choose a version first.';
  const dropped = /^"(.+)" is not running, so its data cannot be dropped - start it first, or detach without --drop$/.exec(text);
  if (dropped) return dropped[1] + ' is not running, so its data cannot be dropped. Start it first, or detach and keep the data.';
  const m = /^could not reach (.+?): (.+)$/is.exec(text);
  // Only a host: "could not reach schtasks to delete ..." is about a program on this computer.
  if (!m || !/^[\w.-]+(\.[a-z]{2,}|:\d+)$/i.test(m[1])) return text;
  const what = m[1];
  if (/:\d+$/.test(what)) return 'Could not reach ' + what + '. Nothing answered at that address.';
  return 'Could not reach ' + what + '. Check this computer\u2019s internet connection, then try again.';
}

async function api(path, opt) {
  let res;
  try {
    res = await fetch('/api' + path, opt);
  } catch (e) {
    // A request that was called off is not a failure to report.
    if (e && e.name === 'AbortError') throw e;
    const err = new Error(plainFailure(0));
    err.network = true;
    throw err;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error ? plainMessage(body.error) : plainFailure(res.status));
    // A refusal the page can do something about carries a code: "java-too-old" gets a
    // "create anyway" rather than a dead end.
    if (body.code) err.code = body.code;
    throw err;
  }
  return res.json();
}

const post = (path, body) => api(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body || {}),
});

