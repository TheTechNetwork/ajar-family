# backend — cloud API (Phase 1 placeholder)

Not implemented yet. Phase 0 defines the contract; this directory is scaffolded
so Phase 1 drops in without restructuring. See `docs/ARCHITECTURE.md §7–§8`.

## Planned stack

- **TypeScript** (Node), **PostgreSQL**, **REST** for CRUD + **WebSocket/SSE** for
  immediate policy-change push. **Redis** only where a concrete need appears
  (rate-limit buckets, WS fan-out). Containerized; **Docker Compose** for local
  dev. Vendor-neutral (AWS/GCP/Azure/Fly/Cloudflare); the Apple **PIR/OHTTP**
  service (for the `NEURLFilter` blocklist layer) is a separate, optional
  component with Apple-specific hosting requirements — see
  `docs/APPLE_URL_FILTER_POC.md` and `apple/poc-urlfilter/pir-server/`.

## Planned modules (Phase 1)

- **auth** — Sign in with Apple / passkeys / email; parent MFA; short-lived
  access tokens + refresh rotation; per-device keypair at enrollment.
- **family** — `Family`, `FamilyMembership` (roles `OWNER | PARENT | LIMITED_GUARDIAN`),
  `Child`, `Device`. Own family graph (no Apple Family Sharing roster API exists).
- **policy** — `Policy`, `PolicyRule`, `TemporaryRule`, `DevicePolicyVersion`;
  targets/actions/scopes and the evaluation order from
  `shared/policy/policy-model.ts` (the reference evaluator is the semantics the
  server and every device adapter must match).
- **requests** — `AccessRequest`, `ApprovalDecision` (server-authoritative,
  records the deciding parent); scope defaults to the narrowest useful permission.
- **sync** — versioned incremental ("changed since vN") + full fallback; issues
  **Ed25519-signed** `DevicePolicySnapshot`s; approval → immediate push.
- **notifications** — APNs abstraction (`NotificationEndpoint`); actionable
  approve/deny notifications.
- **audit** — `AuditEvent` for every decision.

## Data model

See `docs/ARCHITECTURE.md §7`. The shared types in `shared/` are the source of
truth for policy shapes; the DB schema mirrors them.

## Enrollment

Short-lived, single-use enrollment token (QR or 6-digit code) binds a device to a
family + child; the device then generates a persistent keypair. No reusable
family secret on devices.
