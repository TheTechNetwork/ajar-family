# Security posture (alpha)

What the backend + clients do today, and what is deliberately deferred. This is a
living document for an alpha, not a completed audit.

## In place

- **Passwords, no external IdP.** PBKDF2-HMAC-SHA256 (210k iterations, per-user
  salt, constant-time verify) — `backend/src/auth/password.ts`. Self-describing
  stored form so iterations can be raised later.
- **Tokens + sessions.** Short-lived access (1h) + refresh (14d) HMAC bearer
  tokens, each bound to a **session** (one per signed-in device) and carrying the
  user's `tokenVersion`. Two revocation levers, both enforced on every request:
  **per-device** (revoke one session — `/v1/auth/logout`, `DELETE /v1/me/sessions/:id`,
  list via `GET /v1/me/sessions`) and **global** (`/v1/auth/logout-all` and
  password change bump `tokenVersion`, killing all tokens). Revocation is
  immediate: access tokens carry the `sid` and `requireUser` checks the session
  is still live.
- **Rate limiting (layered).** A generous **baseline limit on every route**
  (600/min per client) via a router pre-dispatch guard — it applies to authed
  routes and unmatched paths too, so it blunts general abuse and endpoint
  scanning — **plus stricter caps on the sensitive endpoints**
  (`/v1/auth/{login,register,refresh}` 10/min, `/v1/enroll/redeem` 20/min).
  Per client (proxy IP header, else a shared bucket), in-memory / per-instance —
  back it with Redis or a Durable Object for multi-instance scale
  (`backend/src/http/rate-limit.ts`).
- **Enrollment codes.** 8 chars from a 32-symbol unambiguous alphabet via a
  CSPRNG (~40 bits), single-use, 15-minute TTL, redeemed over a rate-limited
  endpoint. (Replaced a 6-digit `Math.random` code.)
- **Fail closed on secrets.** The backend refuses to run with the public default
  `AUTH_SECRET` when a durable store is configured (`DATABASE_FILE`) or on
  Workers (`AUTH_SECRET` is a required `wrangler secret`). Dev in-memory still
  allows the default (with a warning); override with `ALLOW_INSECURE_AUTH=1`.
- **Signed policy.** Device policy snapshots are Ed25519-signed by the backend.
  The **category Bloom-filter asset** (`GET /v1/categories/filters`) is signed the
  same way (canonical JSON, same key). Verification status is **not uniform** —
  see the table below; do not assume it.

  | Path | Verifies before enforcing? |
  |---|---|
  | Windows extension, backend-fetch (`backend-client.js`) | **Yes**, fail-closed |
  | macOS Safari extension, backend-fetch + native message | **Yes**, fail-closed |
  | Windows native-messaging host | **N/A — the host does not exist.** `windows/agent/` only writes registry policy; there is no snapshot/signature code. The extension's native branch is dead in v1 and the shipping path is the dev HTTP mode. |
  | Apple `PolicyStore.swift` | **No — verify-later TODO.** Any process with App-Group access could plant an allow-all snapshot. Must be closed before any device trial. |

  Cached snapshots and cached category filters restored from
  `chrome.storage.local` / `browser.storage.local` **are** re-verified on load,
  against the pinned key, and discarded if they fail — that store is the child's
  own profile directory, so "it was already in the cache" is not evidence of
  where it came from. Windows already did this; macOS adopted whatever was in
  storage until the trust-anchor work below — on that platform, writing one
  storage key was a cheaper bypass than re-pointing the server. The signature is
  now stored alongside the filter set so it can be re-checked at all. Apple's
  `PolicyStore.swift` row above is unchanged.
