//go:build windows

package main

import (
	"fmt"
	"regexp"

	"golang.org/x/sys/windows/registry"
)

// A Chrome/Edge extension id: exactly 32 characters from a-p. Checked because a
// wrong one is SILENT — the forcelist entry is written, the browser finds no such
// extension, nothing is installed, and the service logs
// "applied Chrome policies (force-install REPLACE_WITH_CHROME_WEB_STORE_ID)" and
// reports Running. Meanwhile ExtensionInstallBlocklist=* HAS applied, so the
// machine ends up with every extension blocked and none of ours installed.
var extensionIDRe = regexp.MustCompile(`^[a-p]{32}$`)

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
	if cfg.ConfigError != "" {
		log("ERROR: %s — running on defaults, which enforce nothing", cfg.ConfigError)
	}
	// NOTHING CONFIGURED IS NOT A QUIET SUCCESS. install.ps1 makes the extension
	// ids optional, so both could be empty: applyAll wrote nothing, logged
	// nothing, returned, and the service reported Running. No forcelist, no
	// incognito block, no devtools block — a correctly-"installed" machine
	// enforcing nothing and saying so nowhere.
	if cfg.ChromeExtensionID == "" && cfg.EdgeExtensionID == "" {
		log("ERROR: no browser extension id is configured (%s) — Ajar is enforcing NOTHING on this machine. "+
			"Re-run install.ps1 with -ChromeExtensionId / -EdgeExtensionId.", configPath())
		return
	}
	for _, b := range []struct {
		name, root, id, updateURL string
	}{
		{"Chrome", chromeKey, cfg.ChromeExtensionID, chromeUpdateURL},
		{"Edge", edgeKey, cfg.EdgeExtensionID, edgeUpdateURL},
	} {
		if b.id == "" {
			continue
		}
		if !extensionIDRe.MatchString(b.id) {
			log("ERROR: %s extension id %q is not a valid extension id (32 letters a-p). "+
				"Nothing will be installed, and other extensions are still blocked. Fix %s.",
				b.name, b.id, configPath())
			continue
		}
		if err := applyChromiumBrowser(b.root, b.id, b.updateURL, cfg.AntiBypass); err != nil {
			log("ERROR: %s policy write failed: %v — this machine is only PARTLY protected", b.name, err)
		} else {
			log("applied %s policies (force-install %s)", b.name, b.id)
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
	// A SLICE, NOT A MAP, and every one is attempted.
	//
	// Go randomises map iteration order, so a single failing write used to leave
	// an ARBITRARY SUBSET of {ECH, QUIC, incognito, devtools, guest, add-person}
	// applied — a different subset on every tick. A machine could sit for months
	// with incognito enabled and nobody could say which run left it that way.
	//
	// Now the order is fixed and one failure does not abandon the rest: partial
	// protection beats less-partial protection, and the caller is told which.
	settings := []struct {
		name string
		v    uint32
	}{
		{"BuiltInDnsClientEnabled", 0},
		{"EncryptedClientHelloEnabled", 0},
		// 3. Kill QUIC/HTTP-3 (no UDP path around inspection/logging).
		{"QuicAllowed", 0},
		// 4. Close private mode, dev tools, guest/other profiles.
		{"IncognitoModeAvailability", 1},
		{"DeveloperToolsAvailability", 2},
		{"BrowserGuestModeEnabled", 0},
		{"BrowserAddPersonEnabled", 0},
	}
	var failed []string
	for _, s := range settings {
		if err := k.SetDWordValue(s.name, s.v); err != nil {
			failed = append(failed, fmt.Sprintf("%s (%v)", s.name, err))
		}
	}
	if len(failed) > 0 {
		return fmt.Errorf("could not write %d anti-bypass value(s): %v", len(failed), failed)
	}
	return nil
}

// policyStatus reads back what is ACTUALLY in the registry.
//
// `status` advertised "print service + policy status" and never read the
// registry at all — it queried the SCM and the console user, so it printed
// "service: RUNNING" on a box where every policy write had been failing since
// install. The one command an operator runs to check told them nothing about the
// thing that does the work.
func policyStatus() []string {
	var out []string
	for _, b := range []struct{ name, root string }{{"Chrome", chromeKey}, {"Edge", edgeKey}} {
		k, err := registry.OpenKey(registry.LOCAL_MACHINE, b.root, registry.QUERY_VALUE)
		if err != nil {
			out = append(out, fmt.Sprintf("  %-7s no policies written (%v)", b.name+":", err))
			continue
		}
		forced := "MISSING"
		if fk, err := registry.OpenKey(registry.LOCAL_MACHINE, b.root+`\ExtensionInstallForcelist`, registry.QUERY_VALUE); err == nil {
			if v, _, err := fk.GetStringValue("1"); err == nil && v != "" {
				forced = v
			}
			fk.Close()
		}
		out = append(out, fmt.Sprintf("  %-7s force-install %s", b.name+":", forced))
		for _, name := range []string{"IncognitoModeAvailability", "DeveloperToolsAvailability", "QuicAllowed", "EncryptedClientHelloEnabled"} {
			if v, _, err := k.GetIntegerValue(name); err == nil {
				out = append(out, fmt.Sprintf("            %s = %d", name, v))
			} else {
				out = append(out, fmt.Sprintf("            %s = NOT SET", name))
			}
		}
		k.Close()
	}
	return out
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
