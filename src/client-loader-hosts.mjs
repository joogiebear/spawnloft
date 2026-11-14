// Where a mod loader's files may come from (design Q5). A loader's profile or installer names its
// own download addresses, and those can only be checked against the host that served them; a
// short list keeps a bad file from pointing anywhere else. A loader that moves hosts needs a
// SpawnLoft update, which the weekly drift job flags first.
import { fail } from './util.mjs'

export const LOADER_HOSTS = [
  // Mojang's, for the libraries a loader shares with the game
  'libraries.minecraft.net',
  'piston-data.mojang.com',
  'piston-meta.mojang.com',
  // the loaders' own
  'maven.fabricmc.net',
  'meta.fabricmc.net',
  'maven.quiltmc.org',
  'meta.quiltmc.org',
  'maven.neoforged.net',
  'maven.minecraftforge.net',
  'files.minecraftforge.net',
]

export function loaderHostAllowed(url) {
  let u
  try { u = new URL(url) } catch { return false }
  return u.protocol === 'https:' && !u.username && !u.password && !u.port && LOADER_HOSTS.includes(u.hostname)
}

// what: who named the address, for the refusal ("Quilt's profile")
export function assertLoaderHost(url, what) {
  if (!loaderHostAllowed(url)) {
    fail(`${what} names a download at ${String(url).slice(0, 120)}, which is not one of the places SpawnLoft takes mod loader files from; update SpawnLoft, or pick another build`, 'loader-host-refused')
  }
  return url
}
