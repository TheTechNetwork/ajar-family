# The UI/UX plan

Three reviews were run against the shipped code — a child psychologist, a
product designer, and a brand/marketing lens. This is the single plan across
all three. It exists because the instruction that prompted them was *"its not
just error messages its the whole UI/UX"*, and answering that with another
round of string patches would have been the wrong shape of answer.

Findings are ordered by **cost to a real family**, not by how hard they are.
Every one cites the file it lives in, and every one was re-verified against the
working tree before it was written down here — three findings from the reviews
were already fixed by the time they landed and are not listed.

---

## 0. The vocabulary decision

The product had **four words for one action**: "Say yes" (BRAND.md:146),
"Unlock this video" (UX_PRINCIPLES §9, ParentAPI.swift:64-75), "Open this
video" (app.js:810), and "Request Access" (since fixed). The two design docs
contradicted each other: BRAND.md §6 bans lock/unlock language and then
prescribes "Ask to unlock" three rows later.

**Settled: open / closed. "Unlock" is retired.**

- A page is **closed**. A parent **opens** it. A child **asks to open** it.
- The product is named for a door left ajar; "unlock" was a second metaphor
  competing with the first.
- Lock language casts the parent as a jailer, which is the framing the
  psychology review identified as driving circumvention. "Closed" is a state
  rather than a verdict, and it carries its own opposite.
- BRAND.md §6's ban is the decision; the "Ask to unlock" row is the leftover.
- A deliberate split (child "opens", parent "says yes") was rejected: two
  intentional glossaries is how a product ends up with four accidental ones.

This is a doc change plus a string sweep across six surfaces. It is tranche C
because it is wide and shallow; the tranches above it are narrow and deep.

---

## Tranche A — the product drops the user

These are not taste. Each one is a family that cannot complete the loop.

### A1. A parent who enrols a passkey cannot sign in to the Apple app
`api.ts:614-628` returns `{mfaRequired, mfaToken}` with **no** `accessToken`.
`ParentAPI.swift:26-31` decodes that into a `TokenResponse` whose fields are all
non-optional, so it throws; `AjarParentApp.swift:58` catches it as
`error.localizedDescription` and `RootView.swift:56-58` renders Foundation's
*"The data couldn't be read because it is missing."* in 14pt grey.

There is no passkey code anywhere under `apple/` (`ASAuthorization` and
`passkey` both return nothing). And `signup.js:253` makes passkey enrolment
**step 2 of 5** — the flow steers every new parent into the state that locks
them out of the one surface where "approve in seconds from your phone" is
supposed to happen.

This was introduced in the same session that added the second factor. Two
fixes, both needed:
1. Decode `mfaRequired` and show a real screen. This is the safety net and it
   must exist even after (2), because a future auth method will hit the same
   decoder.
2. Implement `ASAuthorizationPlatformPublicKeyCredentialProvider` sign-in in
   the parent app against the existing `/v1/auth/passkeys/login` routes.

### A2. Nobody can recover a forgotten password
`/v1/auth/forgot` (`api.ts:643`) and `/v1/auth/reset` (`:652`) are implemented
and `index.ts:45` wires `PASSWORD_RESET_URL`. **No UI anywhere** references
either. `web/parent/index.html:145-148` offers only "Log in" and "Create an
account".

Worse than absent: `signup.js:230` tells a parent whose confirmation failed
*"You can ask for a new link from the sign-in page"* — naming a control that
does not exist. And because login is password-first even for passkey accounts
(`api.ts:617` authenticates before it checks passkeys), a forgotten password
locks out an account **that has a passkey too**.

One ghost button and one landing page. It is the largest hole in the funnel.

### A3. The parent app spins forever instead of saying what went wrong
`RootView.swift:83-91` falls through to `ProgressView()`. `hasNoFamily` requires
`loadedFamilies`, which `AjarParentApp.swift:86-89` sets **only on success**.
Launch the app on a train, `/v1/me` fails, and the screen is a grey spinner
forever — no message, no retry. `RequestsView` never renders `model.error`.

