# Roadmap — candidate features (not yet built)

Captured from product discussion. Each notes the design shape and open questions
so we can pick them up deliberately. Nothing here is implemented yet.

## 1. Apple Family / Sign in with Apple for child onboarding (iOS)

**Idea.** Use Apple Family Sharing + Sign in with Apple to invite/link the
child's Apple account during enrollment on iOS.

**Why it fits.** The iOS enforcement path already *depends* on FamilyControls
`.child` authorization, which requires the child to be a child Apple ID in the
parent's Family Sharing group (see `docs/ARCHITECTURE.md` / `docs/DECISIONS.md`).
Under `.child` the app can't be deleted and iCloud sign-out is blocked — real
anti-tamper we otherwise can't get. So leaning on Apple Family for the iOS child
device is not a detour; it's the grain of the platform.

**Boundary (important).** This does **not** contradict "no IdP" — that was about
*parent* account auth on the backend, which stays our own password system so the
product is cross-platform (iOS/macOS/Windows). Apple Family is an **iOS
enrollment + entitlement path**, layered on top:
- iOS: Sign in with Apple to link the child, request FamilyControls `.child`,
  enroll the device against our backend (device token as today).
- Backend account model unchanged; the Apple linkage is device/enrollment
  metadata, not the identity source.

**Open questions.** Whether to also offer SIWA as an *optional* parent login on
iOS (convenience) without making it required; how Windows/macOS children (no
Apple Family) coexist in the same family graph; App Store review implications.

**Recommendation.** Adopt for iOS child onboarding when we build the iOS child
agent; keep backend identity ours. Medium effort, iOS-specific.

## 2. Self-restriction + accountability partner ("commitment device")

**Idea.** Let an adult restrict *themselves* — categories, YouTube channels,
subreddits, arbitrary sites — either self-managed or with a **visibility /
accountability partner** (spouse, friend) who has visibility and approves
changes. A solo user could later opt into an **AI coach** as the accountability
party — but that's explicitly out of scope for now (build the human-partner and
self paths first; the AI coach is a separate, opt-in future item so people who
don't want a partner still get accountability).

**Why it's a natural extension.** The policy engine already does
"default-deny/allow + per-target exceptions" and the request→approve loop. The
new parts are *who the subject is* and *who approves*:
- **Subject = an adult self-managed account**, not a child. Reuse the same
  per-subject policy (defaults + rules) and the same device enrollment.
- **New role: `ACCOUNTABILITY_PARTNER`** — visibility into the subject's
  requests/decisions and approval rights, but not a parent.
- **Commitment semantics (the crux).** For self-restriction to mean anything,
  the subject must **not** be able to instantly lift their own restriction. Two
  modes: (a) partner must approve un-restriction; (b) solo self-manage with a
  **cooldown/delay** before a removal takes effect (operate before the impulse —
  the same behavioral principle in `docs/UX_PRINCIPLES.md`). Never allow an
  instant self-approve of one's own block.

**New building blocks.**
- Target type + normalizer for **subreddits** (`r/<sub>`), mirroring the
  YouTube normalizer in `shared/`, with extension enforcement.
- A subject/partner relationship + delegated approval + the un-restriction
  cooldown/approval flow.
- Reuse: policy model, signed sync, block screen, request→approve loop.

**Open questions.** Family graph vs. a distinct "circle" for adults; whether a
partner can *add* restrictions or only gate their removal; privacy (partner sees
only requests/decisions, not full browsing — same minimization as today); abuse
cases (coercive partners) — need an exit path.

**Recommendation.** High-value, on-brand differentiator. Build in a phase after
the family MVP is validated, reusing the engine. Start with: subject account +
`ACCOUNTABILITY_PARTNER` role + self-cooldown removal, then partner approval,
then subreddit support. AI coach stays a later, opt-in module.

## 3. Learn mode — a baseline instead of a blank policy

**Idea.** For the first stretch after install (7 days, say), the device does not
close anything on the child. It watches what they actually use, and at the end
Ajar proposes a policy built from that — "here is what this child needs" — rather
than starting a parent from nothing and letting them discover the gaps by being
interrupted.

