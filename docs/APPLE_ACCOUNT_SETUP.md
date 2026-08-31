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
> Where a claim is load-bearing it carries an official URL. The bundle
> identifiers are **not** placeholders to substitute — they are fixed and live in
> the project (§4, §8.4). The only value that varies by who is building is the
> **Team ID**.

Portal entry points used below:

- Developer account home — <https://developer.apple.com/account/>
- Certificates, Identifiers & Profiles — <https://developer.apple.com/account/resources/>
- App Store Connect — <https://appstoreconnect.apple.com/>
- Account help (roles, membership) — <https://developer.apple.com/help/account/>

---

## 0. Do these in this order

Everything below is reference. This is the path. Each step is blocked by the one
above it, and the two marked ⏳ have waiting attached — start them early.

| # | Do | Where | Blocks |
|---|---|---|---|
| 1 | Enroll as an **Organization** ⏳ | §1 | everything (D-U-N-S + verification can take days-to-weeks) |
| 2 | Note the **Team ID**, set roles | §2 | every later step |
| 3 | **Request the Family Controls distribution entitlement** ⏳ | §6 | ALL distribution signing — file it the day you decide TestFlight is the goal |
| 3b | **Create a child Apple Account in a Family Sharing group** | §2.1 | **A6 tamper tests only** — A1–A5 do not need it (measured; an earlier version of this table said otherwise) |
| 4 | Register 3 App IDs + 1 App Group | §4 | signing anything |
| 5 | Create the **App Store Connect API key** (App Manager) | §8.1 | CI signing + upload |
| 6 | Set 3 GitHub secrets + 1 variable | §8.1 | CI signing + upload |
| 7 | Create the App Store Connect **app record** | §8 | the upload has nowhere to land |
| 8 | Fill the record's compliance fields | §8.5 | a build reaching a tester |
| 9 | Run the TestFlight workflow | §8.1 | — |

**Steps 3 and 3b are the two that surprise people, and they are independent of
everything else — start both first and do the rest while they settle.**

Step 3 is a human review at Apple with calendar time attached. No amount of
correct CI gets past it: development signing works without it, App Store and
TestFlight signing do not.

Step 3b is narrower than this document first claimed. `requestAuthorization(for:
.child)` does fail with `FamilyControlsError.invalidAccountType` on an adult
Apple Account — but a later run measured that the filter **enables and enforces
anyway**, with authorization Not Determined. It gates A6 (tamper resistance),
not the enforcement tests. See §2.1.

The **distribution certificate is created by hand** from a CSR (§3.1) — but not
in Keychain Access, and not on a Mac: OpenSSL produces the CSR anywhere. Add it
between steps 4 and 5. Provisioning profiles are still minted by CI (§5).

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

## 2.1 The child Apple Account — what it actually gates

**Corrected by measurement.** This section first said a child Apple Account
blocked the entire A1–A6 protocol. That was wrong, and wrong in the direction
that costs money: it implied a spare iPhone was needed before any enforcement
could be tested.

What is true: `requestAuthorization(for: .child)` returns
`FamilyControlsError.invalidAccountType` on a device signed in with an adult
Apple Account.

What was then measured on an iPhone 16 Pro Max running iOS 27.0: **A1–A3 passed
with FamilyControls authorization Not Determined.** The content filter enabled
and enforced per-video policy regardless. On iOS 27 the
`com.apple.developer.family-controls` **entitlement** was sufficient to run a
content filter; `.child` **authorization** was not required for enforcement.
That contradicts the TN3134 reading ADR-001 was originally built on.

So the account is needed for what it was always actually for:

- [ ] **A6 — tamper resistance.** Whether a child can disable the filter,
      delete the app, or sign out of iCloud is exactly what `.child`
      authorization governs, and none of it can be tested without one.
- [ ] Not needed for A1–A5: install, per-video enforcement, the block page,
      propagation timing, or temporary approvals.

