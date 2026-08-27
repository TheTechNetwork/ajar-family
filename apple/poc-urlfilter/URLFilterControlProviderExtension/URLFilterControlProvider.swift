import NetworkExtension
import os.log

/// PoC D control provider. Implements `NEURLFilterControlProvider`: on demand it
/// hands the system an `NEURLFilterPrefilter` — the on-device Bloom bit-array the
/// system consults BEFORE any network — built offline by
/// `tools/build-bloom/build_bloom.py` and bundled into this extension.
///
/// This is an APP EXTENSION on both iOS and macOS (never a system extension).
/// Info.plist must set:
///     EXExtensionPointIdentifier = com.apple.networkextension.url-filter-control
/// Entitlement `com.apple.developer.networking.networkextension` value:
///     url-filter-provider
///
/// NEURLFilter is BLOCKLIST-ONLY. The prefilter answers "might this URL be in the
/// blocklist?"; a Bloom hit triggers a PIR lookup against the vendor server. There
/// is no author-able allow verdict, no exceptions, one dataset per app. Allowed
/// URLs are allowed by ABSENCE from the set (ARCHITECTURE.md §3.1, ADR-002).
final class URLFilterControlProvider: NEURLFilterControlProvider {

    private let log = Logger(subsystem: "com.example.URLFilterPoC", category: "url-filter-control")

    /// The system asks for the current prefilter, passing the tag of whatever it
    /// already holds. Return `nil` to indicate "unchanged"; otherwise return a
    /// fresh `NEURLFilterPrefilter`. The refresh cadence is governed by
    /// `NEURLFilterManager.prefilterFetchInterval` (floor 2700s / 45min); this is
    /// the ≥45-min propagation floor the PoC measures.
    func fetchPrefilter(existingPrefilterTag: String?) async throws -> NEURLFilterPrefilter? {
        guard let meta = Self.loadMeta() else {
            log.error("bloom.meta.json missing from extension bundle")
            return nil
        }

        // No change since the system's current copy → tell it so (nil = unchanged).
        if let existing = existingPrefilterTag, existing == meta.tag {
            log.info("prefilter unchanged (tag \(meta.tag, privacy: .public))")
            return nil
        }

        guard let data = Self.loadBloomBlob() else {
            log.error("bloom.bin missing from extension bundle")
            return nil
        }

        log.info("returning prefilter tag=\(meta.tag, privacy: .public) bits=\(meta.bitCount) hashes=\(meta.hashCount)")

        // Construct the prefilter from the offline-built blob and its parameters.
        // The bitCount/hashCount/murmurSeed MUST match build_bloom.py exactly, or
        // the on-device matcher will index different bits than the builder set.
        return NEURLFilterPrefilter(
            data: data,
            tag: meta.tag,
            bitCount: meta.bitCount,
            hashCount: meta.hashCount,
            murmurSeed: meta.murmurSeed
        )
    }

    /// Start participating. // TODO(verify on device): whether any prefilter
    /// priming is expected here vs. purely in fetchPrefilter().
    func start() async throws {
        log.info("URLFilterControlProvider start")
    }

    func stop(reason: NEProviderStopReason) async throws {
        log.info("URLFilterControlProvider stop reason=\(reason.rawValue)")
    }

    // MARK: - Bundled Bloom artifacts

    /// Mirror of build_bloom.py's bloom.meta.json.
    private struct BloomMeta: Decodable {
        let bitCount: Int
        let hashCount: Int
        let murmurSeed: UInt32
        let tag: String
    }

    private static func loadMeta() -> BloomMeta? {
        guard let url = Bundle.main.url(forResource: "bloom.meta", withExtension: "json"),
              let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(BloomMeta.self, from: data)
    }

    private static func loadBloomBlob() -> Data? {
        guard let url = Bundle.main.url(forResource: "bloom", withExtension: "bin") else { return nil }
        return try? Data(contentsOf: url)
    }
}
