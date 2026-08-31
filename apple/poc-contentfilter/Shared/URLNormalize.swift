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
        return s
    }

    /// TS `matchesPattern`: trailing "*" is a prefix match on the RAW url;
    /// anything else is exact-URL equality. Deliberately not glob or regex.
    public static func matchesPattern(url: String, pattern: String) -> Bool {
        if pattern.hasSuffix("*") { return url.hasPrefix(String(pattern.dropLast())) }
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
