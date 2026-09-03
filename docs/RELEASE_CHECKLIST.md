# RELEASE_CHECKLIST — gate for merging PR #1 ("initial alpha ready")

> Status: **merge gate.** This is the checklist that decides when PR #1 — the
> initial alpha of the backend — is ready to merge. It is deliberately scoped to
> **what the alpha actually claims**: a transport-agnostic backend that builds,
> tests, deploys to a Workers dev environment, and serves a stable signing key.
> It does **not** gate on the hardware-blocked iOS PoCs (ADR-012) unless the team
> decides otherwise ([§b](#b-apple-prep)). Cross-references:
> `docs/DEPLOYMENT.md`, `docs/APPLE_ACCOUNT_SETUP.md`, ARCHITECTURE §7–§8,
> `docs/DECISIONS.md`.

---

## (a) Backend alpha

- [ ] `npm ci && npm run build` is clean from the repo root (shared → backend
      workspaces; ARCHITECTURE §7).
- [ ] `npm test` green in CI — shared + backend `node:test` suites, including
      `backend/src/domain/signing.test.ts` and `backend/src/domain/flow.test.ts`.
- [ ] Deploys to a **Cloudflare Workers dev environment** via
      `wrangler deploy` (per `docs/DEPLOYMENT.md §4`).
- [ ] **Health endpoint reachable:** `GET /v1/health` →
      `{"status":"ok","version":"0.0.0-alpha"}` against the deployed Worker.
- [ ] **Signing keypair provisioned as secrets:** `SIGNING_PUBLIC_KEY_B64` +
      `SIGNING_PRIVATE_KEY_B64` set via `wrangler secret put` (generated per
      `docs/DEPLOYMENT.md §5.1`), and `GET /v1/signing-key` returns a **stable**
      public key across redeploys (not the per-isolate ephemeral fallback).
      `AUTH_SECRET` also set.
- [x] **Durable store — DONE, not a decision to record.** This item described
      the alpha as shipping the in-memory store with D1 as "the follow-up" and a
      "commented `[[d1_databases]]` binding". Both are out of date: `SqlStore`
      over D1 is selected in `backend/src/worker.ts` whenever the `DB` binding is
      present, and the binding in `backend/wrangler.toml` is live rather than
      commented. Confirm before a release that `DB` is actually bound in the
      deploying account — without it the Worker silently falls back to the
      in-memory store, which IS what this item used to describe and is a
      local-dev fallback, never a deployment.

## (b) Apple prep

Per `docs/APPLE_ACCOUNT_SETUP.md` — the **ALPHA column** of its §10 table:

- [ ] **Organization** enrollment done (App Review 5.4/5.5 "approved provider"
      posture; entitlements are org-gated).
- [ ] **Development signing works** — Apple Development cert + Team ID present;
      a dev build can be signed.
- [ ] **App IDs registered** — the FOUR the projects actually build, not the
      `com.<org>.*` placeholders this list used to carry (nothing in the repo has
      ever been named that, so anyone registering them registered the wrong
      things): `family.ajar.parent`, `family.ajar.filter`,
      `family.ajar.filter.DataProvider`, `family.ajar.filter.ControlProvider`,
      and `family.ajar.filter.SafariExtension`. Capabilities per App ID are in
      `docs/APPLE_ACCOUNT_SETUP.md §4`.
- [ ] **App Group** `group.family.ajar.filter` registered and attached to the
      child app, both NetworkExtension providers and the Safari extension.
      `node apple/check-app-group.mjs` fails if any target loses it.
- [ ] **APNs `.p8` key** created; Key ID + Team ID recorded for the backend
      `Notifier`.

> **The PoC-A on-device run is tracked separately by ADR-012 and is NOT a merge
> blocker for the backend alpha** — it is blocked on hardware + a signing
> identity, not on this PR. **Unless the team explicitly decides otherwise**, do
> not hold PR #1 for it. (Distribution signing, the Family Controls *distribution*
> entitlement, App Store Connect/TestFlight, and `NEURLFilter` Identity & Trust
> are all **LATER** per `docs/APPLE_ACCOUNT_SETUP.md §10` and are not alpha gates.)

## (c) CI/CD

Per `docs/DEPLOYMENT.md §6`:

- [ ] **`ci.yml` green** on the PR — `npm ci` → `npm run build` → `npm test`.
      **CI must pass before PR #1 merges.**
- [ ] **`deploy.yml` configured** — deploys to Workers on push to `main` (and/or a
      release tag), gated on repo secrets **`CLOUDFLARE_API_TOKEN`** +
      **`CLOUDFLARE_ACCOUNT_ID`**; skips cleanly when those are absent.
- [ ] Runtime secrets (`AUTH_SECRET`, `SIGNING_*`) are set **on the Worker** (not
      in workflow files/logs).

## (d) Docs current

- [ ] **ARCHITECTURE.md** and **DECISIONS.md** reflect reality — no claim in them
      is contradicted by the merged code (e.g. §7 stack, §8 signed snapshots,
      ADR-010 signing).
- [ ] `backend/README.md` matches what actually shipped (it currently describes
      the module layout the alpha implements).
- [ ] `docs/DEPLOYMENT.md` and `docs/APPLE_ACCOUNT_SETUP.md` (this runbook set) are
      present and their cited commands/URLs match the repo (`wrangler.toml`,
      workspace scripts, endpoint paths).
- [ ] Any ADR whose status changed as a result of this work is updated (status +
      Evidence line), per the ADR convention.

---

## What "alpha ready → merge PR #1" means

**PR #1 is ready to merge when (a), (c), and (d) are fully checked and (b)'s
ALPHA-column account prep is done.** Concretely: the backend **builds and tests
green in CI, deploys to a Workers dev environment, answers `/v1/health`, and signs
snapshots with a stable provisioned Ed25519 key**, with the durable-store decision
recorded and the docs matching the code. The iOS hardware validation (ADR-012) is
**explicitly out of scope** for this merge unless the team says otherwise.

Merging PR #1 lands the **alpha backend**, not the finished product. Per the
README phased roadmap and the repo's branch-per-change git convention, follow-up
work continues on **new branches / new PRs after the merge** — including:

- the **durable `Repository`** implementation (Cloudflare D1 or node:sqlite) — `docs/DEPLOYMENT.md §1`;
- a real **APNs `Notifier`** behind the existing abstraction — `docs/APPLE_ACCOUNT_SETUP.md §7`;
- **macOS** (PoC B) and **Windows** (PoC C) agents;
- **`NEURLFilter` Identity & Trust** onboarding when the PoC-D blocklist layer ships — `docs/APPLE_ACCOUNT_SETUP.md §9`;
- **production hardening** — passkeys and rate limiting have SHIPPED
  (`backend/src/domain/passkeys.ts`, `backend/src/http/rate-limit.ts`); what
  remains here is WS/SSE fan-out and audit retention.

Each is its own branch and PR; PR #1 is not held open for any of them.
