# DEPLOYMENT — backend to Cloudflare Workers via GitHub Actions

> Status: **operational runbook** for the alpha backend. It reflects what is
> actually in the repo today: a transport-agnostic app with a Workers `fetch`
> adapter (`backend/src/worker.ts`) and a Node adapter (`backend/src/index.ts`),
> WebCrypto Ed25519 signing, and a **durable D1-backed store** — `wrangler.toml`
> binds a real `database_id` and `worker.ts` selects `SqlStore` whenever `DB` is
> present, falling back to the in-memory store only when it is not. Cloudflare is
> the deploy *target*, not a dependency: the same app runs on any Node host
> (ARCHITECTURE §7). Load-bearing claims carry official URLs.

---

## 1. Architecture recap (what deploys)

- **Transport-agnostic core.** The router (`backend/src/http/router.ts`) and API
  wiring (`backend/src/http/api.ts`) know nothing about the host. Two adapters
  feed it:
  - **Node** — `backend/src/index.ts` via `backend/src/http/node-server.ts`
    (`npm start`, local dev, and any Node host).
  - **Cloudflare Workers** — `backend/src/worker.ts` exports a default `fetch`
    handler, building the **same** `App` + `Router`.
- **Signing is portable.** `backend/src/domain/signing.ts` uses **WebCrypto
  Ed25519** (`crypto.subtle`), which both Node 22 and Workers implement natively
  (ADR-010). Keys are **base64 of raw SPKI (public) / PKCS8 (private) DER** — see
  [§5](#5-generate-the-ed25519-signing-keypair).
- **Persistence — durable, and already bound.** `SqlStore`
  (`backend/src/store/sql/`) is a `Repository` over SQLite, with a
  **node:sqlite** adapter (Node host, via `DATABASE_FILE`) and a **D1** adapter
  (Workers). Same interface, same schema, covered by a durability test.
  `backend/wrangler.toml` already binds `[[d1_databases]]` with a real
  `database_id`, and `worker.ts` selects D1 whenever `env.DB` is present,
  creating the schema on first use. D1:
  <https://developers.cloudflare.com/d1/>.
  - This section used to say the alpha store is **NOT durable**, and told you to
    "uncomment the `[[d1_databases]]` binding" — which is not commented, and has
    not been since the durable store landed. `RELEASE_CHECKLIST.md` had already
    marked the same item done. A reader following this text either believed the
    deployment loses data on every isolate recycle, or went looking for a comment
    that is not there.
  - `MemoryStore` is still the fallback when no `DB` binding and no
    `DATABASE_FILE` are present, and it is genuinely not durable: it lives for
    the lifetime of one warm isolate, and each isolate is separate. That is the
    dev/smoke-test path, not the deployed one.

---

## 2. Cloudflare prerequisites

- [ ] A **Cloudflare account** and a **Workers subdomain** enabled
      (`*.workers.dev`) — Dashboard → Workers & Pages. Workers overview:
      **Note:** once `wrangler.toml` declares `[[routes]]`, Cloudflare turns the
      `*.workers.dev` hostname OFF — `ajar-backend.<subdomain>.workers.dev` now
      returns 404. The alpha is reached at the two custom domains below.
      <https://developers.cloudflare.com/workers/>.
- [ ] **`wrangler` CLI** installed (`npm i -g wrangler`, or use `npx wrangler`).
      <https://developers.cloudflare.com/workers/wrangler/>.
- [ ] `wrangler login` (interactive) for local deploys; CI uses an **API token**
      instead ([§6](#6-github-actions)).
- [ ] Record the **Account ID** (Dashboard → Workers & Pages → Account details).
- [ ] **`nodejs_compat`** is required and already set in `backend/wrangler.toml`
      (`compatibility_flags = ["nodejs_compat"]`): the Worker uses `node:crypto`
      `randomUUID()` and `Buffer` via the Node compat layer. Node compatibility:
      <https://developers.cloudflare.com/workers/runtime-apis/nodejs/>.
- Current `wrangler.toml` facts: `name = "ajar-backend"`,
  `main = "dist/worker.js"`, `compatibility_date = "2026-08-01"`, observability
  enabled.

---

## 3. Build

From the repo root (npm **workspaces**; root `package.json` builds shared then
backend):

```
npm ci
npm run build     # = build @ajar/shared, then @ajar/backend (tsc → dist/)
```

- `@ajar/shared` builds first (backend imports `@ajar/shared/policy`).
- The backend `tsc` emits `backend/dist/`, including **`dist/worker.js`** (the
  Workers entrypoint) and `dist/index.js` (the Node entrypoint).

Optional sanity check before deploy:

```
npm test          # shared + backend node:test suites (incl. signing.test, flow.test)
```

---

## 4. Deploy

```
cd backend
wrangler deploy   # uses backend/wrangler.toml → main = dist/worker.js, nodejs_compat
```

Post-deploy smoke test (no state required — safe on the in-memory store):

```
curl https://api.ajar.family/v1/health
# → {"status":"ok","version":"0.0.0-alpha"}
curl https://api.ajar.family/v1/signing-key
# → {"publicKeyB64":"...","alg":"Ed25519"}
curl -sI https://ajar.family/ | head -1
# → HTTP/2 200        (the home page — see §4.1)
curl -sI https://ajar.family/parent/ | head -1
# → HTTP/2 200        (the parent console)
curl -sI https://www.ajar.family/ | head -2
# → HTTP/2 301 + location: https://ajar.family/
```

**`ajar.family` is the hostname a parent uses**; `api.ajar.family` is what
enrolled devices talk to. Both are this one Worker, so the pages answer on either
— but every link in the product is relative, so a parent who arrives at the apex
stays there. `www` is a 301 to the apex rather than a fourth working hostname,
because tokens live in localStorage and localStorage is per-origin: two
hostnames that both work is how someone signs up on one and meets a login screen
on the other.

`GET /v1/health` and `GET /v1/signing-key` are defined in
`backend/src/http/api.ts`. `signing-key` returning a **stable** public key
confirms the signing secrets are wired ([§5](#5-generate-the-ed25519-signing-keypair));
if it changes between deploys, the Worker is falling back to an ephemeral key and
`SIGNING_*` secrets are not set.

### 4.1 The Worker also serves the site and the console

`backend/wrangler.toml` has an **`[assets]`** block: `web/` is uploaded with the
Worker and `backend/src/worker.ts` maps the public paths onto it — `/` →
`web/site/index.html`, `/parent/…` → `web/parent/…` — the same mapping the Node
adapter uses. Workers Static Assets:
<https://developers.cloudflare.com/workers/static-assets/>.

**One origin is the requirement, not a convenience.** `web/site/signup.js` writes
the `cf_access` / `cf_refresh` / `cf_family` localStorage keys `web/parent/app.js`
reads, and localStorage is per-origin. Moving the site to its own hostname breaks
that handoff silently: a parent finishes signing up and is shown a login screen.
Serving it from the API's own Worker is what keeps them together, and it adds no
DNS record.

**`run_worker_first = true` is load-bearing.** By default a matching asset is
served *before* Worker code runs, and asset routing ignores the hostname — so
without it `blocked.ajar.family/` would serve the home page, past the
single-purpose guard in `worker.ts` that keeps everything but `/blocked` off the
hostname shipped iOS builds bake in. It is asserted in `backend/src/worker.test.ts`
because it is configuration, and correct code does not substitute for it.

`web/.assetsignore` keeps the READMEs and the `.mjs` dev scripts out: everything
uploaded is public, and `/parent/check-contrast.mjs` answering 200 to the world
is not something anyone would choose on purpose. The six files that are meant to
be served total ~78 KB. `wrangler deploy --dry-run` reports neither the ignore
result nor the asset bytes — its "Read N files" line counts directory entries and
its "Total Upload" is the script bundle — so the exclusion is verified the only
way it can be locally, by requesting those paths under workerd
(`npm run test:workerd`), not by reading the dry-run output.

---

## 5. Secrets

The Worker reads its secrets from `env` (`backend/src/worker.ts` → `Env`); CI
needs two more to authenticate to Cloudflare.

| Secret | Where it lives | Purpose |
|---|---|---|
| `AUTH_SECRET` | `wrangler secret put` | HMAC secret for bearer tokens (`backend/src/auth/tokens.ts`) |
| `SIGNING_PUBLIC_KEY_B64` | `wrangler secret put` | Ed25519 **public** key (SPKI DER, base64) — served at `/v1/signing-key`, shipped to devices |
| `SIGNING_PRIVATE_KEY_B64` | `wrangler secret put` | Ed25519 **private** key (PKCS8 DER, base64) — signs `DevicePolicySnapshot`s (ADR-010) |
| `MAIL_ENDPOINT` + `MAIL_TOKEN` | `wrangler secret put` | Outbound email via a third-party provider. **Only needed if you are NOT using the `EMAIL` binding** (below) — an explicitly set endpoint takes precedence over it. |
| `MAIL_FROM` | `[vars]` in `wrangler.toml` | The From address. Its **domain must be onboarded to Email Service**, or every send fails with `E_SENDER_NOT_VERIFIED`. |

**Email is what gates sign-up.** Creating an account means redeeming a code that
only arrives by email, so with no working sender the Worker runs happily and no
parent can register.

The default path is **Cloudflare Email Sending** — the `[[send_email]]` binding
in `wrangler.toml`, called as `env.EMAIL.send()`. It needs no API token at all,
which is the point: `MAIL_TOKEN` is a long-lived bearer credential held by a
company that can read every subject line, and every subject line here concerns a
specific child. Two things to do once, in the dashboard:

1. **Onboard the sending domain** under Email → Domains, and set `MAIL_FROM` to
   an address on it. For this project that is **`app.ajar.family`** — the apex is
   not onboarded — so `MAIL_FROM = "noreply@app.ajar.family"`. The two have to
   agree and nothing in CI can check that they do: a mismatch fails per-send with
   `E_SENDER_NOT_VERIFIED`, never at startup, so the first symptom is a parent
   waiting for a code that was never sent.
2. **Confirm the account is on the Workers paid plan.** Email Sending has been
   in public beta since 2026-04-16 and is a paid-plan feature.

`wrangler dev` **simulates** this binding: it logs the message and writes the
body to a temp file instead of sending. A green local run proves the call shape
and nothing whatsoever about deliverability. Add `remote = true` to the binding
to send for real from a local run.
| `CLOUDFLARE_API_TOKEN` | GitHub Actions repo secret | CI deploy auth (Workers Scripts:Edit) |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub Actions repo secret | CI deploy target account |

Two plain vars (not secrets) point the emailed links back at the parent console:
`PASSWORD_RESET_URL` (`?token=` is appended) and `VERIFY_EMAIL_URL` (`?verify=`).
Unset, the emails carry the raw code for the parent to paste.

Set the runtime secrets on the Worker:

```
cd backend
wrangler secret put AUTH_SECRET
wrangler secret put SIGNING_PUBLIC_KEY_B64
wrangler secret put SIGNING_PRIVATE_KEY_B64
```

> If `SIGNING_*` are omitted, `App.create` **generates an ephemeral keypair per
> isolate** (`backend/src/app.ts`) — every isolate would then sign with a
> different key and no device could verify. **Provision stable signing secrets
> before any device talks to the backend.**

### 5.1 Generate the Ed25519 signing keypair

Produce the keys in the **exact SPKI/PKCS8 base64 form** the backend imports
(`backend/src/domain/signing.ts` uses `crypto.subtle` `exportKey("spki"|"pkcs8")`
→ base64). A Node 22 one-liner using the same primitives:

```
node --input-type=module -e '
const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign","verify"]);
const spki  = Buffer.from(await crypto.subtle.exportKey("spki",  kp.publicKey )).toString("base64");
const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", kp.privateKey)).toString("base64");
console.log("SIGNING_PUBLIC_KEY_B64=" + spki);
console.log("SIGNING_PRIVATE_KEY_B64=" + pkcs8);
'
```

This is byte-for-byte what `generateSigningKeyPair()` produces, so the output
imports cleanly via `crypto.subtle.importKey("spki"|"pkcs8", …)` in both Node and
Workers.

- [ ] Feed `SIGNING_PUBLIC_KEY_B64` / `SIGNING_PRIVATE_KEY_B64` into
      `wrangler secret put`.
- [ ] The **private key NEVER goes in git** — not in `wrangler.toml`, not in a
      committed `.env`, not in a workflow file. Only the **public** key is
      distributable (it ships to devices for verification).

---

## 6. GitHub Actions

Two workflows under `.github/workflows/` (present in this repo):

- **`ci.yml`** — on **pull_request** and **push**: `npm ci` → `npm run build` →
  `npm test`. This is the gate that **must be green before PR #1 merges**
  (`docs/RELEASE_CHECKLIST.md`). No secrets needed; it never deploys.
- **`deploy.yml`** — on **push to `main`** (and/or a release tag): `npm ci` →
  `npm run build` → deploy via **`cloudflare/wrangler-action`** (or
  `npx wrangler deploy` from `backend/`), **gated on** the repo secrets
  `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`. If those secrets are absent
  the deploy job should be a no-op/skipped, not a failure, so forks and early
  branches don't break.

Sketch of `deploy.yml`'s deploy step (illustrative):

```yaml
      - run: npm ci
      - run: npm run build
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: backend
```

The runtime secrets (`AUTH_SECRET`, `SIGNING_*`) are set **on the Worker** via
`wrangler secret put` (§5), not injected by CI, so they never enter workflow logs.
GitHub Actions: <https://docs.github.com/actions>.

---

## 7. Vendor-neutrality note

Nothing in the app hard-codes Cloudflare **except this deploy target.**

- The domain, HTTP, auth, signing, and store layers are host-agnostic; Cloudflare
  specifics live only in `backend/src/worker.ts` and `backend/wrangler.toml`.
- The **Node server** (`backend/src/index.ts`) runs the identical app on any Node
  host — **Fly, AWS, GCP, Azure**, or a container — per ARCHITECTURE §7 ("No hard
  vendor lock-in; deployable to AWS/GCP/Azure/Fly/Cloudflare"). Signing is
  WebCrypto, so it needs no Cloudflare-specific crypto.
- The durable store has two shipped adapters behind the same `Repository`
  interface: **Cloudflare D1** (Workers) and **node:sqlite** (a Node host / the
  single-binary self-host). Both are SQLite-compatible SQL — there is no
  Postgres. The adapter is selected in `backend/src/store/sql/database.ts`.
- The one genuinely Apple-specific piece (the `NEURLFilter` **PIR/OHTTP** service)
  is a **separate, optional** component, not part of this Worker — see
  `docs/APPLE_ACCOUNT_SETUP.md §9` and `docs/APPLE_URL_FILTER_POC.md`.

---

## 8. Primary sources

- Workers — <https://developers.cloudflare.com/workers/>
- Wrangler — <https://developers.cloudflare.com/workers/wrangler/>
- Workers Node.js compatibility — <https://developers.cloudflare.com/workers/runtime-apis/nodejs/>
- D1 (SQLite) — <https://developers.cloudflare.com/d1/>
- Wrangler secrets — <https://developers.cloudflare.com/workers/configuration/secrets/>
- GitHub Actions — <https://docs.github.com/actions>
- Internal: ARCHITECTURE §7, §8; ADR-010; `backend/README.md`; `backend/wrangler.toml`.
