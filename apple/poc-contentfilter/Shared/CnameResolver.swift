import Foundation
#if canImport(dnssd)
import dnssd
#endif

/// On-device CNAME chain resolution.
///
/// A first-party host is often a CNAME onto a third-party target ("CNAME
/// cloaking"); classifying only the literal hostname lets that bypass
/// DOMAIN/CATEGORY blocks. `shared/net/cname.ts` defines the algorithm: follow
/// one CNAME at a time, normalizing, loop-guarding, and depth-capping. This is
/// that algorithm with `resolveOne` implemented on `DNSServiceQueryRecord`.
///
/// ## Why not getaddrinfo(AI_CANONNAME) — the previous implementation
///
/// `ai_canonname` is at most ONE name: the END of the chain. If
/// `cdn.site.example → tracker.evil.example → edge.cdn.example`, the middle name
/// — which is the one a DOMAIN rule usually names — is never seen. It also
/// returns nothing at all for a chain that terminates in a CNAME the resolver
/// won't expand, and it forces an address lookup we do not need. So the primary
/// path is now an explicit per-step CNAME query, with `getaddrinfo` kept only as
/// a fallback that contributes the terminal name.
///
/// ## Honest limitations (READ BEFORE TRUSTING THIS)
///
/// 1. **It is a second resolution, not the one the flow used.** The chain we see
///    may differ from what the connection actually resolved (split-horizon DNS,
///    round-robin CNAMEs, a different resolver, cache skew). It is a strong
///    signal, not proof.
/// 2. **Rdata name decoding assumes no compression pointers.** mDNSResponder
///    hands back rdata from its own parsed store, which is uncompressed, but that
///    is an implementation detail rather than a documented contract. A 0xC0-
///    prefixed label is REJECTED rather than misparsed — better a missing link
///    than a wrong hostname. Verify against a real chain on device (test C1).
/// 3. **Encrypted DNS / DoH configured by the OS or the app** is bypassed by
///    this query in some configurations, and a resolver that hides CNAMEs
///    (some DoH front-ends flatten them) yields an empty chain.
/// 4. **The NEFilterDataProvider sandbox forbids network access**, and DNS is
///    network access. This resolver therefore must NOT be driven from the data
///    provider: see `CnameChainCache` below and `FilterControlProvider`, which
///    is the extension Apple permits to do network work. `resolve(_:)` is
///    blocking and belongs on the app / control-provider side only.
/// 5. No DNSSEC validation. A hostile resolver can lie in either direction.
public final class CnameResolver {

    public static let shared = CnameResolver()

    /// `DEFAULT_MAX_DEPTH` in `shared/net/cname.ts`.
    public static let defaultMaxDepth = 10
    /// Per-step budget. The whole chain is bounded by this × depth in the worst
    /// case, so callers on a latency-sensitive path must impose their own budget.
    public static let defaultStepTimeoutMs: Int32 = 250

    /// Mirror of `normalizeDnsName()`.
    public static func normalizeDnsName(_ name: String) -> String { Host.normalize(name) }

    /// Mirror of `followCnameChain()`: normalized, loop-guarded, depth-capped.
    /// BLOCKING — never call this from `handleNewFlow` on the data provider.
    public func resolve(_ host: String,
                        maxDepth: Int = CnameResolver.defaultMaxDepth,
                        stepTimeoutMs: Int32 = CnameResolver.defaultStepTimeoutMs,
                        deadline: Date? = nil) -> [String] {
        var out: [String] = []
        var seen = Set<String>()
        var cur = Self.normalizeDnsName(host)
        guard !cur.isEmpty else { return out }
        seen.insert(cur)
        for _ in 0..<maxDepth {
            if let deadline, Date() >= deadline { break }
            guard let next = Self.queryCname(cur, timeoutMs: stepTimeoutMs) else { break }
            let t = Self.normalizeDnsName(next)
            if t.isEmpty || seen.contains(t) { break }   // no CNAME, self-reference, or a loop
            out.append(t)
            seen.insert(t)
            cur = t
        }
        if out.isEmpty {
            // Fallback: the terminal canonical name. Strictly less information
            // than the chain, but better than nothing when CNAME queries are
            // unavailable in this network configuration.
            if let canon = Self.canonicalNameViaGetaddrinfo(cur), canon != cur, !canon.isEmpty {
                out.append(canon)
            }
        }
        return out
    }

    // MARK: - One CNAME step (DNSServiceQueryRecord)

    private final class QueryBox {
        var target: String?
        var finished = false
    }

