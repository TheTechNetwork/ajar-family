# Ajar Parent

The app a parent approves from — **iOS, iPadOS and macOS, one product, one
bundle id** (`family.ajar.parent`).

```sh
brew install xcodegen && xcodegen generate
```

## What it is

A client of the backend API at `https://api.ajar.family`, and nothing more. It
**enforces nothing**, which is why its entitlements are almost empty next to the
filter's: no Family Controls, no Network Extension. Policy lives server-side and
reaches devices as an Ed25519-signed snapshot.

The loop it exists for: sign in → watch the pending-request feed (long-polled, so
an approval is felt in seconds rather than on a timer) → approve **one thing**
for a chosen duration.

`ApprovalScope.applicable(to:)` derives the offered scopes from the request's
target type rather than showing a fixed list. That is not cosmetic: offering a
scope the target cannot match mints a rule that silently never applies, and the
parent sees "approved" while the child stays blocked. It mirrors
`applicableScopes` in `backend/src/domain/services.ts` — change them together.

## Status

⚠️ **Written, not yet built.** There is no Xcode in the environment this was
authored in, so it is written against `backend/openapi.json` rather than
compiled. The first `xcodegen generate` and build should be expected to surface
real errors; that is the point of running it, not a regression.

Not yet done: family selection is a typed id rather than a picker, there is no
registration or password-reset flow (both exist in the API and in the web
console), and APNs is not wired — the pending feed is long-polled instead.
