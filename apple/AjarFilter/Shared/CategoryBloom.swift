import Foundation

/// QUERY-side Swift port of `shared/categories/bloom.ts`, bit-for-bit compatible
/// with the builder in the backend. The build side is deliberately NOT ported —
/// devices only ever query.
///
/// The asset is `GET /v1/categories/filters` → `{ set, signature }` (or
/// `{ upToDate: true }`), where `signature` is Ed25519 over the canonical JSON of
/// `set` (backend `signCanonical`). `CategoryFilterStore` verifies it before this
/// class ever sees it.
///
/// COMPATIBILITY IS THE WHOLE POINT: if any of the arithmetic below diverges from
/// the TypeScript by one bit, every category lookup silently returns the wrong
/// answer (usually "not a member" → under-blocking). `PolicySelfTest` in
/// `SelfTest.swift` carries hand-computed vectors that pin the hash, the probe
/// sequence, and a whole 32-bit filter. RUN IT FIRST.
///
/// NOT COMPILED OR RUN.
public struct SerializedBloom: Codable, Equatable {
    public var m: Int      // bit count
    public var k: Int      // hash count
    public var n: Int      // element count (stats only)
    public var bits: String // base64 of the m/8 bytes
}

public struct CategoryFilterSet: Codable, Equatable {
    public var version: Int
    public var filters: [String: SerializedBloom]
}

/// The signed envelope the backend serves for the filter asset.
public struct CategoryFilterAsset: Codable {
    public var set: CategoryFilterSet?
    public var signature: String?
    public var upToDate: Bool?
}

public enum Bloom {

    // Fixed constants — "so builder and querier are byte-compatible forever".
    static let fnvPrime: UInt32 = 0x0100_0193
    static let seedA: UInt32 = 0x811c_9dc5
    static let seedB: UInt32 = 0x85eb_ca77

    /// FNV-1a 32-bit over UTF-8 bytes with an injectable offset basis.
    ///
    /// TS: `h ^= bytes[i]; h = Math.imul(h, FNV_PRIME) >>> 0;`
    /// `Math.imul` is a signed 32-bit multiply whose result is then coerced to
    /// unsigned — that is exactly UInt32 wrapping multiply (`&*`), because both
    /// are "the low 32 bits of the product".
    public static func fnv1a(_ bytes: [UInt8], seed: UInt32) -> UInt32 {
        var h = seed
        for b in bytes {
            h ^= UInt32(b)
            h = h &* fnvPrime
        }
        return h
    }

    /// The k probe positions for `item`, enhanced double hashing.
    ///
    /// TS:
    /// ```
    /// const h1 = fnv1a(bytes, SEED_A);
    /// let h2 = fnv1a(bytes, SEED_B) | 1;   // odd, so it strides the whole space
    /// let x = h1 >>> 0;
    /// for (let i = 0; i < k; i++) {
    ///   out[i] = x % m;
    ///   x  = (x + h2) >>> 0;
    ///   h2 = (h2 + i) >>> 0;               // decorrelate the probes
    /// }
    /// ```
    /// SUBTLETY: in JS `h2` is a *signed* int32 after `| 1` (it can be negative),
    /// and the additions happen in float64 before `>>> 0` truncates. Because
    /// `ToUint32(a + b) == (a + b) mod 2^32` and a negative int32 is congruent
    /// mod 2^32 to its unsigned bit pattern, the whole sequence is plain UInt32
    /// wrap-around arithmetic. Hence `&+` here with no sign handling — this is
    /// the single easiest place to get a silent mismatch, so it is spelled out.
    public static func indices(_ item: String, m: Int, k: Int) -> [UInt32] {
        precondition(m > 0 && k > 0, "degenerate bloom parameters")
        let bytes = Array(item.utf8)
        let h1 = fnv1a(bytes, seed: seedA)
        var h2 = fnv1a(bytes, seed: seedB) | 1
        var x = h1
        let mu = UInt32(m)
        var out = [UInt32]()
        out.reserveCapacity(k)
        for i in 0..<k {
            out.append(x % mu)
            x = x &+ h2
            h2 = h2 &+ UInt32(i)
        }
        return out
    }

    /// Membership probe over a decoded bit array. TS `bloomHas`.
    /// False positives are possible by construction; false negatives are not.
    public static func has(bits: [UInt8], m: Int, k: Int, item: String) -> Bool {
        for idx in indices(item, m: m, k: k) {
            let byte = Int(idx >> 3)
            guard byte < bits.count else { return false } // truncated/garbage asset → miss
            if bits[byte] & (1 << (idx & 7)) == 0 { return false }
        }
        return true
    }
}

/// Prepared filter set: decodes base64 once so the hot path (one query per
/// navigation) does bit tests only. Mirror of the TS `CategoryFilters` class.
public final class CategoryFilters {

    private struct Decoded { let m: Int; let k: Int; let bits: [UInt8] }
    private let decoded: [String: Decoded]
    public let version: Int

    public init?(set: CategoryFilterSet) {
        var d: [String: Decoded] = [:]
        for (category, f) in set.filters {
            guard f.m > 0, f.k > 0, f.m % 8 == 0,
                  let raw = Data(base64Encoded: f.bits),
                  raw.count == f.m / 8 else {
                // A malformed filter is not silently treated as "empty" — an
                // empty filter answers "not a member" for everything, which
                // would quietly disable category blocking. Reject the asset.
                return nil
            }
            d[category] = Decoded(m: f.m, k: f.k, bits: [UInt8](raw))
        }
        self.decoded = d
        self.version = set.version
    }

    /// Categories whose filter contains any of the host's registrable candidates.
    /// Mirror of the TS `categoriesForHost` (same early-out, same break).
    public func categories(for host: String) -> Set<String> {
        var out = Set<String>()
        let cands = Host.candidates(host)
        if cands.isEmpty { return out }
        for (category, f) in decoded {
            for cand in cands where Bloom.has(bits: f.bits, m: f.m, k: f.k, item: cand) {
                out.insert(category)
                break
            }
        }
        return out
    }
}