Same shape twice more: `decide()` (`:164-167`) rolls a failed approval back
onto the list silently while the parent believes they said yes, and the
long-poll catch (`:145-148`) swallows everything, so *"A request lands here the
moment one is made"* (`RootView.swift:176`) keeps being promised while
disconnected. The web console solved this already — `app.js:701-707` renders
"· reconnecting…" as **word plus colour**. Port it.

### A4. On the phone, a one-tap yes to a website is permanent
`RootView.swift:198-200` defaults `.domain` to `.always`, so the primary button
reads **"… · Always"**. The console defaults every ask to 30 minutes
(`app.js:605`) and keeps `ALWAYS`/`WHOLE_FAMILY` behind `Change…` deliberately.

This inverts UX_PRINCIPLES §3 — *whatever we preselect is the policy most of
the time, so it must be the narrowest useful option* — on the surface where
fatigue is highest. It compounds: the app has no Undo (the console's is at
`app.js:888-897`) and no rules list, so a mis-tap writes a permanent standing
rule findable only in a browser.

### A5. The phone card shows a UUID and a machine timestamp
`RootView.swift:207` takes the avatar initial from `request.childId.prefix(1)`
— the first character of a UUID — and `:214` renders `request.createdAt` raw.
The card reads roughly `[7] dQw4w9WgXcQ / 2026-09-01T14:33:10.812Z`. The
child's name never appears, though `model.children` is loaded on every refresh.
The console shows `Jane · 4 min ago` (`app.js:801`). UX_PRINCIPLES §8 names
this exact failure: *a one-tap decision on an opaque id is not a decision*.

### A6. The console re-announces the ask list every 25 seconds, forever
`api.ts:935-937` returns `upToDate: true` when the long poll times out unchanged.
`app.js:719-722` **ignores it** and re-renders regardless, rebuilding
`innerHTML` and firing `announce("2 asks waiting.")`. Every 25 seconds,
indefinitely: a screen-reader user is interrupted with the same count, any open
`<details>` snaps shut, and the `#scope-{id}` select resets **mid-decision**.
The focus-restore code at `:749-787` is good work that only exists to paper
over a re-render that should not happen. `if (out.upToDate) continue;`

### A7. The iOS block page's personalisation is unreachable — STILL OPEN
`FilterControlProvider.swift:97` builds the remediation URL as `?u=…` with no
`ally` parameter, so `api.ts:403-413`'s entire "Ask Mom" personalisation is
dead in production — every iOS child sees the generic copy. `ally=` appears
nowhere outside `blocked-page.test.ts`.

**Not fixed, and here is why it is not one line.** Appending `ally=` before `u`
is trivial; the problem is that nothing on the device knows what to put in it.
The comment on the route says "the device passes the label it already holds in
its signed snapshot" — and `DevicePolicySnapshot` has no such field. There is no
"what the kids call you" anywhere in the product: not on `Family`, not in the
console, not in signup.

So the real work is a family-level label, end to end: a field in the console, a
column on the family, delivery to the device (either in the signed snapshot,
which means touching the canonical serialisation the signature covers, or in the
enrol-redeem response, which does not), and then the parameter on all three block
pages rather than only this one. That is a small feature, not a defect fix, and
doing the one-line half would leave a parameter that is always empty.

Blocked on: deciding whether the label travels signed. Everything else is
mechanical.