When you do need it: the parent needs a Family Sharing group they organize with
a payment method on file (Apple requires one to verify parental consent), and
the test device signed into the child/teen account. Age bands vary by country —
check Apple's current docs for your region. Re-signing a daily driver into a
child account is disruptive, so a spare device is the practical answer **for A6**
— but it is no longer blocking the enforcement work.

---

## 3. Signing certificates

> **For the CI path you do not create a certificate, and you do not need a CSR.**
> `.github/workflows/testflight.yml` passes `-allowProvisioningUpdates` together
> with the App Store Connect API key (`-authenticationKeyPath/-KeyID/-IssuerID`)
> to both `xcodebuild archive` and `-exportArchive`. Xcode on the runner then
> mints the distribution certificate and the provisioning profiles itself, using
> the API key's **App Manager** role (§8.1). Nothing is generated by hand, which
> is the point — this project builds and ships without a Mac of its own.

- [ ] **Apple Development** cert — signs builds for **on-device debug/test**.
      Needed only if you sign a PoC build from a Mac by hand; the ADR-012 gap is
      hardware + a signed dev build, and Xcode's *Automatically manage signing*
      creates this for you on that Mac.
- [ ] **Apple Distribution** cert — signs **App Store / TestFlight / ad-hoc**
      builds. **Created manually from a CSR** — see §3.1. (This was previously
      left to CI; automatic provisioning hit an Apple-side cap in practice, so
      the certificate is now made by hand and handed to CI.)
- [ ] Note: the special entitlements (Family Controls, NetworkExtension values)
      attach to **App IDs / provisioning profiles**, not to the cert itself.

### 3.1 The CSR question — and why you should not need one

The portal's manual flow at
<https://developer.apple.com/account/resources/certificates/list> asks for a
**Certificate Signing Request**, and Apple documents making one in **Keychain
Access → Certificate Assistant → Request a Certificate From a Certificate
Authority**. That is a Mac-only path, which is why it looks like a wall here.

It is not one. A CSR is just a **PKCS#10** request, and OpenSSL produces one on
any OS:

```sh
openssl req -new -newkey rsa:2048 -nodes \
  -keyout ajar-distribution.key \
  -out ajar-distribution.certSigningRequest \
  -subj "/emailAddress=you@example.com/CN=Ajar Distribution/C=US"
```

Upload the `.certSigningRequest`, download the resulting `.cer`, and pair it back
with the private key to get something a build can actually sign with:

```sh
openssl x509 -in distribution.cer -inform DER -out distribution.pem -outform PEM
openssl pkcs12 -export -inkey ajar-distribution.key -in distribution.pem \
  -out distribution.p12 -name "Apple Distribution"
```

**This is the path we are taking**, and a session on a real Mac has now measured
why. `xcodebuild -allowProvisioningUpdates` **does not perform the portal
writes**: it silently falls back to a cached wildcard profile and emits no
authentication diagnostic at all, even with the account signed in and the team
cached. It does not fail — it produces a build signed with the wrong profile,
which is worse. Only the Xcode GUI or an App Store Connect API key actually
registers devices and creates App IDs.

So the certificate is made by hand from the CSR above and handed to CI rather
than minted per run.

Three things follow from that, and they are the cost of this route — worth
knowing rather than rediscovering:

1. **Apple allows a team one active distribution certificate** for standard App
   Store distribution (two only for in-house enterprise). Revoking the wrong one
   invalidates every provisioning profile built against it, so check what the
   team already holds before creating another.
2. **The private key is now the irreplaceable artifact.** Apple stores only the
   certificate; it cannot re-issue one against a key you no longer have. Lose it
   and you revoke and start over. It belongs in the password manager, and in
   GitHub secrets only as the `.p12` CI imports.
3. **It expires annually** (§12), and unlike the automatic path nothing renews it
   for you. That is now a calendar entry, not a non-event.

