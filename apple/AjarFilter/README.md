# Ajar Filter

The app installed on the device being filtered — **iOS, iPadOS and macOS, one
product, one bundle id** (`family.ajar.filter`).

It was `poc-contentfilter` / "child app" until the enforcement it exists to
provide was measured working on hardware. The name describes what it *is*: the
same binary protects a phone, an iPad and a Mac, and on a shared family Mac "the
child app" is the wrong noun.

| Target | Bundle id | Platform |
|---|---|---|
| `AjarFilter` | `family.ajar.filter` | iOS, iPadOS, macOS |
| `FilterDataProvider` | `family.ajar.filter.DataProvider` | iOS |
| `FilterControlProvider` | `family.ajar.filter.ControlProvider` | iOS |
| App Group | `group.family.ajar.filter` | — |

```sh
brew install xcodegen && xcodegen generate
```

## What is proven, and what is not

**Proven on an iPhone 16 Pro Max / iOS 27.0** (ADR-001, A1–A3): one approved
YouTube video plays while another on the same host shows the block page, with no
VPN, no TLS interception and no MDM. `NEFilterBrowserFlow.url` carries the full
URL including the query string — observed, not inferred.

**The limit that qualifies any product claim:** YouTube is a single-page app.
A blocked URL entered directly is enforced, but tapping through *inside* YouTube
swaps videos over XHR with no top-level WebKit flow, so the filter never sees the
new id. See the README at the repository root.

**macOS is not proven at all.** The target declares the destination; the
extensions above are iOS app extensions, and a macOS content filter must be a
**system extension** — different container, entitlement
(`com.apple.developer.system-extension.install`) and distribution channel
(Developer ID + notarization outside the App Store). A macOS build produces the
app shell without filtering until that target exists.

`Shared/` is the evaluator, snapshot verification, canonical JSON, Bloom querier,
host/YouTube normalisation and safety floor — the same policy semantics the
backend and the browser extensions implement, checked against one conformance
corpus (`npm run conformance`). `Shared/SelfTest.swift` runs its parity vectors
natively; they pass.