**Why it is worth building.** Today a parent turns Ajar on and immediately faces
the worst version of the product: either everything is open and it looks like it
does nothing, or `webDefault: BLOCK` closes the school portal, the homework site
and the thing their kid needs in twenty minutes, and the parent is answering asks
all evening for pages they would have allowed without thinking. Default-deny is
the posture the product is *for*, and it is unusable on day one without a
starting set. Learn mode is how a family gets to default-deny without a bad week.

**Two shapes, and they are not the same product.**

- **(a) Observe only.** Nothing is enforced; the device records what was visited.
  Simple, and it tells you nothing about whether enforcement works.
- **(b) Enforce, then auto-open, invisibly.** Every request goes through the real
  evaluator and is closed, then immediately allowed, and the child never sees a
  block page. Strictly more work, and much better: at the end of the week you
  know the enforcement path actually runs on this device — instead of switching
  it on for the first time on day 7 and finding out the hard way that it breaks
  the school portal. It also exercises the SPA path, the playback chain and the
  category filters under real traffic.

(b) is the one worth building. It must auto-open **on the device**, without
filing an AccessRequest — otherwise a week of learn mode floods the parent
console with hundreds of asks, which is the opposite of the point.

**It cannot run unless a parent turns it on, and it turns itself off.**

`docs/ARCHITECTURE.md` §10.1 is the rule: nothing observes a child unless a
parent switches it on for a stated reason, and it ends with that reason. Learn
mode is the first feature that rule governs, and deliberately so — a principle
whose first use case is exempt from it is not a principle.

What that means concretely:

- **Off by default, and off means the observation code does not run** — not
  gathered and discarded. A switch that only stops the display is not a switch,
  and this one should be testable from outside: with learn mode off, nothing
  writes an observation anywhere.
- **The opt-in is scoped to this, and to a window.** "Let Ajar watch what Sam
  uses for seven days so it can suggest a starting point" is a thing a person can
  consent to. A permanent "allow data collection" toggle is not, and would be a
  worse deal for a parent who only ever wanted the one thing.
- **It expires with the window.** The user's framing was that a parent *can*
  turn it off when learning is done; the stronger version, and the one worth
  building, is that it turns ITSELF off and staying on takes a deliberate act. A
  setting a parent has to remember to disable is a setting that stays on for
  years.
- **Ending it early ends the collection immediately**, and produces whatever
  baseline it has — a parent who has seen enough after two days should not have
  to choose between stopping and getting a result.

**The thing this collides with, and it is the important part.**

The product's central privacy claim is that **there is no browsing history in
it** — stated in `docs/ARCHITECTURE.md`, on the marketing site, and now on
`/legal.html`: *"Not summarised, not sampled, not held briefly."* Learn mode is,
by construction, a record of what a child visited. That is not a reason not to
build it; it is the constraint the design has to be shaped around:

- **The baseline is built and kept ON DEVICE.** The device already evaluates
  locally. It can accumulate the observation set locally and upload only the
  *proposed policy* — a list of hosts to open — never the visit log, never
  timestamps, never counts. That fits the stated goal that the decisions happen
  on device.
- **The raw observations are deleted when the baseline is produced.** They exist
  for the length of the learning window and no longer, on the device only.
- **The child is told.** The terms say Ajar "is not hidden and it is not a
  monitoring tool" and that "the whole design assumes they know". A silent
  seven-day observation period is monitoring, whatever we call it. "Without the
  child ever seeing it was blocked" must mean *no interruption*, not *no
  knowledge* — the device should say it is learning, on the screen where it says
  everything else. This is the one open question that should be settled before
  any code.

**Design notes.**

- **Hosts, not URLs.** A baseline of exact URLs re-closes on every new page of a
  site the child already uses, which is the interrupting behaviour learn mode
  exists to avoid. DOMAIN rules are the right output.
- **YouTube baselines by CHANNEL, and only with provenance.** "The 300 videos
  they watched" is not an allowlist, and a bare list of channels quietly widens
  what a parent thought they were approving. But a channel the child reached
  **from a domain that is already in the baseline** — an embed on the school
  site, a link from a homework page — is a different object: it arrives with
  evidence of why it is there. Propose those, each shown with where it came
  from ("Kurzgesagt — first seen from classroom.google.com"), and leave channels
  found by searching YouTube out of it. The per-video flow stays the product for
  everything else.

  This needs the referring domain to be recorded, which is item 4 below, and it
  needs that referrer treated as **evidence for a human, never an input to an
  automatic decision** — see the trust note there. A proposal a parent ticks is
  fine; a promotion that happens because a referrer claimed something is the
  playlist bug again.
