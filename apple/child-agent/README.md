# apple/child-agent — iOS/macOS child agent (later-phase placeholder)

Not implemented yet. Productionizes the PoC A (iOS) and PoC B (macOS) enforcement
into the shipping child agent. See `docs/ARCHITECTURE.md`, `docs/APPLE_CONTENT_FILTER_POC.md`,
`docs/MACOS_SAFARI_POC.md`.

Responsibilities (Phase 4): enroll device into family (QR / 6-digit code); request
FamilyControls `.child` authorization (iOS); activate/monitor filtering; show
filtering status + assigned child + pending requests; submit access requests;
sync + verify signed policy; enforce temporary-approval expiry locally (UTC +
monotonic); prevent settings changes without parent auth where the OS allows; be
honest in UI about what is technically enforced vs. removable by the device owner
vs. requires a managed device.
