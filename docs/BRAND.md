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
| Windows service | **Ajar Agent** — service display name **"Ajar Family Agent"** | Avoids "guard/service" negativity in the user-visible name. Service ID `AjarFamilyAgent`; binary `ajar-agent.exe`; data under `%ProgramData%\Ajar`. |
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

**Every token ships with its measured contrast ratio.** The ratios below were
computed with the WCAG relative-luminance formula against the two grounds we
actually paint on, not estimated by eye. This table is the reason the palette is
what it is: the original brand teal `#18A08C` carries white text at **3.26:1**,
which fails SC 1.4.3 (4.5:1), and it was the primary button on three surfaces —
the AA failure originated here, in this document, because this column did not
exist. It does now.

### Light theme (ground: Warm Paper `#F6F4EE`, cards `#FFFFFF`)

| Role | Name | Hex | On `#fff` | On `#F6F4EE` | Approved use |
|---|---|---|---|---|---|
| Primary (text-safe) | Ajar Teal Deep | `#0d6d5e` | 6.24:1 *(as bg, white label)* | — | Primary button fill with a white label; icons |
| Primary (decorative) | Ajar Teal | `#18A08C` | 3.26:1 | 3.07:1 | **Decorative fills and borders only. Never white text on it.** |
| Primary (as text) | Ajar Teal Ink | `#0b6355` | 7.17:1 | 6.52:1 | Teal text, links, the wordmark |
| Ink / text | Deep Pine | `#12241F` | 16.18:1 | 14.71:1 | Body text, focus rings, toast ground |
| Ink secondary | | `#3E4F49` | 8.68:1 | 7.89:1 | Secondary body text, form labels |
| Muted | | `#5C6B64` | 5.61:1 | 5.10:1 | Metadata, helper text |
| Surface | Warm Paper | `#F6F4EE` | — | — | Page background |
| Well / secondary fill | | `#EFEDE4` | 1.17:1 | — | **Fill only. Needs a `#767468` border to be a visible control boundary.** |
| Divider (decorative) | | `#E3E1D8` | 1.31:1 | — | **Decorative rules only** — exempt from 1.4.11 |
| Field border (functional) | | `#767468` | 4.70:1 | 4.27:1 | Input, textarea, select and secondary-button borders |
| Accent — the "yes" | Sunrise Coral | `#FF8A5B` | 2.32:1 | 2.11:1 | **Fill only, with `#12241F` ink (6.96:1). Never a focus ring, never a border, never text.** |
| "Yes" hover | | `#E4703F` | — | — | Coral hover; ink on it 5.15:1 |
| Signal — asked / waiting | Amber | `#7d5307` | 6.75:1 | 6.13:1 | Status text (was `#b7791f`, 3.64:1 — failed) |
| Signal — problem | Clay | `#8C4636` | 6.90:1 | — | Error text. Never alarm-red |
| Signal — done | | `#14602f` | 6.75:1 *(on `#EAF3EC`)* | — | Success panel edge and word |

### Dark theme (ground `#12211D`, cards `#1A2A26`)

| Role | Hex | On `#1A2A26` | Notes |
|---|---|---|---|
| Ink | `#EAF1EE` | 13.05:1 | body |
| Ink secondary | `#C3D2CC` | 9.56:1 | |
| Muted | `#9FB1AA` | 6.66:1 | 5.76:1 on the dark well `#223531` |
| Primary fill | `#35B7A2` | — | carries `#0B1512` ink at **7.47:1** |
| Primary as text | `#5FD3BE` | 8.23:1 | |
| Coral | `#FF8A5B` | — | carries `#2A1208` ink at **7.61:1** |
| Amber | `#E0B25A` | 7.62:1 | |
| Clay | `#f0a08c` | 7.21:1 | replaces the hard-coded `#c0563f`, which was 3.31:1 in dark |
| Field border | `#7b8d87` | 4.28:1 | |
| Focus ring | `#FFFFFF` | 14.97:1 | see below |

### Focus indicator — why it is two-tone

A single ring in Deep Pine measures **2.59:1 against the teal primary button**
and a single white ring measures **2.49:1 against the dark-theme teal** and
**2.32:1 against coral**. A one-colour ring cannot clear 3:1 against every fill
we ship. The ring is therefore painted as **2px in the surface colour, then 3px
in `--focus`**: the inner band clears 6.24:1 against teal (6.02:1 in dark, 6.44:1
against coral) and the outer band clears 16.18:1 against the inner band and the
card. Both bands stay ≥3:1 against whatever they touch, in both themes.

**Rule.** Every new token ships with its measured ratio against `#fff` and
`#F6F4EE` (light) or `#1A2A26` (dark). Text pairs must reach **4.5:1**
(SC 1.4.3); UI boundaries and focus indicators must reach **3:1** (SC 1.4.11).
A token with no measured number does not ship. The values live in
`web/parent/tokens.css`, which is the single source for all five surfaces.

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
weightless.

**The interim mark is the lowercase wordmark `ajar`, not an emoji.** The 🚪 glyph
was removed from every surface: screen readers announce U+1F6AA as "door", so the
parent console's heading was read aloud as *"door Ajar em-dash Parent Console"*
and the child's block screen as *"door Ajar"* (SC 1.1.1 — a decorative glyph must
be `aria-hidden`, and a wordmark is not decorative). The wordmark is set in
`--accent-ink` at `--t-base`/700, which also fixes the old rendering of the one
branded element on the child's screen as 13px muted grey — the least visible
thing on the page.

---

*Adopt: **Ajar** · "Say yes faster." — then run a formal trademark + domain check
(USPTO/EUIPO classes 9/42/45) before public launch.*
