#!/usr/bin/env python3
"""
build_bloom.py — Bloom-prefilter + PIR-input builder for the NEURLFilter PoC (PoC D).

This is the *offline dataset builder* half of the supplementary Apple
`NEURLFilter` blocklist layer described in `docs/APPLE_URL_FILTER_POC.md`
(ADR-002). It is dependency-free (Python 3 stdlib only) so it runs anywhere,
including this CI/Linux environment — unlike the Swift scaffold, which needs
Xcode 26 + an iOS 26 device.

It reads a newline-delimited list of URLs to BLOCK and emits three artifacts:

  1. <out>/bloom.bin        — the raw Bloom bit-array blob that the control
                              provider hands back inside an `NEURLFilterPrefilter`
                              (`NEURLFilterPrefilter(data:tag:bitCount:hashCount:murmurSeed:)`).
  2. <out>/bloom.meta.json  — bitCount / hashCount / murmurSeed / tag (SHA-256 of
                              bloom.bin) + parameters, so the Swift side can
                              construct the prefilter with matching numbers.
  3. <out>/input.txtpb      — the Keyword-PIR database text-proto for
                              `PIRProcessDatabase` (Apple swift-homomorphic-encryption):
                              one `rows { keyword: "<url>" value: "1" }` per URL.
                              Value is always the placeholder `1` — NEURLFilter is
                              blocklist-only (ARCHITECTURE.md §3.1, ADR-002).

## Bloom spec (must match the on-device NEURLFilter matcher)

Apple's URL-filter Bloom filter (WWDC25 session 234, "Filter and tunnel network
traffic with NetworkExtension", https://developer.apple.com/videos/play/wwdc2025/234/)
uses two 32-bit hashes with double hashing:

    h1 = FNV-1a (32-bit)
    h2 = MurmurHash3 x86_32 (32-bit, seeded with `murmurSeed`)
    bit_index(i) = (h1 + i * h2) mod bitCount      for i in 0 .. hashCount-1

Sizing from n (distinct keys) and false-positive rate p:

    bitCount  = ceil( -n * ln(p) / (ln 2)^2 )
    hashCount = max(1, round( (bitCount / n) * ln 2 ))

## Canonicalization — UNRESOLVED PoC ITEM (see doc "Key unresolved")

The exact byte form each URL is hashed in (and stored as a PIR keyword) must
match whatever the on-device NEURLFilter enumerator produces, or the Bloom
prefilter will never hit and the PIR lookup will never fire. Apple documents
that dataset URLs are Punycoded and scheme-stripped, and that the request side
is expanded by sub-URL enumeration (~48 keys). This builder implements a
CONSERVATIVE canonicalization (scheme stripped, host lowercased + IDNA/Punycode
encoded, default :443/:80 dropped, fragment dropped) and DOES NOT reproduce the
full sub-URL enumeration — it stores the single exact URL you feed it. The
precise canonical form is flagged as an open item to reconcile against a device;
adjust `canonicalize_url()` once observed on hardware.

Usage:
    python3 build_bloom.py urls.txt --p 0.001 --out-dir ./out
    python3 build_bloom.py --selftest
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
from typing import List

# --------------------------------------------------------------------------
# Hash primitives — LOAD-BEARING. Verified against known vectors in --selftest.
# --------------------------------------------------------------------------

FNV_OFFSET_BASIS_32 = 0x811C9DC5
FNV_PRIME_32 = 0x01000193
MASK32 = 0xFFFFFFFF


def fnv1a_32(data: bytes) -> int:
    """FNV-1a 32-bit hash."""
    h = FNV_OFFSET_BASIS_32
    for b in data:
        h ^= b
        h = (h * FNV_PRIME_32) & MASK32
    return h


def _rotl32(x: int, r: int) -> int:
    return ((x << r) | (x >> (32 - r))) & MASK32


def murmur3_32(data: bytes, seed: int = 0) -> int:
    """MurmurHash3 x86_32 (Austin Appleby, public domain reference)."""
    c1 = 0xCC9E2D51
    c2 = 0x1B873593
    length = len(data)
    h1 = seed & MASK32
    rounded_end = length & ~0x03  # largest multiple of 4 <= length

    for i in range(0, rounded_end, 4):
        k1 = (
            data[i]
            | (data[i + 1] << 8)
            | (data[i + 2] << 16)
            | (data[i + 3] << 24)
        ) & MASK32
        k1 = (k1 * c1) & MASK32
        k1 = _rotl32(k1, 15)
        k1 = (k1 * c2) & MASK32
        h1 ^= k1
        h1 = _rotl32(h1, 13)
        h1 = (h1 * 5 + 0xE6546B64) & MASK32

    # tail
    k1 = 0
    tail_size = length & 0x03
    if tail_size == 3:
        k1 ^= data[rounded_end + 2] << 16
    if tail_size >= 2:
        k1 ^= data[rounded_end + 1] << 8
    if tail_size >= 1:
        k1 ^= data[rounded_end]
        k1 = (k1 * c1) & MASK32
        k1 = _rotl32(k1, 15)
        k1 = (k1 * c2) & MASK32
        h1 ^= k1

    # finalization
    h1 ^= length
    h1 ^= h1 >> 16
    h1 = (h1 * 0x85EBCA6B) & MASK32
    h1 ^= h1 >> 13
    h1 = (h1 * 0xC2B2AE35) & MASK32
    h1 ^= h1 >> 16
    return h1 & MASK32


# --------------------------------------------------------------------------
# Bloom filter
# --------------------------------------------------------------------------


def bloom_params(n: int, p: float) -> tuple[int, int]:
    """Return (bitCount, hashCount) for n keys and false-positive rate p."""
    if n <= 0:
        # Degenerate empty set: 1 byte, 1 hash. Avoids div-by-zero.
        return 8, 1
    ln2 = math.log(2)
    bit_count = math.ceil(-n * math.log(p) / (ln2 * ln2))
    bit_count = max(8, bit_count)
    hash_count = max(1, round((bit_count / n) * ln2))
    return bit_count, hash_count


def bloom_indices(key: bytes, bit_count: int, hash_count: int, murmur_seed: int) -> List[int]:
    """The set of bit indices for one key, via FNV-1a + Murmur3 double hashing."""
    h1 = fnv1a_32(key)
    h2 = murmur3_32(key, murmur_seed)
    return [((h1 + i * h2) % bit_count) for i in range(hash_count)]


def build_bloom(keys: List[bytes], bit_count: int, hash_count: int, murmur_seed: int) -> bytearray:
    """Set bits for every key. Bit b lives in byte b//8, LSB-first (bit b%8)."""
    nbytes = (bit_count + 7) // 8
    bits = bytearray(nbytes)
    for key in keys:
        for idx in bloom_indices(key, bit_count, hash_count, murmur_seed):
            bits[idx >> 3] |= 1 << (idx & 7)
    return bits


