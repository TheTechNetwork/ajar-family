# App icons

```sh
node tools/appicon/make-icon.mjs parent apple/AjarParent/App/Assets.xcassets
node tools/appicon/make-icon.mjs filter apple/AjarFilter/App/Assets.xcassets
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