- **The extensions pin their trust anchor.** Verifying a signature only proves
  "this came from the server I am configured to trust", so it is worth exactly
  as much as control over that config. Both extensions now pin the signing key
  and the address at first enrollment (`shared/trust/trust-anchor.ts`, mirrored
  in `windows/extension/trust-anchor.js` and
  `apple/SafariExtension/Extension/trust-anchor.js`):
  - the pin **survives Disconnect** — disconnecting stops enforcement on that
    browser, it does not hand the next person the right to choose a new signer;
  - re-connecting to the **same address with the same key** needs nothing extra
    (a parent re-linking a wiped device); a **different address or a different
    key** is refused unless the parent setup word checks out (PBKDF2-HMAC-SHA256,
    210k iterations, per-device salt, verified on the device, never sent
    anywhere). A change of *address* is refused **before** the one-time code is
    redeemed, so a refused attempt does not cost a parent their code; a change of
    *key* on the pinned address can only be seen after the server answers, so
    that one does spend the code — the device config is still left untouched;
  - policy verification reads the key **from the pin**, not from the device
    config the options page writes, so rewriting `backendConfig.signingKeyB64`
    alone achieves nothing;
  - the server address is **not typeable in a shipped build**. It comes from the
    bundle; the field appears only when `ajarDevMode` is set in extension
    storage — the same call `web/parent/app.js resolveBackendUrl()` makes for its
    `?api=` override, which is on only when a developer switches it on.

  Held by `shared/trust/trust-vectors.ts`, run against the shared spec, both
  hand-written mirrors, and each extension's real `backend-client.js` and
  background worker by `tools/conformance/run-trust-anchor.mjs` (CI).

  **This raises the cost of the bypass; it is not a boundary.** See the matching
  entry under *Deferred* for what a determined child can still do.
- **Safety floor (non-overridable).** Crisis, abuse and public-health resources
  (`shared/safety/safety-floor.ts`) resolve to ALLOW *above every tier* — above
  device rules, temporary blocks and default-deny. A parent cannot switch it off,
  and reaching one is never reported. Rationale: under default-deny, asking to
  unlock a crisis line means disclosing it to every approver in the family.
- **Host normalization.** A trailing root dot (`reddit.com.`) is stripped before
  matching. Without this, one character defeated every DOMAIN and CATEGORY rule.
