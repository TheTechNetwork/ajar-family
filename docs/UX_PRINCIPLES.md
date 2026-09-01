# UX Principles — "The product should operate before the brain does"

> **Disclaimer.** This is **UX research informed by published behavioral science**. It is **not medical, psychiatric, or clinical advice** and does not diagnose, treat, or make claims about any individual user (child or parent). It cites peer‑reviewed and standards sources so the reasoning is checkable, and it draws on ADHD / executive‑function and habit‑formation literature only to design *interfaces that demand less willpower from everyone*. Where a cited effect is contested in the literature, that is noted inline. Nothing here should be read as a statement that any user has a condition.

## The thesis, stated plainly

A family access‑control product succeeds or fails in the **seconds** between a child hitting a wall and a parent clearing it. If the right action (ask → approve → unblock) is **faster and lighter than the impulse to bypass, argue, or give up**, the product wins on autopilot. If it is slower or heavier, willpower and executive function have to make up the difference — and those are exactly the resources our two users (an impulsive, delay‑sensitive child; a busy, decision‑fatigued parent) have least of in the moment.

So the design goal is not "add more controls." It is **remove the gap between intention and outcome** — reduce latency, reduce decisions, reduce memory load, and remove shame — so the loop runs *before the brain has time to route around it*. Every principle below is one lever on that gap, grounded in a source, turned into a product requirement, and mapped to a specific change in **our current parent console** (`web/parent/`) and **our current block screen** (`windows/extension/blocked.html` + `blocked.js`).

Our core loop (from `README.md` / `docs/ARCHITECTURE.md §7`): **child hits blocked content → friendly block screen → one‑tap Request Access (optional reason) → parent gets a push → one‑tap approve with scope + duration → child device updates in seconds.**

---

## 1. Latency is a feature, not a nice‑to‑have

**Principle.** Treat *time‑to‑approve* and *time‑to‑unblock* as first‑class product metrics with hard budgets. Fast enough feels like the system "just works"; slow enough and the child bypasses, the parent forgets, and trust erodes.

