import Foundation

/// Cross-platform compatibility vectors. **Run this first on a Mac.**
///
/// None of the Swift in `Shared/` has ever been compiled, let alone executed —
/// there was no macOS or Xcode available when it was written. Two things in it
/// are all-or-nothing: if the canonical JSON differs from
/// `backend/src/util/canonical.ts` by one byte, EVERY policy snapshot is
/// rejected and (because the store fails closed) the device blocks the whole
/// web; if the Bloom arithmetic differs from `shared/categories/bloom.ts` by one
/// bit, EVERY category lookup silently misses and "block all social media"
/// quietly enforces nothing.
///
/// So the vectors below are not smoke tests, they are the acceptance gate:
///
/// * The Bloom vectors were computed by hand from the TypeScript algorithm; the
///   working is written out beside each one so a reviewer can check the
///   arithmetic without running anything.
/// * The signature vector is a REAL Ed25519 signature produced by the backend's
///   own code path (`canonicalJSON` + WebCrypto Ed25519) over a snapshot shaped
///   like a real one. Verifying it exercises `CanonicalJSON`, the SPKI to raw
///   key unwrap, and CryptoKit together. Nothing else proves canonical-JSON
///   parity.
///
/// Usage: call `PolicySelfTest.runAll()` from the app on launch (it is cheap) or
/// paste the body into an XCTest target. It returns failures rather than
/// trapping, so the PoC harness can display them.
public enum PolicySelfTest {

    public struct Failure {
        public let name: String
        public let detail: String
    }

    public static func runAll() -> [Failure] {
        var f: [Failure] = []
        f += fnvVectors()
        f += bloomIndexVectors()
        f += bloomFilterVector()
        f += hostVectors()
        f += urlNormalizeVectors()
        f += safetyFloorVectors()
        f += canonicalJSONVectors()
        f += signatureVector()
        f += evaluatorVectors()
        return f
    }

    private static func check(_ name: String, _ ok: Bool, _ detail: @autoclosure () -> String) -> [Failure] {
        ok ? [] : [Failure(name: name, detail: detail())]
    }

    // MARK: - 1. FNV-1a 32-bit

    /// WORKING for fnv1a("a", SEED_A), straight from the TS:
    ///
    ///   h  = SEED_A                = 0x811c9dc5
    ///   h ^= 'a' (0x61)            = 0x811c9da4   (low byte only: 0xc5 ^ 0x61 = 0xa4)
    ///   h  = h * 0x01000193 mod 2^32
    ///
    /// Split the multiply so it can be checked by hand:
    ///   0x01000193 = 2^24 + 403
    ///   h * 2^24 mod 2^32 = (h & 0xff) << 24 = 0xa4 << 24 = 0xa4000000 = 2,751,463,424
    ///   h * 403           = 2,166,136,228 * 403           = 872,952,899,884
    ///   872,952,899,884 mod 2^32 = 872,952,899,884 - 203 * 2^32
    ///                            = 872,952,899,884 - 871,878,361,088 = 1,074,538,796
    ///   sum = 2,751,463,424 + 1,074,538,796 = 3,826,002,220  (below 2^32, no wrap)
    ///                                       = 0xe40c292c                        OK
    ///
    /// The multi-byte vectors are the same procedure iterated per UTF-8 byte.
    private static func fnvVectors() -> [Failure] {
        var out: [Failure] = []
        let cases: [(String, UInt32, UInt32)] = [
            ("a",          Bloom.seedA, 0xe40c_292c),
            ("a",          Bloom.seedB, 0xe82f_20a2),
            ("tiktok.com", Bloom.seedA, 0x46c1_a79c),
            ("tiktok.com", Bloom.seedB, 0x768b_1436),
            ("reddit.com", Bloom.seedA, 0xe7be_0b82),
            ("reddit.com", Bloom.seedB, 0xfa2f_84ac),
            ("",           Bloom.seedA, 0x811c_9dc5),   // empty input is the seed
        ]
        for (item, seed, expected) in cases {
            let got = Bloom.fnv1a(Array(item.utf8), seed: seed)
            out += check("fnv1a(\"\(item)\", 0x\(String(seed, radix: 16)))", got == expected,
                         "expected 0x\(String(expected, radix: 16)), got 0x\(String(got, radix: 16))")
        }
        return out
    }

