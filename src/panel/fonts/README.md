# The panel's typefaces

Compiled into the core and served at `/assets/fonts/` (`rust/crates/spawnloft-lib/build.rs`
takes the `.woff2` files only). `src/panel/css/tokens.css` names each one in an `@font-face`;
a test in `panel/pages.rs` fails if a file here is not named there or the other way round.

| File | Family | Licence |
|---|---|---|
| `bricolage-grotesque-latin.woff2`, `bricolage-grotesque-latin-ext.woff2` | Bricolage Grotesque (headings, big numbers) | SIL OFL 1.1, `OFL-bricolagegrotesque.txt` |
| `inter-latin.woff2`, `inter-latin-ext.woff2` | Inter (everything else) | SIL OFL 1.1, `OFL-inter.txt` |
| `jetbrains-mono-latin.woff2`, `jetbrains-mono-latin-ext.woff2` | JetBrains Mono (console, paths, addresses) | SIL OFL 1.1, `OFL-jetbrainsmono.txt` |

Each is the variable font as Google Fonts serves it, split into Latin and Latin Extended so a
page only loads the second when it has a letter from it. See `rust/SUPPLY-CHAIN.md` before
replacing one.