- **The parent reviews before it becomes policy.** Auto-applying is wrong twice:
  anything the child found in week one is in the baseline forever, and a parent
  who never saw the list cannot be said to have set it. The end state is a
  screen — "47 sites, uncheck anything you don't want" — then `webDefault: BLOCK`
  plus the approved set, written through the same `POST /rules` a parent uses by
  hand.
- **Filter the proposal through the category blocklists** before showing it, and
  never propose a safety-floor host (they are already unconditionally open and
  listing them tells a parent something about their child they did not ask for).
- **It has to be finishable early and extendable.** A parent who sees enough
  after two days should be able to end it; one whose kid was on holiday should be
  able to run it longer.

**Shape in the existing model.** Learn mode is a per-child device posture — a
window with an end date — that behaves like `webDefault: ALLOW` at the enforcement
layer while the device records what it *would* have done, and ends by producing a
set of proposed DOMAIN ALLOW rules plus a `webDefault: BLOCK` flip. It needs no
new policy target type and no new evaluator tier.

**Open questions.** Whether the window is time-based (7 days) or
coverage-based ("we have seen enough"); what happens to a device enrolled
mid-window; whether a second child inherits the first one's baseline as a
starting suggestion; and the disclosure question above, which is the blocker.


## 4. The referring domain, in the ask

**Idea.** When a child asks to open something, tell the parent where they were
when they hit it.

**Why.** These are not the same decision, and today they look identical in the
console:

> **Kurzgesagt — The Egg** · YouTube video
> from **classroom.google.com**

> **Kurzgesagt — The Egg** · YouTube video
> from **youtube.com** (search results)

A parent deciding in fifteen seconds on their phone is doing it on context, and
the single most useful piece of context is the one thing the product currently
throws away. It is also what makes learn mode able to say anything at all about
YouTube (item 3).

**THE TRUST BOUNDARY, and it is the whole design.** The referrer is supplied by
the child's device, and this codebase has already been bitten three times by
exactly this shape: `resolvedHosts` opened the safety floor, `list=` opened every
video on YouTube, and an unvalidated `targetType` opened the entire web. A
referrer is worse than those in one way — a child does not even need to forge it.
Any approved domain that hosts user content (a forum, a doc, a blog, a subreddit)
is a laundering surface: put the link there, follow it, and the referrer honestly
says "approved domain".

So: **display only.** The referrer is shown to a parent, who can weigh it. It
must never widen a rule, never satisfy a match, never promote anything
automatically, and never appear in `EvalContext`. If a future feature wants to
act on it, that feature is wrong.

**Privacy.** A referrer is another URL the child visited, and the product's claim
is that only the thing they explicitly ask about is ever sent. Send the referring
**host**, not the URL — "from reddit.com", never
"from reddit.com/r/<something they would not want shown>". That keeps the signal
a parent needs and drops nearly all of the exposure.

**Where it can come from.** The Safari and Windows extensions have it
(`webRequest` `initiator` / `documentUrl`, and `document.referrer` in the content
script for an in-page route change). `NEFilterDataProvider` does **not** — a
browser flow carries the URL and no referrer — so on iOS this is a
Safari-extension-only signal and the field has to be optional everywhere, with
the console saying nothing rather than "unknown" when it is absent.

**Open questions.** Whether to show the referring host for a same-host referrer
at all (youtube.com → youtube.com is noise); whether "no referrer" is worth
distinguishing from "typed directly", which is a real signal of intent; and
whether the block page should show the child what it is about to tell their
parent, which the product's no-surprises posture probably requires.


## 5. End-to-end encrypted policy — because the server holds a listing

**The question that forced this.** "Policy stored on our server, which is a
requirement — how is that private if we have a listing of everything?"

It is not, and the current claim is thinner than it sounds. §10.1 of
`ARCHITECTURE.md` draws an honest line around *observation* — the product does
not collect what a child visited. That line is real, and it is not the whole
story, because of what the server holds without observing anything:

