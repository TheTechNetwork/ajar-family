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
- **Signed policy.** Device policy snapshots are Ed25519-signed by the backend;
  every client verifies the signature **fail-closed** before enforcing — on both
  the backend-fetch path and the native-host message path (Windows + macOS).
- **Authorization.** Every family-scoped mutation checks membership + role
  (`requireRole`/`requireManage`); no IDOR. All SQL is parameterized.
- **CORS.** Permissive `*` by default (bearer tokens, no cookies — safe); set
  `ALLOWED_ORIGIN` (Node) / `env.ALLOWED_ORIGIN` (Workers) to lock it down.

## Deferred / known limitations

- **Account-enumeration on register.** Registering an existing email returns a
  generic 409, but the status still differs from success. Full non-enumeration
  needs an email-verification flow — deferred.
- **Input validation.** Request bodies are typed but not schema-validated
  (no Zod-style guards yet); malformed input is not uniformly rejected.
- **Rate limiter is per-instance.** Fine for a single node/isolate; needs a
  shared store to be effective across a fleet.
- **Before public launch:** a formal third-party penetration test, secret
  rotation policy, and the input-validation layer.

## Reporting

Report suspected vulnerabilities privately (do not open a public issue).
Contact: `security@ajar.family` (placeholder — set a real inbox before launch).