    // MARK: - 2. Probe sequence (enhanced double hashing)

    /// WORKING for indices("tiktok.com", m = 32, k = 11):
    ///
    ///   h1 = 0x46c1a79c = 1,187,096,476
    ///   h2 = 0x768b1436 | 1 = 0x768b1437 = 1,988,826,167   (odd, strides the space)
    ///   x  = h1
    ///
    ///   i=0: x % 32 = 1,187,096,476 mod 32 = 28   (low 5 bits of 0x9c = 0b11100)
    ///        x  = 1,187,096,476 + 1,988,826,167 = 3,175,922,643   (below 2^32)
    ///        h2 = h2 + 0 = 1,988,826,167
    ///   i=1: x % 32 = 3,175,922,643 mod 32 = 19
    ///        x  = 3,175,922,643 + 1,988,826,167 = 5,164,748,810
    ///           = 5,164,748,810 - 2^32 = 869,781,514          <- the first wrap
    ///        h2 = h2 + 1 = 1,988,826,168
    ///   i=2: x % 32 = 869,781,514 mod 32 = 10
    ///        x  = 869,781,514 + 1,988,826,168 = 2,858,607,682
    ///        h2 = h2 + 2 = 1,988,826,170
    ///   ... continuing gives the full sequence asserted below.
    ///
    /// The i=1 step is the one that matters: it is the first modular wrap, and
    /// where a port using `+` (traps) or Int64 math (never wraps) diverges.
    private static func bloomIndexVectors() -> [Failure] {
        var out: [Failure] = []
        let tiktok: [UInt32] = [28, 19, 10, 2, 28, 25, 26, 0, 12, 31, 26]
        let reddit: [UInt32] = [2, 15, 28, 10, 26, 13, 4, 0, 2, 11, 28]
        out += check("indices(tiktok.com, m=32, k=11)",
                     Bloom.indices("tiktok.com", m: 32, k: 11) == tiktok,
                     "got \(Bloom.indices("tiktok.com", m: 32, k: 11))")
        out += check("indices(reddit.com, m=32, k=11)",
                     Bloom.indices("reddit.com", m: 32, k: 11) == reddit,
                     "got \(Bloom.indices("reddit.com", m: 32, k: 11))")
        return out
    }

    // MARK: - 3. A whole filter, byte for byte

    /// `buildBloom(["tiktok.com", "reddit.com"])` at the default p = 0.001.
    ///
    /// PARAMETERS (paramsFor in the TS):
    ///   n = 2
    ///   m = ceil(-(2 * ln 0.001) / (ln 2)^2) = ceil(13.8155 / 0.480453)
    ///     = ceil(28.755) = 29
    ///   m = max(8, ceil(29/8) * 8) = 32          (byte aligned, so 4 bytes)
    ///   k = max(1, round((32/2) * ln 2)) = round(11.0904) = 11
    ///
    /// BITS, the union of the two index sets above:
    ///   tiktok.com -> {0, 2, 10, 12, 19, 25, 26, 28, 31}
    ///   reddit.com -> {0, 2, 4, 10, 11, 13, 15, 26, 28}
    ///   byte 0 (bits 0-7)   = {0,2,4}                    = 1+4+16       = 21  = 0x15
    ///   byte 1 (bits 8-15)  = {10,11,12,13,15} -> {2,3,4,5,7}
    ///                                                    = 4+8+16+32+128 = 188 = 0xbc
    ///   byte 2 (bits 16-23) = {19} -> {3}                = 8            = 0x08
    ///   byte 3 (bits 24-31) = {25,26,28,31} -> {1,2,4,7} = 2+4+16+128   = 150 = 0x96
    ///   bytes 15 bc 08 96  ->  base64 "FbwIlg=="
    ///
    /// Bit i lives in byte i>>3 at position i&7, LSB first, exactly as the TS
    /// `bits[idx >>> 3] |= 1 << (idx & 7)` writes it.
    ///
    /// A 32-bit filter holding 2 items is absurdly dense (13 of 32 bits set), so
    /// it is a poor filter and an excellent test vector: it pins every byte.
    public static let socialFilterVector = SerializedBloom(m: 32, k: 11, n: 2, bits: "FbwIlg==")