def bloom_contains(bits: bytes, key: bytes, bit_count: int, hash_count: int, murmur_seed: int) -> bool:
    for idx in bloom_indices(key, bit_count, hash_count, murmur_seed):
        if not (bits[idx >> 3] & (1 << (idx & 7))):
            return False
    return True


# --------------------------------------------------------------------------
# Canonicalization  (UNRESOLVED — see module docstring / doc "Key unresolved")
# --------------------------------------------------------------------------


def canonicalize_url(raw: str) -> str:
    """
    Conservative canonical form for a dataset URL: strip scheme, lowercase +
    Punycode (IDNA) the host, drop a default :443/:80, drop the fragment.
    Path and query are preserved verbatim (case-sensitive). This mirrors the
    documented "Punycoded, scheme stripped" dataset shape but does NOT reproduce
    the device-side sub-URL enumeration. FLAGGED as an open item; adjust once the
    exact device canonicalization is observed on hardware.
    """
    s = raw.strip()
    if not s:
        return s
    # strip scheme
    if "://" in s:
        s = s.split("://", 1)[1]
    # drop fragment
    s = s.split("#", 1)[0]
    # split host[:port] from the rest (path/query)
    slash = s.find("/")
    if slash == -1:
        hostport, rest = s, ""
    else:
        hostport, rest = s[:slash], s[slash:]
    # split query off the path so we can lowercase only the host
    if ":" in hostport:
        host, port = hostport.rsplit(":", 1)
    else:
        host, port = hostport, ""
    host = host.lower()
    try:
        host = host.encode("idna").decode("ascii")  # Punycode
    except Exception:
        # Non-IDNA-encodable host (already ascii, or unusual): keep lowercased.
        pass
    if port and port not in ("80", "443"):
        host = f"{host}:{port}"
    return host + rest


# --------------------------------------------------------------------------
# PIR text-proto emission
# --------------------------------------------------------------------------


def _txtpb_escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"')


def emit_input_txtpb(urls: List[str]) -> str:
    """
    Keyword-PIR database in text-proto form for PIRProcessDatabase. Value is the
    placeholder "1" for every row — NEURLFilter datasets are blocklist-only.
    """
    lines = [
        "# Keyword-PIR database for NEURLFilter blocklist (PoC D).",
        "# Generated by build_bloom.py. Value is always \"1\" (blocklist-only).",
        "# Consume with: PIRProcessDatabase (apple/swift-homomorphic-encryption).",
    ]
    for u in urls:
        lines.append(f'rows {{ keyword: "{_txtpb_escape(u)}" value: "1" }}')
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------
# Driver
# --------------------------------------------------------------------------


def read_url_list(path: str) -> List[str]:
    out: List[str] = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            out.append(line)
    return out


