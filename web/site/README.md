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

**The Cloudflare Worker serves no static files at all** (`backend/src/worker.ts`),
so on `api.ajar.family` today there is only the API. Putting these pages in
production is a hosting decision that has not been made — see the options at the
bottom.

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

## Before this is a public signup page

- **Email is never verified** (`docs/SECURITY.md`). A typo means no notifications
  and no password reset, and registration stays an account-enumeration oracle.
  The home page says so in plain words rather than pretending otherwise; that is
  a stopgap for a private alpha, not a substitute for the verify flow.
- **Hosting is undecided.** Either add Workers Assets to `wrangler.toml` and serve
  `web/` from the same Worker as the API — which keeps one origin and needs no DNS
  change — or put the site on its own host, which breaks the localStorage handoff
  and needs a real cross-origin session design first. Neither has been done; the
  first is a production change and nobody has approved it.
