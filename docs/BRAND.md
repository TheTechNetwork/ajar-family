# BRAND — Ajar

> Brand foundation + adopted name for the cross-platform family web-approval
> platform (URL-level, per-video, phone-driven). **Adopted name: `Ajar`.**
> Availability notes here are lightweight signals, not legal clearance — **run a
> formal USPTO/EUIPO class-9/42/45 clearance before public launch.**

**Name: `Ajar` · Tagline: "Say yes faster."** (alt: *"Open, just enough."*)

---

## 1. Positioning + core promise

**Positioning.** For busy parents who want to give kids the open internet without
the all-or-nothing fight, **Ajar** is a family web-approval platform that opens
*exactly one thing* — one video, one page — in seconds, from your phone, across
every device your child uses. Where blunt filters and screen-time blockers build
walls and cast kids as suspects, Ajar turns a "no" into a fast, calm "yes": the
child asks with one tap, the parent approves with one tap, and only that one
thing opens — for as long as the parent chooses, then it closes on its own.

**Core promise:** *Say yes in seconds — to exactly one thing — from anywhere.*

The brand's job is to reframe the whole category: not surveillance, not
punishment, not a leash the child resents — but a **fast, trusting yes**. Speed
is the hero ("approve before the impulse wins"); calm and agency are the feeling.

---

## 2. Why "Ajar"

Every competitor is a **locked door**. Ajar is the door left open a crack — a
standing invitation, a yes already half-given; one small push (one tap) and just
that one thing swings open. It is the rare name where the product's whole
strategic reframe — *not a wall, a door* — lives inside the literal meaning of
the word, and it lands before the tagline even loads.

Why it holds up on every axis that matters:

- **Operates before the brain does.** Two syllables, "uh-JAR." Any US parent says
  it and spells it right on first contact — the same principle the product itself
  is built on (see `UX_PRINCIPLES.md`). No reconstruction, no hesitation.
- **Distinctive & defensible.** "Ajar" is a common word applied to an unrelated
  product — an **arbitrary mark**, one of the strongest, most registrable kinds.
- **Category-clear (the decisive test).** No parental-control, screen-time, kids,
  or family app is named Ajar. The only "AJAR" in software is a *defunct*
  Motorola/TTPCom feature-phone platform (2002–2008); unrelated non-software
  namesakes exist (a Kuwaiti rent-payments fintech; an InDesign-plugin maker) —
  none in our space.
- **Voice-native.** The block screen writes itself: *"Not open yet — want in?"*
  is native to the name.

**Domain (verified available):** flagship **`ajar.family`** (~$10/yr) — exactly
the `.family` pattern this doc always planned. `ajar.com` / `ajar.app` are held
by unrelated parties; `.family` is on-brand and sufficient.

---

## 3. Naming journey (what we rejected, and why it matters)

The bar that finally worked is **three gates at once**: say-it-once + no in-category
collision + an ownable domain. Names die when they miss any one.

| Candidate | Why rejected |
|---|---|
| **Wren** | Loved the sound; category-clear. But the exact `.com` is taken and, in the end, so was `wren.family`. Good name, no ownable flagship. |
| **Chirp** | Instantly sayable and we secured `chirp.family` — but **HIGH legal risk**: two live parental-control apps already use "Chirp" (incl. one literally named "Chirp Family"), plus CHIRP registered for software (class 9/42) and a pending Google mark. Same-category collision = exactly the lawsuit risk to avoid. |
| Kithaya / Nesria / Yendria | Coined and ownable, but 3-syllable and ambiguous to pronounce — failed the say-it-once bar. |
| Gladewing | Available `.com`, but a live musician + an indie game share the exact name *and* the bird-in-forest metaphor; primary handle taken. |
| Nara, Lumo, Onni, Faro, Umi, Okko … | **Fatal** in-category hits — existing kids/family/parental products. |

**Lesson:** for a lawsuit-averse consumer app, a *distinctive* word (arbitrary or
coined) beats a crowded common one. Ajar is a common word used arbitrarily — the
best of both: instantly understood, yet distinctive for our goods.

---

## 4. Naming system (using Ajar)

| Layer | Name | Notes |
|---|---|---|
| Platform / company | **Ajar** | One master brand across web, cloud, and apps. |
| Parent app (hero) | **Ajar** | App Store: "Ajar — Family Web Approvals." The brand *is* the parent app. |
| Child app / agent | **Ajar for Kids** (agent codename **Latch**) | The child's device agent. Its block/ask screen is the moment the door is *ajar* — a calm ask, never a "blocked" wall. |
| iOS content-filter extensions | Ajar filter (data + control appex) | The classic `NEFilterDataProvider` + control provider path. |
| macOS | **Ajar for Mac** (Safari Web Extension + helper) | Extension-based enforcement. Never blocks Safari. |
| Windows service | **Ajar Agent** — service display name **"Ajar Family Agent"** | Avoids "guard/service" negativity in the user-visible name. (Code identifier stays `FamilyFilterAgent` until a coordinated rename.) |
| Backend / API | **Ajar Cloud** — `api.ajar.family` | The shared policy engine + approval loop. |

