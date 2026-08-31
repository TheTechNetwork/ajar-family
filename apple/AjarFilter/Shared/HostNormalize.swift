import Foundation

/// Swift mirror of `shared/categories/category-data.ts` — the host-normalization
/// and registrable-candidate helpers that DOMAIN and CATEGORY matching are built
/// on. The TypeScript is the authoritative spec; keep these in lockstep.
///
/// NOT COMPILED OR RUN: no Xcode/macOS was available when this was written. See
/// README.md §"What a Mac engineer must verify first".
public enum Host {

    /// Mirror of `normalizeHost()`:
    ///
    ///     host.replace(/\.$/, "").replace(/^www\./i, "").toLowerCase()
    ///
    /// Order matters and is copied from the TS: the trailing root dot goes FIRST
    /// (a legal `reddit.com.` resolves to the same site and would otherwise
    /// defeat every DOMAIN and CATEGORY rule with one character), then a leading
    /// `www.` case-insensitively, then lowercase.
    public static func normalize(_ host: String) -> String {
        var h = host
        if h.hasSuffix(".") { h.removeLast() }
        if h.count >= 4, h.prefix(4).lowercased() == "www." { h.removeFirst(4) }
        return h.lowercased()
    }

    /// Mirror of `hostCandidates()`. The finite set of suffixes a stored category
    /// domain could equal: `d` matches host `h` iff `d` is one of these.
    ///
    ///     "m.old.reddit.com" → ["m.old.reddit.com", "old.reddit.com", "reddit.com"]
    ///
    /// SPEC NOTE: the TS loop is `for (i = 0; i < parts.length - 1; i++)`, so the
    /// bare public suffix ("com") is NOT emitted — even though the doc comment in
    /// `shared/categories/category-data.ts` claims it is. The CODE is what both
    /// the SQL store and the Bloom builder agree on, so the code is mirrored here
    /// and the TS comment should be corrected. A single-label host ("localhost")
    /// therefore yields [] and can never match a category.
    public static func candidates(_ host: String) -> [String] {
        let h = normalize(host)
        if h.isEmpty { return [] }
        let parts = h.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard parts.count >= 2 else { return [] }
        var out: [String] = []
        for i in 0..<(parts.count - 1) {
            out.append(parts[i...].joined(separator: "."))
        }
        return out
    }

    /// Mirror of `categoriesForHost()` — the snapshot's INLINE category map path
    /// (small deployments). Large datasets use the Bloom filters in
    /// `CategoryBloom.swift`; the evaluator unions both, exactly as the TS does.
    public static func categories(
        in map: [String: [String]]?,
        for host: String
    ) -> Set<String> {
        var out = Set<String>()
        guard let map, !host.isEmpty else { return out }
        let cands = Set(candidates(host))
        guard !cands.isEmpty else { return out }
        for (category, domains) in map {
            if domains.contains(where: { cands.contains(normalize($0)) }) { out.insert(category) }
        }
        return out
    }
}