**The science.**
- Human response‑time perception has three thresholds: **~0.1 s** feels instantaneous, **~1 s** keeps thought uninterrupted, **~10 s** is the limit of held attention — Nielsen, *Response Time Limits* ([nngroup.com](https://www.nngroup.com/articles/response-times-3-important-limits/)). Past 10 s a person mentally leaves the task.
- The **Doherty Threshold**: productivity and engagement climb sharply when the system answers within **~400 ms**; beyond it users feel they are waiting and disengage (Doherty & Thadani, IBM 1982; summary: [LogRocket](https://blog.logrocket.com/ux-design/designing-instant-feedback-doherty-threshold/)).
- **Why speed changes *behavior*, not just satisfaction:** in intertemporal choice, people systematically over‑value the immediate and discount the delayed — *delay discounting* — and steeper discounting tracks higher impulsivity (Lempert & Phelps review, *Steep Discounting of Future Rewards as an Impulsivity Phenotype*, [PubMed 32236897](https://pubmed.ncbi.nlm.nih.gov/32236897/)). A slow "ask a parent" path is a **delayed** reward competing against the **immediate** reward of a bypass (open another browser, retype the URL, give up and do something else). Cutting the delay makes the sanctioned path the one the impulsive brain reaches for first.

**Product requirement.** Publish and enforce latency budgets end‑to‑end:
| Segment | Budget |
|---|---|
| Block screen renders + Request Access is tappable | ≤ 1 s |
| Request Access tap → visible "sent" confirmation | ≤ 400 ms (optimistic UI) |
| Request appears in parent console / as a push | ≤ 3 s |
| Parent approve action → child device unblocks | ≤ 5 s (p95) |
| Parent decision itself | ≤ 2 taps |

**Change to our UI.**
- **Parent console (`app.js`):** replace the **3‑second poll** (`setInterval(refreshRequests, 3000)`) with the **WebSocket/SSE push** the backend already exposes (`ARCHITECTURE.md §7, §8` — "immediate push on approval"). Polling adds up to 3 s of avoidable latency on *both* legs (request in, approval out). Keep polling only as a reconnect fallback.
- **Block screen (`blocked.js`):** make Request Access **optimistic** — flip to "Sent ✓" the instant it's tapped and reconcile in the background, rather than waiting on the round‑trip before showing "Sending request…". The child should never watch a spinner decide whether asking "worked."
- Instrument both legs and surface the numbers (see §10). If p95 unblock creeps over 5 s, that is a P1 bug, not a tuning task.

---

## 2. Reduce executive‑function load for *both* users (ADHD‑aware, helps everyone)

**Principle.** Design so the right action needs **recognition, not recall**, and **one obvious default, not a configuration exercise**. This is drawn from ADHD/executive‑function research because that population feels the cost first — but working‑memory limits and decision cost are universal, so lowering the floor helps every tired parent and every distractible kid. (Curb‑cut effect.)

**The science.**
- Working memory holds only **~3–5 chunks** at once (Cowan, *The Magical Mystery Four*, [PubMed 20445769](https://pubmed.ncbi.nlm.nih.gov/20445769/)). Any screen that asks the user to juggle more than that leaks intent.
- **Recognition beats recall**: showing labeled, visible options is far cheaper than making users remember or reconstruct them — Nielsen's 6th heuristic and *Memory Recognition and Recall in UIs* ([nngroup.com](https://www.nngroup.com/articles/recognition-and-recall/)). The advantage "magnifies for infrequent users… and users under cognitive stress" — i.e., exactly a parent glancing at a phone mid‑task.
- **ADHD dual‑pathway model** (Sonuga‑Barke): difficulties split into a *"cool"* executive‑control path (working memory, inhibition) **and** a separate *"hot"* motivational **delay‑aversion** path — the pull to escape waiting itself ([PMC3758957](https://pmc.ncbi.nlm.nih.gov/articles/PMC3758957/); dual‑pathway: [ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0149763403001052)). Design must relieve *both*: fewer steps to think through (cool) **and** less waiting to endure (hot, see §1).
- **Progressive disclosure** defers secondary options to a second layer so the primary choice stays small and focused (Nielsen, [nngroup.com](https://www.nngroup.com/articles/progressive-disclosure/)).

**Product requirement.** The default path must be completable **without a single free decision** — smart defaults preselected, narrowest‑useful scope, common durations one tap away, everything else behind a "Change" affordance. No dead‑ends: every screen has an obvious next action, including the failure states.

**Change to our UI.**
- **Parent console (`app.js` `renderRequest`):** today each request renders a **scope `<select>` of 8 options + 6 duration buttons + Deny = up to 15 targets** to parse per request. That exceeds working‑memory capacity and turns a reflex into a project. Collapse to a **single primary button that encodes the narrowest‑useful default** — e.g. **"Allow this video · 30 min"** (scope `THIS_VIDEO`, which the backend already defaults to per `§7`) — plus **Not now** and a quiet **Change…** link that progressively discloses the full scope/duration matrix for the rare case. Two taps become one.
- **Block screen:** keep it to exactly two actions (**Ask a parent** / **Go back**) — it already does; do **not** add scope/duration choices to the child's screen (that's the parent's decision and would add load to the wrong person).
- Kill dead‑ends: the block screen's failure copy ("Couldn't send the request…") should offer a **Try again** button inline, not just describe the failure (see §9).

---

## 3. Decision fatigue is the parent's tax — batch it and default it away

**Principle.** A parent approves the same *kind* of thing dozens of times a week. Each approval spends a little judgment; spent judgment degrades into rushed denials or rubber‑stamps. Minimize the number of *genuine* decisions and let good defaults + memory carry the rest.

**The science.**
- Self‑control and deliberate choosing draw on a **limited, depletable resource**; as it runs down, people fall back to the easy default. The classic illustration is the Israeli‑parole analysis where favorable rulings fell across a session and reset after breaks (Danziger, Levav & Avnaim‑Pesso, PNAS 2011, [doi:10.1073/pnas.1018033108](https://www.pnas.org/doi/10.1073/pnas.1018033108)). **Caveat, stated honestly:** the strong "ego‑depletion"/glucose account has had well‑publicized replication failures and the parole result has alternative explanations (case ordering) — so we lean on the *robust, design‑safe* half of the finding: **more decisions and tired deciders drift toward the low‑effort default**, which for us is a reflexive *deny* or an over‑broad *always‑allow*. The design response (fewer, easier, well‑defaulted decisions) is sound regardless of which mechanism is right.
- **Defaults are decisions users mostly accept.** Johnson & Goldstein, *Do Defaults Save Lives?* (Science 2003) — opt‑out organ‑donation consent runs ~90 %+ vs. single digits/quarters for opt‑in, from the default alone ([besci summary](https://www.besci.org/papers/johnson-goldstein-2003)). Whatever we preselect *is* the policy most of the time, so it must be the **narrowest useful** option, never the broadest.

**Product requirement.** (1) **Sensible, narrow defaults** preselected on every approval. (2) **"Approve + remember"** patterns so recurring asks stop being asks. (3) **Batch** related requests. (4) **Notification‑action approvals** so the common case never requires opening the app.

**Change to our UI.**
- **Default (`app.js`):** the primary button carries the narrowest‑useful scope (`THIS_VIDEO`) and a sane duration (`30m` or `Once`), matching the backend's "never auto‑broaden" rule (`§7`). The broad options (`WHOLE_FAMILY`, `Always`) must live *only* behind Change… and be visually de‑emphasized — never the fast path.
- **Approve + remember:** add **"Always allow this channel"** as an explicit, labeled escalation inside Change… so a parent who keeps approving the same creator can convert repeated decisions into one standing rule (a `TemporaryRule`/policy rule per the model) — turning N future decisions into zero. This is the humane version of the default: the parent, not fatigue, chooses to broaden.
- **Batch:** when several PENDING requests share a child or a channel, group them under one header with an **"Allow all 3 · 30 min"** action, so the parent spends one decision instead of three. Today `refreshRequests` renders a flat list.
- **Notification‑action approvals:** wire the APNs actionable‑notification path (`ARCHITECTURE.md §7` "APNs abstraction") so the notification itself carries **Allow 30 min / Not now** buttons and writes the `ApprovalDecision` without opening the app. For the web console, use the Notifications API with action buttons where the browser supports it. The 2‑tap budget (§1) should usually be **zero app‑opens**.

---

## 4. The block screen is a moment of agency, not punishment

**Principle.** The instant of being blocked is emotionally loaded. Framed as punishment/shame, it drives withdrawal, resentment, and bypass. Framed as *"here's the one thing you can do next,"* it preserves the child's sense of autonomy and competence and channels the impulse straight into the sanctioned path.

**The science.**
- **Self‑Determination Theory** (Ryan & Deci): intrinsic motivation and healthy self‑regulation depend on three needs — **autonomy** (volition), **competence** (effective action), **relatedness** (connection) (Ryan & Deci 2000, [selfdeterminationtheory.org PDF](https://selfdeterminationtheory.org/SDT/documents/2000_RyanDeci_SDT.pdf); overview [APA](https://www.apa.org/members/content/intrinsic-motivation)). A block screen can support all three: a clear next action (competence), a real voice in the outcome (autonomy — including the choice to *follow* the rule), and framing the parent as an ally who responds (relatedness).
- **Shame vs. guilt** (Tangney): shame ("I am bad") is global and drives **avoidance, withdrawal, and hostility**; guilt about a specific behavior drives **repair and approach** ([Tangney, *Moral Emotions and Moral Behavior*, Caltech PDF](https://www.its.caltech.edu/~squartz/Tangney.pdf); *Shame Withdraws, Guilt Corrects*, [PMC12189037](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12189037/)). A screen that reads as a verdict on the *child* invites the maladaptive route; one that neutrally describes the *situation* and offers repair keeps them engaged.

**Product requirement.** Non‑accusatory, situation‑focused copy; a prominent, obvious next action; language that positions the parent as a fast ally, not a warden; never a raw "DENIED"/tech‑error aesthetic.

**Change to our UI.**
- Our current block screen is already fairly humane ("This page isn't available right now… You can ask a parent to allow this") — **protect that** and push further:
  - **Lead with agency:** make **Ask a parent** unmistakably the primary action and reframe the subhead around what the child *can do* and how fast it resolves (see the copy table in §9).
  - **Demote the scary string:** the monospace raw‑URL box (`.target`) currently sits near the top like an error dump. Show a **human label** for the resource (e.g., the YouTube title when derivable via `youtube-normalize.js`) as the hero, and tuck the raw URL behind a "details" disclosure. A wall of `?v=…&pp=…` reads as a system fault, not a friendly gate.
  - **Relatedness:** name the person ("Ask Mom") and promise responsiveness ("she'll get it right away") rather than an anonymous "a parent."
  - **No red‑verdict styling:** the red status dot is fine as a small status cue, but the overall frame should read calm/neutral, not alarm.

---

## 5. Trust & transparency — privacy *is* UX

**Principle.** Both users must be able to see that the system is fair. The child should understand *what* is happening and *why* (not be surveilled by a black box); the parent should see **only what a decision requires** — not a browsing feed. Minimizing collection is both a compliance posture and a trust‑building UX act.

**The science / basis.**
- **Autonomy & relatedness (SDT, §4)** depend on the child not feeling covertly watched; visible, comprehensible rules support volitional compliance rather than resentment ([Ryan & Deci PDF](https://selfdeterminationtheory.org/SDT/documents/2000_RyanDeci_SDT.pdf)).
- **Our own architecture makes minimization a design constraint, not an aspiration:** `ARCHITECTURE.md §10 (privacy)` — *"minimize collection. Store the blocked request that needs approval + decision metadata, not full browsing history… Activity reporting is opt‑in."* `NEURLFilter` is privacy‑preserving by construction (PIR + OHTTP; neither Apple nor we see browsing, `§3.1`). §12 adds COPPA/GDPR‑K minimization duties.

**Product requirement.** The child‑side UI states plainly what is filtered and that only *asked‑for* items are shared with a parent; the parent‑side UI surfaces the **single request + its metadata**, never an implied history feed; anything broader (activity reports) is explicitly opt‑in and labeled.

**Change to our UI.**
- **Block screen:** add one honest line — *"Only pages you ask about are shared with your parent. Your other browsing isn't sent."* This directly reflects `§10` and converts a potentially creepy moment into a trust moment.
- **Parent console:** keep the request card scoped to *this* request's metadata (target, url, reason, child, time) — it already does — and **avoid** ever introducing a "recent sites Jane visited" list that the architecture deliberately doesn't collect. If activity reporting ships later, gate it behind an explicit opt‑in toggle with plain‑language copy, per `§10`.
- **Honesty about enforcement posture:** where the product claims protection, mirror `§4`/`§9`'s honesty matrix in‑product ("technically enforced" vs. "removable by the device owner"). Over‑claiming protection is itself a trust bug.

---

## 6. Notification design — actionable, low‑noise, attention‑respecting

**Principle.** The parent push is the product's heartbeat. It must be **actionable** (decide from the notification), **rare and real** (every buzz is a genuine child request), and **quiet by default** — because the failure mode of notifications is that people stop reading them.

**The science.**
- **Alert fatigue / "cry wolf":** when alerts are frequent or low‑value, people habituate and override them — documented at 49–96 % override rates in clinical decision support; volume *reduces* responsiveness to the alerts that matter (overview: [Workato](https://www.workato.com/the-connector/alert-fatigue/)). More alerts → lower acceptance.
- **Interruptions carry a real cost:** recovering from an interruption incurs a **resumption lag** and elevated stress/error, and reducing interruption frequency raises performance (Iqbal & Horvitz, *Disruption and Recovery of Computing Tasks*, CHI 2007, [Microsoft Research PDF](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/11/CHI_2007_Iqbal_Horvitz-1.pdf); Altmann & Trafton, resumption lag, [interruptions.net PDF](https://www.interruptions.net/literature/Altmann-CogSci04.pdf)). So each notification we send is a debit against the parent's attention — spend it only on real, actionable requests, and let the parent clear it *from* the notification to minimize the interruption.

**Product requirement.** Every child request notification is **actionable inline** (Allow 30 min / Not now); notifications are **deduplicated and batchable** (one grouped push for a burst, not five); non‑decision events are **silent or in‑app only**; respect Do‑Not‑Disturb / quiet hours; the copy states exactly who asked for what so the parent can decide without opening anything.

**Change to our UI.**
- Implement **actionable APNs notifications** (per §3) — the single biggest lever: decide‑from‑lockscreen turns a 30‑second app trip into a 2‑second tap and keeps the interruption tiny.
- **Batch bursts:** if a child fires several requests in a minute, coalesce into one grouped notification ("Jane asked to open 3 things") rather than N buzzes — directly countering alert fatigue.
- **Notification copy** must be self‑sufficient: *"Jane wants to watch a video · tap to allow 30 min or open."* Never a contentless "You have a new request."
- Reserve pushes for **actual access requests and safety‑relevant events**; keep enrollment/status chatter in‑app.

---

## 7. Habit & consistency — make the loop automatic

**Principle.** We *want* this loop to become a reflex for both users: child asks (instead of bypassing), parent taps (instead of deliberating). Reflexes form through **repetition of the same action in the same context** — which requires the UI to be predictable and its language identical every time.

**The science.**
- Habit formation is repetition‑driven automaticity: in Lally et al.'s real‑world study, behaviors became automatic after a **median ~66 days** (range 18–254) of consistent repetition in a stable context — and *consistency of context* was what predicted automaticity (Lally et al. 2010, *Eur. J. Social Psychology*, [Wiley](https://onlinelibrary.wiley.com/doi/10.1002/ejsp.674)). Practical implication: **variability is the enemy of habit.** If the button, the words, or the flow change between encounters, the reflex never sets.
- Consistency is also a core usability heuristic (recognition/consistency, Nielsen's *10 Heuristics*, [nngroup.com](https://www.nngroup.com/articles/ten-usability-heuristics/)) — same concept, same word, same place, every time.

**Product requirement.** One canonical name per concept across child and parent surfaces; the primary action in the same position with the same label every time; the loop's shape never changes between requests.

**Change to our UI.**
- **Unify the verb.** *Settled — see `BRAND.md` §6.1 and `docs/UX_PLAN.md` §0: **open / closed**, with "unlock" retired.* Child taps **"Ask to open it"** → parent sees **"Open this video · 30 min" / "Not now"** → child sees the answer. One mental model, reinforced every cycle. This section previously prescribed "unlock" while `BRAND.md` §6 banned lock language three rows above its own counter-example, which is how the product ended up with four words for one action.
- **Stable primary action:** the parent's primary button stays in the same spot with the same wording for every request (see §2); don't let scope/duration reshuffle it.
- **Consistent status language** the child recognizes instantly: "Asked ✓" → "Opened ✓", same words each time (replacing the current ad‑hoc "Request sent. A parent will be notified.").

---

## 8. Accessibility & inclusive design (WCAG 2.2, HIG)

**Principle.** The loop must work for a distractible kid on a laptop trackpad, a parent tapping one‑handed on a phone in low light, and users with motor, vision, or reading differences. Accessibility here is not a compliance afterthought — it's the same "lower the effort floor" goal as §2, generalized.

**The science / standards.**
- **Target size:** WCAG 2.2 **SC 2.5.8 Target Size (Minimum, AA)** — interactive targets ≥ **24×24 CSS px** (or adequate spacing) ([W3C Understanding 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)); Apple HIG recommends **44×44 pt** ([Apple HIG — Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)). Small targets produce 25 %+ tap errors for users with limited fine‑motor control.
- **Don't rely on color alone:** WCAG **SC 1.4.1 Use of Color (A)** — color must never be the *only* way status is conveyed; pair it with text/icon/shape ([W3C Understanding 1.4.1](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html)). ~1 in 12 men has a color‑vision deficiency.
- **Reduced motion:** WCAG **SC 2.3.3 Animation from Interactions (AAA)** and the `prefers-reduced-motion` media query — honor users who need motion minimized ([W3C Understanding 2.3.3](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html)).
- **Readable/dyslexia‑friendly type:** generous size and line spacing, left‑aligned, avoid justified text and long all‑caps runs ([British Dyslexia Association style guide](https://www.bdadyslexia.org.uk/advice/employers/creating-a-dyslexia-friendly-workplace/dyslexia-friendly-style-guide)).

**Product requirement.** This list is the bar we hold ourselves to, and it is
written to be *checkable* — an audit found the previous version claimed three
properties the code did not implement, because the requirement named no way to
verify them.

1. **Target size.** All controls ≥ **44 px** hit area. (The WCAG floor is 24×24,
   SC 2.5.8; we hold ourselves to 44.) `<summary>` is a control, and gets 44 px
   like everything else.
2. **Contrast, measured.** Text ≥ **4.5:1** (SC 1.4.3) and UI boundaries and
   focus indicators ≥ **3:1** (SC 1.4.11) against their *actual* backgrounds,
   computed with the relative-luminance formula, never eyeballed. Every token
   ships with its number — see `docs/BRAND.md`. A focus ring must clear 3:1
   against **each fill it can land on**, not just against the page.
3. **Status is never colour alone** (SC 1.4.1), and every status *change* is
   delivered to a live region (SC 4.1.3) — a `textContent` write announces to
   nobody.
4. **Every control has a programmatic accessible name** (SC 4.1.2), and every
   input has a real `<label for>` — never a placeholder (SC 3.3.2).
5. **Focus is visible, never removed, and never orphaned by an async update**
   (SC 2.4.3). After any re-render or state flip, focus lands somewhere
   deliberate. Never `disabled` a focused button — use `aria-disabled` plus a
   guard, so the element stays in the tab order and the accessibility tree.
6. **Errors say what went wrong and what to do next** (SC 3.3.1, 3.3.3), in the
   child's or the parent's words. A raw HTTP status or an enum identifier is not
   an error message.
7. **Reflow.** Content works at **320 px** and **200 % zoom** with no horizontal
   scroll and no lost content (SC 1.4.10, 1.4.4). Beware `height:100%` plus
   `align-items:center`: the top overflow of a flex container cannot be scrolled
   back to.
8. **Motion** gated behind `prefers-reduced-motion` — including auto-dismiss
   timers, not just transitions.
9. **Body type ≥ 16 px / 1.5**, left-aligned, never justified, no long all-caps
   runs.
10. **Never render success text the code has not verified.** If the transport did
    not acknowledge it, the UI does not claim it happened; if nothing re-opens
    the page, the UI does not promise that it will.

**Where the five surfaces stand.** (`web/parent/`, both `blocked.html`, both
`options.html`.)

| Requirement | State | Notes |
|---|---|---|
| 1 — 44 px targets | **Done** | One `--tap: 44px` token drives every button, input, select and `summary`. The three `<summary>` disclosures were 18–19.7 px, i.e. under the WCAG 24 px floor, not merely under our own bar. *Corrected: this said Done for months while the `/blocked` route — the only block page on iOS — shipped a 24 px `summary`. It is 44 px now and `blocked-page.test.ts` asserts it, because a table cell claiming Done is what stopped anyone looking.* |
| 2 — measured contrast | **Done** | Token sheet in `web/parent/tokens.css`; numbers in `docs/BRAND.md`. The focus ring is two-tone because no single colour clears 3:1 against both the teal and the coral fill. |
| 3 — status never colour alone, announced | **Done** | Icon + word on every status; `role="status"` regions on all five surfaces, plus a separate `role="alert"` in the console for blocking errors. |
| 4 — labels and names | **Done** | Orphan `<label>`s replaced with real `for`/`id` pairs; every repeated button ("Not now", "30 min") carries an `.sr-only` suffix naming which ask it belongs to. |
| 5 — focus survives async | **Done** | The console's long-poll re-render saves and restores focus (and keeps open `Change…` panels open); the block screens use `aria-disabled` + a guard instead of `disabled`. |
| 6 — actionable errors | **Done** | Message maps in `app.js` and both `options.js`. No surface renders a bare status code any more. |
| 7 — reflow | **Done** | Console header wraps and truncates; block screens use `min-height` + `align-items: safe center`; both `options.html` gained the missing viewport meta. *Corrected: "block screens" was two of the three. The `/blocked` route used plain `center`, so at 200% zoom its heading and ask button left the flex container with no way to scroll back — the exact failure this row claimed was fixed. Asserted in `blocked-page.test.ts` now.* |
| 8 — reduced motion | **Done** | Global `prefers-reduced-motion` block; the toast's auto-dismiss is 6 s (was 1.8 s, below the time a screen-reader user needs to reach it). |
| 9 — 16 px body | **Done** | Both `options.html` were 15 px and were never mentioned in this section; they are 16 px now. |
| 10 — no unverified success | **Partly done, and the gap is deliberate.** | The block screens no longer say "this page opens by itself" (no code re-navigates a parked tab) and no longer report "Asked ✓" before the transport acknowledged. But the console's "Sent to Jane's device" still fires on HTTP 200 from `/decide`, before any device has acknowledged the new policy version — the API has no device-ack channel to gate it on. |

**Still open, and named so nobody re-claims them:**
- **Nothing re-opens the child's page when the answer lands.** `background.js`
  has no handler for it. The block screen therefore shows an explicit **Open it**
  button when it detects the approval, rather than promising an auto-open.
- **The block screen infers the answer from the cached snapshot**, matching only
  explicit URL / video-id / domain rules. Channel, playlist and category answers
  are invisible to it, and it stays on "waiting" rather than guessing — honest,
  but incomplete. The real fix is a decision event on the device long-poll.
- **The parent's "yes" carries no title or thumbnail** — `AccessRequest.title` is
  never populated, so many cards still read `YouTube video — dQw4w9WgXcQ`. A
  one-tap decision on an opaque id is not a decision.
- **A timed "yes" cannot be undone.** The console's 5-second Undo works on any
  decision that produced a standing rule (that is every "Not now", and any "for
  good"), because `DELETE /rules/:id` exists. There is no delete endpoint for a
  temporary grant, so the console does not offer an Undo it cannot honour.
- **The options page lock is a page-level gate, not a real one.** See the header
  comment in `windows/extension/options.js`.

---

## 9. Copy & microcopy principles

**Principles (all evidence‑linked above):**
1. **Situation, not verdict** — describe the state of the page, never judge the person (§4, shame vs. guilt).
2. **Lead with the next action** — the first thing read should be the thing to do (§2, recognition; §4, competence).
3. **Name the ally, promise speed** — "Mom will get it right away" (§4, relatedness; §1, latency).
4. **One verb per concept, everywhere** (§7, consistency).
5. **Autonomy‑supportive, not interrogating** — invite context, don't demand justification (§4, autonomy).
6. **Say what happens next** — reduce uncertainty about the outcome (§2, no dead‑ends).

**Before / after — our current strings**

| Where | Current | Proposed | Why |
|---|---|---|---|
| Block `<h1>` (`blocked.html`) | "This page isn't available right now" | "You can ask to open this page" | Leads with agency/next action, not a verdict (§2, §4) |
| Block subhead | "A parent set up filtering on this computer. You can ask a parent to allow this." | "Ask Mom to open it — you'll hear back right away." | Names the ally, promises speed, relatedness (§4, §1) |
| Note label/placeholder | "Add a note for your parent (optional)" / "Why do you want to watch this?" | "Add a note (optional) — e.g. 'it's for homework'" | Autonomy‑supportive; "why do you want" reads as demanding justification (§4) |
| Primary button (`blocked.html`) | "Request Access" | "Ask to open it" | Plain, kid‑readable, matches unified verb (§7) |
| Sent status (`blocked.js`) | "Request sent. A parent will be notified." | "✓ Sent. Waiting on a parent." + "You asked 4 min ago. Nothing else to do." | Says what happens next and how long it has been. **The earlier proposal here — "this page will open by itself" — was retracted: no code re-navigates a parked tab, so it was a promise the product does not keep.** When the answer lands the screen shows an **Open it** button (§2, §8, and requirement 10 above) |
| Error status (`blocked.js`) | "Couldn't send the request (the filter service may be unreachable). Try again." | "⚠ Couldn't send — [Try again]" (button, not just text) | No dead‑end; actionable; concise (§2, §8) |
| Approved status (`blocked.js`) | *(did not exist)* | h1 "You're in" · "A parent said yes. It may close again later on its own." · **[Open it]** | A yes the child never sees is a yes that did not happen (§2) |
| Declined status (`blocked.js`) | *(did not exist — the child sat on "Asked" forever)* | h1 "Not this one" · "A parent said not this time. You can ask again with a note, or go ask them in person." · **[Ask again]** | Closes the loop. Styled `--muted`, **never** the error colour: a no is an answer, not a fault. Never a dead end (§2, §4) |
| Why it's closed (`blocked.js` REASON_COPY) | "This site isn't on the open list yet." | "New sites go past a parent first." / "This site hasn't been opened yet." | Names an agent instead of an invisible list, and "yet" marks the state as changeable — both reduce the freedom threat that drives circumvention (§4) |
| Parent deny (`app.js`) | "Deny" | "Not now" | Softer, less punitive, leaves the door open (§4) — keep an explicit "Block" only inside Change… for true blocks |
| Parent primary (`app.js`) | six "Allow 15m/30m/1h/…" buttons | "Open this video · 30 min" (single) + "Change…" | Collapses decision load; narrowest‑useful default (§2, §3) |
| Approved toast (`app.js`) | "Approved — child device will update in seconds" | keep (good — states outcome + speed) | Already models §1/§9 well |

---

## 10. Metrics to watch (with targets)

Instrument the loop as a funnel; these are the numbers that tell us whether "the product operates before the brain does."

| Metric | Definition | Target |
|---|---|---|
| **Time‑to‑approve (median)** | Request created → parent decision, waking hours | < 30 s median; < 2 min p90 |
| **Time‑to‑unblock (p95)** | Approval written → child device enforces it | **≤ 5 s** (§1 budget) |
| **Taps‑to‑approve** | Interactions from seeing request to decision | ≤ 2 (ideally 0 app‑opens via notification action) |
| **Notification response rate** | Requests acted on from the push within 5 min | > 80 % |
| **% approvals via notification action** | Decided without opening the app | > 60 % |
| **Request abandonment** | Requests where child navigates away before/without a decision surfacing | < 10 % |
| **Bypass attempts** | Anti‑bypass signals per `ARCHITECTURE.md §11` (alt browser, DNS change, incognito, retype) after a block | Trend **down** as latency drops; watch as the leading indicator that the sanctioned path is too slow |
| **Default‑scope acceptance** | Approvals that keep the preselected narrowest scope vs. broadening | High acceptance = default is well‑tuned (§3) |
| **Repeat‑ask rate** | Same child+target asked ≥ 3× in a week without a standing rule | Falling = "approve + remember" is working (§3) |

**Reading the dashboard:** a rise in *bypass attempts* or *abandonment* alongside a rise in *time‑to‑approve* is the signature of the delay‑discounting failure (§1) — the impulsive path is beating the sanctioned one. The fix is almost always **latency or tap‑count**, not more restriction.

---

## Top 10 concrete UI changes to make now

A prioritized checklist, mapped to files. Ordered by impact‑per‑effort.

1. **[Parent] Actionable push approvals** — Allow 30 min / Not now from the notification, no app open. Writes `ApprovalDecision` directly. *(APNs path, `ARCHITECTURE.md §7`; §1/§3/§6)* — **highest impact.**
2. **[Parent] Replace 3 s polling with WS/SSE push** (`app.js` `setInterval(refreshRequests,3000)` → the backend's existing push channel). Cuts up to ~6 s of round‑trip latency. *(§1)*
3. **[Parent] Collapse the decision to one primary button** — `renderRequest` in `app.js`: "Open this video · 30 min" (narrowest‑useful default) + "Not now" + a "Change…" disclosure hiding the 8‑scope × 6‑duration matrix. *(§2/§3)*
4. ~~**[Block] Optimistic "Asked ✓" on tap**~~ — **done, then corrected.** The
   optimistic flip shipped, but it reported success even when the transport
   dropped the message, and the "opens by itself if yes" copy described a code
   path that does not exist. The screen now shows four honest states — asking /
   asked (with how long ago) / approved / declined — and only claims "sent" once
   the send was acknowledged. *(§1/§9, requirement 10)*
5. **[Block] Demote the raw URL, add a human label** — make the resource title (via `youtube-normalize.js`) the hero; move the monospace URL behind a "details" disclosure. *(§4)*
6. ~~**[Both] Fix tap targets to ≥ 44 px**~~ — **done**, via the `--tap` token. Note the miss the first pass made: the primary buttons were fixed and the `<summary>` disclosures (18–19.7 px, under the WCAG 24 px floor) and the options pages were not. *(§8, WCAG 2.5.8 / HIG)*
7. ~~**[Both] Color‑independent status**~~ — **done on all five surfaces.** The first pass did the block screens and left the console's family picker (fill colour only) and both options pages (a pale wash at 1.14:1) untouched. *(§8, WCAG 1.4.1)*
8. **[Both] Unify the verb** — child "Ask to open it" → parent "Open this video · 30 min" / "Not now" → child "You're in" / "Not this one", identical every cycle. Done in the UI; the notification copy still needs it. *(§7)*
9. **[Block] Non‑shaming copy + privacy line** — apply the §9 before/after table; add "Only pages you ask about are shared." *(§4/§5)*
10. **[Parent] Batch bursts + "Always allow this channel"** — group same‑child/same‑channel PENDING requests with an "Allow all · 30 min" action, and expose a remember‑this escalation inside Change…. *(§3)*
11. **[Parent] Reversibility, so a tired yes or no is safe** — **done.** A
    5‑second Undo on any decision that produced a standing rule, plus a
    "What you've already decided" list with Remove. Without it, "Not now" was a
    permanent, invisible, irreversible block: the softest‑sounding control in the
    product had the harshest effect, and a fatigued parent ratcheted the internet
    shut one mis‑tap at a time with no counter‑force. *(§3, §4)*
12. **[Parent] Put the job above the setup** — **done.** Pending asks are now the
    first thing on the page; family/device setup is a collapsed `<details>` below
    it, opened automatically only when there is no family yet. At 375 px the
    "Asks" heading used to sit 420–600 px down the page, below the fold on every
    phone, for the one thing the parent opened the console to do. *(§2)*

---

### Source list

- Nielsen, *Response Time Limits* — https://www.nngroup.com/articles/response-times-3-important-limits/
- Doherty Threshold (Doherty & Thadani, IBM 1982; summary) — https://blog.logrocket.com/ux-design/designing-instant-feedback-doherty-threshold/
- Lempert & Phelps, *Steep Discounting of Future Rewards as an Impulsivity Phenotype* — https://pubmed.ncbi.nlm.nih.gov/32236897/
- Cowan, *The Magical Mystery Four* (working‑memory capacity) — https://pubmed.ncbi.nlm.nih.gov/20445769/
- Nielsen, *Memory Recognition and Recall in User Interfaces* — https://www.nngroup.com/articles/recognition-and-recall/
- Nielsen, *10 Usability Heuristics* — https://www.nngroup.com/articles/ten-usability-heuristics/
- Nielsen, *Progressive Disclosure* — https://www.nngroup.com/articles/progressive-disclosure/
- Sonuga‑Barke dual‑pathway (ADHD executive dysfunction + delay aversion) — https://pmc.ncbi.nlm.nih.gov/articles/PMC3758957/ · https://www.sciencedirect.com/science/article/abs/pii/S0149763403001052
- Ryan & Deci, *Self‑Determination Theory* (2000) — https://selfdeterminationtheory.org/SDT/documents/2000_RyanDeci_SDT.pdf · APA overview — https://www.apa.org/members/content/intrinsic-motivation
- Tangney, *Moral Emotions and Moral Behavior* (shame vs. guilt) — https://www.its.caltech.edu/~squartz/Tangney.pdf · *Shame Withdraws, Guilt Corrects* — https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12189037/
- Danziger, Levav & Avnaim‑Pesso, PNAS 2011 (decision fatigue; note replication caveats) — https://www.pnas.org/doi/10.1073/pnas.1018033108
- Johnson & Goldstein, *Do Defaults Save Lives?* (Science 2003) — https://www.besci.org/papers/johnson-goldstein-2003
- Lally et al., *How are habits formed* (2010) — https://onlinelibrary.wiley.com/doi/10.1002/ejsp.674
- Alert fatigue (overview) — https://www.workato.com/the-connector/alert-fatigue/
- Iqbal & Horvitz, *Disruption and Recovery of Computing Tasks* (CHI 2007) — https://www.microsoft.com/en-us/research/wp-content/uploads/2016/11/CHI_2007_Iqbal_Horvitz-1.pdf · Altmann & Trafton, resumption lag — https://www.interruptions.net/literature/Altmann-CogSci04.pdf
- WCAG 2.2 SC 2.5.8 Target Size (Minimum) — https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
- WCAG 2.2 SC 1.4.1 Use of Color — https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html
- WCAG 2.2 SC 2.3.3 Animation from Interactions — https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html
- Apple Human Interface Guidelines — Accessibility (44 pt targets) — https://developer.apple.com/design/human-interface-guidelines/accessibility
- British Dyslexia Association — Dyslexia‑friendly style guide — https://www.bdadyslexia.org.uk/advice/employers/creating-a-dyslexia-friendly-workplace/dyslexia-friendly-style-guide

*Internal product context referenced: `README.md`, `docs/ARCHITECTURE.md` (§7 access‑request/approval workflow, §8 sync, §10 privacy, §11 anti‑bypass), `web/parent/` (`index.html`, `app.js`), `windows/extension/blocked.html`, `windows/extension/blocked.js`.*
