import fs from 'node:fs'

// A page of the panel (src/panel/<file>) as one text again: each stylesheet and script it loads
// from /assets/ is put back in place of the tag that loads it, in the order the browser loads
// them. The page tests lift functions and check text in what the browser runs, wherever the
// file it lives in.
export function pageSource(file) {
  const dir = new URL('../src/panel/', import.meta.url)
  const read = (name) => fs.readFileSync(new URL(name, dir), 'utf8')
  return read(file)
    .replace(/<link rel="stylesheet" href="\/assets\/([^"]+)">/g, (_, name) => `<style>\n${read(name)}</style>`)
    .replace(/<script src="\/assets\/([^"]+)"><\/script>/g, (_, name) => `<script>\n${read(name)}</script>`)
}