def build(input_path: str, p: float, out_dir: str, murmur_seed: int) -> dict:
    raw_urls = read_url_list(input_path)
    canon = [canonicalize_url(u) for u in raw_urls]
    # de-dup, preserve order
    seen = set()
    urls: List[str] = []
    for u in canon:
        if u not in seen:
            seen.add(u)
            urls.append(u)

    n = len(urls)
    bit_count, hash_count = bloom_params(n, p)
    keys = [u.encode("utf-8") for u in urls]
    bits = build_bloom(keys, bit_count, hash_count, murmur_seed)

    os.makedirs(out_dir, exist_ok=True)
    bloom_path = os.path.join(out_dir, "bloom.bin")
    with open(bloom_path, "wb") as fh:
        fh.write(bits)

    tag = hashlib.sha256(bits).hexdigest()

    meta = {
        "bitCount": bit_count,
        "hashCount": hash_count,
        "murmurSeed": murmur_seed,
        "byteCount": len(bits),
        "keyCount": n,
        "falsePositiveRate": p,
        "tag": tag,
        "hashSpec": "FNV-1a-32 (h1) + MurmurHash3-x86_32 (h2, seeded); "
        "bit(i)=(h1+i*h2) mod bitCount; bit b in byte b//8 LSB-first",
        "note": "Canonicalization is an UNRESOLVED PoC item; verify against device.",
    }
    with open(os.path.join(out_dir, "bloom.meta.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)
        fh.write("\n")

    with open(os.path.join(out_dir, "input.txtpb"), "w", encoding="utf-8") as fh:
        fh.write(emit_input_txtpb(urls))

    # sanity: every stored key must be reported present by the same matcher.
    for k in keys:
        assert bloom_contains(bits, k, bit_count, hash_count, murmur_seed), (
            "internal error: stored key missed by its own Bloom filter"
        )

    return meta


# --------------------------------------------------------------------------
# Self-test — known-answer vectors for the load-bearing hashes.
# --------------------------------------------------------------------------


def selftest() -> None:
    # FNV-1a 32-bit known vectors.
    assert fnv1a_32(b"") == 0x811C9DC5, hex(fnv1a_32(b""))
    assert fnv1a_32(b"a") == 0xE40C292C, hex(fnv1a_32(b"a"))
    assert fnv1a_32(b"foobar") == 0xBF9CF968, hex(fnv1a_32(b"foobar"))

    # MurmurHash3 x86_32 known vectors.
    assert murmur3_32(b"", 0) == 0x00000000, hex(murmur3_32(b"", 0))
    assert murmur3_32(b"", 1) == 0x514E28B7, hex(murmur3_32(b"", 1))
    assert murmur3_32(b"test", 0) == 0xBA6BD213, hex(murmur3_32(b"test", 0))
    assert murmur3_32(b"Hello, world!", 0) == 0xC0363E43, hex(murmur3_32(b"Hello, world!", 0))
    assert (
        murmur3_32(b"The quick brown fox jumps over the lazy dog", 0) == 0x2E4FF723
    ), hex(murmur3_32(b"The quick brown fox jumps over the lazy dog", 0))

    # Bloom round-trip: stored keys hit, an absent key (very likely) misses.
    bit_count, hash_count, seed = 4096, 7, 0x9747B28C
    keys = [b"youtube.com/watch?v=9bZkp7q19f0", b"malware.example.test/bad"]
    bits = build_bloom(keys, bit_count, hash_count, seed)
    for k in keys:
        assert bloom_contains(bits, k, bit_count, hash_count, seed)
    assert not bloom_contains(
        bits, b"youtube.com/watch?v=dQw4w9WgXcQ", bit_count, hash_count, seed
    ), "unexpected Bloom false positive in self-test (change is not fatal, but flag it)"

    # Sizing sanity.
    bc, hc = bloom_params(1000, 0.001)
    assert bc > 0 and hc >= 1

    print("selftest OK: FNV-1a, MurmurHash3 x86_32, and Bloom round-trip all pass.")


def main(argv: List[str]) -> int:
    ap = argparse.ArgumentParser(description="Build an NEURLFilter Bloom prefilter + PIR input.txtpb.")
    ap.add_argument("input", nargs="?", help="newline-delimited URL blocklist")
    ap.add_argument("--p", type=float, default=0.001, help="target false-positive rate (default 0.001)")
    ap.add_argument("--out-dir", default="./out", help="output directory (default ./out)")
    ap.add_argument(
        "--murmur-seed",
        type=lambda x: int(x, 0),
        default=0x9747B28C,
        help="MurmurHash3 seed used for h2 (default 0x9747b28c); must match the "
        "murmurSeed passed to NEURLFilterPrefilter on-device",
    )
    ap.add_argument("--selftest", action="store_true", help="run known-answer hash tests and exit")
    args = ap.parse_args(argv)

    if args.selftest:
        selftest()
        return 0

    if not args.input:
        ap.error("input file is required (or pass --selftest)")

    meta = build(args.input, args.p, args.out_dir, args.murmur_seed)
    print(json.dumps(meta, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