    /// One CNAME lookup. Returns the target name, or nil for NODATA/NXDOMAIN/
    /// error/timeout — which the chain walker treats as "the chain ends here",
    /// matching the TS `catch { break }`.
    static func queryCname(_ name: String, timeoutMs: Int32) -> String? {
        #if !canImport(dnssd)
        // No DNS-SD on this platform/SDK: the chain walk degrades to the
        // getaddrinfo fallback in `resolve(_:)`, which sees only the terminal
        // canonical name. Documented in the type header, limitation (2).
        return nil
        #else
        var sdRef: DNSServiceRef?
        let box = QueryBox()
        let ctx = Unmanaged.passUnretained(box).toOpaque()

        let callback: DNSServiceQueryRecordReply = {
            _, _, _, errorCode, _, rrtype, _, rdlen, rdata, _, context in
            // Nothing is captured from the enclosing scope (required for a
            // @convention(c) function pointer); the box arrives via `context`.
            guard let context else { return }
            let q = Unmanaged<QueryBox>.fromOpaque(context).takeUnretainedValue()
            q.finished = true
            guard errorCode == kDNSServiceErr_NoError,
                  rrtype == UInt16(kDNSServiceType_CNAME),
                  let rdata, rdlen > 0 else { return }
            let buf = UnsafeRawBufferPointer(start: rdata, count: Int(rdlen))
            q.target = CnameResolver.decodeDNSName([UInt8](buf))
        }

        let err = name.withCString { cname -> DNSServiceErrorType in
            // kDNSServiceFlagsTimeout lets mDNSResponder end the query itself
            // instead of leaving it open if our poll budget is generous.
            DNSServiceQueryRecord(&sdRef,
                                  DNSServiceFlags(kDNSServiceFlagsTimeout),
                                  0,                                   // any interface
                                  cname,
                                  UInt16(kDNSServiceType_CNAME),
                                  UInt16(kDNSServiceClass_IN),
                                  callback,
                                  ctx)
        }
        guard err == kDNSServiceErr_NoError, let ref = sdRef else { return nil }
        defer { DNSServiceRefDeallocate(ref) }

        let fd = DNSServiceRefSockFD(ref)
        guard fd >= 0 else { return nil }
        let start = DispatchTime.now()
        while !box.finished {
            let elapsedMs = Int32(clamping: (DispatchTime.now().uptimeNanoseconds &- start.uptimeNanoseconds) / 1_000_000)
            let remaining = timeoutMs - elapsedMs
            if remaining <= 0 { break }
            var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let ready = poll(&pfd, 1, remaining)
            if ready <= 0 { break }                                  // timeout or error
            if DNSServiceProcessResult(ref) != kDNSServiceErr_NoError { break }
        }
        // The box is referenced only through an opaque pointer, so keep it alive
        // explicitly until the query is done.
        return withExtendedLifetime(box) { box.target }
        #endif
    }

    /// Decode a DNS wire-format domain name: a run of length-prefixed labels
    /// terminated by a zero byte. Compression pointers (top two bits set) are
    /// REJECTED — we do not have the enclosing message to resolve them against,
    /// so guessing would fabricate a hostname.
    static func decodeDNSName(_ bytes: [UInt8]) -> String? {
        var labels: [String] = []
        var i = 0
        while i < bytes.count {
            let len = Int(bytes[i])
            if len == 0 { break }
            if len & 0xC0 != 0 { return nil }           // compression pointer / reserved
            let start = i + 1
            let end = start + len
            guard end <= bytes.count else { return nil }
            guard let label = String(bytes: bytes[start..<end], encoding: .utf8) else { return nil }
            labels.append(label)
            i = end
        }
        if labels.isEmpty { return nil }
        return labels.joined(separator: ".")
    }

    /// Terminal canonical name only. Kept as the fallback described above.
    static func canonicalNameViaGetaddrinfo(_ host: String) -> String? {
        var hints = addrinfo()
        hints.ai_flags = AI_CANONNAME
        hints.ai_family = AF_UNSPEC
        hints.ai_socktype = SOCK_STREAM
        var res: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, nil, &hints, &res) == 0, let info = res else { return nil }
        defer { freeaddrinfo(info) }
        guard let canonC = info.pointee.ai_canonname else { return nil }
        return normalizeDnsName(String(cString: canonC))
    }
}

/// The App-Group-shared CNAME cache.
///
/// The data provider cannot resolve DNS (its sandbox forbids network access), so
/// it READS this cache and, on a miss, asks the control provider for a verdict
/// (`NEFilterNewFlowVerdict.needRules()`), which is the extension Apple allows to
/// do network work. The control provider resolves, writes here, and answers.
///
/// Entries are `host → (chain, expiry)`. The cache is advisory: a miss means
/// "unknown", never "no CNAME".
public final class CnameChainCache {

    public static let shared = CnameChainCache(appGroup: PolicyStore.defaultAppGroup)

    private let defaults: UserDefaults?
    private let key = "cname_chain_cache_v1"
    private let positiveTTL: TimeInterval = 600   // 10 min
    private let negativeTTL: TimeInterval = 60    // 1 min
    private let maxEntries = 512
    private let lock = NSLock()

    public init(appGroup: String) { self.defaults = UserDefaults(suiteName: appGroup) }

    private struct Entry: Codable { var chain: [String]; var expires: Date }

    private func load() -> [String: Entry] {
        guard let data = defaults?.data(forKey: key),
              let map = try? PolicyStore.decoder().decode([String: Entry].self, from: data) else { return [:] }
        return map
    }

    /// Non-blocking read. Returns nil when the host is unknown or stale, so the
    /// caller can tell "no CNAME" (an empty array) apart from "not looked up yet".
    public func chain(for host: String) -> [String]? {
        let h = Host.normalize(host)
        lock.lock(); defer { lock.unlock() }
        guard let e = load()[h], e.expires > Date() else { return nil }
        return e.chain
    }

    /// Writable only where the sandbox allows it (containing app, control
    /// provider). Never call from the data provider.
    public func store(host: String, chain: [String]) {
        let h = Host.normalize(host)
        guard !h.isEmpty else { return }
        lock.lock(); defer { lock.unlock() }
        var map = load()
        map[h] = Entry(chain: chain,
                       expires: Date().addingTimeInterval(chain.isEmpty ? negativeTTL : positiveTTL))
        if map.count > maxEntries {
            // Cheap bound: drop everything already expired, then the oldest.
            let now = Date()
            map = map.filter { $0.value.expires > now }
            if map.count > maxEntries {
                for k in map.sorted(by: { $0.value.expires < $1.value.expires })
                            .prefix(map.count - maxEntries).map({ $0.key }) {
                    map.removeValue(forKey: k)
                }
            }
        }
        if let data = try? PolicyStore.encoder().encode(map) { defaults?.set(data, forKey: key) }
    }
}
