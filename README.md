# Ajar — Cross-Platform Parental URL Filtering Platform

> **Ajar** · *Say yes faster.* — product name and brand in
> [`docs/BRAND.md`](docs/BRAND.md). npm packages are `@ajar/*`; the GitHub repo
> is still named `contentfilter` (rename pending in Settings).
> Every rival is a locked door; Ajar is the door left open a crack — one tap and
> just that one thing swings open.

A consumer (family) parental-control platform whose defining capability is
**URL-level** enforcement, not just domain-level: block YouTube generally, but
let a parent approve **one specific video** in seconds — permanently or
temporarily — without granting all of YouTube, and **without a VPN or TLS
interception on Apple platforms and without enterprise MDM**.

**Install (no Node/Go on the box):** [`docs/INSTALL.md`](docs/INSTALL.md) —
download two prebuilt binaries and run them. The child's PC runs only a single
static service `.exe` + a store browser extension; the backend runs on Cloudflare
Workers (or self-host it as one bundled binary).

> **Repository status: Phase 0 complete + Phase 1 backend alpha underway.** The
> architecture research and PoC scaffolds are in place, and the platform-agnostic
> **cloud backend is implemented and tested** (family model, policy engine,
> temporary approvals, access requests, Ed25519-signed policy sync) running on an
> in-memory store with CI + a Cloudflare Workers deploy target. The device-side
> enforcement mechanisms are still being validated on real hardware. Start with
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); to run the backend see
> [`backend/README.md`](backend/README.md).

## The one question Phase 0 must answer

> Can a child hit a blocked YouTube video, request it, have a parent approve
> **only that canonical video** for a chosen duration, refresh within seconds,
> and play it while every other unapproved video stays blocked — no VPN/TLS-MITM
> on Apple, no MDM?

### Answered on hardware — yes, with one limit that qualifies the claim

Measured on an iPhone 16 Pro Max running iOS 27.0 (see `docs/DECISIONS.md`
ADR-001 and the A1–A3 results in `docs/APPLE_CONTENT_FILTER_POC.md`):
`NEFilterBrowserFlow.url` carries the **full URL including the query string**, so
one video plays while another on the same host shows the block page — on
unmodified iOS, no VPN, no TLS interception, no MDM. That is the design's load-
bearing fact and it is now observed rather than inferred.

**The limit, stated plainly because it changes what may honestly be promised:**
YouTube is a single-page app. Entering a blocked video URL directly is enforced,
but once the child is *inside* YouTube, tapping through to another video swaps it
in over XHR with **no top-level WebKit flow** — so the filter never sees the new
video id, and that video plays. Nothing that only sees browser flows can enforce
per-video policy across in-app navigation.

So **"your child can only watch videos you approved" is not true on iOS today**
for a child who browses within YouTube rather than following links. It is true
for links they are sent or type. Closing the gap needs a different lever, not a
patch to the content filter.

## Repository layout

