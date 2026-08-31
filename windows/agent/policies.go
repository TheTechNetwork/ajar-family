//go:build windows

package main

import (
	"fmt"

	"golang.org/x/sys/windows/registry"
)

// Chrome and Edge share the same policy value names under different roots.
const (
	chromeKey = `SOFTWARE\Policies\Google\Chrome`
	edgeKey   = `SOFTWARE\Policies\Microsoft\Edge`
	// Web Store / Edge Add-ons update URLs used by ExtensionInstallForcelist.
	chromeUpdateURL = "https://clients2.google.com/service/update2/crx"
	edgeUpdateURL   = "https://edge.microsoft.com/extensionwebstorebase/v1/crx"
)

type logf func(format string, a ...any)

// applyAll writes every HKLM policy the enforcement design relies on. Idempotent:
// safe to re-run on the watchdog tick. Requires HKLM write access (LocalSystem).
// See windows/agent/policies/registry-policies.md for the rationale + sources.
func applyAll(cfg Config, log logf) {
	if cfg.ChromeExtensionID != "" {
		if err := applyChromiumBrowser(chromeKey, cfg.ChromeExtensionID, chromeUpdateURL, cfg.AntiBypass); err != nil {
			log("chrome policy error: %v", err)
		} else {
			log("applied Chrome policies (force-install %s)", cfg.ChromeExtensionID)
		}
	}
	if cfg.EdgeExtensionID != "" {
		if err := applyChromiumBrowser(edgeKey, cfg.EdgeExtensionID, edgeUpdateURL, cfg.AntiBypass); err != nil {
			log("edge policy error: %v", err)
		} else {
			log("applied Edge policies (force-install %s)", cfg.EdgeExtensionID)
		}
	}
	// Firefox uses ExtensionSettings JSON (policies.json or the registry tree);
	// left to the installer since it needs the AMO-signed XPI URL. See the
	// registry-policies.md Firefox section.
}

func applyChromiumBrowser(root, extID, updateURL string, antiBypass bool) error {
	k, _, err := registry.CreateKey(registry.LOCAL_MACHINE, root, registry.SET_VALUE|registry.CREATE_SUB_KEY|registry.QUERY_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()

	// 1. Force-install our extension, block all others, allowlist ours.
	if err := setList(root, "ExtensionInstallForcelist", map[string]string{"1": fmt.Sprintf("%s;%s", extID, updateURL)}); err != nil {
		return err
	}
	if err := setList(root, "ExtensionInstallBlocklist", map[string]string{"1": "*"}); err != nil {
		return err
	}
	if err := setList(root, "ExtensionInstallAllowlist", map[string]string{"1": extID}); err != nil {
		return err
	}

	if !antiBypass {
		return nil
	}
	// 2. Keep the network layer legible: kill browser DoH + ECH.
	if err := k.SetStringValue("DnsOverHttpsMode", "off"); err != nil {
		return err
	}
	for name, v := range map[string]uint32{
		"BuiltInDnsClientEnabled":     0,
		"EncryptedClientHelloEnabled": 0,
		// 3. Kill QUIC/HTTP-3 (no UDP path around inspection/logging).
		"QuicAllowed": 0,
		// 4. Close private mode, dev tools, guest/other profiles.
		"IncognitoModeAvailability":  1,
		"DeveloperToolsAvailability": 2,
		"BrowserGuestModeEnabled":    0,
		"BrowserAddPersonEnabled":    0,
	} {
		if err := k.SetDWordValue(name, v); err != nil {
			return err
		}
	}
	return nil
}

// setList writes a "policy list" subkey (REG_SZ values named "1","2",...), the
// shape Chrome/Edge use for ExtensionInstall* lists.
func setList(root, name string, entries map[string]string) error {
	sub := root + `\` + name
	k, _, err := registry.CreateKey(registry.LOCAL_MACHINE, sub, registry.SET_VALUE|registry.CREATE_SUB_KEY)
	if err != nil {
		return err
	}
	defer k.Close()
	for valueName, data := range entries {
		if err := k.SetStringValue(valueName, data); err != nil {
			return err
		}
	}
	return nil
}

// removePolicies deletes the policy roots we created (used by `uninstall`).
func removePolicies(log logf) {
	for _, root := range []string{chromeKey, edgeKey} {
		for _, list := range []string{"ExtensionInstallForcelist", "ExtensionInstallBlocklist", "ExtensionInstallAllowlist"} {
			_ = registry.DeleteKey(registry.LOCAL_MACHINE, root+`\`+list)
		}
		if k, err := registry.OpenKey(registry.LOCAL_MACHINE, root, registry.SET_VALUE); err == nil {
			for _, v := range []string{"DnsOverHttpsMode", "BuiltInDnsClientEnabled", "EncryptedClientHelloEnabled", "QuicAllowed", "IncognitoModeAvailability", "DeveloperToolsAvailability", "BrowserGuestModeEnabled", "BrowserAddPersonEnabled"} {
				_ = k.DeleteValue(v)
			}
			k.Close()
		}
	}
	log("removed browser policies")
}
