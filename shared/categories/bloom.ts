/**
 * Compact on-device category membership — the answer to "we can't ship millions
 * of domains and we can't call the backend per URL."
 *
 * A Bloom filter stores a set of domains in a few bits each (≈1.7 MB per million
 * at a 0.1% false-positive rate) and answers "is this domain in category X?" in
 * O(k) with NO network. The backend compiles one filter per category from the
 * datastore; the device downloads the versioned filter SET once, caches it, and
 * queries it locally. It is delivered as a data asset (not baked into the app
 * binary, so no size hit and no app update to refresh) and refreshed only when
 * its version changes.
 *
 * Tradeoff: a Bloom filter can say "maybe present" for a domain that isn't in
 * the set (false positive; tunable, never a false *negative*). Under default-deny
 * category blocking that is FAIL-SAFE — at worst a safe site is briefly
 * over-blocked, never a blocked one leaked — and the existing request→approve
 * loop clears it (a URL/DOMAIN ALLOW sits above the CATEGORY tier). On Apple 26
 * the OS runs this exact Bloom prefilter and adds a private PIR confirm to erase
 * the false positives without revealing the URL; that is the same shape, one
 * layer deeper.
 *
 * This module is dependency-free and runs identically on Node, Cloudflare
 * Workers, and the browser-extension service workers, so the backend that BUILDS
 * a filter and the client that QUERIES it agree bit-for-bit.
 */
import { hostCandidates } from "./category-data.js";

/** Serialized filter: everything a client needs to query it, JSON-friendly. */
export interface SerializedBloom {
  m: number; // bit count
  k: number; // hash count
  n: number; // element count (for stats / rebuild decisions)
  bits: string; // base64 of the m/8 bytes
}

/** A signed, versioned set of per-category filters (the downloadable asset). */
export interface CategoryFilterSet {
  version: number;
  filters: Record<string, SerializedBloom>; // category slug → filter
}

// FNV-1a (32-bit) with two offset bases → two independent hashes; the k probe
// positions come from Kirsch–Mitzenmacher double hashing. Fixed constants so
// builder and querier are byte-compatible forever.
const FNV_PRIME = 0x01000193;
const SEED_A = 0x811c9dc5;
const SEED_B = 0x85ebca77;

function fnv1a(bytes: Uint8Array, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

const enc = new TextEncoder();

function indices(item: string, m: number, k: number): number[] {
  const bytes = enc.encode(item);
  const h1 = fnv1a(bytes, SEED_A);
  let h2 = fnv1a(bytes, SEED_B) | 1; // odd, so it strides the whole space
  const out = new Array<number>(k);
  let x = h1 >>> 0;
  for (let i = 0; i < k; i++) {
    out[i] = x % m;
    x = (x + h2) >>> 0;
    h2 = (h2 + i) >>> 0; // enhanced double hashing — decorrelate the probes
  }
  return out;
}

// Optimal parameters for n items at target false-positive rate p.
function paramsFor(n: number, p: number): { m: number; k: number } {
  const nn = Math.max(1, n);
  let m = Math.ceil(-(nn * Math.log(p)) / (Math.LN2 * Math.LN2));
  m = Math.max(8, Math.ceil(m / 8) * 8); // byte-aligned
  const k = Math.max(1, Math.round((m / nn) * Math.LN2));
  return { m, k };
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  // btoa exists on Workers + browsers.
  return btoa(s);
}
function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Build a filter over `items` (deduped, normalized upstream). */
export function buildBloom(items: string[], falsePositiveRate = 0.001): SerializedBloom {
  const uniq = [...new Set(items)];
  const { m, k } = paramsFor(uniq.length, falsePositiveRate);
  const bits = new Uint8Array(m / 8);
  for (const item of uniq) {
    for (const idx of indices(item, m, k)) bits[idx >>> 3]! |= 1 << (idx & 7);
  }
  return { m, k, n: uniq.length, bits: bytesToBase64(bits) };
}

/** Query: is `item` (probably) in the filter? False positives possible; false
 *  negatives impossible. */
export function bloomHas(f: SerializedBloom, item: string): boolean {
  const bits = base64ToBytes(f.bits);
  for (const idx of indices(item, f.m, f.k)) {
    if ((bits[idx >>> 3]! & (1 << (idx & 7))) === 0) return false;
  }
  return true;
}

/**
 * A prepared filter set that caches decoded bit arrays so repeated queries (one
 * per navigation) don't re-decode base64. Build once from a fetched
 * `CategoryFilterSet`, then call `categoriesForHost` on the hot path.
 */
export class CategoryFilters {
  private decoded = new Map<string, { m: number; k: number; bits: Uint8Array }>();
  readonly version: number;

  constructor(set: CategoryFilterSet) {
    this.version = set.version;
    for (const [cat, f] of Object.entries(set.filters)) {
      this.decoded.set(cat, { m: f.m, k: f.k, bits: base64ToBytes(f.bits) });
    }
  }

  /** Categories whose filter contains any of the host's registrable candidates. */
  categoriesForHost(host: string): Set<string> {
    const out = new Set<string>();
    const cands = hostCandidates(host);
    if (cands.length === 0) return out;
    for (const [cat, f] of this.decoded) {
      for (const cand of cands) {
        let hit = true;
        for (const idx of indices(cand, f.m, f.k)) {
          if ((f.bits[idx >>> 3]! & (1 << (idx & 7))) === 0) { hit = false; break; }
        }
        if (hit) { out.add(cat); break; }
      }
    }
    return out;
  }
}
