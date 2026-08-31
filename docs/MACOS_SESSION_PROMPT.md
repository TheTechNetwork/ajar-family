# Prompt for a Claude Code session on a Mac

Everything Apple in this repo was built from Linux and **has never been signed or
run**. A session on a Mac can close that gap — not by repeating the setup, but by
doing the two things Linux structurally cannot: **actually signing a build**, and
**running the filter on hardware**.

Copy everything between the rules into a Claude Code session started in a clone
of this repo on a Mac.

---

You are picking up Ajar, a cross-platform parental URL-filtering platform. Work on
branch `claude/parental-url-filtering-arch-g7af3v`. **PR #1 is deliberately open
and must NOT be merged** — it is held for an alpha/beta gate.

## What is already true

- The iOS child app, its two content-filter extensions, and a signed-policy
  evaluator exist in `apple/AjarFilter/`. `project.yml` drives XcodeGen;
  the `.xcodeproj` is generated, never committed.
- Bundle ids are **hardcoded and permanent**: `family.ajar.filter`,
  `family.ajar.filter.DataProvider`,
  `family.ajar.filter.ControlProvider`, App Group `group.family.ajar.filter`.
  Do not change them without saying so explicitly — an App Store Connect record
  makes a bundle id unrenameable.
- `.github/workflows/testflight.yml` archives, signs and uploads. Signing is
  **manual**: it imports a `.p12` into a throwaway keychain and installs three
  provisioning profiles, matching each to its target by reading the
  `application-identifier` inside the profile. **This path has never executed.**
- `docs/APPLE_ACCOUNT_SETUP.md` is the runbook. §0 is the ordered path, §4.1 is
  the full entitlement inventory including unmerged scaffolds, §3.1 covers the
  certificate.
- A distribution CSR and its private key may already exist (generated with
  `openssl` on Linux). Ask before generating a new one — a team gets **one**
  active distribution certificate for standard App Store distribution.

## Your job, in order

**1. Verify the toolchain.** Xcode version, `xcodebuild -version`, `xcodegen`
(`brew install xcodegen`). Report what you find before proceeding.

**2. Prove the project builds and signs locally, before trusting CI.**
This is the single highest-value thing you can do that a Linux session cannot.

```sh
cd apple/AjarFilter && xcodegen generate
xcodebuild -project AjarFilter.xcodeproj -scheme AjarFilter \
  -destination 'generic/platform=iOS' -configuration Release \
  CODE_SIGNING_ALLOWED=NO build
```

A compile-only pass first proves the Swift actually builds — **nothing in this
repo has ever been through a Swift compiler.** Expect real errors and fix them;
that is the point. Then sign for real with a development identity and confirm the
app and BOTH extensions embed correctly.

**3. Only then, the account work.** Prefer the App Store Connect API over
clicking the portal, using the same key CI uses (`ASC_KEY_ID`, `ASC_ISSUER_ID`,
`ASC_KEY_P8`, App Manager role). The API covers bundle ids, their capabilities,
certificates from a CSR, and profiles — **verify the current endpoints against
Apple's docs rather than trusting this list.** Two things the API does not do,
so budget for the portal or a form:

- **App Group creation.** No public endpoint. Portal.
- **The Family Controls distribution entitlement.** A human review at Apple via
  <https://developer.apple.com/contact/request/family-controls-distribution>,
  with real calendar time. **No App Store profile can carry
  `com.apple.developer.family-controls` until it is granted**, so file it first
  and do everything else while waiting. This blocks TestFlight, not development
  signing.

Enable the full capability set from §4.1 — the account holder chose to enable
everything up front rather than per-merge.

**4. Wire CI, then verify it.** Set the secrets from §8.1 (`APPLE_DIST_P12`,
`APPLE_DIST_P12_PASSWORD`, `APPLE_PROFILE_APP` / `_DATA` / `_CONTROL`, all
base64) and the `APPLE_TEAM_ID` variable. Run *iOS — TestFlight (internal)* from
the Actions tab, typing `testflight` to confirm. **Read the log even when it
passes** — the manual-signing path has never run, so treat the first execution as
a test of the workflow, not just of the account.

**5. The part that actually matters: run it on a device.** ADR-012 is the real
gap. `docs/APPLE_CONTENT_FILTER_POC.md` has the A1–A6 protocol. The two questions
that decide the architecture:

- Does FamilyControls `.child` authorization actually **lock the content-filter
  toggle** against the child in Settings?
- Does `NEFilterFlow.url` really carry **full YouTube watch URLs** at runtime, or
  only the host?

Record observed results in that doc's tables and in `docs/DECISIONS.md`. A green
TestFlight upload proves the app builds and signs; it proves nothing about
whether the filter works.

## Rules

- **Never commit signing material.** `.gitignore` refuses `*.key`, `*.p12`,
  `*.cer`, `*.certSigningRequest`, `*.mobileprovision` — do not weaken it, and
  do not paste key contents into files, commit messages, or the transcript.
- **Do not merge PR #1.**
- Commit and push to the branch above as you go. CI must stay green: `npm test`,
  `npm run conformance`, `node web/parent/sync-tokens.mjs --check`,
  `node web/parent/check-contrast.mjs`.
- If a doc claims something you find to be false on real hardware, **fix the
  doc** — several claims in this repo were written without a Mac and are marked
  UNVERIFIED for exactly this reason.
- Report what failed as plainly as what worked. A first signing run that fails
  with a real error is more useful than a green tick nobody believes.
