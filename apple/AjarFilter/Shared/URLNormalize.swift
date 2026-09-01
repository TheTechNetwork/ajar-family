import Foundation
import CryptoKit

/// Small helpers shared by the store and the verifier.
public enum Digest {
    public static func sha256(_ d: Data) -> Data { Data(SHA256.hash(data: d)) }
}

/// Swift mirror of `normalizeExactUrl()` / `matchesPattern()` in
/// `shared/policy/policy-model.ts`:
///
/// ```ts
/// const u = new URL(raw);
/// u.hostname = normalizeHost(u.hostname);
/// u.hash = "";
/// u.searchParams.sort();
/// let s = u.toString().replace(/\/$/, "");
/// ```
///
/// PARITY CAVEAT (documented, medium risk — see README): WHATWG `URL.toString()`
/// does more than `URLComponents.string` — it lowercases the scheme and host,
/// removes a default port, forces an empty path to "/", and re-normalizes
/// percent-encoding. Those steps are reproduced explicitly below, but this is a
/// *behavioral* mirror rather than a shared implementation, so an exotic URL
/// (userinfo, IDN/punycode, unusual encodings) can still normalize differently on
/// the two sides. The consequence is a URL-tier rule that fails to match on iOS,
/// which then falls through to the DOMAIN/CATEGORY/default tiers — i.e. it can
/// lose a URL-level ALLOW exception. Cross-check with the TS before shipping URL
/// rules that are not plain https origins + path + query.
public enum URLNormalize {

    public static func normalizeExact(_ raw: String) -> String {
        guard var c = URLComponents(string: raw), let scheme = c.scheme else { return raw }
        c.scheme = scheme.lowercased()
        if let h = c.host { c.host = Host.normalize(h) }
        c.fragment = nil
        // CREDENTIALS IN THE AUTHORITY. `https://user@example.com/page` is the
        // same page as `https://example.com/page` and used to be a different
        // key — so it slipped a URL block, or broke an approval a parent
        // believed they gave. Two characters.
        c.user = nil
        c.password = nil
        // WHATWG URL drops the port when it is the scheme default.
        if let port = c.port, defaultPort(for: c.scheme ?? "") == port { c.port = nil }
        // WHATWG URL gives a special-scheme URL an empty path of "/".
        if c.path.isEmpty, c.host != nil { c.path = "/" }
        // `searchParams.sort()` is a STABLE sort by name, comparing UTF-16 code
        // units. Swift's `sorted(by:)` is not stable, so the index is used as a
        // tiebreaker to reproduce it exactly.
        if let items = c.queryItems, !items.isEmpty {
            let sorted = items.enumerated()
                .sorted { a, b in
                    if a.element.name == b.element.name { return a.offset < b.offset }
                    return CanonicalJSON.lessThanByUTF16(a.element.name, b.element.name)
                }
                .map { $0.element }
            c.queryItems = sorted
        } else {
            c.queryItems = nil
        }
        var s = c.string ?? raw
        if s.hasSuffix("/") { s.removeLast() }
        // PERCENT-ENCODING. `/%70age` is `/page`, and the two were different
        // keys for one page. Decoded ONLY where it is unambiguous: a decode that
        // reintroduces a delimiter (/ ? #) changes what the URL means, so those
        // are left exactly as written rather than guessed at. Same unreserved
        // set as the JS mirrors: A-Z a-z 0-9 - . _ ~
        return decodeUnreservedEscapes(s)
    }

    /// Replace `%XX` with its character when that character is unreserved.
    ///
    /// Written by hand rather than with `removingPercentEncoding`, which decodes
    /// EVERYTHING — including `%2F`, an encoded slash that means something
    /// different from a path separator.
    static func decodeUnreservedEscapes(_ s: String) -> String {
        guard s.contains("%") else { return s }
        var out = ""
        out.reserveCapacity(s.count)
        var i = s.startIndex
        while i < s.endIndex {
            guard s[i] == "%", let a = s.index(i, offsetBy: 1, limitedBy: s.endIndex),
                  let b = s.index(i, offsetBy: 2, limitedBy: s.endIndex),
                  b < s.endIndex else {
                out.append(s[i]); i = s.index(after: i); continue
            }
            let hex = String(s[a...b])
            if let byte = UInt8(hex, radix: 16), isUnreserved(byte) {
                out.append(Character(UnicodeScalar(byte)))
                i = s.index(after: b)
            } else {
                out.append(s[i]); i = s.index(after: i)
            }
        }
        return out
    }

    private static func isUnreserved(_ b: UInt8) -> Bool {
        switch b {
        case 0x41...0x5A, 0x61...0x7A, 0x30...0x39: return true   // A-Z a-z 0-9
        case 0x2D, 0x2E, 0x5F, 0x7E: return true                  // - . _ ~
        default: return false
        }
    }

    /// TS `matchesPattern`: trailing "*" is a prefix match, anything else is
    /// exact-URL equality. Deliberately not glob or regex.
    ///
    /// BOTH SIDES ARE NORMALIZED, including the wildcard branch. It used to
    /// compare the pattern against the RAW url while the exact branch
    /// normalized, so `https://example.com/safe/*` did not match
    /// `https://EXAMPLE.com/safe/x`, `https://www.example.com/safe/x` or
    /// `https://example.com./safe/x`: an allow-pattern silently failed to open
    /// what a parent opened, and a block-pattern was evaded by one character.
    public static func matchesPattern(url: String, pattern: String) -> Bool {
        if pattern.hasSuffix("*") {
            let prefix = String(pattern.dropLast())
            // Normalizing a prefix is only meaningful when it parses as a URL; a
            // truncated one falls back to the raw compare.
            guard URLComponents(string: prefix)?.scheme != nil else { return url.hasPrefix(prefix) }
            return normalizeExact(url).hasPrefix(normalizeExact(prefix))
        }
        return normalizeExact(url) == normalizeExact(pattern)
    }

    private static func defaultPort(for scheme: String) -> Int? {
        switch scheme.lowercased() {
        case "http", "ws": return 80
        case "https", "wss": return 443
        case "ftp": return 21
        default: return nil
        }
    }
}