- **Every rule.** Every site, channel, video and category the family has an
  opinion about. A blocklist is a statement about a family; a list of what a
  parent decided their child may not see is not less sensitive than a history,
  it is more considered.
- **Every ask.** `AccessRequest` carries the target, the page **title**, the
  **URL**, the child's free-text **reason**, and now the **referring host**.
  Those are things the child chose to surface — to their parent. The server is
  not the parent.
- **The audit log**, whose `detail` embeds `"${targetType}:${targetValue}"`
  verbatim.

"There is no browsing history in this product" is true and answers a question
nobody asked. The listing is the thing.

**Why E2E is actually available here, and not a stretch.** The server never
*evaluates* policy. Every decision is on-device — that is the founding
constraint of this product, and it turns out to be the thing that makes the
privacy answer possible. The backend stores, versions, signs, and relays. Those
four jobs need structure. Only two of them need to read values, and both have a
way out (below).

**Signatures still work.** Sign the ciphertext. `signSnapshot` covers the
canonical JSON of the snapshot; whether a field holds `"youtube.com"` or an
AES-GCM blob does not change what an Ed25519 signature proves — that *this*
server issued *this* version to *this* device, which is what defeats forgery and
rollback. Provenance and confidentiality are orthogonal properties and we get to
keep both. This is the load-bearing observation: nothing about the anti-tamper
model has to be given up.

### 5.1 Encrypt values, not shapes

The instinct is to encrypt the whole record. That is wrong, and it is wrong in
the direction that has already bitten this codebase three times: it moves
server-side safety checks onto the child's device.

`childRequestTargetError` exists because a device that could name its own target
could ask for `CATEGORY:adult` or `DOMAIN:com` and get a parent to tap the green
button on "the entire web, for two hours, above every standing rule". That check
must not become client-side. So:

| Field | Disposition | Why |
|---|---|---|
| `targetType` (enum) | **Plaintext** | Low-cardinality. "This family has 47 rules, 12 about YouTube videos" is not a listing. Keeps the child-request type check, the approval-scope compatibility check, and the ONCE/scope machinery server-side. |
| `scope`, `childId`, `deviceId`, `version`, `expiresAt`, `consumedAt`, `status`, timestamps | **Plaintext** | Routing and lifecycle. The server cannot do its four jobs without them, and none of them says *what*. |
| `targetValue`, `title`, `url`, `reason`, `referrerHost`, audit `detail` | **Ciphertext** | This is the listing. All of it. |

Leaking the shape and keeping the values is the trade that preserves the safety
floor. Say so out loud rather than discovering it later.

**Every ciphertext field carries its own format version**, as a prefix on the
blob rather than a column beside it — `v1:<nonce>:<ct>`, and a reader that does
not recognise the version refuses rather than guesses. This is nearly free now
and impossible to retrofit: the day the AEAD, the KDF, or the AAD composition
has to change, every device in the field is holding blobs in the old shape, and
without a version marker there is no way to tell them apart except by trying to
decrypt and seeing what happens. Note the snapshot's monotonic `version` does
NOT cover this — that counts policy edits, not envelope format, and the two move
independently.

