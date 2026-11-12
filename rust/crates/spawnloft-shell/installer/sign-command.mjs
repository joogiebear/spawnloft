// The bundler's bundle.windows.signCommand for a signing script (Tauri 2: `cmd` and `args`, with
// %1 replaced by the file to sign). Windows PowerShell 5.1 is on every Windows machine, so the
// script needs nothing else installed to start; -ExecutionPolicy Bypass because the machine's
// policy may refuse an unsigned script from a checkout.
export function signCommand(script) {
  if (/["%]/.test(script)) throw new Error(`the signing script path cannot hold " or %: ${script}`)
  return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '%1'] }
}
