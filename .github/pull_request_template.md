## What this changes, and why

<!-- One reason per PR. The why matters more than the what - the diff already shows the what. -->

## How it was verified

<!-- Tests added or run, and if it touches the panel or a server lifecycle, what you did by hand. -->

- [ ] `npm test` passes
- [ ] Commit messages carry conventional prefixes (`feat:`, `fix:`, ...)
- [ ] No runtime dependencies added, and nothing a package has to build (if a panel page uses a new Tailwind class: `node tools/panel-css.mjs`, and commit `src/panel/css/tailwind.css`)
