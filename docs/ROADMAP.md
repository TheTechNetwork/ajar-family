# Roadmap — candidate features (not yet built)

Captured from product discussion. Each notes the design shape and open questions
so we can pick them up deliberately. Nothing here is implemented yet.

## 1. Apple Family / Sign in with Apple for child onboarding (iOS)

**Idea.** Use Apple Family Sharing + Sign in with Apple to invite/link the
child's Apple account during enrollment on iOS.

**Why it fits.** The iOS enforcement path already *depends* on FamilyControls
`.child` authorization, which requires the child to be a child Apple ID in the
parent's Family Sharing group (see `docs/ARCHITECTURE.md` / `docs/DECISIONS.md`).
Under `.child` the app can't be deleted and iCloud sign-out is blocked — real
anti-tamper we otherwise can't get. So leaning on Apple Family for the iOS child
device is not a detour; it's the grain of the platform.

**Boundary (important).** This does **not** contradict "no IdP" — that was about
*parent* account auth on the backend, which stays our own password system so the
product is cross-platform (iOS/macOS/Windows). Apple Family is an **iOS
enrollment + entitlement path**, layered on top:
- iOS: Sign in with Apple to link the child, request FamilyControls `.child`,
  enroll the device against our backend (device token as today).
- Backend account model unchanged; the Apple linkage is device/enrollment
  metadata, not the identity source.

**Open questions.** Whether to also offer SIWA as an *optional* parent login on
iOS (convenience) without making it required; how Windows/macOS children (no
Apple Family) coexist in the same family graph; App Store review implications.

**Recommendation.** Adopt for iOS child onboarding when we build the iOS child
agent; keep backend identity ours. Medium effort, iOS-specific.

## 2. Self-restriction + accountability partner ("commitment device")

**Idea.** Let an adult restrict *themselves* — categories, YouTube channels,
subreddits, arbitrary sites — either self-managed or with a **visibility /
accountability partner** (spouse, friend) who has visibility and approves
changes. A solo user could later opt into an **AI coach** as the accountability
party — but that's explicitly out of scope for now (build the human-partner and
self paths first; the AI coach is a separate, opt-in future item so people who
don't want a partner still get accountability).

**Why it's a natural extension.** The policy engine already does
"default-deny/allow + per-target exceptions" and the request→approve loop. The
new parts are *who the subject is* and *who approves*:
- **Subject = an adult self-managed account**, not a child. Reuse the same
  per-subject policy (defaults + rules) and the same device enrollment.
- **New role: `ACCOUNTABILITY_PARTNER`** — visibility into the subject's
  requests/decisions and approval rights, but not a parent.
- **Commitment semantics (the crux).** For self-restriction to mean anything,
  the subject must **not** be able to instantly lift their own restriction. Two
  modes: (a) partner must approve un-restriction; (b) solo self-manage with a
  **cooldown/delay** before a removal takes effect (operate before the impulse —
  the same behavioral principle in `docs/UX_PRINCIPLES.md`). Never allow an
  instant self-approve of one's own block.

**New building blocks.**
- Target type + normalizer for **subreddits** (`r/<sub>`), mirroring the
  YouTube normalizer in `shared/`, with extension enforcement.
- A subject/partner relationship + delegated approval + the un-restriction
  cooldown/approval flow.
- Reuse: policy model, signed sync, block screen, request→approve loop.

**Open questions.** Family graph vs. a distinct "circle" for adults; whether a
partner can *add* restrictions or only gate their removal; privacy (partner sees
only requests/decisions, not full browsing — same minimization as today); abuse
cases (coercive partners) — need an exit path.

**Recommendation.** High-value, on-brand differentiator. Build in a phase after
the family MVP is validated, reusing the engine. Start with: subject account +
`ACCOUNTABILITY_PARTNER` role + self-cooldown removal, then partner approval,
then subreddit support. AI coach stays a later, opt-in module.
