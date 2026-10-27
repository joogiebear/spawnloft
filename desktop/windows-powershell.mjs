// The signature checks run Windows PowerShell 5.1 (`powershell`). Started from PowerShell 7, it
// inherits PowerShell 7's PSModulePath, cannot load the module behind Get-AuthenticodeSignature,
// and a correctly signed file reads as unsigned. Without PSModulePath, 5.1 builds its own default.
export function windowsPowerShellEnv(env = process.env) {
  const out = {}
  for (const [key, value] of Object.entries(env)) if (key.toLowerCase() !== 'psmodulepath') out[key] = value
  return out
}
