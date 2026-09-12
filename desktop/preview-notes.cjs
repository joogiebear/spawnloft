'use strict'
exports.renderPreviewNotes = function (text, mode) {
  if (!['signed', 'ad-hoc'].includes(mode)) throw new Error('Unknown Mac signing mode')
  const block = /<!-- MAC_DISTRIBUTION -->[\s\S]*?<!-- \/MAC_DISTRIBUTION -->/g
  if ([...text.matchAll(block)].length !== 1) throw new Error('Expected one Mac distribution note block')
  if (mode === 'ad-hoc') return text
  return text.replace(block, `The Mac app is **Developer ID signed and Apple-notarized**, with the notarization ticket
stapled to the app. Both architectures passed signature, hardened-runtime, ticket, and
Gatekeeper checks before publication. Mac updates remain manual for this beta.
If macOS blocks a downloaded build, report the exact message, app version, and macOS version.`)
}
