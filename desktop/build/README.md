# Build assets

## `icon.svg` — the source

One lapis block, seen as a machine. Minecraft supplies the cube and the colour (lapis is a block,
not a brand blue); the lit vent on the shaded face is what makes it a server rather than a generic
isometric logo. The vent uses the same signal the panel uses for a running instance, so the taskbar
icon and the app agree about what "this is on" looks like.

Drawn for 16px first. A taskbar icon that only works at 256 is decoration — the vent is deliberately
oversized and near-white so it survives the downscale as a bright band, and the block is mid-value
lapis so the silhouette holds on both a dark taskbar and a light Explorer window.

## `icon.ico` — what ships

Seven sizes: 16, 24, 32, 48, 64, 128, 256. Everything below 256 is a classic 32-bit DIB entry with
an AND mask, which is what every Windows shell code path has always understood; 256 is PNG, which is
the only way it is allowed to be. An all-PNG icon usually works and occasionally does not, and
"occasionally" is not a property you want in the first thing a stranger sees.

electron-builder picks this up automatically from `build/icon.ico` for the executable, the installer,
the uninstaller and the Start Menu entry. `main.js` points `BrowserWindow` at it explicitly as well,
because an unpackaged `npm start` does not get it for free.

### Regenerating

`icon.svg` is the only thing to edit. To rebuild the `.ico` after changing it, rasterise the SVG to
PNGs at the seven sizes above with a renderer that antialiases properly (a browser canvas does), then
pack them — small sizes as DIB, 256 as PNG. Do not let an image tool resample one large bitmap down
to 16px; the vent turns to mush.

## `icon.png`

The 256px raster, kept alongside for documentation and release notes.

## `icon-mac.png`

The same SVG rasterized at 1024px for the Mac app bundle. macOS packaging requires
at least 512px; regenerate this from `icon.svg` instead of enlarging the 256px image.
The Mac preview configuration converts it to the bundle's ICNS icon during packaging.