### A8. The iOS ask is a dead end when it fails
`ContentView.swift:235-239` offers the `Link` only for `.answered`; `.failed`
gets **"Done" and nothing else**, while drawing an `arrow.clockwise` icon that
promises a retry which does not exist. Both extension pages always offer one.
Also: no note field (the deep link carries only the URL, so every iOS ask
reaches the parent contextless and the card's quote block is dead weight), and
the loop never closes because the device is never told the decision.

### A9. macOS calls every blocked page "This video"
`macos/safari-extension/Extension/blocked.html:413-419` maps `NOUN` for
YouTube types only and falls back to `"This video"` — so a blocked news site
announces itself as *"This video"* in 18px semibold. Windows covers `DOMAIN`
and `URL` too and falls back to the hostname. Same file: `requestBtn` awaits
`sendMessage` with **no timeout** where Windows guards at 12s, so a dead worker
parks the child on "Sending…" forever. And macOS has no `REASON_COPY`, so it
never says *why* — the one line UX_PRINCIPLES §9 singles out for reducing the
threat-to-freedom that drives circumvention.

### A10. The console can only enrol Windows devices
`app.js:579` hardcodes `platform: "WINDOWS"` and `index.html:259-263` gives
extension instructions, while signup offers iPhone/iPad/Mac/Windows and the
marketing table lists all four. A parent who taps "I'll do this later" during
signup can never enrol their child's iPhone, and is handed instructions for the
wrong platform.

### A11. Console boot has no loading state, and offline looks like a sign-out
`app.js:1000-1009`: between page load and `/v1/me` returning, `<main>` is
**empty** — the skeletons live inside a card that is still hidden. If that call
fails offline the sign-in form is un-hidden, so a signed-in parent is shown
*"Welcome back / Log in"* plus "Can't reach Ajar", which reads as *you have
been signed out*. Show the card with its skeletons when a token exists; on a
non-auth failure keep the frame and offer a retry.

---

## Tranche B — accessibility the docs record as done

Each of these is a claim in UX_PRINCIPLES §8 that the code does not honour.
Docs that overstate the state of the code are worse than docs that say nothing,
because they stop anyone looking.

### B1. The coral "yes" has no perceivable edge on four of six surfaces
`tokens.css:208-215` states the rule and the measurement: coral is **2.32:1**
on a white card, so `.btn-yes` must carry `border-color: var(--yes-ink)` or the
most important control in the product fails SC 1.4.11. Four surfaces
re-implement the button and drop the border: the marketing site
(`index.html:26-28`), all five signup steps (`signup.html:31-32`), the iOS
block page (`api.ts:450-452`), and both Swift apps (`Theme.swift`, capsule with
no stroke).

`check-contrast.mjs` passes because its 48 pairs check **token against token**,
never whether a surface drew the border. That is the gap that let this through,
and it is the more important half of the fix: the check has to learn about
compositions, or the next re-implementation reintroduces it.

Same class: `api.ts:453` gives the secondary block-page button a `--line`
border (1.31:1, documented decorative-only), and `SecondaryButton(quiet:)`
strokes with `Ajar.line` — that is the parent's **"Not now"**.

### B2. The iOS block page ships neither claim made about it
UX_PRINCIPLES §8 records 44px targets and `align-items: safe center` as
**Done**. `api.ts:446` sets `summary { min-height: 24px }`; `api.ts:434` sets
plain `center`, so at 200% zoom the heading leaves the flex container and
cannot be scrolled back — the precise failure the doc says was fixed. Both
extension copies get this right, with a comment explaining why. The page also
defines **no `:focus-visible` rule at all**, so its links get the UA default
instead of the two-tone ring the whole palette was built around.

### B3. Both Swift apps: placeholder-as-label, no Dynamic Type, no reduced motion
`RootView.swift:30,37` and `ContentView.swift:69,89` are placeholder-only
inputs (SC 3.3.2), which the console gets right. Every type size in both apps
is a fixed `.font(.system(size:))` across ~40 call sites, so **Dynamic Type
does nothing** — on a parental-control product, whose buyers skew to an age
where system text size is set above default. `.animation(.default, …)` is not
gated on `accessibilityReduceMotion`, where the web has a global
`prefers-reduced-motion` block. And `Theme.swift:24-30`'s `dyn()` falls back to
the light hex under `#else`, so **the macOS parent app has no dark mode** in a
design system whose dark palette is checked in CI.

### B4. Errors are the quietest text on screen
`ContentView.swift:119,123,168` and `RootView.swift:57` render every error in
`Ajar.muted` 14pt centred — quieter than body copy. `--err` exists in the CSS
and in both `Theme.swift` source palettes but is **not declared in the Swift
`Ajar` enums at all**. UX_PRINCIPLES §8 asks errors to say what went wrong and
what to do next; these say it in grey and offer nothing next.

### B5. Signup regressions
`signup.html:89` promises a **code** and `:97-98` says a **link** was sent — on
the screen the parent is staring at while waiting. "Send it again"
(`signup.js:198-209`) only calls `announce()`, so a sighted parent taps it and
nothing visibly happens. `signup.js:116,277` set `disabled` on a button that
may hold focus, which UX_PRINCIPLES §8 requirement 5 forbids and which every
other surface honours. The progress dots are `aria-hidden` with no `sr-only`
equivalent, so a screen-reader user has no sense of position in a five-step
flow.

---

## Tranche C — one product, one voice

Applies the tranche 0 decision. Wide and shallow.

### C1. Three block pages, three scripts
The child sees one of three pages that disagree on the headline ("You can ask
to open this page" vs "This one's closed right now"), the primary button colour
(coral vs teal), the button label, whether a note can be written, whether it
says *why*, and how many states exist (2 vs 5 vs 5). UX_PRINCIPLES §7 is
explicit that variability is what stops the reflex forming.

The irony worth recording: only the **iOS** page uses the agency-first
headline the doc prescribes, and the two pages that grew the four-state machine
kept the verdict-first one. The merge should take the iOS headline and the
extension state machine, not pick a file and copy it.

Also: **"Not now"** means *child, go back* on both extension pages and *parent,
decline* in the console and the app. One string, two opposite actors.

### C2. One set of durations and scopes
Web offers `15 min / 30 min / 1 hour / End of day / Just once / For good`; the
app offers `Once / 30 min / 2h / Today / Always`. Different options **and**
different words for the same options — and "Always" undoes the deliberate
softening of "For good". Scopes diverge too: `app.js:662-670` always offers
`THIS_DEVICE / THIS_CHILD / WHOLE_FAMILY` and `ParentAPI.swift:50-59` never
does, so the `Change…` sheet on the phone cannot express decisions the console
can.

### C3. Four wordmarks
BRAND.md:247-254 settles the interim mark: lowercase **`ajar`** in
`--accent-ink` at `--t-base`/700 — and it names the bug it was fixing, *"the
one branded element on the child's screen rendered as 13px muted grey"*. The
console and both extension pages comply. Marketing and signup use a door SVG
with capitalised "Ajar". The iOS block page (`api.ts:438-439`) and the child
app (`ContentView.swift:37-40`) both render **"Ajar" at 14px in `ink-2`** — the
exact regression BRAND.md documents as fixed — and the child app's SF Symbol
has no `.accessibilityHidden(true)`, so VoiceOver announces *"door left hand
open"*, which is the SC 1.1.1 problem that got the 🚪 removed originally.

Button radius follows the same pattern: 10px, 999px, 12px, and `Capsule()`.

---

## Tranche D — defensible either way

- `confirm()` at `app.js:363,863,948` in a product that already has a designed
  toast + Undo pattern. They cannot be themed and they are the only
  dark-mode-blind element on the page — and at `:863` the modal is the **only**
  place that says the block is reversible.
- Coral spent on eight comparison-table chips above the fold
  (`web/site/index.html:46`), outranking the single coral CTA in the hero, when
  BRAND.md:181 reserves coral for the yes action.
- Three type scales: tokens stop at 28px, marketing goes to 62px, signup to
  34px. Marketing legitimately needs display type — so the sheet should ship a
  documented display ramp instead of each page inventing one and
  re-implementing the focus ring.
- Two front doors to signup: five guided steps, versus the console's in-page
  register mode, which drops the passkey step entirely.
- Three empty-state treatments on one console page, only one written as
  reassurance — and `app.js:764` picks an arbitrary child, so a two-kid family
  reads "When Jane asks…" and Bob does not exist.
- No `.refreshable` on the parent app's list; Refresh is buried in an
  `ellipsis.circle` menu.

---

## Still open, and not caused by any of the above

Carried forward so they are not lost between tranches:

- **The device is never told the decision.** ***Fixed.***
  `GET /v1/devices/{deviceId}/answers` reports what the parent actually decided
  for the device's own child, and all three surfaces prefer it over the old
  inference:

  - The extensions ask their worker, which asks the endpoint. The cached
    snapshot is still consulted first, because it paints an approval with no
    round trip, and it remains the fallback when the network or the native-host
    path cannot answer — so an offline device is never worse off than before.
  - iOS turns a policy-version bump into an actual verdict: `RequestState` has
    `.opened` and `.closed` alongside the old `.answered`, which is now the
    degraded case rather than the ceiling. A refusal gets its own screen, styled
    as an answer and not a fault, with "Ask again" on it.

  What is deliberately NOT delivered: the scope, the duration, and who decided.
  A child needs to know they were answered and which way; a parent who says yes
  to the whole family forever should not have that read off their child's
  screen. The test pins the payload's key list exactly.

  The endpoint grants nothing and no filter consults it. Enforcement is still
  only the signed snapshot — this exists to make a sentence true.
- **Ask TTL vs grant TTL disagree.** *Root cause now fixed — see the next item.
  The time-based honesty below stays as the offline fallback.* A "Not now" writes
  a temporary BLOCK grant that expires after `ONCE_GRANT_TTL_MS` (five minutes),
  and the block pages can only infer "declined" while that rule is LIVE —
  the backend drops expired temporary rules before it signs a snapshot. So a
  refused child saw the answer for five minutes at most and then the page went
  back to "Waiting on a parent" for up to the seven days the ask is remembered.
  On iOS it was worse: the long poll was asked exactly once, so a timeout left
  the child on "waiting" with nothing polling ever again.

  All three surfaces now stop asserting what they cannot know, and offer the one
  check that is authoritative — open the page and let the filter answer. iOS
  also keeps polling instead of asking once. The underlying gap is the next
  item, and it is what a real fix depends on.
- **Overclaims in copy**: *"the child cannot stop"* and *"Keep the rest of
  YouTube closed"*.
- **No LICENSE, privacy policy, or terms** on a product that handles children's
  browsing.
- **No recovery codes for passkeys** — see A1 and A2; the two compound.

---

## What is worth preserving

Recorded because a rewrite is where good work gets thrown out with the bad.

1. **`web/parent/tokens.css`** — every colour carries its measured ratio, the
   comments explain why a token exists, and three CI checks defend it. Two
   caveats, neither fatal to the idea: the header omits the `/blocked` route's
   sixth inline copy, which nothing checks; and the checks verify tokens, not
   compositions, which is how B1 survived.
2. **The four honest states on the extension block pages.** No "Asked ✓" before
   the transport acknowledged, no "this page opens by itself" because nothing
   re-navigates a parked tab, and a decline styled `--muted` with the note *"An
   answer, not a fault"* rather than the error colour. This is the emotional
   core of the product and the best-built screen in the repo.
3. **The console's decision architecture.** One primary button whose scope is
   *derived* from the request; `applicableScopes()` mirroring the server so the
   UI cannot offer an ungrantable option; scopes ordered narrow→broad; Undo
   offered only where the server can honour it. Every one of those is a mistake
   that had to be made once to be designed away. **The app should be ported to
   this, not the other way round.**
