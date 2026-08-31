# shared — the platform-agnostic source of truth

These TypeScript modules are the **authoritative specification** the backend and
every platform enforcement adapter must reproduce. When a Swift/JS port exists
(iOS `apple/AjarFilter/Shared/`, macOS/Windows extension
`youtube-normalize.js`), the TypeScript here is canonical and the ports must be
kept in lockstep.

- `policy/policy-model.ts` — policy targets, actions, scopes; the
  `DevicePolicySnapshot` shape; and the reference **`evaluate()`** implementing
  the mandated evaluation order (device → child → temporary → exact-URL allow →
  exact-URL block → YouTube video/playlist/channel → domain → category →
  default, with an independent YouTube default). Temporary approvals carry a
  server-signed UTC `expiresAt`; adapters enforce them with a monotonic clock and
  clock-rollback detection.
- `youtube/youtube-normalize.ts` — reduces any YouTube URL form to a canonical
  `YOUTUBE_VIDEO | CHANNEL | PLAYLIST` object keyed by id, plus
  `YOUTUBE_PLAYBACK_SUPPORT_HOSTS` (the resources that must stay reachable for an
  approved video to play — never block these, including `*.googlevideo.com`).

## Conformance

Each adapter has a test obligation: given the same `DevicePolicySnapshot` and
URL, it must produce the same allow/deny decision as `evaluate()` here. Adapters
that cannot evaluate on-path (e.g. `NEURLFilter`'s blocklist dataset) instead
**compile** a documented subset and record the gap in `docs/DECISIONS.md`.

> Phase 0 ships these as a spec + reference implementation. A `package.json`,
> `tsconfig.json`, and unit tests land with the backend in Phase 1.