The repo `.gitignore` refuses `*.key`, `*.p12`, `*.cer`, `*.certSigningRequest`
and `*.mobileprovision` so none of this can be committed by reflex.

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
| `family.ajar.child` | **Child app** (container) | **Family Controls**; **Network Extensions**; **App Groups** |
| `family.ajar.child.FilterDataProvider` | Content-**filter data** provider (`NEFilterDataProvider`) | **Network Extensions**; **App Groups** |
| `family.ajar.child.FilterControlProvider` | Content-**filter control** provider (`NEFilterControlProvider`) | **Network Extensions**; **App Groups** |
| `family.ajar.parent` | **Parent app** (not built yet — `apple/parent-app/` is a stub) | **Push Notifications**; **Sign in with Apple** |

The first three are hardcoded in `apple/poc-contentfilter/project.yml` and its
`.entitlements` files (§8.4) — they are what `testflight.yml` signs today.
`family.ajar.parent` is registered ahead of its target existing. Register all
four plus the App Group below.

**Enable all of them now.** Register every App ID below with its full capability
set rather than adding capabilities as each target lands, so no profile has to be
regenerated later just because a merge turned one on.

| Capability | On | Note |
|---|---|---|
| **Push Notifications** | `family.ajar.child`, `family.ajar.parent` | no Apple code registers for remote notifications yet; the entitlement is inert until it does |
| **`url-filter-provider`** | `family.ajar.child` (add to the existing NetworkExtension array) | for the `NEURLFilter` layer in `apple/poc-urlfilter/` (§9) |
| **Sign in with Apple** | `family.ajar.parent` | 4.8 only compels it alongside a third-party login, which Ajar does not offer |

One consequence to be ready for rather than surprised by: App Review asks you to
justify the entitlements a binary carries, so a capability enabled ahead of the
code that uses it is a question you answer at review time. That is a conversation,
not a rejection — and it is the trade for never regenerating a profile mid-merge.

> **App IDs, not App Store Connect records.** Registering an App ID is free and
> reversible. An App Store Connect *record* is the permanent artifact — its bundle
> id can never be renamed or reused — so create the record for `family.ajar.child`
> only (§8), and add `family.ajar.parent`'s record when that app can actually be
> uploaded.

### 4.1 Every entitlement, including the scaffolds not yet merged

The table above is what exists and signs **today**. This is the full inventory
for the surfaces already scaffolded in the repo, so a provisioning profile is
never regenerated just because a merge added a capability. Enable a capability
on the App ID only when its target actually merges — a profile carrying an
entitlement the binary does not use is a review question you have to answer.

**Legend:** `NE[...]` = `com.apple.developer.networking.networkextension` with
that value in its array. `FC` = `com.apple.developer.family-controls`.
`AG` = `com.apple.security.application-groups`.

**A. iOS child app — `apple/poc-contentfilter/` (MERGED, signs today)**

| Target | Entitlements | Verified |
|---|---|---|
| `family.ajar.child` | `FC`, `NE[content-filter-provider]`, `AG` | ✅ in repo |
| `…child.FilterDataProvider` | `NE[content-filter-provider]`, `AG` | ✅ in repo |
| `…child.FilterControlProvider` | `NE[content-filter-provider]`, `AG` | ✅ in repo |

**B. `NEURLFilter` category blocklist — `apple/poc-urlfilter/` (PoC D, NOT merged)**

| Target | Entitlements | Note |
|---|---|---|
| host app | `NE[url-filter-provider]` **added to the existing array**, so the child app ends up with *both* values | the entitlement is one key; the array carries both |
| `…child.URLFilterControlProvider` | `NE[url-filter-provider]`, **`AG`** | an **ExtensionKit** extension (`EXExtensionPointIdentifier`), not a classic `.appex` |

> ⚠️ The scaffold's `.entitlements` today declares `NE[url-filter-provider]` and
> **no App Group**. That is fine in isolation but will not survive merging: the
> control provider has to read the prefilter the app builds. Add `AG` when it
> merges. Also note this target does **not** need `FC` — PoC D loads without it.

**C. Parent iOS app — `apple/parent-app/` (README stub, NOT built)**

| Target | Entitlements | Note |
|---|---|---|
| `family.ajar.parent` | `aps-environment` (Push Notifications) | for "new access request" |
| | *Sign in with Apple* — **only** if a third-party login is ever added (4.8) | not planned; auth is self-contained passwords |