    private static func bloomFilterVector() -> [Failure] {
        var out: [Failure] = []
        guard let bits = Data(base64Encoded: socialFilterVector.bits) else {
            return [Failure(name: "bloom filter vector", detail: "base64 did not decode")]
        }
        out += check("filter bytes", [UInt8](bits) == [0x15, 0xbc, 0x08, 0x96], "got \([UInt8](bits))")

        let set = CategoryFilterSet(version: 3, filters: ["social": socialFilterVector])
        guard let filters = CategoryFilters(set: set) else {
            return out + [Failure(name: "CategoryFilters init", detail: "rejected a well-formed filter")]
        }
        // Members, plus subdomain and normalization forms that reach them
        // through hostCandidates.
        for host in ["tiktok.com", "www.tiktok.com", "reddit.com", "m.old.reddit.com", "REDDIT.COM."] {
            out += check("filter contains \(host)", filters.categories(for: host) == ["social"],
                         "got \(filters.categories(for: host))")
        }
        // Non-members. These specific strings were checked against the TS
        // algorithm and do not collide; this toy filter is dense, so do not add
        // hosts here without recomputing the probes.
        for host in ["khanacademy.org", "example.com", "com"] {
            out += check("filter excludes \(host)", filters.categories(for: host).isEmpty,
                         "got \(filters.categories(for: host))")
        }
        return out
    }

    // MARK: - 4. Host normalization / candidates

    /// Exact-URL canonicalization and pattern matching.
    ///
    /// Pure functions, so they need no signed snapshot — which matters, because
    /// every other evaluator vector here runs against one fixed pre-signed
    /// blob and cannot be extended without re-signing it. These are the four
    /// URL-shaped defects an outside review found, pinned on the platform that
    /// ships.
    private static func urlNormalizeVectors() -> [Failure] {
        var out: [Failure] = []
        func same(_ a: String, _ b: String, _ why: String) -> [Failure] {
            check("normalizeExact(\(a)) == normalizeExact(\(b))",
                  URLNormalize.normalizeExact(a) == URLNormalize.normalizeExact(b),
                  "\(why): got \(URLNormalize.normalizeExact(a)) vs \(URLNormalize.normalizeExact(b))")
        }
        func differ(_ a: String, _ b: String, _ why: String) -> [Failure] {
            check("normalizeExact(\(a)) != normalizeExact(\(b))",
                  URLNormalize.normalizeExact(a) != URLNormalize.normalizeExact(b), why)
        }

        // Percent-encoding: `/%70age` is `/page`, and they used to be two keys
        // for one page — so an encoded form slipped a URL block, or broke an
        // approval a parent believed they gave.
        out += same("https://example.com/page", "https://example.com/%70age",
                    "unreserved escapes must decode")
        // ...but an encoded SLASH is not a path separator, and decoding it would
        // change what the URL means.
        out += differ("https://example.com/a/b", "https://example.com/a%2Fb",
                      "%2F must NOT decode — it is a different URL")
        // Credentials in the authority: same page, two characters.
        out += same("https://example.com/page", "https://user@example.com/page",
                    "userinfo must not create a second key")
        out += same("https://example.com/page", "https://user:pw@example.com/page",
                    "userinfo with a password must not either")
        // Already covered by the shared spec, kept so a regression here is local.
        out += same("https://example.com/a?b=1&a=2", "https://example.com/a?a=2&b=1",
                    "query order must not matter")
        out += same("https://EXAMPLE.com/x", "https://www.example.com/x/",
                    "case, www and a trailing slash must not matter")

        // A wildcard pattern normalizes BOTH sides. It used to compare against
        // the raw URL, so an allow-pattern missed and a block-pattern was evaded
        // by one character.
        let pat = "https://example.com/safe/*"
        for u in ["https://EXAMPLE.com/safe/x", "https://www.example.com/safe/x",
                  "https://example.com./safe/x", "https://example.com/safe/deep/er"] {
            out += check("matchesPattern(\(u))", URLNormalize.matchesPattern(url: u, pattern: pat),
                         "a normalized form of the URL did not match its own pattern")
        }
        out += check("matchesPattern outside the prefix",
                     !URLNormalize.matchesPattern(url: "https://example.com/unsafe/x", pattern: pat),
                     "a pattern matched outside its prefix")
        return out
    }

