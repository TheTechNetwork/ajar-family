# PoC A scaffold — iOS content filter + FamilyControls `.child`

On-device-runnable proof for `docs/APPLE_CONTENT_FILTER_POC.md`. **Cannot be
built in the CI/Linux environment** — open in **Xcode 26**, run on an **iOS 26**
device signed in with a child Apple ID in a Family Sharing group.

## Targets (create in Xcode as one app + two extensions + a shared framework)

```
ParentFilterPoC.xcodeproj
├── App/                      (iOS app target — SwiftUI harness)
│   ├── ParentFilterPoCApp.swift
│   ├── ContentView.swift
│   ├── FilterController.swift          // NEFilterManager + FamilyControls auth
│   └── ParentFilterPoC.entitlements    // com.apple.developer.family-controls,
│                                       // App Group, networking.networkextension
├── FilterDataProvider/       (Network Extension — Content Filter, data provider)
│   ├── FilterDataProvider.swift        // NEFilterDataProvider subclass
│   └── FilterDataProvider.entitlements
├── FilterControlProvider/    (Network Extension — Content Filter, control provider)
│   ├── FilterControlProvider.swift     // NEFilterControlProvider + remediation
│   └── FilterControlProvider.entitlements
└── Shared/                   (framework linked by all three targets)
    ├── YouTubeNormalize.swift          // Swift mirror of shared/youtube/*
    ├── PolicyModel.swift               // Swift mirror of shared/policy/*
    └── PolicyStore.swift               // App-Group-backed signed snapshot cache
```

## Wiring notes

- **App Group** (e.g. `group.com.example.parentfilterpoc`) is the only channel
  between the containing app and the sandboxed extensions — the data-provider
  sandbox blocks network/IPC/disk-writes, so the app writes the signed policy
  snapshot into the App Group container and the providers read it.
- **FamilyControls**: the app calls
  `AuthorizationCenter.shared.requestAuthorization(for: .child)`; a parent must
  approve on the child device. Only then does the content filter load on an
  unsupervised device (TN3134).
- **Enable the filter**: `NEFilterManager.shared().providerConfiguration` set to
  an `NEFilterProviderConfiguration` with `filterBrowsers = true` (WebKit flow
  URLs) and `filterSockets = true`; `isEnabled = true`; `saveToPreferences`.
- **Remediation**: the control provider sets `remediationMap` and the data
  provider returns `.remediateVerdict(...)` for a blocked WebKit flow; the app
  handles the tapped link (blocked canonical id) to create an access request.
- **Fast update**: after the app writes a new snapshot, it pings the control
  provider (via App Group flag + `NEFilterManager` reload) which calls
  `notifyRulesChanged()`.

The `Shared/` Swift MUST reproduce the semantics of the TypeScript in `/shared`
(the TypeScript is the authoritative spec). Keep them in lockstep.

## What to measure

Follow `docs/APPLE_CONTENT_FILTER_POC.md` tests A1–A6 and fill the Observed
Results tables there and update `docs/DECISIONS.md` ADR-001.
