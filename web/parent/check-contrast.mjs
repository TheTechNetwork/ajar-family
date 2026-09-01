#!/usr/bin/env node
/**
 * Verify the contrast ratios the design system CLAIMS.
 *
 *   node web/parent/check-contrast.mjs           # assert every pair, exit 1 on failure
 *   node web/parent/check-contrast.mjs --report  # print computed ratios (to update docs/BRAND.md)
 *
 * WHY THIS EXISTS. tokens.css asserts "every colour pair a surface actually
 * renders was computed with the WCAG relative-luminance formula, not eyeballed",
 * and docs/BRAND.md carries ~32 specific ratios. Until now NOTHING checked any
 * of them: sync-tokens.mjs only diffs the four inline copies against the
 * canonical sheet, so a hex could change and leave its ratio comment stale, or a
 * number could simply be written down wrong.
 *
 * That is not hypothetical. A focus ring in this palette was documented at
 * 15.91:1 when the value that mattered — the ring against the teal primary
 * button — was 2.59:1, a 6x error that read as compliant. Hand-computed ratios
 * in comments are prose, and prose does not fail CI. This does.
 *
 * Thresholds: WCAG 2.2 SC 1.4.3 (text) = 4.5:1, SC 1.4.11 (UI components and
 * focus indicators) = 3:1. Decorative-only tokens (--line) are exempt by the
 * same SC and are deliberately absent from the table below.
 *
 * Zero dependencies, Node stdlib only — same constraint as sync-tokens.mjs.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "tokens.css"), "utf8");

// ---- WCAG 2.x relative luminance ------------------------------------------
const channel = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
function luminance(hex) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function ratio(a, b) {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// ---- Extract the three token scopes ---------------------------------------
// Light lives in bare `:root`; dark is defined TWICE — once behind the media
// query and once under [data-theme="dark"] so an explicit toggle beats the
// query in both directions. Two copies of the same palette is a drift vector of
// exactly the kind this file exists to catch, so they are compared below.
function scope(startRe) {
  const i = css.search(startRe);
  if (i < 0) throw new Error(`token scope not found: ${startRe}`);
  const body = css.slice(i, css.indexOf("}", i));
  const out = {};
  for (const [, name, value] of body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    out[name] = value.toLowerCase();
  }
  return out;
}
const light = scope(/:root\s*\{\s*\n\s*color-scheme/);
const darkMedia = scope(/:root:not\(\[data-theme="light"\]\)\s*\{/);
const darkToggle = scope(/:root\[data-theme="dark"\]\s*\{/);

// ---- The pairs a surface actually renders ---------------------------------
// [foreground, background, threshold, what renders it]
const TEXT = 4.5, UI = 3;
const PAIRS = [
  ["ink", "bg", TEXT, "body text on the page ground"],
  ["ink", "surface", TEXT, "body text on a card"],
  ["ink", "surface-2", TEXT, "body text in a well"],
  ["ink-2", "surface", TEXT, "secondary text / form labels"],
  ["ink-2", "bg", TEXT, "secondary text on the ground"],
  ["muted", "surface", TEXT, "metadata and helper text"],
  ["muted", "surface-2", TEXT, "helper text inside a well"],
  ["muted", "bg", TEXT, "metadata on the ground"],
  ["accent-ink", "surface", TEXT, "teal links and the wordmark"],
  ["accent-ink", "bg", TEXT, "teal text on the ground"],
  ["accent-ink", "accent-wash", TEXT, "teal text in a chip / code block"],
  ["on-accent", "accent-strong", TEXT, "the primary button label"],
  ["yes-ink", "yes", TEXT, "the approve button label"],
  ["yes-ink", "yes-strong", TEXT, "approve button label, hover"],
  ["warn", "surface", TEXT, "the asked / waiting status word"],
  ["warn", "warn-wash", TEXT, "the waiting word on its own panel / status pill"],
  ["err", "surface", TEXT, "error text"],
  ["err", "err-wash", TEXT, "error text on its own panel"],
  ["ok", "ok-wash", TEXT, "the done word on its success panel"],
  // SC 1.4.11 — boundaries and focus indicators, not text.
  ["field-line", "surface", UI, "input / select / secondary-button border"],
  ["field-line", "bg", UI, "field border against the ground"],
  // The ring is `0 0 0 2px var(--focus-halo), 0 0 0 5px var(--focus)`: the halo
  // is the INNER band, sitting on the control, and --focus is the OUTER band,
  // sitting on the page. Perceptibility is carried by the outer band against the
  // page ground — that is the pair SC 1.4.11 turns on, and it is asserted here.
  ["focus", "bg", UI, "focus ring outer band against the page ground"],
  ["focus", "surface", UI, "focus ring outer band against a card"],
  ["focus", "focus-halo", UI, "the two ring bands against each other"],
  // NOT asserted: halo-against-fill. --focus-halo is deliberately the surface
  // colour, so against a plain card it is 1.00:1 and invisible BY DESIGN — it is
  // a spacer that keeps the dark outer band off a coloured fill, not a band that
  // has to be seen. On coloured fills it lands at 3.26:1 (light teal), 2.32:1
  // (light coral), 6.02:1 and 6.44:1 (dark). The 2.32:1 is why the claim "both
  // bands clear 3:1 against whatever they touch" was wrong and has been corrected
  // in tokens.css; it is not a failure, because the outer band above is what
  // makes the focus state perceivable.
];

let failures = 0;
const rows = [];
for (const [theme, tokens] of [["light", light], ["dark", darkMedia]]) {
  for (const [fg, bg, min, what] of PAIRS) {
    const a = tokens[fg] ?? light[fg], b = tokens[bg] ?? light[bg];
    if (!a || !b) { console.error(`✗ ${theme}: unknown token in pair --${fg} / --${bg}`); failures++; continue; }
    const r = ratio(a, b);
    const ok = r >= min;
    if (!ok) {
      console.error(`✗ ${theme}  --${fg} on --${bg}  ${r.toFixed(2)}:1  < ${min}:1 required  (${what})`);
      failures++;
    }
    rows.push(`${ok ? "✓" : "✗"} ${theme.padEnd(5)} --${fg} on --${bg}`.padEnd(46) +
      `${r.toFixed(2)}:1`.padStart(9) + `  (min ${min}:1)  ${what}`);
  }
}

// ---- Every surface that PAINTS the coral fill must also draw its edge ------
//
// The pairs above check token against token. They cannot see whether a given
// surface actually drew the border a token pair assumes — and that gap is not
// theoretical: coral measures 2.32:1 on a white card, tokens.css says so and
// requires `.btn-yes` to carry `border-color: var(--yes-ink)`, and FOUR
// surfaces re-implemented the button and dropped it. The most important control
// in the product had no perceivable boundary (SC 1.4.11) on the marketing site,
// all five signup steps, the iOS block page and both Swift apps — while this
// script printed "contrast ok" on every run.
//
// So the inventory is explicit, in the same spirit as sync-tokens.mjs: naming
// the surfaces is what makes a NEW one fail loudly instead of silently.
// Adding a surface that paints coral means adding it here.
const CORAL_SURFACES = [
  // [file, how the fill is written, how the edge must be written]
  ["web/parent/tokens.css", /\.btn-yes\b[^}]*\{[^}]*background:\s*var\(--yes\)/,
                            /\.btn-yes\b[^}]*\{[^}]*border-color:\s*var\(--yes-ink\)/],
  ["web/site/index.html", /background:\s*var\(--yes\)/, /border-color:\s*var\(--yes-ink\)/],
  ["web/site/signup.html", /background:\s*var\(--yes\)/, /border:\s*1px solid var\(--yes-ink\)/],
  // The iOS block page is NOT in this list any more, and that is the point:
  // BRAND.md reserves coral for the parent's yes, and this page carries the
  // CHILD'S ASK, which both extension block pages have always drawn in teal.
  // Asserted below as an absence, so it cannot drift back to coral unnoticed.
  // SwiftUI writes the same two facts as a fill and an overlay stroke.
  ["apple/AjarParent/App/Theme.swift", /\.background\(Ajar\.yes/, /\.stroke\(Ajar\.yesInk/],
  ["apple/AjarFilter/App/Theme.swift", /\.background\(Ajar\.yes/, /\.stroke\(Ajar\.yesInk/],
];

const repoRoot = join(here, "..", "..");
for (const [rel, fill, edge] of CORAL_SURFACES) {
  let text;
  try { text = readFileSync(join(repoRoot, rel), "utf8"); }
  catch { console.error(`✗ ${rel}: listed as a coral surface but the file is gone — remove it here or restore it`); failures++; continue; }
  if (!fill.test(text)) {
    // Not a pass. Either the button moved, in which case this entry is stale and
    // is no longer checking anything, or the fill is written a new way that the
    // edge check would also miss.
    console.error(`✗ ${rel}: no coral fill found (${fill}) — this entry has gone stale and is checking nothing`);
    failures++;
    continue;
  }
  if (!edge.test(text)) {
    console.error(`✗ ${rel}: paints --yes but never draws its border (${edge}). ` +
      "Coral is 2.32:1 on a light surface; without an edge the control fails SC 1.4.11.");
    failures++;
  }
}

// The one surface that must NOT paint coral. Spending it on the child's ask
// left the same colour meaning "ask" on one screen and "yes" on the next.
{
  const rel = "backend/src/http/api.ts";
  const text = readFileSync(join(repoRoot, rel), "utf8");
  const blockPage = text.slice(text.indexOf(".btn {"), text.indexOf(".foot {"));
  if (/background:\s*var\(--yes\)/.test(blockPage)) {
    console.error(`✗ ${rel}: the block page's ask button paints --yes. Coral is reserved ` +
      "for the parent's yes (BRAND.md); the child's ask is --accent-strong on both other block pages.");
    failures++;
  }
}

// ---- Dark defined twice must BE twice the same ----------------------------
for (const name of new Set([...Object.keys(darkMedia), ...Object.keys(darkToggle)])) {
  if (darkMedia[name] !== darkToggle[name]) {
    console.error(`✗ dark palette drift: --${name} is ${darkMedia[name] ?? "(absent)"} under the media ` +
      `query but ${darkToggle[name] ?? "(absent)"} under [data-theme="dark"] — the toggle and the ` +
      "system setting would render different colours");
    failures++;
  }
}

if (process.argv.includes("--report")) console.log(rows.join("\n"));

if (failures > 0) {
  console.error(`\n${failures} contrast failure(s). Fix the token, or if the pair is genuinely ` +
    "decorative remove it from PAIRS with a comment saying why.");
  process.exit(1);
}
console.log(`contrast ok — ${PAIRS.length * 2} pairs across both themes, plus dark-palette parity`);