    private static func hostVectors() -> [Failure] {
        var out: [Failure] = []
        out += check("normalize strips root dot then www",
                     Host.normalize("WWW.Reddit.com.") == "reddit.com",
                     "got \(Host.normalize("WWW.Reddit.com."))")
        out += check("candidates(m.old.reddit.com)",
                     Host.candidates("m.old.reddit.com") == ["m.old.reddit.com", "old.reddit.com", "reddit.com"],
                     "got \(Host.candidates("m.old.reddit.com"))")
        out += check("candidates(reddit.com)",
                     Host.candidates("reddit.com") == ["reddit.com"],
                     "got \(Host.candidates("reddit.com"))")
        // A single-label host produces no candidates in the TS, so it can never
        // match a category. Mirrored deliberately.
        out += check("candidates(com) is empty", Host.candidates("com").isEmpty,
                     "got \(Host.candidates("com"))")
        let map = ["social": ["reddit.com", "tiktok.com"], "adult": ["example-adult.test"]]
        out += check("inline map matches subdomain",
                     Host.categories(in: map, for: "m.reddit.com") == ["social"],
                     "got \(Host.categories(in: map, for: "m.reddit.com"))")
        return out
    }

    // MARK: - 5. Safety floor

    private static func safetyFloorVectors() -> [Failure] {
        var out: [Failure] = []
        // Copied from shared/safety/safety-floor.test.ts.
        out += check("floor: 988lifeline.org", SafetyFloor.matches("988lifeline.org"), "")
        out += check("floor: chat.988lifeline.org", SafetyFloor.matches("chat.988lifeline.org"), "")
        out += check("floor: www.thetrevorproject.org", SafetyFloor.matches("www.thetrevorproject.org"), "")
        out += check("floor rejects 988lifeline.org.evil.com",
                     !SafetyFloor.matches("988lifeline.org.evil.com"), "lookalike matched")
        out += check("floor rejects example.com", !SafetyFloor.matches("example.com"), "")
        out += check("floor list size", SafetyFloor.domains.count == 16,
                     "expected the 16 domains in safety-floor.ts, got \(SafetyFloor.domains.count)")
        return out
    }

    // MARK: - 6. Canonical JSON

