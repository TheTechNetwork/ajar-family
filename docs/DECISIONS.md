# Architecture Decision Record (ADR)

Running log of load-bearing decisions and the empirical results that confirm or
overturn them. Each ADR has a status: **Proposed** (design-time, unproven),
**Accepted** (proven on hardware or firmly settled), **Superseded**.

Phase-0 ADRs are mostly **Proposed** — they encode the research conclusion and
name the PoC that must confirm them. Update the status + "Evidence" line when a
PoC produces a result.

---

### ADR-001 — The per-video-approval engine on iOS is `NEFilterDataProvider`, not `NEURLFilter`
**Status:** Proposed (confirm in PoC A)
**Context:** The headline requirement is default-deny YouTube with per-video
approval in seconds. Research shows `NEURLFilter` is **blocklist-only** (dataset
values are always `1`; sub-URL enumeration blocks a whole domain with no
override) and has **no remediation/Request-Access UX**. The classic
`NEFilterDataProvider` content filter, under FamilyControls `.child`, sees the
**full URL** on WebKit/Safari flows, supports a **dynamic allowlist** with
`notifyRulesChanged()` (seconds), and provides a **remediation block page**.
**Decision:** iOS per-video enforcement = `NEFilterDataProvider` + FamilyControls
`.child`. `NEURLFilter` is relegated to the supplementary blocklist layer.
**Consequences:** iOS requires a genuine child Apple ID in Family Sharing; the
`.individual` posture is explicitly not marketed as parental control.
**Evidence:** _partial — compile-time only; the runtime claim is still unproven._
On 2026-08-27 the PoC A scaffold was assembled into a real Xcode project
(`apple/poc-contentfilter/project.yml`, XcodeGen 2.46.0) and **builds clean for
`arm64` device** against the iPhoneOS SDK shipped with Xcode 27.0, deployment
target iOS 26.0 (app + filter-data `.appex` + filter-control `.appex`, App Group
`group.com.example.parentfilterpoc`). That confirms the API surface the decision
rests on *exists and type-checks* — `NEFilterDataProvider.handleNewFlow`,
`NEFilterBrowserFlow`, `NEFilterNewFlowVerdict.remediateVerdict(...)`,
`NEFilterControlProvider.remediationMap` / `notifyRulesChanged()`,
`NEFilterManager` + `NEFilterProviderConfiguration.filterBrowsers`, and
`AuthorizationCenter.shared.requestAuthorization(for: .child)`.
It does **not** confirm any behavioural claim. Tests A1–A6 have **not been run**:
no iOS device and no signing identity were available (see ADR-012). The
propagation number, the A6 tamper findings, and the §0 workflow all remain
**unproven**. Do not treat this ADR as Accepted.

### ADR-002 — `NEURLFilter` is a supplementary large-scale blocklist, not the core
**Status:** Proposed (confirm in PoC D)
**Context:** `NEURLFilter` scales to millions of blocked URLs with a
privacy-preserving Bloom+PIR design, but cannot express allow-one-video and
cannot update the Bloom prefilter faster than 45 minutes.
**Decision:** Use `NEURLFilter` only for adult/malware/known-proxy/category
blocklists and specific bad videos. Do not over-invest PIR/OHTTP infrastructure
in Phase 0.
**Evidence:** _pending PoC D._

### ADR-003 — No VPN and no TLS interception on Apple platforms
**Status:** Accepted (design principle)
**Context:** Older parental-control apps use a local VPN. The native
content-filter + URL-filter path meets the requirement without routing or
decrypting traffic.
**Decision:** No `NEVPNManager`/packet-tunnel and no TLS MITM on Apple. A VPN is a
documented fallback only, introduced solely if a PoC proves the native path
cannot meet a concrete requirement.
**Evidence:** native path covers the MVP flow by design; revisit only on a proven gap.

### ADR-004 — Never block Safari to gain enforcement on macOS
**Status:** Accepted (product constraint)
**Context:** Native-macOS content filter is hostname-only and `NEURLFilter` can't
default-deny, making Safari per-video hard.
**Decision:** macOS per-video enforcement is a **Safari Web Extension** (+
`NEURLFilter` blocklist + `NEFilterDataProvider` system extension for
socket/hostname). Safari stays fully functional; we never disable it.
**Evidence:** _direction set; feasibility of force-install + tamper resistance pending PoC B._

### ADR-005 — Windows starts without TLS interception
**Status:** Proposed (confirm in PoC C)
**Context:** No Windows OS layer sees an HTTPS path. Per-URL control comes from a
**policy-installed browser extension** (`webRequestBlocking` survives policy
install) or a local MITM proxy. MITM is invasive (root CA, pinning breakage,
QUIC handling).
**Decision:** Ship first with hardened service + policy-installed Chrome/Edge/
Firefox extensions doing full-URL enforcement + anti-tamper/browser-policy +
block unsupported browsers. Introduce TLS interception only if a concrete
required case cannot be covered this way.
**Evidence:** _pending PoC C (esp. force-install + webRequestBlocking on Win 11 Home, non-domain-joined)._

