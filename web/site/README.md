# web/site — home page + parent signup

Two static pages, no build step, no dependencies:

| Path | File | What it is |
|---|---|---|
| `/` | `index.html` | The home page: what Ajar does, honestly labelled |
| `/signup.html` | `signup.html` + `signup.js` | Account → family → first child → setup code |

The parent console is `web/parent/`, served at **`/parent/`**.

## They must share one origin

`signup.js` writes `cf_access`, `cf_refresh` and `cf_family` — the exact keys
`web/parent/app.js` reads — so "Go to your console" lands signed in. localStorage
is per-origin, so splitting the site and the console across hosts breaks that
handoff: a parent finishes signing up and lands on a login screen.

`backend/src/http/node-server.ts` serves both from one process, which is why the
console moved from `/` to `/parent/` rather than the site moving. The console's
markup references `app.js` and `tokens.css` **relatively**, so it survives being
put under a prefix; a page at `/` cannot.

In production the **same Worker** serves them, through the `[assets]` block in
`backend/wrangler.toml`: `web/` is uploaded whole and `backend/src/worker.ts`
maps the public paths onto it with the same rules the Node adapter uses. So the
site, the signup flow, the console and the API are all on `api.ajar.family` —
one origin, and no DNS record to add.

`run_worker_first = true` is not decoration. Workers Assets serves a matching
file BEFORE Worker code by default, and asset routing does not look at the
hostname — so without it `blocked.ajar.family/` would hand out this home page,
straight past the single-purpose guard in `worker.ts`. Running the Worker first
keeps that guard the only router.

## Tokens are linked, not copied

Both pages `<link>` `../parent/tokens.css`. `..` clamps at the server root, so
that one href works served (`/parent/tokens.css`) and opened as a file
(`web/parent/tokens.css`).

Only the four extension pages have to inline the palette — they cannot load CSS
from outside their bundle. A web page can, so it does. Every extra copy is one
more place a colour can drift, and `sync-tokens.mjs` would have had to grow a
fifth and sixth target for no benefit.

New colour pairings introduced here (`--warn` on `--warn-wash`, `--err` on
`--err-wash`) were added to `check-contrast.mjs` rather than assumed.

## What signup actually does

Four requests, in order, each gated on the previous one succeeding:

1. `POST /v1/auth/register` → `{accessToken, refreshToken}`
2. `POST /v1/families` → the family (caller becomes OWNER)
3. `POST /v1/families/{id}/children` → the first child
4. `POST /v1/families/{id}/enroll` → a single-use setup code + its expiry

Server error strings are shown to the parent as-is. They are written for parents
("password must be at least 8 characters", "unknown IANA time zone: Mars/Olympus"),
and replacing them with something friendlier here would hide what went wrong. A
raw status code never reaches the page; 429 gets its own sentence.

The time zone is pre-filled from `Intl.DateTimeFormat().resolvedOptions()`. A
wrong guess is harmless — the backend rejects an unknown zone with a 400 that
names it.

## Run it

```sh
npm run build
cd backend && AUTH_SECRET=$(head -c 32 /dev/urandom | base64) node dist/index.js
# http://localhost:8787/          home
# http://localhost:8787/signup.html
# http://localhost:8787/parent/   console
```

That is the Node adapter. To exercise the paths the way production serves them —
through Workers Assets, in workerd — run the Worker instead:

```sh
npm run build
cd backend && npx wrangler dev --var AUTH_SECRET:local-dev-secret
```

`npm run test:workerd` asserts all six paths in that runtime, so a broken mapping
fails CI rather than waiting for someone to open a browser.

## Before this is a public signup page

- **Email is never verified** (`docs/SECURITY.md`). A typo means no notifications
  and no password reset, and registration stays an account-enumeration oracle.
  The home page says so in plain words rather than pretending otherwise; that is
  a stopgap for a private alpha, not a substitute for the verify flow.
- **Hosting is done, and it is the one-origin option.** `web/` is served by the
  API's own Worker (above). The alternative — the site on its own host — stays
  rejected rather than merely unbuilt: it breaks the localStorage handoff and
  needs a real cross-origin session design first.
