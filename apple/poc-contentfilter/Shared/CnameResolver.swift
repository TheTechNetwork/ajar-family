import Foundation

/// On-device CNAME resolution for the network-layer filter. A first-party host is
/// often a CNAME onto a third-party target ("CNAME cloaking"); classifying only
/// the literal hostname lets that bypass DOMAIN/CATEGORY blocks. We resolve the
/// canonical name and hand it to `PolicyStore.evaluate(resolvedHosts:)`.
///
/// `getaddrinfo` with `AI_CANONNAME` returns the canonical name at the end of the
/// CNAME chain (the destination that actually matters). Resolution is cached and
/// filled asynchronously: `chain(for:)` is non-blocking and returns whatever is
/// cached, `prime(_:)` kicks off a lookup. The filter data path must return a
/// verdict promptly, so the first sighting of a new host uses the empty chain and
/// subsequent flows are covered — the same model the browser extensions use.
public final class CnameResolver {
    public static let shared = CnameResolver()

    private struct Entry { let chain: [String]; let expires: Date }
    private var cache: [String: Entry] = [:]
    private var inflight: Set<String> = []
    private let lock = NSLock()
    private let ttl: TimeInterval = 600      // 10 min for a positive result
    private let negTtl: TimeInterval = 60     // 1 min for "no CNAME"
    private let queue = DispatchQueue(label: "com.ajar.cname", qos: .utility, attributes: .concurrent)

    private func norm(_ s: String) -> String {
        var h = s.lowercased()
        if h.hasSuffix(".") { h.removeLast() }
        if h.hasPrefix("www.") { h.removeFirst(4) }
        return h
    }

    /// Non-blocking: the cached canonical chain for `host`, or [] if not resolved.
    public func chain(for host: String) -> [String] {
        let h = norm(host)
        lock.lock(); defer { lock.unlock() }
        if let e = cache[h], e.expires > Date() { return e.chain }
        return []
    }

    /// Kick off (once) an async resolution that fills the cache for `host`.
    public func prime(_ host: String) {
        let h = norm(host)
        guard !h.isEmpty else { return }
        lock.lock()
        if let e = cache[h], e.expires > Date() { lock.unlock(); return }
        if inflight.contains(h) { lock.unlock(); return }
        inflight.insert(h)
        lock.unlock()

        queue.async { [weak self] in
            guard let self else { return }
            let chain = self.resolveCanonical(h)
            self.lock.lock()
            self.cache[h] = Entry(chain: chain,
                                  expires: Date().addingTimeInterval(chain.isEmpty ? self.negTtl : self.ttl))
            self.inflight.remove(h)
            self.lock.unlock()
        }
    }

    /// Blocking canonical-name lookup via getaddrinfo(AI_CANONNAME). Returns the
    /// canonical name if it differs from the queried host, else [].
    private func resolveCanonical(_ host: String) -> [String] {
        var hints = addrinfo()
        hints.ai_flags = AI_CANONNAME
        hints.ai_family = AF_UNSPEC
        hints.ai_socktype = SOCK_STREAM
        var res: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, nil, &hints, &res) == 0, let info = res else { return [] }
        defer { freeaddrinfo(info) }
        guard let canonC = info.pointee.ai_canonname else { return [] }
        let canon = norm(String(cString: canonC))
        return (canon.isEmpty || canon == host) ? [] : [canon]
    }
}
