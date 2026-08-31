import ExtensionFoundation
import NetworkExtension
import os.log

/// PoC D control provider. Implements `NEURLFilterControlProvider`: on demand it
/// hands the system an `NEURLFilterPrefilter` — the on-device Bloom bit-array the
/// system consults BEFORE any network — built offline by
/// `tools/build-bloom/build_bloom.py` and bundled into this extension.
///
/// This is an **ExtensionKit app extension** on both iOS and macOS (never a
/// system extension). Info.plist sets:
///     EXExtensionPointIdentifier = com.apple.networkextension.url-filter-control
/// Entitlement `com.apple.developer.networking.networkextension` value:
///     url-filter-provider
///
/// SDK REALITY (verified against the Xcode 27 iPhoneOS SDK — see ADR-013):
/// `NEURLFilterControlProvider` is a **protocol refining ExtensionFoundation's
/// `AppExtension`**, not a class to subclass. So this is a `@main` struct that
/// conforms; `configuration` comes from the protocol's default implementation.
///
/// NEURLFilter is BLOCKLIST-ONLY. The prefilter answers "might this URL be in the
/// blocklist?"; a Bloom hit triggers a PIR lookup against the vendor server. There
/// is no author-able allow verdict, no exceptions, one dataset per app. Allowed
/// URLs are allowed by ABSENCE from the set (ARCHITECTURE.md §3.1, ADR-002).
@main
struct URLFilterControlProvider: NEURLFilterControlProvider {

    private static let log = Logger(subsystem: "com.example.URLFilterPoC", category: "url-filter-control")

    init() {}

    /// The system asks for the current prefilter, passing the tag of whatever it
    /// already holds. Return `nil` to indicate "unchanged"; otherwise return a
    /// fresh `NEURLFilterPrefilter`. The refresh cadence is governed by
    /// `NEURLFilterManager.prefilterFetchInterval` (floor 2700s / 45min); this is
    /// the ≥45-min propagation floor the PoC measures.
    func fetchPrefilter(existingPrefilterTag: String?) async throws -> NEURLFilterPrefilter? {
        guard let meta = Self.loadMeta() else {
            Self.log.error("bloom.meta.json missing from extension bundle")
            return nil
        }

        // No change since the system's current copy → tell it so (nil = unchanged).
        if let existing = existingPrefilterTag, existing == meta.tag {
            Self.log.info("prefilter unchanged (tag \(meta.tag, privacy: .public))")
            return nil
        }

        guard let data = Self.loadBloomBlob() else {
            Self.log.error("bloom.bin missing from extension bundle")
            return nil
        }

        Self.log.info("prefilter tag=\(meta.tag, privacy: .public) bits=\(meta.bitCount) hashes=\(meta.hashCount)")

        // The bitCount/hashCount/murmurSeed MUST match build_bloom.py exactly, or
        // the on-device matcher will index different bits than the builder set.
        //
        // SDK REALITY: `data:` is an `NEURLFilterPrefilter.PrefilterData` enum,
        // not raw `Data` — `.smallFilter(Data)` for an in-memory blob or
        // `.temporaryFilepath(URL)` for a large one spilled to disk (ADR-013).
        return NEURLFilterPrefilter(
            data: .smallFilter(data),
            tag: meta.tag,
            bitCount: meta.bitCount,
            hashCount: meta.hashCount,
            murmurSeed: meta.murmurSeed
        )
    }

    func start() async throws {
        Self.log.info("URLFilterControlProvider start")
    }

    func stop(reason: NEProviderStopReason) async throws {
        Self.log.info("URLFilterControlProvider stop reason=\(reason.rawValue)")
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