    private static func canonicalJSONVectors() -> [Failure] {
        var out: [Failure] = []
        func canon(_ s: String) -> String {
            guard let d = try? CanonicalJSON.canonicalize(Data(s.utf8)),
                  let t = String(data: d, encoding: .utf8) else { return "<threw>" }
            return t
        }
        // Recursive key sort, array order preserved, no whitespace.
        out += check("sorts keys recursively",
                     canon(#"{"b":1,"a":{"z":[3,1,2],"y":true}}"#)
                        == #"{"a":{"y":true,"z":[3,1,2]},"b":1}"#,
                     "got \(canon(#"{"b":1,"a":{"z":[3,1,2],"y":true}}"#))")
        // UTF-16 code-unit ordering, NOT Foundation's `.sortedKeys` collation:
        // uppercase sorts before lowercase, so "Z" comes before "a".
        out += check("uppercase key sorts before lowercase",
                     canon(#"{"a":1,"Z":2}"#) == #"{"Z":2,"a":1}"#,
                     "got \(canon(#"{"a":1,"Z":2}"#)) - if the order is unchanged the sort is collating, not code-unit")
        // JSON.stringify escaping: short escapes used, forward slash left bare.
        out += check("string escaping",
                     canon(#"{"s":"a\nb/c\"d"}"#) == #"{"s":"a\nb/c\"d"}"#,
                     "got \(canon(#"{"s":"a\nb/c\"d"}"#))")
        // Parse-then-stringify collapses number forms: 1.0 -> 1, 1e2 -> 100, -0 -> 0.
        out += check("integer number forms collapse",
                     canon(#"{"a":1.0,"b":1e2,"c":-0}"#) == #"{"a":1,"b":100,"c":0}"#,
                     "got \(canon(#"{"a":1.0,"b":1e2,"c":-0}"#))")
        // Fractional numbers are refused rather than guessed at; see the
        // CanonicalJSON header for why.
        out += check("fractional numbers are refused",
                     (try? CanonicalJSON.canonicalize(Data(#"{"a":1.5}"#.utf8))) == nil,
                     "a fractional number canonicalized; JS Number-to-String was not implemented, so this must throw")
        return out
    }

    // MARK: - 7. End-to-end signature vector (the real acceptance gate)

    /// Produced with the backend's own signing path: `canonicalJSON()` from
    /// `backend/src/util/canonical.ts` plus WebCrypto Ed25519, using the fixed
    /// test key below whose private seed is the bytes 00 01 02 ... 1f.
    ///
    /// Regenerate with:
    ///
    ///     node --input-type=module -e '
    ///     import {webcrypto} from "node:crypto";
    ///     const seed  = Buffer.from(Array.from({length:32},(_,i)=>i));
    ///     const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"), seed]);
    ///     const priv  = await webcrypto.subtle.importKey("pkcs8", pkcs8, {name:"Ed25519"}, true, ["sign"]);
    ///     // ... canonicalJSON(snapshot minus signature), sign, print base64 ...
    ///     '
    ///
    /// This is a TEST key. It must never appear in a deployment;
    /// `PolicyStore.pinnedSigningKeySPKIB64` must carry the real backend key.
    public static let testSigningKeySPKIB64 = "MCowBQYDK2VwAyEAA6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg="
    /// The same key with the 12-byte DER header removed: what CryptoKit wants.
    public static let testSigningKeyRawB64 = "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg="

    /// A snapshot as delivered. Its keys are deliberately NOT in sorted order,
    /// so a canonicalizer that forgot to sort cannot accidentally pass.
    public static let signedSnapshotJSON = """
    {"signature":"whCOaXb0MrncqIB9OADkqpdDrpNwaeR8l8suv1A08dLEKZANnHVYeQAqmHfTHm2NZc/qPznenLWTOeOeyLTXDg==",\
    "version":7,"issuedAt":"2026-08-30T12:00:00.000Z","familyId":"fam-1","childId":"child-1","deviceId":"dev-1",\
    "defaults":{"youTubeDefault":"BLOCK","webDefault":"ALLOW"},\
    "rules":[{"value":"social","target":"CATEGORY","id":"r1","action":"BLOCK","createdBy":"parent-1",\
    "createdAt":"2026-08-01T00:00:00.000Z","scope":{"type":"CHILD","familyId":"fam-1","childId":"child-1"}}],\
    "temporaryRules":[],"categories":{"social":["tiktok.com","reddit.com"]}}
    """

    /// The exact bytes the backend signed: canonicalJSON(snapshot minus
    /// signature). If `CanonicalJSON` emits anything else, the diff against this
    /// string shows precisely where the two implementations part company.
    public static let expectedCanonicalSnapshot = #"{"categories":{"social":["tiktok.com","reddit.com"]},"childId":"child-1","defaults":{"webDefault":"ALLOW","youTubeDefault":"BLOCK"},"deviceId":"dev-1","familyId":"fam-1","issuedAt":"2026-08-30T12:00:00.000Z","rules":[{"action":"BLOCK","createdAt":"2026-08-01T00:00:00.000Z","createdBy":"parent-1","id":"r1","scope":{"childId":"child-1","familyId":"fam-1","type":"CHILD"},"target":"CATEGORY","value":"social"}],"temporaryRules":[],"version":7}"#

    /// The filter asset the backend serves, signed with the same test key over
    /// canonicalJSON(set). The filter inside it is the hand-computed vector.
    public static let signedFilterAssetJSON = """
    {"set":{"version":3,"filters":{"social":{"m":32,"k":11,"n":2,"bits":"FbwIlg=="}}},\
    "signature":"dyyuGnIOT8CTQfrN275ITGzidwhMf0qp1Q5ENWwLkyiVeyl6OnEgk+rlJAlgqfTSwHRV5MCoEjfqXkauA4LVDA=="}
    """

    private static func signatureVector() -> [Failure] {
        var out: [Failure] = []
        let raw = Data(signedSnapshotJSON.utf8)

        // (a) canonical bytes match the backend's, character for character.
        do {
            let canonical = try CanonicalJSON.canonicalizeObject(raw, removingTopLevelKey: "signature")
            let got = String(data: canonical, encoding: .utf8) ?? ""
            out += check("canonical JSON parity", got == expectedCanonicalSnapshot,
                         "MISMATCH - the backend signs different bytes than this device hashes.\n"
                            + "expected: \(expectedCanonicalSnapshot)\ngot:      \(got)")
        } catch {
            out += [Failure(name: "canonical JSON parity", detail: "threw: \(error)")]
        }

        // (b) SPKI DER unwraps to the 32-byte raw key.
        if let der = Data(base64Encoded: testSigningKeySPKIB64),
           let rawKey = Data(base64Encoded: testSigningKeyRawB64) {
            out += check("SPKI is 44 bytes", der.count == 44, "got \(der.count)")
            out += check("raw key is the trailing 32 bytes", der.suffix(32) == rawKey, "mismatch")
        }

        // (c) the whole thing: CryptoKit verifies a real backend signature.
        do {
            try SnapshotVerifier.verifySnapshot(rawSnapshot: raw, publicKeyB64: testSigningKeySPKIB64)
        } catch {
            out += [Failure(name: "Ed25519 snapshot verification", detail: "FAILED: \(error)")]
        }

        // (d) fail closed: one edited value must break verification.
        let tampered = Data(signedSnapshotJSON
            .replacingOccurrences(of: "\"action\":\"BLOCK\"", with: "\"action\":\"ALLOW\"").utf8)
        let tamperRejected = (try? SnapshotVerifier.verifySnapshot(
            rawSnapshot: tampered, publicKeyB64: testSigningKeySPKIB64)) == nil
        out += check("tampered snapshot is rejected", tamperRejected,
                     "an edited snapshot verified, so verification is not actually running")

        // (e) the filter asset, whose signature covers canonicalJSON(set).
        do {
            let root = try CanonicalJSON.parse(Data(signedFilterAssetJSON.utf8))
            guard case let .object(fields) = root,
                  let setValue = fields["set"],
                  case let .string(sig)? = fields["signature"] else {
                throw CanonicalJSON.Error.notAnObject
            }
            let canonical = Data(try CanonicalJSON.emit(setValue).utf8)
            out += check("filter-set canonical form",
                         String(data: canonical, encoding: .utf8)
                            == #"{"filters":{"social":{"bits":"FbwIlg==","k":11,"m":32,"n":2}},"version":3}"#,
                         "got \(String(data: canonical, encoding: .utf8) ?? "nil")")
            try SnapshotVerifier.verifyCanonical(rawObject: canonical, signatureB64: sig,
                                                 publicKeyB64: testSigningKeySPKIB64)
        } catch {
            out += [Failure(name: "Ed25519 filter-asset verification", detail: "FAILED: \(error)")]
        }

        return out
    }

    // MARK: - 8. The evaluator, end to end

    /// Installs the signed vector snapshot into a THROWAWAY UserDefaults suite
    /// (never the real App Group) and checks the decisions the product depends
    /// on. This is what proves CATEGORY rules actually enforce, which is the gap
    /// this pass exists to close.
    ///
    /// The vector snapshot is: webDefault ALLOW, youTubeDefault BLOCK, one
    /// CHILD-scoped `CATEGORY social BLOCK` rule, inline map social =
    /// [tiktok.com, reddit.com].
    public static func evaluatorVectors() -> [Failure] {
        var out: [Failure] = []
        let suite = "com.ajar.policy-selftest"
        UserDefaults.standard.removePersistentDomain(forName: suite)

        let store = PolicyStore(appGroup: suite)
        store.categoryFilters = CategoryFilterStore(appGroup: suite)
        guard store.enrollSigningKey(testSigningKeySPKIB64) else {
            return [Failure(name: "self-test enrollment",
                            detail: "could not enroll the test key; is pinnedSigningKeySPKIB64 set to something else?")]
        }
        do {
            try store.install(rawSnapshot: Data(signedSnapshotJSON.utf8))
        } catch {
            return [Failure(name: "self-test install", detail: "install threw: \(error)")]
        }

        func expect(_ url: String, _ action: RuleAction, _ reasonPrefix: String,
                    resolved: [String] = []) -> [Failure] {
            let r = store.evaluate(url, resolvedHosts: resolved)
            return check("evaluate(\(url))", r.action == action && r.reason.hasPrefix(reasonPrefix),
                         "got \(r.action.rawValue) reason=\(r.reason) key=\(r.matchedKey ?? "-")")
        }

        // CATEGORY rules enforce, over the inline map, including subdomains.
        out += expect("https://www.tiktok.com/@someone", .block, "rule:CATEGORY")
        out += expect("https://m.old.reddit.com/r/x", .block, "rule:CATEGORY")
        // ...and over a CNAME-resolved alias, which is the cloaking case.
        out += expect("https://cdn.first-party.example/x", .block, "rule:CATEGORY",
                      resolved: ["edge.tiktok.com"])
        // Unrelated hosts fall through to the web default.
        out += expect("https://khanacademy.org/math", .allow, "default:web")
        // YouTube keeps its own default.
        out += expect("https://www.youtube.com/watch?v=dQw4w9WgXcQ", .block, "default:youtube")
        // The safety floor sits above the lot.
        out += expect("https://chat.988lifeline.org/", .allow, "safety-floor")
        out += check("safety-floor decisions are not reportable",
                     !store.evaluate("https://chat.988lifeline.org/").isReportable,
                     "a safety-floor hit was marked reportable")

        // Fail closed: corrupt the stored bytes and everything but the floor blocks.
        UserDefaults(suiteName: suite)?.set(Data("{\"not\":\"a snapshot\"}".utf8),
                                            forKey: "device_policy_snapshot_raw_v2")
        let corrupted = PolicyStore(appGroup: suite)
        corrupted.categoryFilters = CategoryFilterStore(appGroup: suite)
        out += check("tampered cache blocks the web",
                     corrupted.evaluate("https://khanacademy.org/math").action == .block,
                     "a tampered snapshot did not fail closed")
        out += check("tampered cache still allows the safety floor",
                     corrupted.evaluate("https://988lifeline.org/").action == .allow,
                     "the safety floor did not survive a tampered snapshot")

        UserDefaults.standard.removePersistentDomain(forName: suite)
        return out
    }
}
