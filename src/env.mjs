// Environment names. SpawnLoft reads SPAWNLOFT_<NAME> first and the older MCCTL_<NAME> second, and
// keeps reading the old one: launchd plists written by earlier versions set MCCTL_DATA_ROOT for as long
// as they exist. New shims and plists write only the SPAWNLOFT_ spelling.
export function envVar(name, env = process.env) {
  return env[`SPAWNLOFT_${name}`] || env[`MCCTL_${name}`] || undefined
}