- **Category dataset import** (`PUT /v1/categories/dataset`) is GLOBAL data and
  is **disabled unless `CATEGORY_ADMIN_TOKEN` is set**, then requires that token
  in `x-admin-token` (compared in constant time, on SHA-256 digests, so neither
  the secret's length nor a matching prefix is published through response time)
  **on top of** a valid session. Previously any registered user could wipe or
  poison category enforcement for every family on the instance. A deployment
  secret rather than a per-user admin flag on purpose: an admin flag puts a
  switch over global reference data behind one parent's password and inbox, so a
  single account takeover would reach every family. Covered by
  `backend/src/http/categories-admin.test.ts`.
- **Password reset (self-service, no enumeration).** `POST /v1/auth/forgot`
  always answers **202** with an identical body whether or not the address is
  known, so it cannot be used to test which emails have accounts.
  `POST /v1/auth/reset` consumes a **256-bit CSPRNG token**, stored only as
  `base64url(SHA-256(token))` — a dump of `password_reset_tokens` is not a set of
  account takeovers — with a **30-minute TTL**, **single use**, superseded by any
  newer request, and redemption **bumps `tokenVersion` and revokes every
  session**, so a reset prompted by a compromise locks the attacker out at the
  same instant. Both routes sit behind the existing `authLimiter` (10/min per
  client), so the flow cannot be used to flood an inbox. The new password is
  validated *before* the token is burned, so a rejected password does not cost
  the parent their reset link.
- **Email verification, and a sign-up that answers the same either way.**
  `POST /v1/auth/register` now **always** answers **202** with an identical body,
  and **creates nothing**: a free address gets a `pending_registrations` row
  (password already PBKDF2-hashed, token stored only as `base64url(SHA-256)`) and
  a link; an address that already has an account gets an email to its owner
  saying someone tried, with the **same subject** and no code. The account comes
  into being when the link is opened (`POST /v1/auth/verify` → 201 + token pair);
  `POST /v1/auth/verify/request` re-sends for an account that already exists.
  Codes are **single-use**, **60-minute TTL**, and superseded by any newer one.
  Both register branches hash the password, read `users` once and send one
  message, so the coarse timing tell is gone — see the limitation below for what
  that does *not* claim. Consequences: a squatter cannot park on an address they
  do not control (the pending row expires and never blocks the real owner), and a
  typo'd address now fails visibly instead of silently.
- **What an unverified account may do: everything.** `GET /v1/me` reports
  `emailVerified`, and **nothing is gated on it**. Every account that existed
  before this flow is unverified by definition, and gating a parental control on
  a mail round-trip would stop enforcement for families who are already running.
  The flag is there for the console to prompt with, and any parent can confirm at
  any time via `/v1/auth/verify/request`. Re-visit once the alpha's accounts have
  been given the chance to confirm.
- **Request bodies are schema-validated.** Every route that reads a body reads it
  through `backend/src/http/validate.ts` — a ~150-line internal validator, no
  dependency added (the repo has zero runtime dependencies). Malformed JSON is a
  **400 with a message written for a parent**, where it used to throw out of
  `req.json()` and be reported as **500 internal error**; wrong types are refused
  at the edge instead of reaching the domain, where only *some* fields were
  checked. Concretely, before this: `{"decision": 123}` on an approval returned
  200 and wrote a grant that silently became a BLOCK, a rule with
  `target: "NOT_A_TARGET"` was stored and could never match, a notification
  endpoint of kind `CARRIER_PIGEON` was accepted, and a malformed dataset import
  crashed with a 500. Unknown fields are ignored, so a newer client is never
  refused over a field this build does not read.
- **Notifications actually reach a person.** The alpha's only wired Notifier
  wrote to the server's stdout. `EmailNotifier` + a `MailSender` now deliver
  parent notifications and reset codes by POSTing a small JSON envelope to a
  configurable provider endpoint (`MAIL_ENDPOINT` + `MAIL_TOKEN`, bearer auth) —
  no SMTP client, no dependency, works on Node and Workers. Registration
  automatically creates the parent's `EMAIL` notification endpoint, so a family
  is never silently running with zero endpoints. Message bodies are deliberately
  terse (a notification about a blocked page discloses what a child tried to
  reach, and inboxes are often read on shared screens).
- **"Just once" is single use — in the browser extensions.** A `grantKind:
  "ONCE"` approval was an ordinary 5-minute temporary rule with unlimited replays
  inside the window: the narrowest option a parent could pick was materially
  wider than advertised. `POST /v1/devices/{deviceId}/grants/{ruleId}/consume`
  marks it spent, bumps the policy version, and drops it from every later
  snapshot; consumption state never travels to devices, so the signed wire shape
  is unchanged.

  **This entry was written when the endpoint existed and no client called it.**
  That is the defect class this document keeps finding in itself — a documented
  safety that nothing implements — so read the scope carefully:

  - **Windows and macOS Safari: enforced.** The extensions spend the grant on the
    first top-level navigation, keep it spent locally while the new snapshot is
    in flight, and report it. Only a top-level navigation counts: a favicon would
    otherwise burn the grant before the page the parent approved had rendered.
    Sub-resources of that one load still see the grant, which is what lets the
    approved page finish loading.
  - **iOS: NOT enforced. `ONCE` is still the 5-minute window there**, and the two
    reasons are structural rather than unfinished work. `NEFilterFlow` does not
    distinguish a top-level navigation from a sub-resource, so a filter that
    spent the grant on the first flow it saw would spend it on the page's own
    scripts and the approved video would not play. And the data provider
    deliberately holds no device token — it is app-only precisely so the two
    extensions cannot talk to the backend — so it has nothing to report with.
    Solving it needs a way to identify a page load inside the filter; until then
    an iOS "just once" is honestly a "just now".
- **Local-time approvals.** `UNTIL_END_OF_DAY` expired at **UTC** midnight, i.e.
  5pm in California (the child was cut off after school on a grant the parent
  thought lasted until bedtime) and 9am the following morning in UTC+10 (most of
  an extra day). `Child.timezone` (IANA, validated against `Intl` on write,
  default `UTC`) now drives a DST-aware local end-of-day.
- **Device heartbeat + token refresh.** Every policy fetch records `lastSeenAt`
  and the version the device actually pulled;
  `GET /v1/families/{id}/devices` reports both plus a `stale` flag, so a parent
  can see that protection stopped running rather than assume it is fine. Device
  tokens (30 days) are renewed at
  `POST /v1/devices/{deviceId}/token/refresh` — previously they simply expired
  and the device went silent with no recovery short of re-enrollment.

  **The endpoint shipped and nothing called it**, which meant every enrolled
  device was still on the day-31 cliff. All three clients now renew a third of
  the way through the lifetime, from inside the loop they already run. Renewal
  has to be PROACTIVE: `/token/refresh` authenticates with the token it is
  replacing, so a client that waits for its first 401 has already lost. Asking
  at ten days leaves twenty days of failed attempts before anything breaks.

  A device enrolled before the issue date was recorded reads no date and renews
  immediately — one extra request, against the alternative of a device that
  silently stops filtering. **The signing key returned by a renewal is ignored
  on every client**: `enrollSigningKey` is write-once and this is a routine
  unattended call, so honouring it would make "wait for a renewal" a way to swap
  the key that verifies every policy the device enforces.
- **Erasure.** `DELETE` a child or a device cascades their rules, temporary
  grants, access requests, default policy, and any `LIMITED_GUARDIAN`
  assignment naming them. A device token is checked against a live device row on
  every request, so a removed device's long-lived token stops working immediately
  instead of surviving until expiry.

  **`DELETE /v1/me` closes a whole account**, re-authenticating with the current
  password first — this is the most destructive call in the API and a live
  session on a shared computer is not enough for it. What goes with it is a
  decision, not a cascade: a family where somebody ELSE is also an `OWNER`
  survives minus this membership, so a co-parent keeps their children and nothing
  on a child's device changes; a family where this account was the last `OWNER`
  is erased with it — children, devices, rules, grants, requests, decisions,
  enrollment codes, memberships **and the audit log**, which is the record of
  what a named child was told they could not look at and so the last thing that
  should survive an erasure request.

  Two limits, stated rather than implied. The devices of an erased family cannot
  be reached: they stop authenticating (every request checks the device row) and
  keep enforcing the last policy they hold, exactly as they do when the network
  is down. There is no remote wipe, and a filter that failed OPEN on deletion
  would be the worse answer. And erasure is verified against a reopened SQLite
  file (`store/sql/sql-store.test.ts`) rather than only against the in-memory
  store, because a Map that forgets a key and a table with a row still in it look
  identical from the domain's side.
- **Request dedupe.** An identical still-`PENDING` request from the same
  (child, device, target) is returned rather than re-created, so a reloading
  blocked page can no longer mint dozens of rows and dozens of notifications for
  one ask.
- **Co-parent invites are validated.** `POST /v1/families/{id}/parents` took a
  raw `userId` on trust and happily created a membership pointing at nobody —
  which appeared in the family and counted as an approver while belonging to an
  account nobody could sign into. It now accepts `email` (preferred) or `userId`,
  requires a real account, rejects duplicates, validates every
  `assignedChildIds` entry against the family, and refuses assignment lists on
  roles that do not honour them.
- **Authorization.** Every family-scoped mutation checks membership + role
  (`requireRole`/`requireManage`); no IDOR. All SQL is parameterized.
- **CORS.** Permissive `*` by default (bearer tokens, no cookies — safe); set
  `ALLOWED_ORIGIN` (Node) / `env.ALLOWED_ORIGIN` (Workers) to lock it down.

## Deferred / known limitations

- **The second factor is a passkey, and the recovery story is the weak part.**
  Sign-in is two steps: `POST /v1/auth/login` checks the password and, for an
  account with a passkey enrolled, returns a short-lived `mfa` token and **no
  session**; only `POST /v1/auth/passkeys/login` turns that into a token pair.
  The `mfa` kind is its own token kind rather than a user token with a flag, so a
  route that does nothing special refuses it by default — including
  `/v1/me/passkeys/options`, which would otherwise let someone with a password
  enrol their own passkey and then finish the sign-in honestly. Both the
  challenge and the credential are bound to the account, so a genuine assertion
  from an attacker's own enrolled passkey is not a sign-in as somebody else.

  A passkey rather than a code because **the adversary lives in the house**: they
  can watch a password being typed, try the ones a parent reuses, and reach a
  shared computer where a session may still be open. A six-digit code can be read
  out to someone who asks for it; an assertion bound to this origin cannot be, and
  there is nothing for a phishing page on another domain to collect.

  **What is honestly still open:**

  - **Two ways to hold an account with no second factor.** An account created
    before this existed has no passkey, and `POST /v1/auth/login` still returns a
    session for it, flagged `passkeyRequired`. And a browser that cannot do
    WebAuthn at all can skip the enrolment step at sign-up. Both are deliberate —
    refusing would lock people out with no way in to fix it — and both mean "every
    parent has a second factor" is **not** a claim this document makes. The
    console asks; nothing enforces.
  - **Losing every passkey means losing the account.** There is no recovery code,
    and email is deliberately not a way around the passkey: a fallback to "click
    the link we sent you" makes the second factor exactly as strong as the
    parent's inbox, which is to say it stops being one. A password reset changes
    the password and nothing else. Synced passkeys (iCloud Keychain, Google
    Password Manager) survive a lost phone, which is why `backedUp` is shown in
    the console — but a device-bound passkey on a single lost device is an
    account with no way in. **Recovery codes are the intended answer and are not
    built.** Until they are, the mitigation is social: the console shows what is
    enrolled and pushes for a second one.
  - **`PASSKEY_RP_ID` / `PASSKEY_ORIGIN` cannot be changed after parents enrol.**
    A passkey is bound by the browser to the rpId it was created under. Changing
    either invalidates every enrolled passkey at once, with no migration. They are
    committed in `wrangler.toml` rather than left to be set, because getting them
    wrong does not fail at boot — the browser simply refuses every ceremony, which
    reads as "passkeys are broken".
  - **Sign-in is where it stops.** Approving a request, changing a policy and
    removing a device all ride on a session that a passkey opened; none of them
    ask again. A step-up on an already-open session is the obvious next control
    and is not built.

  Verification: `backend/src/domain/passkeys.test.ts` (real captured ceremonies
  from py_webauthn, plus the negatives), `backend/test/passkey-workerd.test.mjs`
  (the same ceremonies inside workerd, which has no `node:crypto`), and
  `backend/src/http/passkey-routes.test.ts` (that the HTTP surface actually
  withholds a session until the second step happens).

- **Enumeration resistance is about STATUS and shape, not wall-clock time.**
  Register's two branches were made to do the same work — one PBKDF2 hash, one
  `users` lookup, one message with one subject — which removes the obvious tell.
  That is as far as the claim goes: **the residual timing difference has not been
  measured**, and a taken address does one string comparison and one mail send
  along a slightly different code path. Treat this as "the coarse oracle is
  closed", not as constant-time. A statistical timing study belongs with the
  pen test.
- **Sign-up now depends on working email.** With `MAIL_ENDPOINT`/`MAIL_TOKEN`
  unset the confirmation code goes nowhere and **no account can be created** —
  the Node server says so on boot. That is the price of not having register
  answer differently for a taken address; a self-host without a mail provider
  needs one before its first parent can sign up.
- **Confirming an address reveals whether the code was valid** (401 vs 200/201),
  exactly as the reset endpoint does. Inherent to a code-in-email flow at this
  token strength (256 bits, 60 minutes, single use).
- **Verification is not enforced anywhere**, by choice (see above). Until it is,
  an address that has never been confirmed can still hold approval rights over a
  child; what verification buys today is that the sign-up path is no longer an
  enumeration oracle and that a typo'd address fails visibly.
- **The validator is structural, not semantic.** It checks types, enums, lengths
  and shapes at the edge. Meaning still belongs to the domain — an IANA time
  zone, a real child id, a password's minimum length — and those checks stay
  where they were.
- **Rate limiter is per-instance.** Fine for a single node/isolate; needs a
  shared store to be effective across a fleet.
- **The extensions' trust anchor is only as strong as extension storage.** The
  pin, the parent-word hash and the dev-mode flag all live in
  `chrome.storage.local` / `browser.storage.local`, which the child can read AND
  write from the devtools console of any extension page. Deleting the pin and the
  word record returns the device to the state of a fresh install, where the next
  enrollment pins whatever it is pointed at. So the bypass is now "open devtools,
  delete two storage keys, then re-enroll against your own server" rather than
  "click Disconnect, type a URL, click Connect". That is a real increase in cost
  and nothing more: a page cannot defend against a debugger attached to itself,
  and the child can in any case disable or remove the extension from the
  browser's own extensions screen.

  Closing it properly is outside the extension: hold the anchor where the browser
  profile cannot rewrite it (the Windows LocalSystem service's registry policy;
  the macOS containing app), ship production builds without the options page (or
  behind a build flag), and have the backend notice and tell a parent when a
  device unenrolls or re-enrolls unexpectedly. Tracked as redteam C2.

  Two smaller consequences, stated plainly: the word hash is readable, so a short
  setup word is open to an offline guessing attack — 210k PBKDF2 iterations makes
  that slow, not impossible; and a parent who forgets the setup word has no
  recovery inside the page — removing and reinstalling the extension clears its
  storage, which is also exactly what the child can do.
- **One approved video no longer opens all of YouTube** (fixed: the playback
  carve-out now requires a sub-resource request type and, on `www.youtube.com`,
  a true player path). Media hosts remain opaque by design — an approved video
  and a blocked one are indistinguishable on `*.googlevideo.com`.
- **MV3 cold start is fail-open.** The request that wakes the service worker is
  decided with no snapshot in memory; only YouTube fails closed.
- **Single-use grants are client-attested.** A device that never reports a
  `ONCE` grant as consumed keeps it until the 5-minute TTL, so "once" is
  best-effort against a cooperating client, not a hostile one. Enforcing it
  against a hostile client would mean holding no usable grant on the device and
  asking per load, which breaks offline enforcement — the product's core
  requirement. The TTL is the real bound; treat `ONCE` as "one short window",
  not as a cryptographic guarantee.
- **Asks are not emailed at all** (ADR-016). A child's access request goes to the
  real-time feed every parent client long-polls, never to an inbox: the promise
  is measured in seconds, one message per ask is how an inbox stops being read,
  and it kept the core loop hostage to a mail provider. Until APNs / Web Push are
  implemented, a parent is reached **while a client is open and not otherwise** —
  a real gap, named rather than papered over.
- **Email delivery is best-effort.** A provider outage is logged and swallowed
  rather than failing the request that triggered it (a child's access request
  must not 500 because the mail provider is down), so a notification can be lost
  silently. There is no delivery receipt, retry queue or bounce handling, and
  On Workers the default path is now Cloudflare Email Sending (`[[send_email]]`,
  `env.EMAIL.send()`), which carries NO credential — it is authorised by being
  bound, so there is nothing to leak and nothing to rotate, and no third party
  sees the subject lines. The paragraph below describes the provider path, still
  supported and still what a self-hosted deployment uses:
  `MAIL_TOKEN` is a long-lived bearer credential for a third party that can see
  the subject lines. Reset codes travel in plain-text email and are therefore
  only as strong as the parent's inbox — hence the 30-minute, single-use bound.
- **Device staleness is a signal, not proof.** `lastSeenAt` tells a parent the
  device is still talking to the backend. It does not prove the OS-level filter
  is installed and enforcing — a tampered client can keep polling while
  enforcing nothing. Client attestation is out of scope for the alpha.
- **Push transports are documented, not implemented.** APNs and Web Push exist
  as specified adapters in `backend/src/push/notifier.ts` (auth, endpoints,
  payloads, error handling) and deliberately throw if wired, rather than
  reporting success while sending nothing. Email is the only real transport
  today, so a time-critical approval depends on how fast a parent reads mail.
- **No outsider invites.** Adding a co-parent requires them to already have an
  account; there is no emailed acceptance token. This is a deliberate trade —
  the alternative was minting password-less shell accounts that hold approval
  rights over a child.
- **Password-reset tokens are not bound to a device or IP**, and the reset
  endpoint reveals validity by status code (401 vs 200). That is inherent to a
  code-in-email flow at this token strength (256 bits, 30 minutes, single use).
- **Before public launch:** a formal third-party penetration test and a secret
  rotation policy.

## Reporting

Report suspected vulnerabilities privately (do not open a public issue).
Contact: `security@ajar.family` (placeholder — set a real inbox before launch).
