#!/usr/bin/env node
/**
 * Draw an Ajar app icon: 1024x1024, opaque, no alpha channel.
 *
 *   node tools/appicon/make-icon.mjs parent apple/AjarParent/App/Assets.xcassets
 *
 * WHY THIS EXISTS. AjarParent's project.yml already set
 * ASSETCATALOG_COMPILER_APPICON_NAME, but there was no asset catalog for it to
 * name, so nothing compiled an icon and CFBundleIconName never reached the
 * Info.plist. App Store Connect rejected the upload (error 90713) after a full
 * archive and export had succeeded. A checked-in generator means the next app
 * gets an icon from a command rather than from someone remembering.
 *
 * ALPHA IS FATAL. An icon with an alpha channel is rejected outright, so this
 * writes PNG colour type 2 (truecolour, no alpha) and never composites onto
 * transparency.
 *
 * Zero dependencies — node:zlib for the DEFLATE stream, everything else by hand.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Geometry below is authored in a 1024 box; any output size samples that box,
// so every icon is the same drawing rather than a resize of a bitmap.
const BOX = 1024;

// Supersampling per axis. A 16px icon covers 64 box-units per pixel, so the
// three samples that are plenty at 1024 leave the door edge visibly ragged —
// small sizes need more, and they are cheap precisely because they are small.
const ssFor = (size) => (size >= 512 ? 3 : size >= 128 ? 4 : 8);

// Straight from web/parent/tokens.css. Not eyeballed to something close.
const PAPER = [0xf6, 0xf4, 0xee]; // --bg          Warm Paper
const PINE = [0x0d, 0x6d, 0x5e]; // --accent-strong
const CORAL = [0xff, 0x8a, 0x5b]; // --yes         Sunrise Coral

// The filter app guards; the parent app answers. Same door, inverted palette, so
// the two read as a pair on a home screen and are still told apart at a glance.
const THEMES = {
  filter: { ground: PINE, door: PAPER, light: CORAL, knob: PINE },
  parent: { ground: CORAL, door: PAPER, light: PINE, knob: CORAL },
};

// --- geometry, in a 1024 box ------------------------------------------------
const FRAME = { x0: 248, y0: 146, x1: 776, y1: 878, r: 52 };
const PANEL = { x0: 276, y0: 174, x1: 748, y1: 850, r: 28 };
const LEAF_X = 612; // where the open leaf's free edge falls
const LEAF_TOP = 215; // that edge is nearer the viewer, so it rises...
const LEAF_BOT = 800; // ...and falls, opening the wedge of light behind it
const KNOB = { cx: 564, cy: 512, r: 19 };

const inRoundRect = (x, y, { x0, y0, x1, y1, r }) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const dx = x < x0 + r ? x0 + r - x : x > x1 - r ? x - (x1 - r) : 0;
  const dy = y < y0 + r ? y0 + r - y : y > y1 - r ? y - (y1 - r) : 0;
  return dx * dx + dy * dy <= r * r;
};

/** The leaf is a quadrilateral clipped to the frame, so its hinge side keeps
 *  the frame's rounded corners instead of poking through them. */
const inLeaf = (x, y) => {
  if (!inRoundRect(x, y, PANEL)) return false;
  if (x > LEAF_X) return false;
  // Interpolate the slanted free edge across the leaf's width.
  const t = (x - PANEL.x0) / (LEAF_X - PANEL.x0);
  const top = PANEL.y0 + (LEAF_TOP - PANEL.y0) * t;
  const bot = PANEL.y1 - (PANEL.y1 - LEAF_BOT) * t;
  return y >= top && y <= bot;
};

function sample(x, y, t) {
  const dx = x - KNOB.cx;
  const dy = y - KNOB.cy;
  if (dx * dx + dy * dy <= KNOB.r * KNOB.r) return t.knob;
  if (inLeaf(x, y)) return t.door;
  if (inRoundRect(x, y, PANEL)) return t.light;
  if (inRoundRect(x, y, FRAME)) return t.door;
  return t.ground;
}

function render(theme, size = BOX) {
  const t = THEMES[theme];
  if (!t) throw new Error(`unknown theme "${theme}" (have: ${Object.keys(THEMES).join(", ")})`);
  const SS = ssFor(size);
  const scale = BOX / size; // pixel -> box units
  // One filter byte (0 = None) per scanline, then RGB triples.
  const raw = Buffer.alloc(size * (1 + size * 3));
  const step = 1 / SS;
  const off = step / 2;
  for (let py = 0; py < size; py++) {
    const rowStart = py * (1 + size * 3);
    raw[rowStart] = 0;
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample(
            (px + off + sx * step) * scale,
            (py + off + sy * step) * scale,
            t,
          );
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const n = SS * SS;
      const i = rowStart + 1 + px * 3;
      raw[i] = Math.round(r / n);
      raw[i + 1] = Math.round(g / n);
      raw[i + 2] = Math.round(b / n);
    }
  }
  return raw;
}

// --- PNG container ----------------------------------------------------------
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (const byte of buf) c = t[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body));
  return Buffer.concat([len, body, crc]);
}

function png(raw, size = BOX) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour, NO alpha (see note above)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Sizes a Safari web extension wants: `icons` uses the larger set (Apple's own
// converter template ships 48/96/128/256/512) and the toolbar `action` uses the
// small ones.
const EXTENSION_SIZES = [16, 32, 48, 96, 128, 256, 512];

const [theme, dest] = process.argv.slice(2);
if (!theme || !dest) {
  console.error("usage: make-icon.mjs <filter|parent> <path/to/Assets.xcassets>");
  console.error("       make-icon.mjs extension <path/to/Extension>");
  process.exit(2);
}

// Web-extension icons: FLAT FILES, no subdirectory. The extension's resources
// are added to the appex individually and Copy Bundle Resources flattens them
// to the bundle root (see apple/*/project.yml — a folder reference there put
// manifest.json one level down and Safari never found it). An icons/ directory
// would be collapsed the same way and every path in the manifest would break,
// so these live beside manifest.json and are referenced by bare filename.
if (theme === "extension") {
  mkdirSync(dest, { recursive: true });
  for (const size of EXTENSION_SIZES) {
    const name = `icon-${size}.png`;
    writeFileSync(join(dest, name), png(render("filter", size), size));
    console.log(`wrote ${join(dest, name)}  (${size}x${size})`);
  }
  process.exit(0);
}

const catalog = dest;
const set = join(catalog, "AppIcon.appiconset");
mkdirSync(set, { recursive: true });
writeFileSync(join(catalog, "Contents.json"), `{\n  "info" : { "author" : "xcode", "version" : 1 }\n}\n`);
writeFileSync(
  join(set, "Contents.json"),
  `{\n  "images" : [\n    {\n      "filename" : "AppIcon.png",\n      "idiom" : "universal",\n      "platform" : "ios",\n      "size" : "1024x1024"\n    }\n  ],\n  "info" : { "author" : "xcode", "version" : 1 }\n}\n`,
);
writeFileSync(join(set, "AppIcon.png"), png(render(theme)));
console.log(`wrote ${set}/AppIcon.png  (1024x1024, ${theme}, no alpha)`);