**Reverse-DNS bundle prefix.** Tie to the domain we can register (`ajar.family`):
**`com.ajarfamily.*`** —

```
com.ajarfamily.parent                 # parent iOS app
com.ajarfamily.child                  # child agent (iOS)
com.ajarfamily.child.filterdata       # NEFilterDataProvider appex
com.ajarfamily.child.filtercontrol    # NEFilterControlProvider appex
com.ajarfamily.child.urlfilter        # NEURLFilter control provider appex
com.ajarfamily.child.safari           # macOS Safari Web Extension
group.com.ajarfamily.child            # App Group (signed policy cache share)
```

**Domains:** register **`ajar.family`** (flagship) + defensive `ajar.app` /
`getajar.com` if available at purchase time, and the matching handle set
(@ajarfamily / @ajarapp) together.

---

## 5. Tagline

1. **"Say yes faster."** ⭐ — verb-forward, reframes the category from *blocking*
   to *approving*, and names the hero (speed / "approve before the impulse wins").
2. **"Open, just enough."** — leans on the name's own image: the door ajar, only
   this one thing, only for now. Pairs beautifully with "Ajar."
3. **"One little push, and they're in."** — the single-tap approval as a picture.

**Recommended: "Say yes faster."** as the benefit-led promise; **"Open, just
enough."** as the evocative brand line that leans on the name.

---

## 6. Brand voice

**Adjectives:** Calm · Warm · Confident · Plain-spoken *(and quietly quick)*.

**Do**
- Lead with *yes*, *open*, *let through*, *unlock just this*.
- Short sentences. Everyday words. Zero jargon.
- Respect the child as a person ("ask," "want in?") — never "caught," never
  shamed.
- Reassure the busy/ADHD parent: fewer steps, instant, reversible, low-stakes.
- Make speed feel good ("done — it's open").

**Don't**
- Never use: *filter, blocker, lock, guard, nanny, spy, monitor, restrict,
  forbidden, violation, caught, danger* (as a scare).
- No fear-based or surveillance framing. No "gotcha." No infantilizing the child.
- No corporate/security jargon in anything a family reads.

**Microcopy (block screen + approval button), in voice**

| Where | Typical / off-brand | Ajar |
|---|---|---|
| Child block screen (headline + helper) | "Access Denied. This content is blocked by your administrator." | **"Not open yet — want in?"** · helper: *"Send a quick ask and a parent can unlock just this."* |
| Child request button | "Request Access" | **"Ask to unlock"** |
| Parent approval button | "Approve Request" | **"Say yes"** — primary, with a duration chip: *"Just this video · 30 min"* |

Post-approval child confirmation: **"You're in. Have fun — this closes on its own
later."**

---

## 7. Visual direction

**Color.** Calm and alive, not corporate-cold, not alarm-red. A confident teal-
green that nods at "go / greenlight" without the literal traffic light, warmed by
a friendly coral for the *yes* action.

| Role | Name | Hex |
|---|---|---|
| Primary | Ajar Teal | `#18A08C` |
| Ink / text | Deep Pine | `#12241F` |
| Surface | Warm Paper | `#F6F4EE` |
| Accent — the "yes"/action | Sunrise Coral | `#FF8A5B` |

Signal states stay soft (muted amber for "asked," calm teal for "open"), never
harsh red/green enforcement colors.

**Type vibe.** A friendly humanist sans — rounded but grown-up, approachable, not
techy-monospace and not clinical (the warmth of Inter/Söhne with soft terminals).
Wordmark set in **lowercase — `ajar`** — to feel human, quiet, and modern.
Nothing about the type should read "security product."

**Logo concept.** A single door **ajar** — a simple rounded rectangle with one
edge swung open a few degrees, a warm sliver of Sunrise Coral light spilling
through the gap. The whole mark reads as "open, just enough" in one glance;
the open leaf can double as a checkmark's upstroke. One-color-capable, rounded,
weightless. (The interim UI mark is the 🚪 glyph until the custom logo lands.)

---

*Adopt: **Ajar** · "Say yes faster." — then run a formal trademark + domain check
(USPTO/EUIPO classes 9/42/45) before public launch.*
