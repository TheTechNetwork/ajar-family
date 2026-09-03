# App icons

```sh
node tools/appicon/make-icon.mjs parent apple/AjarParent/App/Assets.xcassets
node tools/appicon/make-icon.mjs filter apple/AjarFilter/App/Assets.xcassets
node tools/appicon/make-icon.mjs extension apple/SafariExtension/Extension
```

Writes `AppIcon.appiconset/AppIcon.png` — 1024x1024, opaque, plus both
`Contents.json` files. Zero dependencies; `node:zlib` and a scanline rasterizer.

**Why a generator and not just a PNG in the repo.** `AjarParent`'s `project.yml`
already named `ASSETCATALOG_COMPILER_APPICON_NAME`, but no asset catalog existed
for it to name. Nothing compiled an icon, `CFBundleIconName` never reached the
Info.plist, and App Store Connect rejected the upload with error 90713 *after* a
full archive and export had succeeded. A command is harder to forget than a
binary someone has to remember to draw.

**Alpha is fatal.** Apple rejects an icon with an alpha channel, so this writes
PNG colour type 2 (truecolour, no alpha) and never composites onto transparency.

**The palette is not eyeballed.** `PAPER`, `PINE` and `CORAL` are lifted from
`web/parent/tokens.css`. The filter app guards and the parent app answers, so
they share the door and invert the palette: teal ground for the filter, coral —
the "yes" colour — for the parent.

**`apple/AjarFilter`'s committed icon predates this tool** and was drawn
elsewhere. Running the `filter` theme here produces a deliberate sibling of it,
not a byte-identical copy. It is not regenerated, because that icon is already in
a shipped build and the geometry here was matched by eye.

## The Safari extension's icons

`extension` writes `icon-16/32/48/96/128/256/512.png` for the web extension's
`icons` (48 and up, matching Apple's own converter template) and its toolbar
`action.default_icon` (16/32/48). It always uses the `filter` theme: the
extension ships inside the filter app on iOS and the macOS container, so it is
that app's door, not a third mark.

**They are flat files beside `manifest.json`, and they have to be.** The
extension's resources are added to the appex individually, and Copy Bundle
Resources flattens them to the bundle root — that is the whole reason
`project.yml` does not use a folder reference there. An `icons/` directory would
be collapsed the same way and every path in the manifest would resolve to
nothing, which Safari reports by doing nothing at all.
`apple/check-project-yml.mjs` fails if a manifest path contains a `/` or names a
file that is not there.

Geometry is authored once in a 1024 box and sampled per output size, so a 16px
icon is the same drawing rather than a downscaled bitmap; supersampling rises as
the size falls, because three samples per axis leave the door edge ragged when
one pixel covers 64 box-units.
