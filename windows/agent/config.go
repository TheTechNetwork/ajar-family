//go:build windows

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Config is read from %ProgramData%\FamilyFilter\config.json (written by
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
}

func programDataDir() string {
	pd := os.Getenv("ProgramData")
	if pd == "" {
		pd = `C:\ProgramData`
	}
	return filepath.Join(pd, "FamilyFilter")
}

func configPath() string { return filepath.Join(programDataDir(), "config.json") }

func loadConfig() Config {
	cfg := Config{ReapplyMinutes: 5, AntiBypass: true}
	b, err := os.ReadFile(configPath())
	if err == nil {
		_ = json.Unmarshal(b, &cfg)
	}
	if cfg.ReapplyMinutes <= 0 {
		cfg.ReapplyMinutes = 5
	}
	return cfg
}
