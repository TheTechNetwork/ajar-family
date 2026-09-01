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

## 3. Learn mode — a baseline instead of a blank policy

**Idea.** For the first stretch after install (7 days, say), the device does not
close anything on the child. It watches what they actually use, and at the end
Ajar proposes a policy built from that — "here is what this child needs" — rather
than starting a parent from nothing and letting them discover the gaps by being
interrupted.

**Why it is worth building.** Today a parent turns Ajar on and immediately faces
the worst version of the product: either everything is open and it looks like it
does nothing, or `webDefault: BLOCK` closes the school portal, the homework site
and the thing their kid needs in twenty minutes, and the parent is answering asks
all evening for pages they would have allowed without thinking. Default-deny is
the posture the product is *for*, and it is unusable on day one without a
starting set. Learn mode is how a family gets to default-deny without a bad week.

**Two shapes, and they are not the same product.**

- **(a) Observe only.** Nothing is enforced; the device records what was visited.
  Simple, and it tells you nothing about whether enforcement works.
- **(b) Enforce, then auto-open, invisibly.** Every request goes through the real
  evaluator and is closed, then immediately allowed, and the child never sees a
  block page. Strictly more work, and much better: at the end of the week you
  know the enforcement path actually runs on this device — instead of switching
  it on for the first time on day 7 and finding out the hard way that it breaks
  the school portal. It also exercises the SPA path, the playback chain and the
  category filters under real traffic.

(b) is the one worth building. It must auto-open **on the device**, without
filing an AccessRequest — otherwise a week of learn mode floods the parent
console with hundreds of asks, which is the opposite of the point.

**The thing this collides with, and it is the important part.**

The product's central privacy claim is that **there is no browsing history in
it** — stated in `docs/ARCHITECTURE.md`, on the marketing site, and now on
`/legal.html`: *"Not summarised, not sampled, not held briefly."* Learn mode is,
by construction, a record of what a child visited. That is not a reason not to
build it; it is the constraint the design has to be shaped around:

- **The baseline is built and kept ON DEVICE.** The device already evaluates
  locally. It can accumulate the observation set locally and upload only the
  *proposed policy* — a list of hosts to open — never the visit log, never
  timestamps, never counts. That fits the stated goal that the decisions happen
  on device.
- **The raw observations are deleted when the baseline is produced.** They exist
  for the length of the learning window and no longer, on the device only.
- **The child is told.** The terms say Ajar "is not hidden and it is not a
  monitoring tool" and that "the whole design assumes they know". A silent
  seven-day observation period is monitoring, whatever we call it. "Without the
  child ever seeing it was blocked" must mean *no interruption*, not *no
  knowledge* — the device should say it is learning, on the screen where it says
  everything else. This is the one open question that should be settled before
  any code.

**Design notes.**

- **Hosts, not URLs.** A baseline of exact URLs re-closes on every new page of a
  site the child already uses, which is the interrupting behaviour learn mode
  exists to avoid. DOMAIN rules are the right output.
- **YouTube does not baseline.** You cannot turn "the 300 videos they watched"
  into an allowlist, and doing it per-channel quietly widens what a parent
  thought they were approving. YouTube keeps its own default and stays out of the
  proposed set — the per-video flow is the product, not something to pre-approve
  in bulk.
- **The parent reviews before it becomes policy.** Auto-applying is wrong twice:
  anything the child found in week one is in the baseline forever, and a parent
  who never saw the list cannot be said to have set it. The end state is a
  screen — "47 sites, uncheck anything you don't want" — then `webDefault: BLOCK`
  plus the approved set, written through the same `POST /rules` a parent uses by
  hand.
- **Filter the proposal through the category blocklists** before showing it, and
  never propose a safety-floor host (they are already unconditionally open and
  listing them tells a parent something about their child they did not ask for).
- **It has to be finishable early and extendable.** A parent who sees enough
  after two days should be able to end it; one whose kid was on holiday should be
  able to run it longer.

**Shape in the existing model.** Learn mode is a per-child device posture — a
window with an end date — that behaves like `webDefault: ALLOW` at the enforcement
layer while the device records what it *would* have done, and ends by producing a
set of proposed DOMAIN ALLOW rules plus a `webDefault: BLOCK` flip. It needs no
new policy target type and no new evaluator tier.

**Open questions.** Whether the window is time-based (7 days) or
coverage-based ("we have seen enough"); what happens to a device enrolled
mid-window; whether a second child inherits the first one's baseline as a
starting suggestion; and the disclosure question above, which is the blocker.
