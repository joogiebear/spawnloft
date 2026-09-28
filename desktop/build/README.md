# Build Assets

| File | Purpose |
| --- | --- |
| `icon.svg` | Source artwork. The only file to edit. |
| `icon.ico` | Windows icon: 16, 24, 32, 48, 64, 128 and 256 px |
| `icon.png` | 256 px raster, kept for documentation and release notes |
| `icon-mac.png` | 1024 px raster for the Mac app bundle |
| `installer.nsh` | NSIS installer customization |
| `entitlements.spawnloft.plist` | macOS hardened-runtime entitlements (V8 JIT) |
| `linux/spawnloft` | Linux command launcher |

## `icon.svg`

A lapis block seen as a machine. Minecraft supplies the cube and the colour (lapis is a block, not a brand blue). The lit vent on the shaded face makes it a server; it uses the same signal the panel shows for a running instance, so the taskbar icon and the app agree about what "on" looks like.

The icon is drawn for 16 px first. The vent is deliberately oversized and near-white so it survives downscaling as a bright band, and the block is mid-value lapis so the silhouette holds on both a dark taskbar and a light Explorer window.

## `icon.ico`

Sizes below 256 px are classic 32-bit DIB entries with an AND mask, which every Windows shell code path understands. The 256 px entry is PNG, the only form allowed at that size. An all-PNG icon usually works and occasionally does not.

electron-builder picks up `build/icon.ico` automatically for the executable, installer, uninstaller and Start Menu entry. `main.js` also points `BrowserWindow` at it explicitly, because an unpackaged `npm start` does not get it otherwise.

### Regenerating

1. Edit `icon.svg`.
2. Rasterize it to PNG at each of the seven sizes with a renderer that antialiases properly (a browser canvas does).
3. Pack the `.ico`: DIB for sizes below 256 px, PNG for 256 px.

Do not resample one large bitmap down to 16 px; the vent turns to mush.

## `icon-mac.png`

`icon.svg` rasterized at 1024 px. macOS packaging requires at least 512 px, so regenerate it from the SVG rather than enlarging `icon.png`. The Mac configuration converts it to the bundle's ICNS icon during packaging.
