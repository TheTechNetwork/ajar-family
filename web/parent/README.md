# web/parent — Parent Console (dev/demo web UI)

A minimal static web UI for the approval workflow, so the whole MVP loop is
clickable in a browser. **The production parent experience is the iOS app**
(`apple/parent-app/`); a web admin was noted as optional in the brief. This exists
to demo and test the backend without curl.

## What it does

Sign in (register/login) → create a family → add a child → **generate a one-time
enrollment code** (enter it in the child's browser extension Options) → watch
**pending requests** stream in (polled) → **approve** with a scope (default
`THIS_VIDEO`) and a duration (15m / 30m / 1h / end-of-day / once / always) or deny.
An approval propagates to the child device in seconds via the backend long-poll.

## Run

It's static files — serve them any way you like, pointing at a running backend:

```sh
# 1) backend (from repo root)
npm ci && npm run build && (cd backend && AUTH_SECRET=dev PORT=8787 node dist/index.js)

# 2) serve this folder (any static server), e.g.:
npx http-server web/parent -p 5500    # then open http://localhost:5500
```

Set the **Backend URL** field to your backend (default `http://localhost:8787`).
The backend enables permissive CORS for the alpha (bearer-token auth, no cookies);
restrict the allowed origin for production.

## End-to-end demo (with the Windows extension)

1. Here: register → create family → add child → **Enroll a device** (copy the code).
2. In Chrome/Edge: load `windows/extension/` unpacked → Options → enter the backend
   URL + code → enroll.
3. Browse a YouTube video → blocked → **Request Access** → it appears here → click
   **Allow 30m** → the child's extension picks up the signed policy within seconds
   and the exact video plays; other videos stay blocked; the grant auto-expires.
