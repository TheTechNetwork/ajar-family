# Security posture (alpha)

What the backend + clients do today, and what is deliberately deferred. This is a
living document for an alpha, not a completed audit.

## In place

- **Passwords, no external IdP.** PBKDF2-HMAC-SHA256 (210k iterations, per-user
  salt, constant-time verify) — `backend/src/auth/password.ts`. Self-describing
  stored form so iterations can be raised later.
- **Tokens.** Short-lived access (1h) + refresh (14d) HMAC bearer tokens, each
  carrying the user's `tokenVersion`. **Logout and password change bump it,
  revoking every outstanding token** (`/v1/auth/logout`, `/v1/auth/password`).
  `requireUser` rejects a token whose version is stale.
- **Rate limiting.** `/v1/auth/{login,register,refresh}` and `/v1/enroll/redeem`
  are rate-limited per client (`backend/src/http/rate-limit.ts`). In-memory /
  per-instance — back it with Redis or a Durable Object for multi-instance scale.
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
- **Per-session refresh revocation.** Revocation today is all-or-nothing per user
  (the `tokenVersion` bump). Revoking one device while keeping others would need
  server-side refresh-token records; deferred to avoid a multi-device UX
  regression. Refresh TTL kept short (14d) in the meantime.
- **Input validation.** Request bodies are typed but not schema-validated
  (no Zod-style guards yet); malformed input is not uniformly rejected.
- **Rate limiter is per-instance.** Fine for a single node/isolate; needs a
  shared store to be effective across a fleet.
- **Before public launch:** a formal third-party penetration test, secret
  rotation policy, and the input-validation layer.

## Reporting

Report suspected vulnerabilities privately (do not open a public issue).
Contact: `security@ajar.family` (placeholder — set a real inbox before launch).
