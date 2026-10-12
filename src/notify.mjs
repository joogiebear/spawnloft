// Discord webhook per instance, only for events worth waking someone for (crash, recovery,
// failed scheduled task). A dead webhook is logged and otherwise ignored.

// exported so a test can pin the payload shape
export function formatDiscord(instanceName, message) {
  return { content: `**${instanceName}** — ${message}` }
}

export function acceptableWebhook(url) {
  try {
    const u = new URL(String(url))
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

export async function notifyInstance(inst, message, { log = () => {} } = {}) {
  const url = inst?.webhook
  if (!url) return false
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(formatDiscord(inst.name, message)),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) log(`webhook answered ${res.status}`)
    return res.ok
  } catch (err) {
    log(`webhook failed: ${err.message}`)
    return false
  }
}
