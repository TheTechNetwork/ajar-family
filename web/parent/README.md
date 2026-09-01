# web/parent — Parent Console (dev/demo web UI)

A minimal static web UI for the approval workflow, so the whole MVP loop is
clickable in a browser. **Served at `/parent/`** — `/` is the home page and
signup flow (`web/site/`), which hands off to this console through localStorage
keys the two share. It moved off `/` because this page's markup references
`app.js` and `tokens.css` relatively and therefore survives a prefix. **The production parent experience is the iOS app**
(`apple/parent-app/`); a web admin was noted as optional in the brief. This exists
to demo and test the backend without curl.

## What it does

Sign in (log in / create an account) → create a family → add a kid → **generate a
one-time setup code** (typed into the kid's browser extension Setup page) → watch
**pending asks** stream in over a long-poll → **open** it with one tap at the
narrowest-useful scope for what was actually asked for (`defaultScopeFor()`), or
"Not now". Everything wider hides behind **Change…**. An approval propagates to
the child device in seconds via the backend long-poll.

The page is ordered around the one job: **asks are first**, "What you've already
decided" (standing rules, each with **Remove**) is second, and family/device setup
is a collapsed `<details>` at the bottom — opened automatically only when there is
no family yet.

Every decision that writes a standing rule gets a **5-second Undo** in the toast.
A timed "yes" gets no Undo, because the API has no endpoint to delete a temporary
grant — the console does not offer an affordance it cannot honour.

Design tokens for all five surfaces live in **`tokens.css`** in this folder; the
four extension pages inline a copy (they cannot load CSS from outside their
bundle). See that file's header before changing a colour.

## Run

It's static files — serve them any way you like, pointing at a running backend:

```sh
# 1) backend (from repo root)
npm ci && npm run build && (cd backend && AUTH_SECRET=dev PORT=8787 node dist/index.js)

# 2) serve this folder (any static server), e.g.:
npx http-server web/parent -p 5500    # then open http://localhost:5500
```

**There is no Backend URL field.** The console is served by the backend at `/`,
so it uses `location.origin`. That field was pure friction for a parent and, on
the extension side, a straightforward bypass. For local development against a
backend on another origin, opt in explicitly:

```js
localStorage.setItem("cf_dev", "1");   // then load ?api=http://localhost:8787
```

The backend enables permissive CORS for the alpha (bearer-token auth, no cookies);
restrict the allowed origin for production.

## End-to-end demo (with the Windows extension)

1. Here: register → create family → add child → **Enroll a device** (copy the code).
2. In Chrome/Edge: load `windows/extension/` unpacked → its Setup page → enter the
   server address, the 8-character code, **and a parent setup word** (needed later
   to disconnect the browser) → Connect.
3. Browse a YouTube video → blocked → **Ask to unlock** → it appears here → tap
   **Open this video · 30 min** → the child's extension picks up the signed policy
   within seconds. The block screen notices the approval and offers **Open it**;
   it does *not* claim the page reopens by itself, because nothing re-navigates a
   parked tab yet. Other videos stay blocked; the grant auto-expires.