No `FC`, no `NE`: the parent device enforces nothing. The App ID **is**
registered up front with Push and Sign in with Apple enabled (§4); only its App
Store Connect record waits for a binary.

**D. macOS child app — `macos/safari-extension/` (loose JS, NO Xcode project)**

A Safari Web Extension cannot ship standalone; it lives in a container app.

| Target | Entitlements | Note |
|---|---|---|
| container app | `com.apple.security.app-sandbox`, `com.apple.security.network.client`, `AG` | the product surface + onboarding |
| Safari Web Extension | `com.apple.security.app-sandbox`, `AG` | `SafariWebExtensionHandler` bridges JS ↔ native |
| native messaging host | `AG` (sandbox if bundled) | delivers signed snapshots (ARCHITECTURE §8) |

**E. macOS native filter layer (ARCHITECTURE §"macOS", NOT built)**

| Target | Entitlements | Note |
|---|---|---|
| container app that installs it | **`com.apple.developer.system-extension.install`** | this key goes on the INSTALLING app, not the extension |
| `NEFilterDataProvider` system extension | `NE[content-filter-provider]`, `AG` | socket/hostname enforcement + `disableEncryptedDNSSettings` |

> **This is the one fork worth deciding early.** A NetworkExtension *system*
> extension distributed outside the App Store needs **Developer ID signing plus
> notarization**, which is a different distribution channel from everything else
> here — not TestFlight. Shipping the macOS filter through the App Store instead
> means the app-extension flavor and different constraints. ARCHITECTURE §"macOS
> tamper model" already assumes a notarized system extension and a standard
> (non-admin) account (ADR-006). Confirm the channel before building the target,
> because it changes the signing pipeline, not just an entitlement.

**F. Conditional — not needed yet**

| Entitlement | When it becomes needed |
|---|---|
| `keychain-access-groups` | if the device keypair moves from the App Group into the Keychain, shared app ↔ extension. `Shared/PolicyStore.swift` flags this as a hardening TODO; the App Group alone covers today's storage. |
| `com.apple.developer.usernotifications.communication` | not applicable — no communication notifications |
| `com.apple.developer.applesignin` | only alongside a third-party login (§4, 4.8) |

**What this means for manual provisioning profiles.** Each profile is generated
from an App ID **after** its capabilities are enabled, and it bakes them in — so
the order is: enable capability → regenerate profile → rebuild. Adding an
entitlement to a `.entitlements` file without regenerating the profile produces a
signing failure that names the entitlement, which is the good case; the bad case
is a profile that silently carries more than the binary uses.

**And the gate that outranks all of it:** an App Store profile cannot carry
`FC` until the **Family Controls distribution entitlement** is granted (§6). Every
row above marked `FC` is blocked on that human review, no matter how correct the
capability checkboxes are.

**App Group (register once, share across app + all extensions):**

- [ ] Register App Group **`group.family.ajar.child`** under Identifiers →
      App Groups, and add it to the child agent app **and every child-side
      extension** above. This group is where the **Ed25519-signed
      `DevicePolicySnapshot`** cache lives (ARCHITECTURE §8, ADR-010).

**Extension `Info.plist` facts to get right (not App-ID settings, but they pair
with the entitlements above):**

- [ ] `FilterDataProvider` / `FilterControlProvider` are classic `.appex` extensions
      (`NSExtensionPointIdentifier = com.apple.networkextension.filter-data` /
      `…filter-control`).
- [ ] (Deferred, PoC D) the URL-filter provider is an **ExtensionKit** extension (lands in
      `MyApp.app/Extensions/`, not `PlugIns/`) with
      **`EXExtensionPointIdentifier = com.apple.networkextension.url-filter-control`**
      (per ADR-013).

**Sign in with Apple note:** SIWA is required **only if** you offer another
third-party login (4.8). Email/passkey-only auth (ARCHITECTURE §7) does **not**
force SIWA. Enable it on a parent App ID only if/when a parent iOS app exists AND a
3rd-party login is added — it is **not** an alpha requirement.

