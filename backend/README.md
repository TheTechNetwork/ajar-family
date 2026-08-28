# backend — cloud API (Phase 1, alpha)

TypeScript backend implementing the platform-agnostic core: family model, roles,
enrollment, policy engine, temporary approvals, access requests, approval
decisions, push abstraction, and **signed, versioned policy sync**. Reuses the
`@ajar/shared` policy model + YouTube canonicalization as the source of
truth. See `docs/ARCHITECTURE.md §7–§8`.

> **Alpha status:** runs on an **in-memory store** by default (zero external
> services) and is fully tested. A **durable SQLite/D1 store** is also implemented
> (`src/store/sql/`): set `DATABASE_FILE` for a file-backed SQLite DB on a Node
> host, or bind a D1 database as `DB` on Workers — same `Repository` interface,
> same SQLite schema, verified by a durability test. No secrets or browsing
> history are stored by default.

## Run locally

```sh
npm ci                 # from the repo root (workspaces)
npm run build          # builds shared → backend to dist/
npm run start --workspace @ajar/backend   # or: cd backend && npm start
# → Ajar backend (alpha) listening on :8787
curl localhost:8787/v1/health
```

## Test

```sh
npm test               # shared + backend (node:test); backend covers the MVP flow
```

The backend test (`src/domain/flow.test.ts`) proves the MVP at the service layer:
a parent approves ONE canonical YouTube video for 30 minutes → it plays → every
other video stays blocked → it auto-expires, with the device-side decision
computed by the **shared** `evaluate()` so backend and device agree, and the
snapshot Ed25519-verified.

## Shape

```
src/
  domain/      model.ts · services.ts (family/enrollment/policy/approvals) · signing.ts (WebCrypto Ed25519)
  store/       repository.ts (interface) · memory.ts (in-memory impl)
  auth/        tokens.ts (WebCrypto HMAC bearer tokens — skeleton)
  push/        notifier.ts (APNs/WebSocket abstraction; in-memory + console impls)
  http/        router.ts (transport-agnostic) · api.ts (routes) · node-server.ts (node:http adapter)
  app.ts       assembles repo + notifier + services
  index.ts     Node entrypoint          worker.ts  Cloudflare Workers fetch entrypoint
```

The HTTP layer is **transport-agnostic**: the same router runs under `node:http`
(local/any Node host) and the Cloudflare Workers fetch handler (`src/worker.ts`).
Signing and tokens use **WebCrypto**, which both runtimes support. Deploy: see
`docs/DEPLOYMENT.md`.

## API (v1, bearer auth)

- `POST /v1/auth/register` · `POST /v1/auth/login` → `{ userId, token }`
- `POST /v1/families` · `GET /v1/families/:id` · `POST /v1/families/:id/parents` · `POST|GET /v1/families/:id/children`
- `PUT /v1/families/:id/children/:childId/defaults` · `POST|GET|DELETE /v1/families/:id/rules[/:ruleId]`
- `POST /v1/families/:id/enroll` → `{ code }`; `POST /v1/enroll/redeem` (device) → `{ device, deviceToken, signingPublicKeyB64 }`
- `POST /v1/requests` (device) · `GET /v1/families/:id/requests` · `POST /v1/families/:id/requests/:reqId/decide`
- `GET /v1/devices/:deviceId/policy[?since=N]` (device) → signed snapshot / `{ upToDate: true }`
- `GET /v1/devices/:deviceId/policy/wait?since=N[&timeout=ms]` (device) → **long-poll**: returns the new signed snapshot the moment an approval bumps the version (woken via the in-process event hub), else `{ upToDate: true }` after the timeout. Gives seconds-level approval delivery on Node **and** Workers with no streaming.
- `GET /v1/signing-key` → `{ publicKeyB64 }` (devices verify snapshots) · `GET /v1/health`
