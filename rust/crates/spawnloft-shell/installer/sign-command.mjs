// The bundler's bundle.windows.signCommand for a signing script (Tauri 2: `cmd` and `args`, with
// %1 replaced by the file to sign). `host` is the PowerShell that has the signing module:
// pwsh.exe (PowerShell 7, where `Install-Module` from a PowerShell 7 prompt puts it, and where
// electron-builder ran it for 1.x) or powershell.exe (5.1, on every Windows machine).
// -ExecutionPolicy Bypass because the machine's policy may refuse an unsigned script from a checkout.
export function signCommand(script, host = 'powershell.exe') {
  if (/["%]/.test(script)) throw new Error(`the signing script path cannot hold " or %: ${script}`)
  if (!['powershell.exe', 'pwsh.exe'].includes(host)) throw new Error(`unknown PowerShell ${host}`)
  return { cmd: host, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '%1'] }
}
