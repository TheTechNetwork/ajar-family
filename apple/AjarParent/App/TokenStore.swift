import Foundation
import Security

/// Session tokens in the Keychain, not UserDefaults.
///
/// A refresh token is a bearer credential for a parent account that can approve
/// what a child reaches. UserDefaults is a plist in the container — readable by
/// anything with file access and included in unencrypted backups.
///
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: the app refreshes in the
/// background (it long-polls for requests), so it must read after first unlock
/// rather than only while unlocked — but the token must never migrate to a new
/// device via backup.
enum TokenStore {
    private static let service = "family.ajar.parent.session"
    private static let account = "tokens"

    static func save(_ t: TokenResponse) {
        guard let data = try? JSONEncoder().encode(t) else { return }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)          // upsert
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }

    static func load() -> TokenResponse? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(TokenResponse.self, from: data)
    }

    static func clear() {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ] as CFDictionary)
    }
}