| Path | What it is |
|---|---|
| `docs/ARCHITECTURE.md` | **Start here.** Full Phase-0 research: what current platform APIs can/can't do, the architecture, and the unresolved questions. |
| `docs/DECISIONS.md` | ADR log — load-bearing decisions and the evidence that confirms/overturns them. |
| `docs/APPLE_CONTENT_FILTER_POC.md` | **PoC A (primary)** — iOS `NEFilterDataProvider` + FamilyControls `.child`. The per-video approval engine. |
| `docs/MACOS_SAFARI_POC.md` | **PoC B** — macOS Safari Web Extension (per-video, unresolved). Never block Safari. |
| `docs/WINDOWS_FILTER_POC.md` | **PoC C** — Windows policy-installed browser extension + hardened service (no MITM by default). |
| `docs/APPLE_URL_FILTER_POC.md` | **PoC D (supplementary)** — `NEURLFilter` Bloom/PIR large-scale blocklist. |
| `docs/INSTALL.md` | **Install with prebuilt binaries** — no Node/Go on the box; cloud or self-hosted backend. |
| `docs/BRAND.md` | Product name (**Ajar**), voice, microcopy, and palette. |
| `docs/UX_PRINCIPLES.md` | Behavioral-science UX principles for the ask→approve→unblock loop, mapped to concrete UI changes. |
| `docs/DEPLOYMENT.md` | Backend → Cloudflare Workers via GitHub Actions; secrets + signing-key generation. |
| `docs/APPLE_ACCOUNT_SETUP.md` | Apple Developer account prep runbook (enrollment, App IDs, entitlements, Family Controls request, APNs). |
| `docs/RELEASE_CHECKLIST.md` | The gate for merging PR #1 — "alpha ready → merge." |
| `backend/` | **Cloud backend (implemented, tested)** — TypeScript, in-memory + durable SQLite/D1 store, node:http + Workers adapters. |
| `web/parent/` | **Parent Console** — static web UI to demo the approval loop in a browser (production parent UX is the iOS app). |
| `windows/extension/` | **Windows MV3 extension** — enforcing client; browser-testable against the live backend (enroll → long-poll → block → request → approve). |
| `shared/policy/policy-model.ts` | Platform-agnostic policy model + evaluation order + reference evaluator (**the source of truth**). |
| `shared/youtube/youtube-normalize.ts` | Canonical YouTube object normalization (**the source of truth**). |
| `apple/poc-contentfilter/` | PoC A scaffold (Xcode 26 / iOS 26, on-device). |
| `apple/poc-urlfilter/` | PoC D scaffold (NEURLFilter + Bloom builder + PIR server config). |
| `apple/child-agent/`, `apple/parent-app/` | Later-phase placeholders. |
| `macos/safari-extension/` | Safari Web Extension — enforcing client, backend-wired (same client modules as Windows; Safari gates via webNavigation + content-script since it lacks blocking webRequest). |
| `windows/agent/`, `windows/extension/` | PoC C skeleton (service + MV3 extension). |

## Enforcement, per platform (research summary)

| Requirement | iOS/iPadOS 26+ | macOS 26+ | Windows |
|---|---|---|---|
| Default-deny YouTube, approve one video, per-URL, seconds | `NEFilterDataProvider` + FamilyControls `.child` | Safari Web Extension (+ native layers) | Policy-installed MV3 extension (`webRequestBlocking`) |
| Large-scale category/adult/malware blocklist | `NEURLFilter` (Bloom + PIR) | `NEURLFilter` | Extension rulesets + DNS layer |
| Anti-tamper anchor | FamilyControls `.child` | Standard (non-admin) account + notarized system extension | Standard account + hardened service |

Key honest constraints: the only strongly-enforced posture is **iOS with a real
child Apple ID in Family Sharing (`.child`)**; **macOS and Windows require a
standard (non-admin) child account** and an admin child defeats consumer-grade
protection. `NEURLFilter` is blocklist-only and cannot do per-video approval —
that is why iOS uses the classic content filter for the core flow. We never block
Safari, never route child traffic through our cloud, and use only documented OS
security mechanisms (no stealth/rootkit techniques).

## Phased roadmap

- **Phase 0 — Architecture research + PoCs (this repo state).** `docs/` + PoC scaffolds.
- **Phase 1 — Backend**: auth, family/children/parents/devices, policy engine, temporary approvals, access requests, approval decisions, push abstraction, sync. With tests.
- **Phase 2 — Apple PoC validation** on hardware (record results into the PoC docs + ADRs).
- **Phase 3 — Parent iOS app** (SwiftUI): login, family, children, requests, approvals, temporary access, devices, policies.
- **Phase 4 — Child Apple agent**: enrollment + enforcement.
- **Phase 5 — Windows PoC → agent**.
- **Phase 6 — Production hardening.**

## MVP success test (must pass end-to-end before "done")

Parent creates a family, adds Child A, assigns a Windows PC + MacBook + iPhone,
restricts YouTube. Child opens an unapproved school video → blocked → **Request
Access** → both parents notified → a parent taps **Allow this video for 30
minutes** → policy propagates in seconds → child refreshes → that exact video
plays → another video stays blocked → after 30 minutes the approved video is
blocked again automatically. Verified on iOS Safari, macOS Safari, Windows Edge,
Windows Chrome; Firefox documented separately.
