# APPLE_ACCOUNT_SETUP — Apple Developer account prep runbook

> Status: **operational prep checklist.** This enumerates every concrete Apple
> Developer step to get the iOS PoCs and eventual apps **signable, testable on a
> real device, and (later) distributable**. It is the account-side companion to
> the hardware blocker recorded in **ADR-012** (no device / no signing identity /
> no team yet) and to the entitlement facts in **ARCHITECTURE §3 and §12**.
>
> Scope note: **development-signed on-device testing needs far less than
> distribution.** The Family Controls *distribution* entitlement and the
> `NEURLFilter` OHTTP/PIR Identity & Trust onboarding are **LATER** (pre-public-
> beta), not alpha blockers — see [§8](#8-alpha-vs-later) and ARCHITECTURE §3.1.
> Where a claim is load-bearing it carries an official URL. Do not fill in Team
> IDs / bundle prefixes here from guesswork; the person running this holds the
> accounts and substitutes `<org>` throughout.

Portal entry points used below:

- Developer account home — <https://developer.apple.com/account/>
- Certificates, Identifiers & Profiles — <https://developer.apple.com/account/resources/>
- App Store Connect — <https://appstoreconnect.apple.com/>
- Account help (roles, membership) — <https://developer.apple.com/help/account/>

---

## 1. Enroll the Apple Developer Program as an **Organization** (not Individual)

**Why Organization is required (not optional for this product):**

- Parental-control apps that use NetworkExtension / act as content filters are
  reviewed as **"approved providers"** under App Review Guidelines **5.4
  (VPN/NEVPNManager)** and the parental-controls provisions of **5.5**; Apple
  grants the sensitive entitlements to **organizations**, and the
  **Family Controls distribution entitlement** ([§6](#6-family-controls-distribution-entitlement-later))
  is issued per-app to an enrolled org, not to an individual. See ARCHITECTURE
  §3.3 and §12.
- An Individual account cannot host the org-level agreements (child-safety data
  handling under 5.1.2 / 5.5) that the family backend implies.

**Checklist:**

- [ ] Have a **D-U-N-S number** for the legal entity (Apple looks it up during
      enrollment; request/verify it first — Apple links the free lookup from the
      enrollment flow).
- [ ] Legal entity name, address, and website match the D-U-N-S record.
- [ ] The person enrolling has **legal authority to bind the entity** (Apple
      verifies this by phone).
- [ ] Enroll as **Organization** at **<https://developer.apple.com/programs/enroll/>**.
- [ ] Pay the annual membership fee; wait for Apple's verification call/email.
- [ ] Record the outcome: this account becomes the **Account Holder**.

> Individual enrollment "to get started faster" is a false economy here: the
> entitlements this product needs are org-gated, and you cannot transfer an
> individual account into an org.

---

## 2. Team, Team ID, and roles

- [ ] In <https://developer.apple.com/account/>, record the **Team ID** (10-char,
      e.g. `A1B2C3D4E5`). It is also the **APNs Team ID** ([§7](#7-apns-push-key))
      and a hand-off secret to the backend/CI ([§9](#9-secrets-to-hand-to-backendci)).
- [ ] Confirm the **Account Holder** (only one; controls agreements + entitlement
      requests).
- [ ] Add team members with roles (**Admin** for those who manage certificates,
      identifiers, and App Store Connect; **Developer** for build/test). Roles
      reference: <https://developer.apple.com/help/account/>.
- [ ] The person who will submit the **Family Controls distribution** request and
      the **Identity & Trust** config must be **Account Holder or Admin**.

---

## 3. Signing certificates

Two certificate types; create both once the team exists.

- [ ] **Apple Development** cert — signs builds for **on-device debug/test**. This
      is the one that unblocks the ADR-012 gap once a device + team are present.
- [ ] **Apple Distribution** cert — signs **App Store / TestFlight / ad-hoc**
      builds (LATER).
- Create at **Certificates, Identifiers & Profiles →
      <https://developer.apple.com/account/resources/certificates/list>**.
- [ ] Decide certificate custody: let Xcode **"Automatically manage signing"** for
      the app + each extension target, OR manage manually. Automatic is fine for
      the PoCs; CI/distribution later may want an explicit provisioning profile
      per target.
- [ ] Note: the special entitlements below (Family Controls, NetworkExtension
      values) attach to **App IDs / provisioning profiles**, not to the cert
      itself.

---

## 4. App IDs / bundle identifiers to register

Register each App ID under **Certificates, Identifiers & Profiles → Identifiers →
+ → App IDs** (<https://developer.apple.com/account/resources/identifiers/list>).
Enable exactly the capabilities listed. `<org>` is the reverse-DNS org prefix.

> The **NetworkExtension** capability is a single entitlement key
> (`com.apple.developer.networking.networkextension`) whose **value list**
> selects the provider types (`content-filter-provider`, `url-filter-provider`,
> …). Enable the capability, then include the right values in each target's
> entitlements file. Ref:
> <https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.networking.networkextension>.

| App ID / bundle id | Purpose | Capabilities to enable |
|---|---|---|
| `com.<org>.parentfilter` | **Parent app** | **Push Notifications** (APNs); **App Groups**; **Sign in with Apple** *only if* also offering a 3rd-party (Google/Facebook) login — App Review 4.8. See note below. |
| `com.<org>.childfilter` | **Child agent app** (container) | **Family Controls** (`com.apple.developer.family-controls`); **Network Extensions** with **`content-filter-provider`** AND **`url-filter-provider`**; **App Groups**; **Push Notifications** |
| `com.<org>.childfilter.filter-data` | Content-**filter data** provider extension (`NEFilterDataProvider`) | **Network Extensions → `content-filter-provider`**; **App Groups** |
| `com.<org>.childfilter.filter-control` | Content-**filter control** provider extension (`NEFilterControlProvider`) | **Network Extensions → `content-filter-provider`**; **App Groups** |
| `com.<org>.childfilter.urlfilter` | **URL-filter** control provider extension (`NEURLFilterControlProvider`, PoC D) | **Network Extensions → `url-filter-provider`**; **App Groups** |

**App Group (register once, share across app + all extensions):**

- [ ] Register App Group **`group.com.<org>.childfilter`** under Identifiers →
      App Groups, and add it to the child agent app **and every child-side
      extension** above. This group is where the **Ed25519-signed
      `DevicePolicySnapshot`** cache lives (ARCHITECTURE §8, ADR-010).

**Extension `Info.plist` facts to get right (not App-ID settings, but they pair
with the entitlements above):**

- [ ] `filter-data` / `filter-control` are classic `.appex` extensions
      (`NSExtensionPointIdentifier = com.apple.networkextension.filter-data` /
      `…filter-control`).
- [ ] `urlfilter` is an **ExtensionKit** extension (lands in
      `MyApp.app/Extensions/`, not `PlugIns/`) with
      **`EXExtensionPointIdentifier = com.apple.networkextension.url-filter-control`**
      (per ADR-013).

**Sign in with Apple note:** SIWA is required **only if** you offer another
third-party login (4.8). Email/passkey-only auth (ARCHITECTURE §7) does **not**
force SIWA. Enable it on `com.<org>.parentfilter` only if/when a 3rd-party login
is added — it is **not** an alpha requirement.

---

## 5. Provisioning profiles

- [ ] For each App ID above, an **Apple Development** provisioning profile
      (automatic or manual) so the app + all four extensions install on a
      development device.
- [ ] For distribution (LATER): matching **App Store / ad-hoc** profiles, which
      is where the **Family Controls distribution entitlement** must already be
      granted ([§6](#6-family-controls-distribution-entitlement-later)).

---

## 6. Family Controls **distribution** entitlement (LATER)

Distinct from the *development* Family Controls capability enabled in §4.

- **Fact (ARCHITECTURE §3.1, §12; ADR-012):** development-signed builds run the
  content filter and `.child` authorization **WITHOUT** the distribution
  entitlement — this is what makes PoC A / PoC D testable on device as soon as a
  team + device exist. **App Store, TestFlight, ad-hoc, and Developer-ID
  distribution all require** the distribution entitlement.
- **It is requested from Apple and is granted per-app AND per Screen Time API
  extension** — i.e. you request it for the child agent **and** each Screen Time /
  Family Controls-using extension separately.

**Checklist (do when moving toward TestFlight/public beta):**

- [ ] Submit the request at
      **<https://developer.apple.com/contact/request/family-controls-distribution>**.
- [ ] List every bundle id that uses Family Controls / Screen Time APIs
      (`com.<org>.childfilter` and any extension that touches those APIs).
- [ ] Describe the parental-control use (aligns with the 5.5 "approved provider"
      posture).
- [ ] After grant, add the distribution entitlement to those targets' entitlements
      and regenerate distribution provisioning profiles (§5).

> Do **not** block the backend alpha or the PoC-A on-device run on this. It gates
> distribution only.

---

## 7. APNs push key

Use a **token-based APNs Auth Key (.p8)** — one key works for all your bundle ids
and does not expire like per-app certificates.

- [ ] Create the key at **Certificates, Identifiers & Profiles → Keys → +**
      (<https://developer.apple.com/account/resources/authkeys/list>), enabling
      **Apple Push Notifications service (APNs)**.
- [ ] **Download the `.p8` once** (Apple never lets you re-download it) and store
      it in the team secret manager.
- [ ] Record the **Key ID** (10 chars) and the **Team ID** (§2).
- [ ] Note which bundle ids will send push: `com.<org>.parentfilter` (parent gets
      "new access request"), and `com.<org>.childfilter` (child gets "sync now").
- Backend consumption: the **`NotificationEndpoint` / `Notifier`** abstraction
  (`backend/src/push/notifier.ts`, ARCHITECTURE §7) is where an APNs `Notifier`
  drops in behind the existing interface; it consumes the `.p8` + Key ID + Team
  ID. UserNotifications / APNs reference:
  **<https://developer.apple.com/documentation/usernotifications>**.

---

## 8. App Store Connect & TestFlight (LATER)

- [ ] Create App Store Connect app records for **parent** (`com.<org>.parentfilter`)
      and **child** (`com.<org>.childfilter`) apps at
      <https://appstoreconnect.apple.com/>.
- [ ] Use **TestFlight** for internal/external beta once distribution signing +
      the Family Controls distribution entitlement (§6) are in place.
- [ ] **Category: do NOT use the Kids Category.** Per ARCHITECTURE §12 the
      **parent is the buyer and account holder**, and the Kids Category's
      no-third-party-PII rules conflict with the server-side family model. Pick a
      Utilities/Productivity-style category, not Kids.

### 8.1 Wiring App Store Connect to CI — exactly what to do

`.github/workflows/testflight.yml` archives, signs and uploads the iOS child app
with **no Mac involved**. It needs five values, and it preflights for all of them
so a missing one fails in seconds with a readable list instead of a signing error
twenty minutes in.

**Step 1 — create an App Store Connect API key** (this replaces app-specific
passwords and Fastlane Match; it both mints signing profiles and uploads).

- App Store Connect → **Users and Access → Integrations → App Store Connect API**
  → **Team Keys** → **+**.
- Role: **App Manager**. Developer is NOT enough — `xcodebuild
  -allowProvisioningUpdates` has to be able to create/modify provisioning
  profiles, and Developer cannot.
- Download the **`.p8` exactly once** — Apple will not show it again. Note the
  **Key ID** and, at the top of that page, the **Issuer ID** (a UUID, shared by
  the whole team).

**Step 2 — set them in GitHub** (repo → Settings → Secrets and variables → Actions):

| Name | Kind | Value |
|---|---|---|
| `ASC_KEY_ID` | secret | the 10-char Key ID |
| `ASC_ISSUER_ID` | secret | the Issuer UUID |
| `ASC_KEY_P8` | secret | **the whole `.p8` file contents**, including the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines |
| `APPLE_TEAM_ID` | **variable** | the 10-char Team ID (§2) |
| `IOS_BUNDLE_ID` | **variable** | the real child-app bundle id, e.g. `com.<org>.childfilter` (§4) |

The last two are variables, not secrets — a Team ID and a bundle id are public,
and putting them in secrets only makes CI logs harder to read.

**Step 3 — register the bundle id and create the app record.** §4 registers the
App ID with its entitlements; then create the App Store Connect app record for
that same id (§8 above). The upload has nowhere to land without it.

**Step 4 — run it.** Actions → *iOS — TestFlight (internal)* → Run workflow, type
`testflight` to confirm. The workflow generates the Xcode project from
`project.yml`, rewrites the `com.example.parentfilterpoc` placeholders to your
`IOS_BUNDLE_ID`, signs, exports and uploads. Processing in App Store Connect takes
a few minutes before the build appears to internal testers.

### 8.2 What will actually stop you (in the order you will hit it)

1. **The Family Controls distribution entitlement (§6).** This is the real gate,
   and it is a human review with calendar time attached — not something CI can
   route around. Development signing works without it; **App Store / TestFlight
   signing does not.** Request it the day you decide TestFlight is the goal, not
   the day you want to upload. Everything else here is minutes of work.
2. **App Manager role.** A key created with the Developer role archives fine and
   then fails to create a provisioning profile.
3. **Placeholder bundle ids.** `com.example.parentfilterpoc` cannot be signed for
   distribution. The workflow rewrites them from `IOS_BUNDLE_ID`, but the id has
   to be registered first (§4) with Family Controls, Network Extensions and App
   Groups enabled — and the two extensions need their own ids.
4. **Export compliance.** First upload prompts for encryption questions. Ajar uses
   only standard TLS + platform crypto, so the usual answer is the exemption — but
   it blocks the build from reaching testers until answered, and it is easy to
   miss sitting in App Store Connect.

### 8.3 What a green TestFlight run does and does not prove

It proves the app **builds, signs and uploads**. It does **not** prove the filter
works: PoC A's enforcement has never run on hardware (ADR-012), and the two
questions that decide the architecture — whether `.child` actually locks the
filter toggle, and whether `NEFilterFlow.url` really carries full YouTube watch
URLs at runtime — are answered by *installing that build and running the A1–A6
protocol* in `docs/APPLE_CONTENT_FILTER_POC.md`. Getting to TestFlight is how you
start that, not how you finish it.

---

## 9. `NEURLFilter` OHTTP relay / PIR server — Identity & Trust onboarding (DEFERRED)

> **Deferred — only when the supplementary `NEURLFilter` blocklist layer (PoC D)
> ships. NOT needed for the PoC-A core or the alpha.** Development-signed builds
> **skip Apple's OHTTP relay entirely** (ARCHITECTURE §3.1, ADR-002), so the
> mechanism is testable on-device now without any of this. This section exists so
> the onboarding is not rediscovered later.

Non-development distribution of a `url-filter-provider` requires Apple to
**validate your OHTTP gateway + PIR service** via **CloudKit Console → Identity &
Trust** (<https://icloud.developer.apple.com/dashboard/identity>). Onboarding
checklist (from the PoC-D research; see `docs/APPLE_URL_FILTER_POC.md`):

- [ ] Register the URL-filter config in **CloudKit Console → Identity & Trust**,
      tied to the child app **bundle id**.
- [ ] Provide **per-continent traffic estimates** (Apple sizes relay capacity).
- [ ] Serve the **`www.apple.com/url-filter-test` canary** in your dataset with
      value **`1`** (Apple's validation probe).
- [ ] Stand up an **OHTTP gateway over HTTP/2** returning an **RFC 9458 BINARY**
      key configuration (**not** JSON).
- [ ] Provide a **Privacy Pass token issuer URL**.
- [ ] Provide the **service URL as a subdomain, not a path** — custom paths were
      **removed in iOS/macOS 26.4**; use `pir.<domain>` style subdomains.
- [ ] Publish a **DNS TXT record `apple-url-filter=<bundleid>`** on the service
      domain.
- [ ] Provide an **HTTP bearer token** for Apple's validation fetch.
- [ ] Ensure the deployment is **live during Apple's validation** window.
- Reference server stack (Apache-2.0): **`apple/pir-service-example`**
  (<https://github.com/apple/pir-service-example>) and
  **`apple/swift-homomorphic-encryption`**
  (<https://github.com/apple/swift-homomorphic-encryption>).

---

## 10. What's needed for the ALPHA vs LATER {#8-alpha-vs-later}

| Item | ALPHA (unblock PoC-A on device + build/test) | LATER (pre-public-beta) |
|---|---|---|
| Organization enrollment (§1) | ✅ required | — |
| Team + Team ID + roles (§2) | ✅ required | — |
| **Apple Development** signing cert (§3) | ✅ required | — |
| Apple **Distribution** cert (§3) | — | ✅ |
| Child agent + parent **App IDs** (§4) | ✅ required | — |
| Filter-data / filter-control / urlfilter extension App IDs (§4) | ✅ (PoC scaffolds already reference them) | — |
| **App Group** `group.com.<org>.childfilter` (§4) | ✅ required | — |
| **APNs `.p8` key** + Key ID + Team ID (§7) | ✅ required (backend Notifier) | — |
| **Family Controls _distribution_ entitlement** (§6) | ❌ not needed (dev-signed works) | ✅ required |
| App Store Connect records + TestFlight (§8) | ❌ | ✅ |
| **`NEURLFilter` Identity & Trust** onboarding (§9) | ❌ deferred | ✅ (only if PoC-D layer ships) |

> The remaining alpha blocker is **hardware + a signed dev build**, not a
> distribution artifact — exactly the ADR-012 gap. Everything in the ALPHA column
> is account/portal work the account holder can complete now.

---

## 11. Secrets to hand to the backend / CI {#9-secrets-to-hand-to-backendci}

Store in the team secret manager (never in git). These are Apple-side; the
Cloudflare/signing secrets live in `docs/DEPLOYMENT.md`.

| Secret | What | Consumed by |
|---|---|---|
| `APNS_KEY` | the APNs **`.p8`** file contents (§7) | backend APNs `Notifier` |
| `APNS_KEY_ID` | 10-char Key ID (§7) | backend APNs `Notifier` |
| `APPLE_TEAM_ID` | 10-char Team ID (§2) | backend APNs `Notifier` (also = APNs Team ID) |
| `APNS_TOPIC_PARENT` | bundle id `com.<org>.parentfilter` (§4) | APNs topic for parent pushes |
| `APNS_TOPIC_CHILD` | bundle id `com.<org>.childfilter` (§4) | APNs topic for child "sync now" pushes |
| `ASC_KEY_ID` | App Store Connect API **Key ID** (§8.1) | `testflight.yml` — signing + upload |
| `ASC_ISSUER_ID` | App Store Connect API **Issuer UUID** (§8.1) | `testflight.yml` — signing + upload |
| `ASC_KEY_P8` | the App Store Connect **`.p8`** contents (§8.1) | `testflight.yml` — signing + upload |

GitHub **variables** (not secrets — both are public values):

| Variable | What | Consumed by |
|---|---|---|
| `APPLE_TEAM_ID` | 10-char Team ID (§2) | `testflight.yml` |
| `IOS_BUNDLE_ID` | real child-app bundle id (§4) | `testflight.yml` — rewrites the PoC placeholders |

---

## 12. Primary sources

- Program enrollment (Organization) — <https://developer.apple.com/programs/enroll/>
- App Review Guidelines (5.4 / 5.5 / 4.8 / 5.1.2) — <https://developer.apple.com/app-store/review/guidelines/>
- Certificates, Identifiers & Profiles — <https://developer.apple.com/account/resources/>
- NetworkExtension entitlement (values incl. content-filter-provider / url-filter-provider) — <https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.networking.networkextension>
- FamilyControls — <https://developer.apple.com/documentation/familycontrols>
- Family Controls **distribution** entitlement request — <https://developer.apple.com/contact/request/family-controls-distribution>
- UserNotifications / APNs — <https://developer.apple.com/documentation/usernotifications>
- CloudKit Console → Identity & Trust — <https://icloud.developer.apple.com/dashboard/identity>
- App Store Connect — <https://appstoreconnect.apple.com/>
- `apple/pir-service-example` — <https://github.com/apple/pir-service-example> · `apple/swift-homomorphic-encryption` — <https://github.com/apple/swift-homomorphic-encryption>
- Internal: ARCHITECTURE §3, §7, §12; ADR-002, ADR-011, ADR-012, ADR-013.
