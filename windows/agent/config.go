//go:build windows

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Config is read from %ProgramData%\Ajar\config.json (written by
// install.ps1). All fields have safe defaults so the service runs even if the
// file is missing.
type Config struct {
	// Web Store / Add-ons extension IDs to force-install (published, unlisted OK).
	ChromeExtensionID string `json:"chromeExtensionId"`
	EdgeExtensionID   string `json:"edgeExtensionId"`
	// Backend base URL the extension talks to (recorded for reference/diagnostics).
	BackendURL string `json:"backendUrl"`
	// Re-apply interval; 0 → default 5 minutes.
	ReapplyMinutes int `json:"reapplyMinutes"`
	// If false, skip the QUIC/DoH/ECH anti-bypass block (kept simple for testing).
	AntiBypass bool `json:"antiBypass"`

	// Set when the file exists but could not be read. Not from JSON: it is what
	// this process knows about the file, and it must reach a log rather than be
	// swallowed into zero-value ids that look like "not configured yet".
	ConfigError string `json:"-"`
}

func programDataDir() string {
	pd := os.Getenv("ProgramData")
	if pd == "" {
		pd = `C:\ProgramData`
	}
	return filepath.Join(pd, "Ajar")
}

func configPath() string { return filepath.Join(programDataDir(), "config.json") }

func loadConfig() Config {
	cfg := Config{ReapplyMinutes: 5, AntiBypass: true}
	b, err := os.ReadFile(configPath())
	if err == nil {
		// A TRUNCATED OR HAND-EDITED FILE IS NOT AN EMPTY ONE. This was
		// `_ = json.Unmarshal(...)`, so malformed JSON silently produced
		// zero-value extension ids — a machine enforcing nothing, with no
		// diagnostic, which is the same end state as never configuring it.
		if err := json.Unmarshal(b, &cfg); err != nil {
			cfg.ConfigError = fmt.Sprintf("%s could not be read as JSON: %v", configPath(), err)
			// Keep the defaults rather than a half-populated struct.
			cfg.ChromeExtensionID, cfg.EdgeExtensionID = "", ""
		}
	} else if !os.IsNotExist(err) {
		cfg.ConfigError = fmt.Sprintf("%s could not be opened: %v", configPath(), err)
	}
	if cfg.ReapplyMinutes <= 0 {
		cfg.ReapplyMinutes = 5
	}
	return cfg
}