---

## 5. Provisioning profiles

> **Created by hand, like the certificate (§3.1).** Three App Store profiles —
> one per target — supplied to CI as base64 secrets (§8.1). Generate each AFTER
> its App ID's capabilities are enabled (§4.1): a profile bakes in the
> entitlements present at generation time, so enabling a capability later means
> regenerating the profile, not just editing the `.entitlements` file.

- [ ] **Development** profiles — created by Xcode's *Automatically manage
      signing* when you sign a PoC build on a Mac, covering the app and both
      filter-provider extensions (§4).
- [ ] **App Store** profiles — created by CI. The one precondition CI cannot
      satisfy for itself: the **Family Controls distribution entitlement** must
      already be granted ([§6](#6-family-controls-distribution-entitlement-later)),
      because a profile cannot carry an entitlement the account has not been
      approved for. Until then, distribution signing fails no matter how correct
      the workflow is.

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
- [ ] List every bundle id that uses Family Controls / Screen Time APIs. Today
      that is **`family.ajar.child`** only — the entitlement lives on the app
      target, not the two extensions (§4).
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
- [ ] Note which bundle ids will send push: **`family.ajar.child`** (child gets
      "sync now"). There is no parent push topic — the parent console is the web
      app, which uses Web Push, not APNs. Deferred either way: no Apple code
      registers for remote notifications yet (§4).
- Backend consumption: the **`NotificationEndpoint` / `Notifier`** abstraction
  (`backend/src/push/notifier.ts`, ARCHITECTURE §7) is where an APNs `Notifier`
  drops in behind the existing interface; it consumes the `.p8` + Key ID + Team
  ID. UserNotifications / APNs reference:
  **<https://developer.apple.com/documentation/usernotifications>**.

---

## 8. App Store Connect & TestFlight (LATER)

- [ ] Create the App Store Connect app record for the **child app**
      (`family.ajar.child`) at <https://appstoreconnect.apple.com/>. There is no
      parent app record — the parent console is the web app (§4).
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
| `APPLE_DIST_P12` | secret | the distribution `.p12` (§3.1), **base64**: `base64 -i distribution.p12 \| pbcopy` |
| `APPLE_DIST_P12_PASSWORD` | secret | the passphrase set at `openssl pkcs12 -export` |
| `APPLE_PROFILE_APP` | secret | App Store profile for `family.ajar.child`, **base64** |
| `APPLE_PROFILE_DATA` | secret | profile for `…child.FilterDataProvider`, **base64** |
| `APPLE_PROFILE_CONTROL` | secret | profile for `…child.FilterControlProvider`, **base64** |
| `APPLE_TEAM_ID` | **variable** | the 10-char Team ID (§2) |

Signing is **manual** (§3.1): the workflow imports the certificate into a
throwaway keychain and installs the three profiles, rather than letting Xcode
mint them. It matches each profile to its target by **reading the
`application-identifier` inside the profile**, not by name — so a profile named
anything you like still lands on the right target, and one for the wrong bundle
id fails immediately with a readable error instead of signing the wrong binary.
It also prints each profile's entitlement keys, because a profile generated
before Family Controls was granted looks valid right up until it fails to sign.

#### Turning the binary files into pasteable secrets

A `.p12` and a `.mobileprovision` are **binary**; a GitHub secret is text. `cat`
them and you get terminal garbage, so base64 first.

**Linux / WSL** (GNU `base64`; `-w0` gives one unwrapped line):

```sh
base64 -w0 distribution.p12                     # APPLE_DIST_P12
base64 -w0 Ajar_Child_AppStore.mobileprovision  # APPLE_PROFILE_APP
```

**macOS** (BSD `base64` — does not wrap, and `pbcopy` beats selecting 3 KB by hand):

```sh
base64 -i distribution.p12 | pbcopy
```

Then paste into **Settings → Secrets and variables → Actions → New repository
secret**.

> **On WSL, avoid `| clip.exe`.** Use `-w0` and select the terminal output, or
> write to a file under `/mnt/c/` and open it in a Windows editor. Piping base64
> through Windows clipboard tooling can round-trip it as CRLF, and **`base64
> --decode` rejects embedded carriage returns outright** with `invalid input` —
> verified, along with the fact that a single trailing CRLF is harmless. The
> workflow now strips `\r` before decoding so this cannot bite either way, but a
> clean single line is still the thing to paste.
>
> Nothing about the certificate flow needs macOS: `openssl` in WSL generates the
> CSR (§3.1) and builds the `.p12`. Only the *build* needs a Mac, and that is the
> CI runner's job.

Two things that actually go wrong here:

- **Do not `cat` the `.p12`.** Besides being unreadable, it leaves the raw key in
  scrollback and shell history.
- **Check you copied all of it.** A truncated secret fails at `security import`
  with a misleading error about the *password*. Compare
  `base64 -w0 distribution.p12 | wc -c` against the length GitHub reports.

**Step 3 — register the bundle id and create the app record.** §4 registers the
App ID with its entitlements; then create the App Store Connect app record for
that same id (§8 above). The upload has nowhere to land without it.

**Step 4 — run it.** Actions → *iOS — TestFlight (internal)* → Run workflow, type
`testflight` to confirm. The workflow generates the Xcode project from
`project.yml` — which already carries the real bundle ids (§8.4) — then signs,
exports and uploads. Processing in App Store Connect takes
a few minutes before the build appears to internal testers.

### 8.2 What will actually stop you (in the order you will hit it)

1. **The Family Controls distribution entitlement (§6).** This is the real gate,
   and it is a human review with calendar time attached — not something CI can
   route around. Development signing works without it; **App Store / TestFlight
   signing does not.** Request it the day you decide TestFlight is the goal, not
   the day you want to upload. Everything else here is minutes of work.
2. **App Manager role.** A key created with the Developer role archives fine and
   then fails to create a provisioning profile.
3. **Unregistered bundle ids.** The ids in §8.4 must exist in the developer
   account before anything can sign — all three App IDs plus the App Group, with
   Family Controls, Network Extensions and App Groups enabled.
4. **~~Export compliance~~ — fixed in code.** This used to park every upload in
   App Store Connect waiting for someone to answer the encryption questions.
   `ITSAppUsesNonExemptEncryption: false` is now set in `project.yml` (§8.5), so
   uploads no longer stop. Listed here only so the old symptom is recognisable if
   a third-party crypto library is ever linked and the declaration stops holding.
5. **The rest of the app record (§8.5).** Age rating, content rights and — for
   external testing — the privacy label. A build can upload perfectly and still
   reach nobody because a questionnaire is unanswered.

### 8.3 What a green TestFlight run does and does not prove

It proves the app **builds, signs and uploads**. It does **not** prove the filter
works: PoC A's enforcement has never run on hardware (ADR-012), and the two
questions that decide the architecture — whether `.child` actually locks the
filter toggle, and whether `NEFilterFlow.url` really carries full YouTube watch
URLs at runtime — are answered by *installing that build and running the A1–A6
protocol* in `docs/APPLE_CONTENT_FILTER_POC.md`. Getting to TestFlight is how you
start that, not how you finish it.

### 8.4 The bundle identifiers (hardcoded, and why)

These live in `apple/poc-contentfilter/project.yml` and the `.entitlements` files,
not in CI variables:

| Identifier | What |
|---|---|
| `family.ajar.child` | the child app (container) |
| `family.ajar.child.FilterDataProvider` | content-filter data provider extension |
| `family.ajar.child.FilterControlProvider` | content-filter control provider extension |
| `group.family.ajar.child` | App Group shared by all three |

Reverse-DNS of `ajar.family`, the domain we own. Register **all four** (the three
App IDs and the App Group) before the first signed build.

**Why hardcoded rather than a CI variable.** A bundle id is permanent, public, and
identical for every build — it is not configuration that varies by environment.
Injecting it meant CI rewrote generated project files with `sed`, which is fragile
(miss a file type and you get a mismatched id and an opaque signing failure) and
let a local build and a CI build sign as *different apps*. One value in one file
that everyone reads is strictly better.

**Identifiers that do NOT exist yet** (do not register them until there is a
target to sign — an App ID nothing signs is clutter, and an App Store Connect
record is permanent):

| Future identifier | Blocked on | Note |
|---|---|---|
| `family.ajar.parent` | no parent iOS app — `apple/parent-app/` is a README stub and the parent console is `web/parent/` | correct name when it exists |
| macOS container app + `…​.Extension` | `macos/safari-extension/` is loose JS with no Xcode project, container app or `Info.plist` | a Safari Web Extension cannot ship standalone; it needs a container app plus the native messaging host |

**Decide before the first macOS upload:** one bundle id can span iOS **and**
macOS under a *single* App Store Connect record. The macOS child app can
therefore reuse **`family.ajar.child`** rather than minting `family.ajar.mac` —
one record, one TestFlight history, one Family Controls entitlement request,
instead of two apps that drift apart. Cheap to choose now, impossible to merge
later.

The Windows extension is not an Apple identifier at all — it ships through the
Chrome Web Store, Edge Add-ons and AMO (ARCHITECTURE, Windows tiering).

**Changing them is cheap NOW and expensive later.** Once an App Store Connect
record exists for a bundle id, that id is permanent — you cannot rename it, you
can only create a new app and lose the TestFlight history. If `family.ajar.*` is
not what you want, say so before the first upload.

---

### 8.5 The App Store Connect record — fields that gate a build

A green upload is not a delivered build. These live in the app record, not in
code, and each one can hold a build that uploaded perfectly.

- [x] **Export compliance** — *already handled in code.*
      `ITSAppUsesNonExemptEncryption: false` is set in
      `apple/poc-contentfilter/project.yml`, so uploads no longer stop to ask.
      The basis: Apple exempts encryption built into the OS, and this app uses
      only TLS via `URLSession` plus CryptoKit for Ed25519 snapshot verification.
      **Re-confirm if a third-party crypto library is ever linked** — the
      declaration is yours, not the toolchain's.
      <https://developer.apple.com/help/app-store-connect/test-a-beta-version/provide-export-compliance-information-for-beta-builds/>
- [ ] **Age rating** — answer the questionnaire on the app record. Required
      before any build goes to testers.
- [ ] **Content rights** — declare whether the app contains third-party content.
- [ ] **App Privacy ("nutrition label")** — required for App Store review and
      external TestFlight. Declare what the backend actually collects: an account
      email, the child's display name, and blocked-request metadata for approvals.
      ARCHITECTURE §12 is the source of truth for what is collected; do not
      declare more than the code does, and do not declare less.
- [ ] **Internal testers** — add them to the app record. Internal testing
      (up to 100 App Store Connect users on your team) needs **no Beta App
      Review**, which is why it is the target here.
- [ ] **External testing needs Beta App Review** — a real review pass, and the
      point where the Family Controls entitlement and the privacy label are
      actually scrutinised. Internal first.
- [ ] **Category — do NOT use the Kids Category** (repeated from §8 because it is
      easy to pick by reflex for a parental-control app). Per ARCHITECTURE §12
      the parent is the buyer, and the Kids Category's no-third-party-PII rules
      conflict with the server-side family model. Utilities or Productivity.

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
| **Apple Development** signing cert (§3) | ✅ only to sign from a Mac (Xcode makes it) | — |
| Apple **Distribution** cert (§3) | — | ✅ created by hand from a CSR (§3.1) |
| Child app **App ID** `family.ajar.child` (§4) | ✅ required | — |
| The two filter-provider extension App IDs (§4) | ✅ required | — |
| **App Group** `group.family.ajar.child` (§4) | ✅ required | — |
| **APNs `.p8` key** + Key ID + Team ID (§7) | ❌ not yet (no Apple push code) | ✅ when APNs ships |
| **Family Controls _distribution_ entitlement** (§6) | ❌ not needed (dev-signed works) | ✅ required |
| App Store Connect records + TestFlight (§8) | ❌ | ✅ |
| **`NEURLFilter` Identity & Trust** onboarding (§9) | ❌ deferred | ✅ (only if PoC-D layer ships) |

> **Superseded by measurement.** Hardware and a signed dev build are no longer
> the blocker: the app builds, signs and launches on a physical iPhone, and
> `com.apple.developer.family-controls` is granted for **development** without
> Apple review (read off a minted profile). The remaining alpha blocker is the
> **child Apple Account** (§2.1) — without it `.child` authorization fails and
> no on-device enforcement test can run.

---

## 11. Secrets to hand to the backend / CI {#9-secrets-to-hand-to-backendci}

Store in the team secret manager (never in git). These are Apple-side; the
Cloudflare/signing secrets live in `docs/DEPLOYMENT.md`.

| Secret | What | Consumed by |
|---|---|---|
| `APNS_KEY` | the APNs **`.p8`** file contents (§7) | backend APNs `Notifier` |
| `APNS_KEY_ID` | 10-char Key ID (§7) | backend APNs `Notifier` |
| `APPLE_TEAM_ID` | 10-char Team ID (§2) | backend APNs `Notifier` (also = APNs Team ID) |
| `APNS_TOPIC_CHILD` | bundle id `family.ajar.child` (§4) | APNs topic for child "sync now" pushes (unused until APNs is wired) |
| `ASC_KEY_ID` | App Store Connect API **Key ID** (§8.1) | `testflight.yml` — signing + upload |
| `ASC_ISSUER_ID` | App Store Connect API **Issuer UUID** (§8.1) | `testflight.yml` — signing + upload |
| `ASC_KEY_P8` | the App Store Connect **`.p8`** contents (§8.1) | `testflight.yml` — upload |
| `APPLE_DIST_P12` | distribution cert + private key, base64 (§3.1) | `testflight.yml` — signing |
| `APPLE_DIST_P12_PASSWORD` | its export passphrase | `testflight.yml` — signing |
| `APPLE_PROFILE_APP` / `_DATA` / `_CONTROL` | the three App Store profiles, base64 (§5) | `testflight.yml` — signing |

GitHub **variables** (not secrets — both are public values):

| Variable | What | Consumed by |
|---|---|---|
| `APPLE_TEAM_ID` | 10-char Team ID (§2) | `testflight.yml` |

---

## 12. What expires, and what breaks when it does

The failure mode is always the same — CI was green for months, then is not, and
nothing in the repo changed. Worth a calendar entry for each.

| Thing | Lifetime | What breaks | Recovery |
|---|---|---|---|
| **Apple Developer Program membership** | 1 year | *everything* — certificates and profiles stop being valid, apps can be removed from sale | renew; keep the payment method current |
| **Apple Distribution certificate** | 1 year | distribution signing | CI re-mints it via `-allowProvisioningUpdates` (§3) |
| **App Store provisioning profiles** | 1 year | distribution signing | CI re-mints them (§5) |
| **App Store Connect API key** (`ASC_KEY_P8`) | does **not** expire | — | revoke and re-issue only if leaked; rotate the GitHub secrets together |
| **APNs auth key** (`.p8`, §7) | does **not** expire | — | one key serves every bundle id |
| **Family Controls distribution entitlement** | does not expire | — | but it is per-app: a NEW bundle id needs its own request (§6) |

Two consequences worth internalising:

1. **The membership lapsing is the big one.** It invalidates the certificates and
   profiles CI depends on, and CI cannot mint replacements against a lapsed
   account — so the failure looks like a signing bug rather than a billing one.
2. **Certificates and profiles expiring are non-events here**, precisely because
   nothing was created by hand. That is the strongest practical argument for the
   §3.1 API-key path over a hand-made cert and a `.p12` in CI secrets: the
   annual rotation nobody remembers simply does not exist.

---

## 13. Primary sources

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