### ADR-006 — Child must be a standard (non-admin) account on macOS and Windows
**Status:** Accepted (product constraint)
**Context:** An admin child can delete apps, remove system extensions/CAs,
uninstall the service, and edit policy on both OSes; PPL/ELAM (the only
admin-resistant Windows mechanism) is out of reach for a small vendor.
**Decision:** Require a standard child account; the agent detects admin-child and
alerts the parent instead of claiming protection it cannot provide.
**Evidence:** research-confirmed; agent enforcement is an implementation task.

### ADR-007 — YouTube resources are first-class policy objects keyed by canonical id
**Status:** Accepted
**Context:** The same video appears under many URL forms; approving a URL string
would be brittle and could leak into the channel/recommendations.
**Decision:** All adapters call `shared/youtube/youtube-normalize.ts` to reduce a
URL to `YOUTUBE_VIDEO|CHANNEL|PLAYLIST:<id>` before consulting policy; the policy
engine operates on ids; approving a video never widens scope.
**Evidence:** implemented in `shared/`; adapters must reuse it (enforced by review).

### ADR-008 — One shared policy model + evaluation order; platforms only differ in enforcement
**Status:** Accepted
**Context:** Five enforcement engines must behave identically.
**Decision:** `shared/policy/policy-model.ts` defines targets/actions/scopes,
the evaluation order, temporary-rule expiry, and the reference `evaluate()`.
Adapters reproduce these semantics or compile a documented subset (e.g.
`NEURLFilter`'s blocklist).
**Evidence:** implemented; conformance is a per-adapter test obligation.

### ADR-009 — Temporary approvals: server-signed UTC expiry + monotonic clock + rollback detection
**Status:** Accepted (design principle)
**Context:** A child can change the system clock (admin) or time zone (standard
user, on Windows) to extend a grant.
**Decision:** Store/compare expiries in **UTC**; track durations with a
**monotonic** clock; detect clock/timezone skew vs. server time as a tamper
signal; grants are server-authoritative and signed. Fail closed on protected
categories, fail open on ordinary network errors.
**Evidence:** encoded in `shared/policy/policy-model.ts` (`TemporaryRule`,
`EvalContext.nowMs`); adapter enforcement pending per-platform PoCs.

### ADR-010 — Approvals are server-authoritative and cryptographically signed
**Status:** Accepted
**Context:** A child must never fabricate a parent approval.
**Decision:** `ApprovalDecision` + `TemporaryRule` originate server-side, are
delivered inside an Ed25519-signed `DevicePolicySnapshot`, and adapters reject
unsigned/altered snapshots (fail closed).
**Evidence:** snapshot signature field defined in `shared/`; backend + adapter
verification is a Phase-1 task.

### ADR-011 — iOS 26/27 SDK corrections to the PoC A scaffold
**Status:** Accepted (compiler-verified against the Xcode 27.0 iPhoneOS SDK)
**Context:** The Phase-0 scaffold was written from documentation without an SDK
to compile against. Building it for real surfaced three places where the SDK
disagrees with what was written. Recorded here because two of them are load-
bearing for the remediation ("Request Access") design, not cosmetic.
**Corrections applied:**
1. `NEFilterNewFlowVerdict.remediateVerdict(remediationURLMapKey:remediationButtonTextMapKey:)`
   does not exist. The Swift label is **`withRemediationURLMapKey:`**
   (from ObjC `+remediateVerdictWithRemediationURLMapKey:remediationButtonTextMapKey:`).
2. `NEFilterControlProvider.remediationMap` is typed
   `[String: [String: NSObject]]?`, **not** `[String: [String: String]]`. The
   inner values must be bridged explicitly (`... as NSString`); a plain Swift
   `String` literal is a type error.
3. `NEFilterProvider.handleReport(_:)` was **obsoleted in Swift 3** and is
   renamed to **`handle(_:)`**. Overriding `handleReport` fails to compile.
**Consequence:** none architectural — the capabilities ADR-001 depends on are all
present under corrected names. `apple/poc-contentfilter` now compiles as written.

### ADR-012 — PoC A is build-verified but **not** hardware-verified
**Status:** Open blocker (not a decision — a gap that must be closed)
**Context:** PoC A is the load-bearing proof for the whole iOS story. Executing
it requires a physical iOS 26 device: the Simulator cannot run a content filter,
`NEURLFilter`, or FamilyControls `.child`, and `.child` itself requires a real
child Apple ID inside a Family Sharing group.
**What is actually blocked (2026-08-27):** the development host is an Apple
Virtual Machine (`VirtualMac2,1`) with **no paired iOS device**
(`xcrun devicectl list devices` → none), **zero code-signing identities**
(`security find-identity -p codesigning` → 0), no provisioning profiles, and no
Apple Developer team configured in Xcode. The Family Controls and
`content-filter-provider` entitlements cannot be issued without a team, so the
app cannot be signed, installed, or run.
**Decision:** record PoC A as **build-green / test-not-run**. The Observed
Results table in `docs/APPLE_CONTENT_FILTER_POC.md` is deliberately left empty
rather than filled with expected values — no number in this repo should be one
nobody measured.
**To close:** a Mac with USB access to an iOS 26 device, an Apple Developer team
with the Family Controls entitlement, and a child Apple ID in a Family Sharing
group. Then run A1–A6 verbatim and update ADR-001 and ARCHITECTURE.md §13.