*Prior art worth naming*: RethinkDNS `serverless-dns` encodes an entire blocklist
selection into a versioned URL-safe "blockstamp" (`v:b64` / `v-b32`) carried in
the request path, so the resolver holds no per-user state at all — configuration
travels with the request. Ajar cannot go that far (the approval loop needs
durable state the child's device does not carry), but it is the same instinct
one step further, and it has run in production at scale: the version prefix is
what let that encoding go from v0 to v1 without stranding installed clients.

### 5.2 The two places the server reads a value today

1. **Dedupe** (`createRequest`) compares `(childId, deviceId, targetType,
   targetValue)` against pending asks, so a reloading blocked page does not bury
   the console. Replace `targetValue` with a **blinded index**:
   `HMAC-SHA256(familyKey, canonical(targetType, targetValue))`. The server sees
   an opaque tag, can test two asks for equality, and cannot invert it. Equality
   is the only thing dedupe ever needed.
2. **Category inlining** (`buildSnapshot`) scans rules for `target ===
   "CATEGORY"` to inline only the category maps a device actually needs. With
   `targetType` in plaintext the server still knows a CATEGORY rule exists; it no
   longer knows *which* category. Two ways out, and the second is better: send
   the device the whole signed category asset it already fetches separately
   (`signCanonical` exists for exactly that asset) and let it expand locally.
   Costs bytes, removes a read, and deletes a per-device server computation.

Nothing else on the server ever looks inside a rule.

### 5.3 Keys

**Do not invent anything.** WebCrypto on the parent console, CryptoKit on Apple,
CNG/Go stdlib on Windows — all three have the same primitives:

- **Key derivation: the WebAuthn PRF extension.** The parent already
  authenticates with a passkey (`backend/src/domain/passkeys.ts`); PRF derives a
  stable secret from that same authenticator, so the console can decrypt in a
  browser with no password to remember and no key material on the server. HKDF
  the PRF output into a family key. *Not present today — grep for `prf` returns
  nothing.* PRF is also not universal across authenticators, so the design needs
  a fallback wrap from the start, not bolted on.
- **Content: AES-256-GCM**, per-record nonce, the record's plaintext-side
  identifiers (`familyId`, record id, `targetType`) as AAD so a blob cannot be
  moved between records.
- **Blinded index: HMAC-SHA256** under a separate HKDF-derived subkey. Never the
  same key as content.

**Getting the key to a child device.** Enrollment is already a parent action
with a short-lived single-use token and a device keypair. The parent's console
wraps the family key to the device's enrollment public key; the server relays a
blob it cannot open. No reusable family secret ever exists on the server — which
was already the rule, now with teeth.

**Client-managed vs system-managed.** Client-managed (the family holds the key,
we hold ciphertext) is the default and the honest one. "System-managed when
analytics are enabled" is coherent — you cannot analyze what you cannot read —
but it is precisely the place where a convenience default silently defeats the
whole thing. Rules: per-family, explicitly chosen, never inferred from another
setting, and **forward-only** — turning it off stops future disclosure and does
not un-see what was already seen, and the UI must say that rather than implying
a rollback it cannot perform.

### 5.4 What breaks, stated plainly

E2E is not free and the costs are not small. Anyone proposing this has to own
all four:

- **Recovery becomes data loss.** Lose every passkey and the policy is gone —
  we genuinely cannot help. Mitigation is a wrap per parent device plus a printed
  recovery code (a second wrap under a PBKDF2/scrypt KEK) plus iCloud Keychain
  syncing the passkey itself. **This makes an already-open gap load-bearing:
  there are no passkey recovery codes today.** That gap has to close first or
  this feature ships a footgun.
- **Notifications go quiet.** APNs/Web Push payloads transit our servers, so
  they can say "Sam asked for something" and not what. The full ask renders after
  the console decrypts. That is a genuine UX regression on the product's core
  loop ("say yes in seconds") and it is the cost most likely to be
  underestimated.
- **Support becomes impossible.** No reading a family's rules to explain why
  something was blocked. Every debugging path becomes "reproduce it on the
  device". This is the correct outcome and it is still a real operational cost.
- **Server-side features that need values are permanently off the table** —
  cross-family category suggestions, "families like yours block X", server-side
  policy linting. Ruling those out is a strategy decision, not a technical one,
  and it should be made deliberately rather than discovered when someone asks
  for one.

### 5.5 Key hierarchy — one root, three purposes, per-child separation

A single family key handed to every device would mean a compromised child device
exposes a sibling's asks and their reasons. Derive instead, and derive once:

```
familyKey                       (parent console only; never leaves it unwrapped)
├─ HKDF(familyKey, "policy")    → FAMILY-scoped rule values
├─ HKDF(familyKey, "child:<childId>")
│    ├─ HKDF(·, "content")      → CHILD/DEVICE rules, AccessRequests, audit detail
│    └─ HKDF(·, "index")        → the blinded-index HMAC subkey (§5.2)
└─ (recovery wraps — §5.7)
```

Who gets what:

- **A child's device** receives the `policy` subkey and its own
  `child:<childId>` subkeys. Nothing else. It can decrypt what it must enforce
  and what its own child asked for; a sibling's asks are opaque to it.
- **The parent console** holds `familyKey` and derives everything.
- **The server** holds none of it, ever, in any form it can unwrap.

Scoping the index subkey per child is free and worth taking: the server cannot
correlate "these two children asked for the same thing", which it could if one
family-wide index key produced the same tag for both.

A FAMILY-scoped rule is readable by every child device, deliberately — it is
enforced on all of them, so its existence is not a secret from any of them.

### 5.6 Where the key lives, on each platform, and what protects it from whom

Two rules apply everywhere, and they are what make the per-platform table short:

1. **Decryption happens in the most privileged component on the platform.**
   Never in a browser extension. `windows/extension/background.js` already
   carries the reason in its own comment — `chrome.storage.local` lives in the
   child's profile directory, which the child owns and can read. A key placed
   there is a key given to the child.
2. **The key at rest is protected by the OS mechanism that resists the child,**
   and we state plainly what it does not resist. Nothing here resists a local
   administrator, which is consistent with — not a new exception to — the
   standing rule that the child must be a standard, non-admin account (ADR-006).

| | iOS / iPadOS | macOS | Windows | Parent console |
|---|---|---|---|---|
| **Key at rest** | Keychain, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, access group shared with both NE providers and the Safari extension | Same, app keychain + access group | CNG key in the **Microsoft Platform Crypto Provider** (TPM-backed, non-exportable); floor is DPAPI machine scope inside `%ProgramData%\Ajar` | **Memory only** — never `localStorage`, never IndexedDB |
| **What protects it** | OS sandbox; unreachable by other apps on a non-jailbroken device | Sandbox + standard-account separation | The `%ProgramData%\Ajar` DACL (SYSTEM + Administrators, **no Users**), already applied by `install.ps1`; TPM makes the material non-exportable even with the file | Page lifetime; re-derived per session |
| **What it does *not* protect against** | Jailbreak | Local admin (can dump keychains) | Local admin. **DPAPI machine scope alone protects an offline/stolen disk, not a local process** — the DACL is what stops the child, so it is load-bearing, not defense in depth | A compromised browser |
| **Who decrypts** | `PolicyStore` — already the single read point for every consumer | `PolicyStore` (same shared code) | **The LocalSystem service.** It already verifies the Ed25519 signature before forwarding over native messaging; decryption goes in that same seam and the extension keeps receiving plaintext it was always going to hold | WebCrypto, non-extractable `CryptoKey` |
| **How the key arrives** | Wrapped to the device enrollment keypair at enrollment; relayed by a server that cannot open it | Same | Same, terminating at the service — the extension is never a party to it | Unwrapped from a passkey (§5.7) |

Two consequences worth stating rather than leaving implied:

- **Windows needs no new transport.** The service→extension native-messaging
  channel already carries verified snapshots; it will carry decrypted ones. The
  only new thing on Windows is the CNG/DPAPI key store. This is the sense in
  which Windows "is different": a different key store, not a different design.
- **The extension's backend HTTP mode cannot carry E2E, and that is fine** — it
  is already labelled "dev / browser-testable" in `background.js`. There is no
  privileged component in that mode, so a key would land in the child's profile.
  It must be blocked outright when a family has E2E enabled, not degraded
  silently.
- On Apple this finally forces something `PolicyStore` already flags in its own
  "Known limits": the marker and high-water mark live in the App Group they
  defend, and the fix it names is the Keychain. The key must go there, so the
  marker can go with it.

### 5.7 Recovery: one invariant, several ways to satisfy it

The temptation is a per-platform recovery story. The right shape is a
**platform-neutral invariant with platform-specific ways to meet it**:

> **Two independent unwraps of `familyKey` must exist before E2E can be
> enabled.** The console counts them and refuses to finish setup at one.

"Independent" means they do not fail together. A second passkey on the same
laptop is one unwrap, not two.

| Mechanism | Counts as an unwrap | Notes |
|---|---|---|
| A passkey synced by **iCloud Keychain** | 1 (and survives device loss) | The Apple path; a second Apple device adds redundancy for free |
| A passkey in **Windows Hello** | 1, **device-bound** | Historically does not sync. Microsoft-account passkey backup exists but **the design must not depend on it** — verify before counting it |
| A **cross-device (hybrid) passkey** — a Windows browser authenticating against the parent's phone | 1 | Fully supported and worth naming: a Windows parent with an iPhone gets iCloud Keychain redundancy anyway |
| A **hardware security key** | 1 | The clean answer for a Windows-only family that wants no printed secret |
| A **printed recovery code** (wrap under an Argon2id/PBKDF2 KEK) | 1 | Always available, always offered |
| A second parent's passkey | 1 | Also the answer to "two parents, one policy" |

**The consequence for a Windows-only family is concrete, not vague:** one PC,
one Windows Hello passkey, no phone and no security key = **one** unwrap, and the
console must refuse and say why. A printed recovery code or a second factor is
mandatory there. On Apple the same rule is usually satisfied invisibly, which is
exactly why it must be a counted invariant and not a platform note — otherwise
the Windows family is the only one that ever meets it deliberately, and it will
be the one that gets a "skip" button.

**PRF has a fallback, and the fallback is not E2E.** The WebAuthn PRF extension
needs the authenticator's `hmac-secret`; availability on Windows Hello varies by
build and must be verified, not assumed. Where PRF is unavailable, the only
self-contained fallback is a KEK derived from the parent's account password —
and the server sees that password at login, so it could derive the KEK. That
means two tiers, and they must be named differently everywhere they appear:

| | Protects against a database dump | Protects against us | May be called |
|---|---|---|---|
| **PRF or recovery-code derived** | Yes | Yes | "End-to-end encrypted" |
| **Password derived** | Yes | **No** | "Encrypted at rest" — never "end-to-end" |

Collapsing those two into one reassuring word is the single most likely way this
feature ends up lying, so the distinction belongs in the data model and the UI
copy, not only in this document.

### 5.8 The durable record: define the mechanism, then the automation

Point 4 — a record of what, when, and where that the family keeps — is a
separate thing from key storage, and conflating them is how "iCloud" becomes a
hand-wave.

**The defined mechanism, on every platform, is a parent-initiated export from
the console.** It contains the same ciphertext blobs plus a wrap of `familyKey`
under the recovery-code KEK, so the export is a file that is useless to whoever
finds it and openable by the family forever, including after we stop existing.
That property — outliving the vendor — is worth more than convenience and it is
the same on Windows, macOS and iOS.

**CloudKit is an Apple-only automation of that mechanism**, not a capability
Windows lacks: same records, in the family's own iCloud account, written
continuously instead of on a button press. Where an automation for Windows is
wanted later, the honest options are a scheduled local export to a
parent-chosen folder (which the LocalSystem service can already write) or the
parent's own storage provider — **not** a second Ajar cloud, which would
reintroduce the listing this whole section exists to remove.

So the correct statement is not "Windows can't do the iCloud thing". It is:
every platform has the export; Apple additionally has it automatically.

**Open questions.** Whether `targetType` in plaintext is a line we hold under
pressure (the first feature that wants one more plaintext field is the test);
whether the blinded index needs rotation when a parent is removed from a family,
and what re-encrypting a family's whole policy costs; whether a family that opts
into system-managed keys can go back to client-managed without a full re-key (it
can, but only forward — see 5.3); and how the console re-derives the key each
session without asking a parent to touch their authenticator on every visit,
which is the one UX cost of memory-only key storage (§5.6) and has no obvious
answer that is not "cache the key somewhere", i.e. not an answer.

**Must be verified before any of this is designed further** — each is a fact
about a platform, not a judgement call, and each changes the shape above:

1. **WebAuthn PRF / `hmac-secret` support in Windows Hello**, per build. If it
   is absent on the builds families actually run, the password tier stops being
   a fallback and becomes the common case for Windows-only parents — and that
   tier is not end-to-end (§5.7).
2. **Whether Windows Hello passkeys sync** via Microsoft-account backup, and
   whether that is dependable enough to count as surviving device loss. Until
   verified it counts as one device-bound unwrap.
3. **TPM/CNG non-exportable key availability** on consumer Windows 11 Home,
   including machines with no usable TPM, where the floor is DACL + DPAPI alone.
4. **Keychain access-group behaviour** for a key shared between the containing
   app, two NetworkExtension providers and a Safari extension — the same App
   Group set, but the Keychain is a different sharing mechanism than the App
   Group container `PolicyStore` uses today.
