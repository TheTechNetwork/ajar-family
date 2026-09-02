/**
 * REST API surface wiring the transport-agnostic Router to the domain services.
 *
 * Parent sign-in is self-contained — a password (auth/password.ts) plus a
 * passkey (domain/passkeys.ts), with HMAC bearer tokens and refresh rotation
 * (auth/tokens.ts). No external identity provider is involved anywhere.
 */
import type { App } from "../app.js";
import { Router, ok, err, html, type HttpRequest, type HttpResponse } from "./router.js";
import { issueToken, verifyToken, type Principal } from "../auth/tokens.js";
import { openapiDocument } from "./openapi.js";
import { RateLimiter, clientKey } from "./rate-limit.js";
import * as v from "./validate.js";
import type { AccessRequest, ApprovalDuration } from "../domain/model.js";
import { CATEGORY_DATA_ATTRIBUTION } from "@ajar/shared/categories";

/**
 * Every route that reads a body reads it through one of these. Before this, a
 * body was type-ASSERTED and never checked, so malformed JSON came back as a 500
 * and a wrong-shaped body failed somewhere further in — see http/validate.ts.
 *
 * The enums are repeated here rather than derived from the domain types on
 * purpose: TypeScript's unions are erased at run time, and this is the run-time
 * boundary. The OpenAPI contract test keeps the documented set honest.
 */
const ROLE_VALUES = ["OWNER", "PARENT", "LIMITED_GUARDIAN"] as const;
const PLATFORM_VALUES = ["IOS", "IPADOS", "MACOS", "WINDOWS"] as const;
const ACTION_VALUES = ["ALLOW", "BLOCK"] as const;
const TARGET_VALUES = ["DOMAIN", "URL", "URL_PATTERN", "YOUTUBE_VIDEO", "YOUTUBE_CHANNEL",
  "YOUTUBE_PLAYLIST", "CATEGORY", "APPLICATION"] as const;
const APPROVAL_SCOPE_VALUES = ["THIS_REQUEST", "THIS_URL", "THIS_VIDEO", "THIS_CHANNEL",
  "THIS_DOMAIN", "THIS_DEVICE", "THIS_CHILD", "WHOLE_FAMILY"] as const;
const RULE_SCOPE_VALUES = ["FAMILY", "CHILD", "DEVICE"] as const;
const DURATION_VALUES = ["MINUTES", "UNTIL_END_OF_DAY", "ONCE", "ALWAYS"] as const;
const PUSH_KIND_VALUES = ["APNS", "WEBSOCKET", "CONSOLE", "EMAIL", "WEBPUSH"] as const;

// A password is never trimmed — a leading or trailing space a parent typed is
// part of their password, and quietly removing it locks them out later. Its
// LENGTH rule lives in auth/password.ts and stays there: one source of truth.
const password = () => v.str({ max: 512, trim: false });
const id = () => v.str({ max: 128 });
/** Base64url, and nothing else. Every field a WebAuthn ceremony sends is this. */
const b64url = (max: number) => v.str({ max, pattern: /^[A-Za-z0-9_-]*$/ });

const bodies = {
  register: v.object(
    { email: v.email(), password: password(), displayName: v.str({ max: 120 }) },
    { email: "email address", password: "password", displayName: "name" }),
  login: v.object({ email: v.email(), password: password() },
    { email: "email address", password: "password" }),
  refresh: v.object({ refreshToken: v.str({ max: 4096 }) }, { refreshToken: "sign-in token" }),
  // Deliberately NOT `v.email()`. These two answer 202 whatever they are given,
  // and a 400 for a malformed address would be a second answer where there is
  // meant to be exactly one. The domain does the structural check and stays
  // silent — see AuthService.requestPasswordReset.
  emailOnly: v.object({ email: v.str({ max: 254 }) }, { email: "email address" }),
  reset: v.object({ token: v.str({ max: 512 }), newPassword: password() },
    { token: "reset code", newPassword: "new password" }),
  verify: v.object({ token: v.str({ max: 512 }) }, { token: "confirmation code" }),
  changePassword: v.object({ currentPassword: password(), newPassword: password() },
    { currentPassword: "current password", newPassword: "new password" }),
  deleteAccount: v.object({ password: password() }, { password: "password" }),
  dataset: v.object({ categories: v.dict(v.arrayOf(v.str({ max: 253 }))) }),
  family: v.object({ name: v.str({ max: 120 }) }, { name: "family name" }),
  addParent: v.object({
    email: v.optional(v.email()), userId: v.optional(id()),
    role: v.oneOf(ROLE_VALUES), assignedChildIds: v.withDefault(v.arrayOf(id(), { max: 64 }), []),
  }, { email: "email address", role: "role", assignedChildIds: "list of children" }),
  addChild: v.object({ displayName: v.str({ max: 120 }), timezone: v.withDefault(v.str({ max: 64 }), "UTC") },
    { displayName: "name", timezone: "time zone" }),
  setTimezone: v.object({ timezone: v.str({ max: 64 }) }, { timezone: "time zone" }),
  defaults: v.object({ webDefault: v.oneOf(ACTION_VALUES), youTubeDefault: v.oneOf(ACTION_VALUES) },
    { webDefault: "what to do with websites by default", youTubeDefault: "what to do with YouTube by default" }),
  addRule: v.object({
    target: v.oneOf(TARGET_VALUES), value: v.str({ max: 2048 }), action: v.oneOf(ACTION_VALUES),
    priority: v.optional(v.int({ min: 0, max: 1_000_000 })),
    scope: v.object({
      type: v.oneOf(RULE_SCOPE_VALUES), childId: v.optional(id()), deviceId: v.optional(id()),
    }, { type: "who this rule is for" }),
  }, { target: "what the rule matches", value: "the address or category", action: "allow or block" }),
  enroll: v.object({ childId: id(), platform: v.oneOf(PLATFORM_VALUES) }, { childId: "child", platform: "device type" }),
  redeem: v.object({
    code: v.str({ max: 64 }), devicePublicKey: v.str({ max: 4096 }), displayName: v.str({ max: 120 }),
  }, { code: "setup code", displayName: "device name" }),
  createRequest: v.object({
    targetType: v.oneOf(TARGET_VALUES), targetValue: v.str({ max: 2048 }),
    title: v.optional(v.str({ max: 512 })), url: v.optional(v.str({ max: 2048 })),
    reason: v.optional(v.str({ max: 1024 })),
    // A HOST, so the cap is a host's length and not a URL's. See
    // AccessRequest.referrerHost: display only, normalized server-side, and a
    // value that fails to look like a host is dropped rather than shown.
    referrerHost: v.optional(v.str({ max: 253 })),
  }),
  decide: v.object({
    decision: v.oneOf(ACTION_VALUES), scope: v.oneOf(APPROVAL_SCOPE_VALUES),
    duration: v.object({ kind: v.oneOf(DURATION_VALUES), minutes: v.optional(v.int({ min: 1, max: 100_000 })) },
      { kind: "how long for", minutes: "number of minutes" }),
  }, { decision: "allow or block", scope: "how widely this applies", duration: "how long for" }),
  endpoint: v.object({ kind: v.oneOf(PUSH_KIND_VALUES), token: v.str({ max: 4096 }) },
    { kind: "kind of notification", token: "where to send it" }),

  // WebAuthn ceremony bodies. These are validated field by field rather than
  // passed through, and the parser REBUILDS the object from the fields named
  // here — so whatever reaches the crypto is a known shape of bounded strings,
  // not whatever JSON arrived. The fields are exactly the ones
  // @simplewebauthn/server reads; adding one it does not read would be dead
  // weight, and dropping one it does read would break the ceremony, so this list
  // is checked against the library rather than guessed.
  passkeyRegister: v.object({
    label: v.withDefault(v.str({ max: 64 }), "Passkey"),
    credential: v.object({
      id: b64url(1024), rawId: b64url(1024), type: v.oneOf(["public-key"] as const),
      response: v.object({
        attestationObject: b64url(32_768),
        clientDataJSON: b64url(8192),
        transports: v.optional(v.arrayOf(v.str({ max: 32 }), { max: 8 })),
      }),
    }, { id: "passkey" }),
  }, { credential: "passkey" }),
  passkeyLogin: v.object({
    credential: v.object({
      id: b64url(1024), rawId: b64url(1024), type: v.oneOf(["public-key"] as const),
      response: v.object({
        authenticatorData: b64url(8192),
        clientDataJSON: b64url(8192),
        signature: b64url(4096),
        userHandle: v.optional(b64url(1024)),
      }),
    }, { id: "passkey" }),
  }, { credential: "passkey" }),
};

async function principal(app: App, req: HttpRequest): Promise<Principal | null> {
  const auth = req.headers["authorization"] ?? req.headers["Authorization"];
  if (!auth?.startsWith("Bearer ")) return null;
  return verifyToken(app.authSecret, auth.slice(7));
}
const UNAUTH = (msg: string) => Object.assign(new Error(msg), { code: "UNAUTHORIZED" });

/** Resolve + fully validate a user token: signature/exp, tokenVersion (global
 *  revocation), and — if the token carries a session id — that the session is
 *  still live (per-device revocation). Returns the userId and its session id. */
async function userPrincipal(app: App, req: HttpRequest): Promise<{ userId: string; sid?: string }> {
  const p = await principal(app, req);
  if (!p || p.kind !== "user") throw UNAUTH("login required");
  await app.auth.userForToken(p.userId, p.tv);
  if (p.sid && !(await app.auth.sessionActive(p.sid))) throw UNAUTH("session revoked");
  return { userId: p.userId, sid: p.sid };
}
async function requireUser(app: App, req: HttpRequest): Promise<string> {
  return (await userPrincipal(app, req)).userId;
}

// Access + refresh token pair for one session (sid). Access is short-lived; the
// refresh token mints new access tokens via /v1/auth/refresh. Both carry the
// user's tokenVersion (global revoke) AND the session id (per-device revoke).
const ACCESS_TTL = 60 * 60; // 1h
const REFRESH_TTL = 60 * 60 * 24 * 14; // 14d
// Long enough to pick up a phone and touch a sensor, short enough that a
// password captured on a shared machine is not still half a sign-in tomorrow.
const MFA_TTL = 5 * 60; // 5m
const deviceLabel = (req: HttpRequest) =>
  req.headers["x-device-label"] || req.headers["user-agent"] || "Unknown device";
async function tokenPair(app: App, user: { id: string; tokenVersion: number }, sid: string) {
  return {
    userId: user.id,
    tokenType: "Bearer",
    expiresIn: ACCESS_TTL,
    accessToken: await issueToken(app.authSecret, { kind: "user", userId: user.id, tv: user.tokenVersion, sid }, ACCESS_TTL),
    refreshToken: await issueToken(app.authSecret, { kind: "refresh", userId: user.id, tv: user.tokenVersion, sid }, REFRESH_TTL),
  };
}
/**
 * Resolve a device token AND confirm the device still exists. Device tokens are
 * self-contained and long-lived, so without this check a device that a parent
 * deleted kept working until its token expired — erasure that erased nothing.
 */
async function requireDevice(app: App, req: HttpRequest) {
  const p = await principal(app, req);
  if (!p || p.kind !== "device") throw Object.assign(new Error("device token required"), { code: "UNAUTHORIZED" });
  const device = await app.repo.getDevice(p.deviceId);
  if (!device) throw Object.assign(new Error("this device has been removed"), { code: "UNAUTHORIZED" });
  return p;
}

/**
 * Resolve a half-finished sign-in. Accepts ONLY the `mfa` kind — a full user
 * token is refused here, so a signed-in session cannot be replayed into the
 * second half of somebody else's login — and re-checks tokenVersion, so a
 * password change or a sign-out-everywhere in the seconds between the two steps
 * invalidates the half-finished one too.
 */
async function mfaPrincipal(app: App, req: HttpRequest) {
  const p = await principal(app, req);
  if (!p || p.kind !== "mfa") throw UNAUTH("start again from the sign-in page");
  return app.auth.userForToken(p.userId, p.tv);
}

/** What a passkey looks like from outside. Never the public key: it is not
 *  secret, but publishing it is free help to anyone building a target list. */
const publicPasskey = (c: { id: string; label: string; backedUp: boolean; createdAt: string; lastUsedAt?: string }) =>
  ({ id: c.id, label: c.label, backedUp: c.backedUp, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt });

/** Device tokens last 30 days and can be refreshed while still valid. */
const DEVICE_TOKEN_TTL = 60 * 60 * 24 * 30;
const issueDeviceToken = (app: App, d: { id: string; familyId: string; childId: string }) =>
  issueToken(app.authSecret, { kind: "device", deviceId: d.id, familyId: d.familyId, childId: d.childId }, DEVICE_TOKEN_TTL);


/**
 * Compare two secrets without leaking their contents through how long the
 * comparison ran. `a !== b` on strings stops at the first differing byte, and
 * the length check that preceded it published the secret's length as well.
 * Hashing first makes both operands the same fixed size, so the loop below
 * always runs the same number of steps whatever was offered.
 */
async function secretEquals(offered: string, expected: string): Promise<boolean> {
  const digest = async (x: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(x)));
  const [a, b] = await Promise.all([digest(offered), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Minimal HTML escaping for the one page this API serves. */
function escapeHtml(v: string): string {
  return v.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * A value safe to embed in an inline `<script>`.
 *
 * `JSON.stringify` escapes quotes and backslashes and stops there: `</script>`
 * inside the string would close the element and everything after it would be
 * markup. The one value this is used on is a parsed-and-reserialised URL, where
 * `<` and `>` are already percent-encoded and a `<` in the host makes parsing
 * throw — so it cannot happen today. It is escaped anyway, because "cannot
 * happen" is doing a lot of work in a sentence about script injection, and the
 * cost is one replace.
 */
function jsonForScript(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c").replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/**
 * Pull `u` out of the block page's query string WITHOUT letting a `&` inside it
 * end the value.
 *
 * iOS builds this URL by substituting the blocked flow URL into `?u=…`, and the
 * substitution is not percent-encoded — the substitution is the system's, not
 * ours, so there is nowhere to add the encoding. A target that carries its own
 * query therefore arrives with live `&`s, and `URLSearchParams` splits it:
 *
 *     ?u=https://example.com/a?id=123&page=2
 *        → u = "https://example.com/a?id=123"   and a stray page=2
 *
 * That truncation is not cosmetic. A non-YouTube block becomes a `URL` rule for
 * the exact string (FilterController.handleIncoming), so the parent approves
 * `…?id=123`, the child's actual page is `…?id=123&page=2`, and the rule does
 * not match it. The approval silently does nothing.
 *
 * It was very nearly written off because the ONE case that survives is YouTube —
 * `v` sits before the first `&`, so the video id comes through intact. Every
 * other site on the web is the case that does not survive, and this product
 * filters URLs, not YouTube.
 *
 * So `u` is read from the raw query string and runs to the END of it. That makes
 * the ordering a contract: **`u` must be last**. Anything else the page reads
 * goes before it (see `ally`), and the iOS remediation URL is built that way.
 *
 * Falls back to the parsed value when no raw query is available — a test
 * harness, or an adapter that has not been taught to pass one. The fallback is
 * lossy in exactly the way described above, which is why both live adapters
 * supply `rawQuery`.
 */
export function blockedTargetParam(req: HttpRequest): string {
  const raw = req.rawQuery;
  if (raw !== undefined) {
    // Only at a parameter boundary: `?maybe_u=x` must not be mistaken for `u=x`.
    const at = raw.startsWith("u=") ? 0 : raw.indexOf("&u=") + 1;
    if (at > 0 || raw.startsWith("u=")) {
      // Everything after `u=`, decoded ONCE. A client that did encode its target
      // (the extensions do) is decoded correctly; iOS's unencoded one has
      // nothing to decode and passes through, except that a literal `%` would
      // throw — hence the fallback to the raw slice.
      const value = raw.slice(at + 2);
      try {
        return decodeURIComponent(value).slice(0, 2048);
      } catch {
        return value.slice(0, 2048);
      }
    }
    return "";
  }
  return (req.query.get("u") ?? "").slice(0, 2048);
}

/**
 * The `u` parameter of the block page, made safe to reflect — or dropped.
 *
 * TWO THINGS ARE TRUE AT ONCE and the first version only honoured one of them.
 *
 * 1. `u` is reflected into an `ajar://` link and into the page. Emitting it
 *    unchecked makes this a redirect into any scheme a browser will honour —
 *    `javascript:`, `data:`, `file:`. So the scheme must be an allowlist.
 * 2. **iOS does not always send a scheme.** `remediationMap` substitutes
 *    `NEFilterProviderRemediationURLFlowURL`, and for a socket flow there is no
 *    full URL to substitute — the system passes the host. A real child hitting a
 *    real block got `?u=www.youtube.com/`, which the old `^https?://` test
 *    rejected, so the page said "No address came through" and the Request Access
 *    button was not rendered at all. The one screen whose entire job is to let a
 *    child ask was a dead end on the most common kind of block.
 *
 * So: accept http(s) as before, ADD a scheme to something that has none, and
 * still refuse anything carrying a different one.
 *
 * The scheme test deliberately looks at the authority — everything before the
 * first `/`, `?` or `#` — rather than matching `^[a-z][a-z0-9+.-]*:` against the
 * whole string. Scheme characters include `.` and `-`, so that pattern reads
 * `www.youtube.com:8080/x` as the scheme `www.youtube.com` and throws away a
 * perfectly ordinary host and port. Requiring the part after any colon in the
 * authority to be digits separates a port from `javascript:alert(1)`.
 *
 * Parsing at the end is not decoration: it rejects an empty or malformed host
 * that survives the shape check, and returns the browser's own canonical form
 * rather than whatever arrived.
 */
export function normalizeBlockedTarget(raw: string): string {
  const target = raw.trim();
  if (!target) return "";

  let candidate: string;
  if (/^https?:\/\//i.test(target)) {
    candidate = target;
  } else {
    // `//evil.com` has an empty authority and is protocol-relative — a redirect
    // in disguise — so the `[^:/?#]+` here has to require at least one char.
    const authority = target.split(/[/?#]/, 1)[0] ?? "";
    if (!/^[^:/?#]+(:\d+)?$/.test(authority)) return "";
    candidate = `https://${target}`;
  }

  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (!url.hostname) return "";
    return url.toString();
  } catch {
    return "";
  }
}

export function buildRouter(app: App): Router {
  const r = new Router();

  // Layered rate limiting: a generous baseline on EVERY route (abuse / scanning /
  // authed hammering), plus stricter caps on the sensitive unauthenticated ones.
  // Per-client (proxy IP header, else a shared bucket); per-process — front with
  // Redis / a Durable Object at multi-instance scale. See docs/SECURITY.md.
  const globalLimiter = new RateLimiter(600, 60_000); // 600/min per client, all routes
  const authLimiter = new RateLimiter(10, 60_000);    // 10/min per client for auth
  const enrollLimiter = new RateLimiter(20, 60_000);  // 20/min per client for redeem
  const limited = (lim: RateLimiter, req: HttpRequest) =>
    !lim.allow(clientKey(req.headers, app.trustProxyHeaders))
      ? err(429, "too many attempts — slow down", "RATE_LIMITED") : null;
  r.before((req) => limited(globalLimiter, req));

  r.get("/v1/health", async () => ok({ status: "ok", version: "0.0.0-alpha" }));
  r.get("/v1/signing-key", async () => ok({ publicKeyB64: app.signingPublicKeyB64, alg: "Ed25519" }));

  /**
   * Apple App Site Association — what lets the parent APP use the passkeys a
   * parent enrolled in the BROWSER.
   *
   * A passkey is bound to its rpId (`ajar.family`). A native app may only claim
   * that rpId if Apple can fetch this file from `https://<rpId>/.well-known/
   * apple-app-site-association` and find the app's id under `webcredentials`.
   * Without it `ASAuthorizationPlatformPublicKeyCredentialProvider` fails with
   * a domain-association error, and since sign-in is password-then-passkey, the
   * parent cannot get into the app at all.
   *
   * Served from the router rather than as a static asset so it exists on every
   * deploy target, and because it must be JSON with no redirect — Apple follows
   * neither a 30x nor an HTML error page.
   *
   * `appleAppIds` is empty until a real Team ID is known (APPLE_APP_IDS, e.g.
   * `ABCDE12345.family.ajar.parent`). Serving an EMPTY apps list would tell
   * Apple, authoritatively and with caching, that no app may claim this domain;
   * a 404 is the honest answer for "not configured yet" and is retried.
   */
  r.get("/.well-known/apple-app-site-association", async () => {
    const apps = app.appleAppIds;
    if (apps.length === 0) return err(404, "no associated apps are configured", "NOT_FOUND");
    // Universal Links are deliberately NOT claimed alongside webcredentials. The
    // block page hands back via the `ajar://` scheme (AjarFilter/project.yml),
    // and claiming paths we do not handle would swallow ordinary web links to
    // ajar.family into an app that has no screen for them.
    //
    // `ok` serves this as application/json, which is what Apple requires; it
    // does not accept text/html, and the wrong type here is indistinguishable
    // from a missing file.
    return ok({ webcredentials: { apps } });
  });

  /**
   * The Request-Access block page (iOS content-filter remediation target).
   *
   * When the data provider returns `.remediateVerdict`, iOS renders THIS page
   * inside Safari with `?u=<the blocked flow URL>`. It is deliberately:
   *
   *  - **unauthenticated** — it is fetched by a browser that holds no device
   *    token, while a filter is actively blocking traffic;
   *  - **dependency-free** — no scripts and no external assets, because some of
   *    those fetches would themselves be filtered, and a block page that cannot
   *    render is a child who cannot ask;
   *  - **not where the request is filed.** The button hands off to the app via
   *    `ajar://`, and the APP calls POST /v1/requests with its device token.
   *    A page that could file requests on its own would be an unauthenticated
   *    write endpoint reachable by anyone who guesses the URL.
   *
   * The canonical id is computed on the device rather than here, so the app's
   * normalization stays the single source of truth for what "this video" means.
   */
  r.get("/blocked", async (req) => {
    const safe = normalizeBlockedTarget(blockedTargetParam(req));
    const shown = escapeHtml(safe);
    const deepLink = safe ? `ajar://request?u=${encodeURIComponent(safe)}` : "";

    // Who the child is asking. The page is deliberately UNAUTHENTICATED and
    // stateless, so it cannot look a child up — the device passes the label it
    // already holds in its signed snapshot. A child can edit the parameter, and
    // that is fine: it only renames a button on their own screen, grants nothing
    // and reaches no one else.
    //
    // It is still reflected input, so it is constrained to something that can
    // only be a NAME: 24 characters of letters, marks, spaces, apostrophes and
    // hyphens. escapeHtml alone would be enough against markup (verified), but a
    // label is not free-form text and there is no reason to accept 2 KB of it.
    const rawAlly = (req.query.get("ally") ?? "").slice(0, 24).trim();
    const ally = /^[\p{L}\p{M} '’-]{1,24}$/u.test(rawAlly) ? rawAlly : "";
    const named = ally.length > 0;
    // No pronoun anywhere. "she'll get a message" forces a guess the product has
    // no business making and breaks the moment a family picks the generic label;
    // promising the CHILD a fast answer keeps the relatedness and the speed
    // promise without gendering anyone (docs/UX_PRINCIPLES.md §4, §9).
    const askLabel = named ? `Ask ${escapeHtml(ally)}` : "Send request";
    const subhead = named
      ? `Ask ${escapeHtml(ally)} to open it — you’ll hear back right away.`
      : "Send a request — you’ll hear back right away.";

    return html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Blocked</title>
<style>
  /* Values lifted from web/parent/tokens.css, which CI contrast-checks. Inlined
     rather than linked: this page renders inside the content filter's
     remediation view, which loads nothing cross-origin. */
  :root { color-scheme: light dark;
    --bg:#F6F4EE; --surface:#FFFFFF; --surface-2:#EFEDE4; --line:#E3E1D8;
    --field-line:#767468; --ink:#12241F; --ink-2:#3E4F49; --muted:#5C6B64;
    --accent-ink:#0b6355; --accent-wash:#E7F4F1; --yes:#FF8A5B; --yes-ink:#12241F;
    --accent-strong:#0D6D5E; --on-accent:#FFFFFF;
  }
  @media (prefers-color-scheme: dark) { :root {
    --bg:#12211D; --surface:#1A2A26; --surface-2:#223531; --line:#2B3A35;
    --field-line:#7b8d87; --ink:#EAF1EE; --ink-2:#C3D2CC; --muted:#9FB1AA;
    --accent-ink:#5FD3BE; --accent-wash:#1F322D; --yes:#FF8A5B; --yes-ink:#2A1208;
    --accent-strong:#35B7A2; --on-accent:#0B1512;
  } }
  * { box-sizing: border-box; }
  /* "safe center" and not plain "center" (no backticks anywhere in this file's
     CSS comments: it is a template literal). At 200% zoom a centred flex child
     taller than its container overflows in BOTH directions and the top — the
     heading and the ask button — cannot be scrolled back to. "safe" degrades to
     flex-start exactly then. UX_PRINCIPLES §8 records reflow as Done and cites
     the block screens; both extension copies do this and carry the comment, and
     this one, the only block page on the flagship platform, did not. */
  body { margin:0; min-height:100vh; display:flex; align-items:safe center; justify-content:center;
         background:var(--bg); color:var(--ink); padding:24px;
         font:16px/1.5 -apple-system, system-ui, "Segoe UI", Roboto, sans-serif; }
  .card { max-width:32rem; width:100%; }
  /* BRAND.md:247-254 settles the interim mark: the lowercase wordmark in
     accent-ink at 16px/700. It names the exact bug it was fixing — the one
     branded element on the child's screen rendering as small muted grey — and
     this page, which IS the child's screen, had drifted straight back to it.
     The console and both extension block pages have always complied. */
  .mark { display:flex; align-items:center; gap:8px; margin-bottom:32px;
          font-size:16px; font-weight:700; color:var(--accent-ink); }
  h1 { font-size:22px; line-height:1.25; font-weight:600; margin:0 0 12px; }
  .sub { color:var(--ink-2); margin:0 0 24px; }
  .target { background:var(--surface); border:1px solid var(--line); border-radius:14px;
            padding:16px; margin-bottom:24px; }
  .target .name { font-size:18px; font-weight:600; line-height:1.25; word-break:break-word; }
  details { margin-top:12px; }
  /* 44, not 24. UX_PRINCIPLES §8 records 44px targets as Done — one --tap token
     driving every button, input, select and summary; this page shipped the
     WCAG 2.5.8 floor instead, on a control a child taps with a thumb. The flex
     centring keeps the label vertically centred in the taller box. */
  summary { font-size:14px; color:var(--muted); cursor:pointer;
            min-height:44px; display:flex; align-items:center; }
  .url { font:12px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
         color:var(--muted); word-break:break-all; margin-top:8px; }
  /* Coral is FILL ONLY and carries dark ink — white on it measures 2.32:1. */
  /* TEAL, not coral, and this is the brand rule rather than a preference.
     BRAND.md reserves coral for THE YES — the parent's action. This button is
     the child's ASK, which is not a yes, and both extension block pages have
     always drawn it in accent-strong. Three block pages disagreeing on the
     colour of the same control is exactly the variability UX_PRINCIPLES §7 says
     stops the reflex forming; and spending coral here left it meaning two
     different things in one loop.
     No border needed: on-accent on accent-strong is a text pair that clears
     4.5:1 (check-contrast.mjs), unlike white on coral at 2.32:1. */
  .btn { display:flex; align-items:center; justify-content:center; width:100%;
         min-height:52px; background:var(--accent-strong); color:var(--on-accent);
         text-decoration:none;
         border-radius:999px; font-size:16px; font-weight:600; }
  /* --line is documented decorative-only (1.31:1) and this is a real control —
     the child's way back to the page. --field-line is the border token that
     clears 3:1. */
  .btn.again { background:transparent; color:var(--accent-ink); border:1px solid var(--field-line);
               margin-top:12px; }
  .foot { font-size:14px; color:var(--muted); text-align:center; margin:16px 0 0; }
  /* The page defined NO focus rule at all, so every control on it fell back to
     the UA default — on the one screen in the product that is reached by being
     stopped, and in a palette built around a two-tone ring. The two bands are
     the same shape as tokens.css: an inner halo sitting on the control and an
     outer band carrying the perceptibility against the page. */
  :focus-visible { outline:none;
                   box-shadow:0 0 0 2px var(--surface), 0 0 0 5px var(--accent-ink); }
  .note { margin-bottom:16px; }
  .note label { display:block; font-size:14px; color:var(--ink-2); margin-bottom:6px; }
  .note textarea { width:100%; min-height:52px; padding:12px 14px; resize:vertical;
                   background:var(--surface); color:var(--ink); font:inherit; font-size:16px;
                   border:1px solid var(--field-line); border-radius:10px; }
</style></head>
<body><div class="card">
  <div class="mark">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4 21V5a2 2 0 0 1 2-2h7l5 4v14"></path><path d="M13 3v18"></path>
    </svg>
    ajar
  </div>
  ${safe ? `<h1>You can ask to open this page</h1>
  <p class="sub">${subhead}</p>
  <div class="target">
    <div class="name">${shown.replace(/^https?:\/\/(www\.)?/i, "").split("/")[0] || "This page"}</div>
    <details><summary>Details</summary><div class="url">${shown}</div></details>
  </div>
  <div class="note">
    <label for="note">Add a note if you want — like “it’s for homework”</label>
    <textarea id="note" rows="2" maxlength="280" placeholder="A quick note for your parent"></textarea>
  </div>
  <a class="btn" href="${escapeHtml(deepLink)}" id="ask">${askLabel}</a>
  <a class="btn again" href="${shown}" id="again">Try the page again</a>
  <p class="foot">New sites go past a parent first.</p>`
         : `<h1>This page is closed</h1>
  <p class="sub">No address came through, so there is nothing to ask about yet.</p>`}
</div>
${safe ? `<script>
/* Reloading this page should land the child back on the page a parent just
   approved — not on this page again.
 *
 * The block page cannot ASK whether the grant landed. It is unauthenticated and
 * holds no device token, and an endpoint that answered "is this allowed yet?"
 * to anyone who asked would be a policy oracle. It does not need to: navigating
 * to the target puts the question to the filter, which is the only thing whose
 * answer is authoritative. Allowed, the page loads. Still blocked, the filter
 * serves this page again.
 *
 * WHICH IS ALSO THE TRAP. Retrying on every load is an infinite bounce — block
 * page, target, blocked, block page, target. The guard is the navigation TYPE:
 * only a RELOAD retries. The render the filter produces when it blocks a page is
 * a "navigate", and so is the one that comes back from a refused retry, so a
 * reload costs exactly one attempt and can never chain into a second.
 *
 * That also means a child's first block is unchanged — no bounce, no flash, the
 * page and its buttons straight away. Only an explicit refresh, which is a child
 * saying "I think it is unlocked now", spends a navigation on finding out.
 *
 * Inline, and the only script here. The no-scripts rule this page was written
 * under is about FETCHES: an external asset can itself be blocked by the filter
 * that put the child here, and a block page that cannot render is a child who
 * cannot ask. Inline code fetches nothing, so the reason does not apply to it.
 * Everything below degrades to the "Try the page again" button, which needs no
 * script at all.
 */
(function () {
  var target = ${jsonForScript(safe)};
  var reloaded = false;
  try {
    var nav = performance.getEntriesByType("navigation")[0];
    if (nav) reloaded = nav.type === "reload";
    // performance.navigation is deprecated and still the only answer in older
    // WebKit, which is exactly what an older iOS puts this page in.
    else if (performance.navigation) reloaded = performance.navigation.type === 1;
  } catch (e) { /* no timing API: never auto-retry, the button still works */ }
  // replace(), not assign(): a child who taps back should reach where they were
  // before, not walk back through a stack of block pages.
  if (reloaded) location.replace(target);

  /* Carry the note into the app.
   *
   * The Windows and macOS block pages have always collected a reason, and this
   * one did not — so the parent's card quoted nothing for every iOS family, and
   * the quote block on both parent surfaces was dead weight on the flagship
   * platform. The deep link is OURS (unlike the remediation URL the system
   * substitutes into), so a second parameter is safe here; u is kept last
   * anyway, because a reader who has learned that rule for one URL should not
   * have to relearn where it does and does not apply.
   * (No backticks in this comment: it lives inside a template literal.)
   *
   * The href starts out complete and note-less. If this script never runs, the
   * ask still works — it just arrives without the note, which is exactly what
   * happened before the field existed. */
  var ask = document.getElementById("ask");
  var note = document.getElementById("note");
  if (ask && note) {
    var base = ask.getAttribute("href");
    note.addEventListener("input", function () {
      var text = note.value.trim().slice(0, 280);
      ask.setAttribute("href", text
        ? "ajar://request?note=" + encodeURIComponent(text) + "&u=" + encodeURIComponent(target)
        : base);
    });
  }
})();
</script>` : ""}
</body></html>`);
  });
  // Machine-readable API contract (the source of truth clients integrate against).
  r.get("/openapi.json", async () => ok(openapiDocument));

  // --- categorization dataset (lookup + feed import; NOT hardcoded) ---
  // The domain→category classification lives in the datastore behind a provider.
  // These let a parent/ops see how a site is classified and swap the whole
  // dataset for a maintained feed without a code change or redeploy.
  r.get("/v1/categories", async (req) => {
    await requireUser(app, req);
    return ok({ version: await app.categories.version(), categories: await app.categories.listCategories() });
  });
  // The credit the category data's licence requires, served so a public page can
  // render it from the SAME constant the compiled filter set carries. It was
  // only ever inside the signed asset — technically travelling with the data,
  // and visible to nobody. CC BY-SA attribution is a distribution obligation.
  // Public: it is a credit, and gating a credit behind a login defeats it.
  r.get("/v1/categories/attribution", async () => ok(CATEGORY_DATA_ATTRIBUTION));
  r.get("/v1/categories/lookup", async (req) => {
    await requireUser(app, req);
    const host = (req.query.get("host") ?? "").trim();
    if (!host) return err(400, "host query param required", "BAD_REQUEST");
    // Follow the CNAME chain (best-effort) so classification reflects the real
    // destination, not a cloaking first-party alias. `resolve=0` opts out.
    const resolve = req.query.get("resolve") !== "0";
    const chain = resolve ? await app.cnameResolver.resolveChain(host) : [];
    const cats = new Set<string>();
    for (const h of [host, ...chain]) for (const c of await app.categories.lookup(h)) cats.add(c);
    return ok({ host, resolvedHosts: chain, categories: [...cats] });
  });
  // Replace the entire categorization dataset from a feed (ops/admin action —
  // there is no admin role yet, so it requires an authenticated user; restrict
  // this further before production, see docs/SECURITY.md).
  r.put("/v1/categories/dataset", async (req) => {
    await requireUser(app, req);
    // The category dataset is GLOBAL, not family-scoped: any authenticated user
    // could otherwise wipe or poison enforcement for every family on the
    // instance (registration is open). Until there is an admin role this is an
    // ops action gated by a deployment secret, and OFF unless configured.
    const admin = app.categoryAdminToken;
    if (!admin) return err(503, "category dataset import is not enabled on this deployment", "DISABLED");
    if (!(await secretEquals(req.headers["x-admin-token"] ?? "", admin)))
      return err(403, "admin token required", "FORBIDDEN");
    const b = await v.readBody(req, bodies.dataset);
    const version = await app.categories.replace(b.categories);
    return ok({ version, categories: await app.categories.listCategories() });
  });
  // Device-facing: the signed, versioned category Bloom-filter asset. A child
  // device downloads this once, caches it, and queries it locally — no per-URL
  // call, no domain list in the app. `?since=N` returns { upToDate: true } when
  // the device already has the current version.
  r.get("/v1/categories/filters", async (req) => {
    const dev = await requireDevice(app, req);
    const since = Number(req.query.get("since") ?? "-1");
    const asset = await app.policy.categoryFilterAsset(Number.isFinite(since) ? since : -1,
      { familyId: dev.familyId, childId: dev.childId, deviceId: dev.deviceId });
    return ok(asset);
  });

  // --- auth (self-contained passwords, no external IdP) ---
  // Ask to create an account. ALWAYS 202 with an identical body, whether or not
  // the address already has an account — a 201-vs-409 split is a working test for
  // "does this person have an Ajar account?", and the whole point of the
  // verification flow is that the answer goes to the inbox instead. No account
  // exists until the link in that email is opened (see AuthService).
  r.post("/v1/auth/register", async (req) => {
    const capped = limited(authLimiter, req); if (capped) return capped;
    const b = await v.readBody(req, bodies.register);
    await app.auth.requestRegistration(b.email, b.password, b.displayName, { verifyUrlBase: app.verifyUrlBase });
    return ok({ status: "accepted" }, 202);
  });
  // Send (or re-send) a confirmation email for an account that already exists.
  // 202 either way, same as /v1/auth/forgot and for the same reason.
  r.post("/v1/auth/verify/request", async (req) => {
    const capped = limited(authLimiter, req); if (capped) return capped;
    const b = await v.readBody(req, bodies.emailOnly);
    await app.auth.requestEmailVerification(b.email, { verifyUrlBase: app.verifyUrlBase });
    return ok({ status: "accepted" }, 202);
  });
  // Confirm an address with the emailed code. For a sign-up this is where the
  // account actually comes into being, and the parent is signed straight in —
  // they proved the address seconds ago. For an existing account it just records
  // the proof. Single use, one-hour TTL, stored only as a SHA-256 hash.
  r.post("/v1/auth/verify", async (req) => {
    const capped = limited(authLimiter, req); if (capped) return capped;
    const b = await v.readBody(req, bodies.verify);
    const { user, created } = await app.auth.completeVerification(b.token);
    if (!created) return ok({ verified: true, userId: user.id });
    const s = await app.auth.startSession(user.id, deviceLabel(req), REFRESH_TTL);
    return ok({ verified: true, ...(await tokenPair(app, user, s.id)) }, 201);
  });
  // Step ONE of sign-in. The password alone does not produce a session: an
  // account with a passkey enrolled gets back a short-lived `mfa` token and has
  // to finish at /v1/auth/passkeys/login. That token is a different KIND, not a
  // user token with a flag on it, so a route that forgets to check cannot be
  // talked into accepting a password on its own (auth/tokens.ts).
  //
  // An account with NO passkey still gets a full pair, and is told to enrol.
  // Refusing here instead would lock out every account created before enrolment
  // existed, with no way in to fix it — the flag is what the console acts on.
  r.post("/v1/auth/login", async (req) => {
    const capped = limited(authLimiter, req); if (capped) return capped;
    const b = await v.readBody(req, bodies.login);
    const user = await app.auth.authenticate(b.email, b.password);
    const passkeys = await app.passkeys.list(user.id);
    if (passkeys.length > 0) {
      return ok({
        mfaRequired: true,
        methods: ["passkey"],
        mfaToken: await issueToken(app.authSecret, { kind: "mfa", userId: user.id, tv: user.tokenVersion }, MFA_TTL),
        expiresIn: MFA_TTL,
      });
    }
    const s = await app.auth.startSession(user.id, deviceLabel(req), REFRESH_TTL);
    return ok({ ...(await tokenPair(app, user, s.id)), passkeyRequired: true });
  });
  // Exchange a refresh token for a fresh pair (same session). Rejected if the
  // session was revoked (this device) or the user's tokenVersion changed (all).
  r.post("/v1/auth/refresh", async (req) => {
    const capped = limited(authLimiter, req); if (capped) return capped;
    const { refreshToken } = await v.readBody(req, bodies.refresh);
    const p = await verifyToken(app.authSecret, refreshToken);
    if (!p || p.kind !== "refresh") return err(401, "invalid refresh token", "UNAUTHORIZED");
    const { user, sid } = await app.auth.refreshSession(p.userId, p.tv, p.sid);
    return ok(await tokenPair(app, user, sid));
  });
  // Start a password reset. ALWAYS 202, whether or not the address is known —
  // a different status for "no such account" turns this into an account
  // enumeration oracle. The email (if any) is sent out of band.
  r.post("/v1/auth/forgot", async (req) => {
    const capped = limited(authLimiter, req); if (capped) return capped;
    const b = await v.readBody(req, bodies.emailOnly);
    await app.auth.requestPasswordReset(b.email, { resetUrlBase: app.resetUrlBase });
    return ok({ status: "accepted" }, 202);
  });
  // Complete a password reset with the emailed token. Single-use, 30-minute TTL,
  // and it kills every existing session (bumped tokenVersion + revoked sessions)
  // so a reset genuinely locks out whoever prompted it.
  r.post("/v1/auth/reset", async (req) => {
    const capped = limited(authLimiter, req); if (capped) return capped;
    const b = await v.readBody(req, bodies.reset);
    const user = await app.auth.resetPassword(b.token, b.newPassword);
    const s = await app.auth.startSession(user.id, deviceLabel(req), REFRESH_TTL);
    return ok(await tokenPair(app, user, s.id));
  });
  // --- passkeys ------------------------------------------------------------
  //
  // A passkey is the second factor for a parent account, and the reason it is a
  // passkey rather than a six-digit code is that a code can be read out over the
  // phone by someone who has been talked into it. A passkey cannot: it is bound
  // to this origin by the browser, so a convincing copy of our sign-in page on
  // another domain gets nothing, and there is no shared secret for a parent to
  // hand over.
  //
  // Enrolment is required at sign-up. That is deliberately strict, and the
  // reason there is no email-based way around it is that a fallback to "click
  // the link we sent you" makes the second factor exactly as strong as the
  // parent's inbox, which is to say it stops being a second factor. The cost is
  // real — see docs/SECURITY.md on what happens when every passkey is lost.

  /** Step two of sign-in: the challenge, issued against a half-finished login. */
  r.post("/v1/auth/passkeys/login/options", async (req) => {
    const capped = limited(authLimiter, req); if (capped) return capped;
    const user = await mfaPrincipal(app, req);
    return ok(await app.passkeys.loginOptions(user));
  });

  /** Step two of sign-in, completed. This is the only route that turns an `mfa`
   *  token into a session. */
  r.post("/v1/auth/passkeys/login", async (req) => {
    const capped = limited(authLimiter, req); if (capped) return capped;
    const user = await mfaPrincipal(app, req);
    const b = await v.readBody(req, bodies.passkeyLogin);
    await app.passkeys.login(user.id, b.credential);
    const s = await app.auth.startSession(user.id, deviceLabel(req), REFRESH_TTL);
    return ok(await tokenPair(app, user, s.id));
  });

  /** Enrolment options. Needs a real session — the one minted by confirming the
   *  email address at sign-up, or an existing signed-in console. */
  r.post("/v1/me/passkeys/options", async (req) => {
    const userId = await requireUser(app, req);
    const user = await app.repo.getUser(userId);
    if (!user) throw UNAUTH("login required");
    return ok(await app.passkeys.registerOptions({
      id: user.id, email: user.email, displayName: user.displayName,
    }));
  });

  /** Enrolment, completed. */
  r.post("/v1/me/passkeys", async (req) => {
    const userId = await requireUser(app, req);
    const b = await v.readBody(req, bodies.passkeyRegister);
    const cred = await app.passkeys.register(userId, b.credential, b.label);
    return ok(publicPasskey(cred), 201);
  });

  r.get("/v1/me/passkeys", async (req) => {
    const userId = await requireUser(app, req);
    return ok((await app.passkeys.list(userId)).map(publicPasskey));
  });

  // Removing the LAST passkey is refused, not warned about: it is a parent
  // locking themselves out of their children's controls, and the fix (enrol the
  // replacement first) costs them thirty seconds.
  r.del("/v1/me/passkeys/:id", async (req) => {
    const userId = await requireUser(app, req);
    await app.passkeys.remove(userId, req.params.id!);
    return ok({ ok: true });
  });

  /**
   * Close this account. Re-authenticates first — this is the most destructive
   * thing the API can do and a live session on a shared computer is not enough.
   *
   * DELETE with a body is unusual and deliberate: the alternative is a password
   * in the query string, which lands in access logs and browser history.
   */
  r.del("/v1/me", async (req) => {
    const capped = limited(authLimiter, req); if (capped) return capped;
    const userId = await requireUser(app, req);
    const b = await v.readBody(req, bodies.deleteAccount);
    const out = await app.auth.deleteAccount(userId, b.password);
    return ok({ deleted: true, familiesDeleted: out.familiesDeleted });
  });

  // Sign out THIS device (revoke the current session only).
  r.post("/v1/auth/logout", async (req) => {
    const { userId, sid } = await userPrincipal(app, req);
    if (sid) await app.auth.revokeSession(userId, sid);
    return ok({ ok: true });
  });
  // Sign out EVERYWHERE (revoke all sessions + bump tokenVersion).
  r.post("/v1/auth/logout-all", async (req) => {
    const userId = await requireUser(app, req);
    await app.auth.revokeAllSessions(userId);
    return ok({ ok: true });
  });
  // Change password (verifies the current one); revokes all prior sessions and
  // returns a fresh token pair on a new session so the caller stays signed in.
  r.post("/v1/auth/password", async (req) => {
    const { userId } = await userPrincipal(app, req);
    const b = await v.readBody(req, bodies.changePassword);
    const user = await app.auth.changePassword(userId, b.currentPassword, b.newPassword);
    const s = await app.auth.startSession(user.id, deviceLabel(req), REFRESH_TTL);
    return ok(await tokenPair(app, user, s.id));
  });
  // List this user's active sessions (per-device); mark which is the caller's.
  r.get("/v1/me/sessions", async (req) => {
    const { userId, sid } = await userPrincipal(app, req);
    const sessions = await app.auth.listSessions(userId);
    return ok(sessions.map((s) => ({
      id: s.id, label: s.label, createdAt: s.createdAt, lastUsedAt: s.lastUsedAt, current: s.id === sid,
    })));
  });
  // Revoke one session by id (remote sign-out of another device).
  r.del("/v1/me/sessions/:sessionId", async (req) => {
    const userId = await requireUser(app, req);
    await app.auth.revokeSession(userId, req.params.sessionId!);
    return ok({ revoked: true });
  });

  r.get("/v1/me", async (req) => {
    const userId = await requireUser(app, req);
    const user = await app.repo.getUser(userId);
    const memberships = await app.repo.listMembershipsForUser(userId);
    const families = await Promise.all(memberships.map(async (m) => ({
      familyId: m.familyId, role: m.role, family: await app.repo.getFamily(m.familyId),
    })));
    // `emailVerified` is reported, never enforced: every account created before
    // this flow existed is unverified and must keep working (docs/SECURITY.md).
    // It is here so the console can ask, not so the API can refuse.
    return ok({
      userId, email: user?.email, displayName: user?.displayName,
      emailVerified: !!user?.emailVerifiedAt, emailVerifiedAt: user?.emailVerifiedAt, families,
    });
  });

  // --- families ---
  r.post("/v1/families", async (req) => {
    const userId = await requireUser(app, req);
    const { name } = await v.readBody(req, bodies.family);
    return ok(await app.family.createFamily(name, userId), 201);
  });
  r.get("/v1/families/:familyId", async (req) => {
    const userId = await requireUser(app, req);
    await app.family.membership(req.params.familyId!, userId); // authorizes membership
    const fam = await app.repo.getFamily(req.params.familyId!);
    return fam ? ok(fam) : err(404, "not found", "NOT_FOUND");
  });
  // Invite a co-parent/guardian. `email` is the identifier a parent actually
  // knows; `userId` still works for existing integrations. Either way the person
  // must already have an account — this used to accept any string and create a
  // membership pointing at nobody, which showed up as a family member and an
  // approver but could never sign in.
  r.post("/v1/families/:familyId/parents", async (req) => {
    const userId = await requireUser(app, req);
    const b = await v.readBody(req, bodies.addParent);
    if (!b.email && !b.userId) return err(400, "we need the co-parent's email address", "BAD_REQUEST");
    const membership = b.email
      ? await app.family.inviteParentByEmail(req.params.familyId!, userId, b.email, b.role, b.assignedChildIds)
      : await app.family.addParent(req.params.familyId!, userId, b.userId!, b.role, b.assignedChildIds);
    return ok(membership, 201);
  });
  r.post("/v1/families/:familyId/children", async (req) => {
    const userId = await requireUser(app, req);
    const { displayName, timezone } = await v.readBody(req, bodies.addChild);
    return ok(await app.family.addChild(req.params.familyId!, userId, displayName, timezone), 201);
  });
  // Update a child's IANA time zone — what "until the end of the day" is measured in.
  r.put("/v1/families/:familyId/children/:childId", async (req) => {
    const userId = await requireUser(app, req);
    const { timezone } = await v.readBody(req, bodies.setTimezone);
    return ok(await app.family.setChildTimezone(req.params.familyId!, userId, req.params.childId!, timezone));
  });
  // Erase a child and everything attached to them (devices, rules, grants,
  // requests, defaults). Irreversible by design — this is the erasure path.
  r.del("/v1/families/:familyId/children/:childId", async (req) => {
    const userId = await requireUser(app, req);
    await app.family.removeChild(req.params.familyId!, userId, req.params.childId!);
    return ok({ deleted: true });
  });
  r.get("/v1/families/:familyId/children", async (req) => {
    const userId = await requireUser(app, req);
    const visible = await app.family.visibleChildIds(req.params.familyId!, userId);
    const children = await app.repo.listChildren(req.params.familyId!);
    return ok(visible ? children.filter((c) => visible.has(c.id)) : children);
  });
  // Devices with liveness: `lastSeenAt`, the version each one actually pulled,
  // and a `stale` flag. This is how a parent finds out that protection stopped
  // running on a laptop three weeks ago instead of assuming it is fine.
  r.get("/v1/families/:familyId/devices", async (req) => {
    const userId = await requireUser(app, req);
    return ok(await app.devices.listWithStatus(req.params.familyId!, userId));
  });
  r.del("/v1/families/:familyId/devices/:deviceId", async (req) => {
    const userId = await requireUser(app, req);
    await app.devices.remove(req.params.familyId!, userId, req.params.deviceId!);
    return ok({ deleted: true });
  });
  // The audit log is FAMILY-WIDE and its `detail` is free-form, so it cannot be
  // filtered per child with any confidence — an event about one child routinely
  // names another. A LIMITED_GUARDIAN is the deliberately narrow role, so it does
  // not get a log it cannot be safely shown a slice of. Owners and parents do.
  r.get("/v1/families/:familyId/audit", async (req) => {
    const userId = await requireUser(app, req);
    const m = await app.family.membership(req.params.familyId!, userId);
    if (m.role === "LIMITED_GUARDIAN") {
      return err(403, "FORBIDDEN", "this role cannot read the family activity log");
    }
    return ok(await app.repo.listAuditEvents(req.params.familyId!));
  });

  // --- policy ---
  // What a child is on right now. There was a PUT and no GET, so a console had
  // no way to show the control's current value — one reason nothing ever called
  // the setter and every child stayed on the hardcoded posture.
  r.get("/v1/families/:familyId/children/:childId/defaults", async (req) => {
    const userId = await requireUser(app, req);
    return ok(await app.policy.getDefaults(req.params.familyId!, userId, req.params.childId!));
  });
  r.add("PUT" as string, "/v1/families/:familyId/children/:childId/defaults", async (req) => {
    const userId = await requireUser(app, req);
    const d = await v.readBody(req, bodies.defaults);
    await app.policy.setDefaults(req.params.familyId!, userId, req.params.childId!, d);
    return ok({ updated: true });
  });
  r.post("/v1/families/:familyId/rules", async (req) => {
    const userId = await requireUser(app, req);
    const b = await v.readBody(req, bodies.addRule);
    const rule = await app.policy.addRule(req.params.familyId!, userId, {
      target: b.target, value: b.value, action: b.action, priority: b.priority,
      scope: { type: b.scope.type, familyId: req.params.familyId!, childId: b.scope.childId, deviceId: b.scope.deviceId },
    });
    return ok(rule, 201);
  });
  // Live temporary grants, and a way to take one back before it runs out. A
  // permanent decision could always be deleted; a timed one could not, so a
  // misfired "30 minutes" had to be waited out.
  r.get("/v1/families/:familyId/grants", async (req) => {
    const userId = await requireUser(app, req);
    return ok(await app.policy.listActiveGrants(req.params.familyId!, userId));
  });
  r.del("/v1/families/:familyId/grants/:grantId", async (req) => {
    const userId = await requireUser(app, req);
    await app.policy.revokeGrant(req.params.familyId!, userId, req.params.grantId!);
    return ok({ revoked: true });
  });
  r.del("/v1/families/:familyId/rules/:ruleId", async (req) => {
    const userId = await requireUser(app, req);
    await app.policy.removeRule(req.params.familyId!, userId, req.params.ruleId!);
    return ok({ deleted: true });
  });
  r.get("/v1/families/:familyId/rules", async (req) => {
    const userId = await requireUser(app, req);
    const visible = await app.family.visibleChildIds(req.params.familyId!, userId);
    const rules = await app.repo.listRules(req.params.familyId!);
    if (!visible) return ok(rules);
    // Family-wide rules apply to their child too, so they stay. A rule naming
    // another child, or a device belonging to one, does not.
    const devices = await app.repo.listDevices(req.params.familyId!);
    const childOfDevice = new Map(devices.map((d) => [d.id, d.childId]));
    return ok(rules.filter((rule) => {
      if (rule.scope.childId) return visible.has(rule.scope.childId);
      if (rule.scope.deviceId) {
        const owner = childOfDevice.get(rule.scope.deviceId);
        return owner ? visible.has(owner) : false;
      }
      return true;
    }));
  });

  // --- enrollment ---
  r.post("/v1/families/:familyId/enroll", async (req) => {
    const userId = await requireUser(app, req);
    const { childId, platform } = await v.readBody(req, bodies.enroll);
    const tok = await app.enrollment.createToken(req.params.familyId!, userId, childId, platform);
    return ok({ code: tok.code, expiresAt: tok.expiresAt }, 201);
  });
  r.post("/v1/enroll/redeem", async (req) => {
    const capped = limited(enrollLimiter, req); if (capped) return capped;
    const b = await v.readBody(req, bodies.redeem);
    const device = await app.enrollment.redeem(b.code, b.devicePublicKey, b.displayName);
    const token = await issueDeviceToken(app, device);
    return ok({ device, deviceToken: token, expiresIn: DEVICE_TOKEN_TTL, signingPublicKeyB64: app.signingPublicKeyB64 }, 201);
  });

  // --- access requests & approvals ---
  r.post("/v1/requests", async (req) => {
    const dev = await requireDevice(app, req);
    const b = await v.readBody(req, bodies.createRequest);
    const reqRec = await app.approvals.createRequest({
      familyId: dev.familyId, childId: dev.childId, deviceId: dev.deviceId,
      targetType: b.targetType, targetValue: b.targetValue, title: b.title, url: b.url,
      reason: b.reason, referrerHost: b.referrerHost,
    });
    return ok(reqRec, 201);
  });
  r.get("/v1/families/:familyId/requests", async (req) => {
    const userId = await requireUser(app, req);
    const visible = await app.family.visibleChildIds(req.params.familyId!, userId);
    const status = req.query.get("status") ?? undefined;
    // Age out asks nobody answered, before answering. `EXPIRED` has been a
    // published status since the model was written and nothing ever set it, so
    // "Waiting on you" only ever grew.
    await app.approvals.expireStaleRequests(req.params.familyId!);
    const list = await app.repo.listAccessRequests(req.params.familyId!, status);
    return ok(visible ? list.filter((x) => visible.has(x.childId)) : list);
  });
  // Long-poll the pending-request feed: returns the current PENDING list the
  // instant a child files a request or a parent decides one (woken via the hub),
  // or the unchanged list after the timeout. Lets the parent console react in
  // seconds without a tight poll. `count` is the client's current pending size;
  // if it already differs we return immediately. Cross-runtime (no streaming).
  r.get("/v1/families/:familyId/requests/wait", async (req) => {
    const userId = await requireUser(app, req);
    // The feed a LIMITED_GUARDIAN actually watches — filtered like the list
    // above, and for the same reason: an ask carries a URL, a title and the
    // child's own words about why they want it.
    const visible = await app.family.visibleChildIds(req.params.familyId!, userId);
    const forThisUser = (list: AccessRequest[]) =>
      (visible ? list.filter((x) => visible.has(x.childId)) : list);
    const known = Number(req.query.get("count") ?? "-1");
    const timeout = Math.min(Math.max(Number(req.query.get("timeout") ?? "25000"), 0), 60000);
    const deadline = Date.now() + timeout;
    // Return immediately if the pending set already differs from what the client
    // knows; otherwise park until a create/decide wakes us (return the fresh list
    // on any wake, so a simultaneous decide+create that nets to the same length is
    // still delivered) or the deadline passes.
    //
    // `count` is compared against the FILTERED list, so a guardian does not get
    // woken — or told they are out of date — by an ask about a child they cannot
    // see, which would leak its existence through the length alone.
    await app.approvals.expireStaleRequests(req.params.familyId!);
    const pending = forThisUser(await app.repo.listAccessRequests(req.params.familyId!, "PENDING"));
    if (pending.length !== known) return ok({ requests: pending });
    const remaining = deadline - Date.now();
    if (remaining <= 0) return ok({ requests: pending, upToDate: true });
    const woken = await app.hub.wait(`family:${req.params.familyId}`, remaining);
    if (!woken) return ok({ requests: pending, upToDate: true });
    return ok({ requests: forThisUser(await app.repo.listAccessRequests(req.params.familyId!, "PENDING")) });
  });
  r.post("/v1/families/:familyId/requests/:requestId/decide", async (req) => {
    const userId = await requireUser(app, req);
    const b = await v.readBody(req, bodies.decide);
    const out = await app.approvals.decide({
      familyId: req.params.familyId!, requestId: req.params.requestId!, decidedBy: userId,
      decision: b.decision, scope: b.scope, duration: b.duration as ApprovalDuration, policy: app.policy,
    });
    return ok(out);
  });

  // --- device policy sync ---
  r.get("/v1/devices/:deviceId/policy", async (req) => {
    const dev = await requireDevice(app, req);
    if (dev.deviceId !== req.params.deviceId) return err(403, "device mismatch", "FORBIDDEN");
    const since = Number(req.query.get("since") ?? "-1");
    if (Number.isFinite(since) && since >= 0) {
      const snap = await app.policy.syncSince(dev.familyId, dev.childId, dev.deviceId, since);
      // Heartbeat on EVERY poll, including "you're already current" — a device
      // that is up to date is still alive, and that is precisely what the parent
      // needs to see. Record the version it actually holds.
      // Never record a version the device merely CLAIMS: see syncSince's clamp.
      await app.devices.heartbeat(dev.deviceId,
        snap ? snap.version : await app.policy.clampSyncedVersion(dev.deviceId, since));
      return snap ? ok(snap) : ok({ upToDate: true });
    }
    const full = await app.policy.buildSnapshot(dev.familyId, dev.childId, dev.deviceId);
    await app.devices.heartbeat(dev.deviceId, full.version);
    return ok(full);
  });

  /**
   * WHAT THE PARENT ACTUALLY DECIDED, told to the device rather than inferred.
   *
   * THE BUG THIS CLOSES. A refusal writes a temporary BLOCK grant that expires
   * after ONCE_GRANT_TTL_MS (five minutes), and the block pages could only work
   * out "declined" by noticing such a rule in the snapshot — which the policy
   * builder drops as soon as it expires. So a child who was told no saw the
   * answer for five minutes at most and then the page went back to "waiting on
   * a parent", for up to the seven days the ask is remembered. Every honesty
   * fix on those screens has been compensation for this endpoint's absence.
   *
   * Scoped to the DEVICE'S OWN CHILD, never the family: a sibling's refusals are
   * not this device's business, and a device token is not a parent session.
   *
   * `status` is the whole payload beyond identity. Deliberately NOT the scope,
   * the duration, or who decided: the child needs to know they were answered and
   * which way, and the rest is the parent's business. Enforcement still comes
   * from the signed snapshot — this endpoint grants nothing and is not consulted
   * by any filter.
   */
  r.get("/v1/devices/:deviceId/answers", async (req) => {
    const dev = await requireDevice(app, req);
    if (dev.deviceId !== req.params.deviceId) return err(403, "device mismatch", "FORBIDDEN");
    // A window, not the whole history. A block page is asking about something a
    // child asked for minutes or hours ago; a month of decisions is a profile of
    // the child sitting on an endpoint reachable from the device they use.
    const windowMs = 7 * 24 * 3600 * 1000;
    const cutoff = Date.now() - windowMs;
    const all = await app.repo.listAccessRequests(dev.familyId);
    const answers = all
      .filter((r) => r.childId === dev.childId)
      .filter((r) => r.status === "APPROVED" || r.status === "DENIED")
      .filter((r) => Date.parse(r.createdAt) >= cutoff)
      .map((r) => ({
        requestId: r.id,
        targetType: r.targetType,
        targetValue: r.targetValue,
        // "opened" / "closed", not APPROVED/DENIED: this is read by a screen a
        // child looks at, and the product settled on open/closed (BRAND.md §6.1).
        answer: r.status === "APPROVED" ? "opened" : "closed",
        askedAt: r.createdAt,
      }));
    return ok({ answers });
  });

  /**
   * Refresh a device token before it expires. Device tokens last 30 days and had
   * no renewal path at all: on day 31 a child's device stopped syncing policy,
   * silently, and the only recovery was a full re-enrollment by a parent. A
   * device that can still authenticate can mint its successor.
   */
  r.post("/v1/devices/:deviceId/token/refresh", async (req) => {
    const dev = await requireDevice(app, req);
    if (dev.deviceId !== req.params.deviceId) return err(403, "device mismatch", "FORBIDDEN");
    const device = await app.repo.getDevice(dev.deviceId);
    if (!device) return err(404, "unknown device", "NOT_FOUND");
    await app.devices.heartbeat(device.id);
    return ok({
      deviceToken: await issueDeviceToken(app, device),
      expiresIn: DEVICE_TOKEN_TTL,
      signingPublicKeyB64: app.signingPublicKeyB64,
    });
  });

  /**
   * Spend a single-use ("just once") grant. The device calls this the moment it
   * lets the grant through; the grant then disappears from every later snapshot.
   * Without it, `grantKind: "ONCE"` was an unlimited-replay 5-minute window.
   */
  r.post("/v1/devices/:deviceId/grants/:ruleId/consume", async (req) => {
    const dev = await requireDevice(app, req);
    if (dev.deviceId !== req.params.deviceId) return err(403, "device mismatch", "FORBIDDEN");
    const grant = await app.approvals.consumeGrant(dev.deviceId, req.params.ruleId!);
    return ok({ consumed: true, ruleId: grant.id, consumedAt: grant.consumedAt });
  });

  // Long-poll: returns the new signed snapshot the moment an approval bumps the
  // version (woken via the hub), or { upToDate: true } after the timeout. Lets a
  // child pick up an approval in seconds without tight polling. Works on Node and
  // Workers (no streaming). `timeout` ms is capped server-side.
  r.get("/v1/devices/:deviceId/policy/wait", async (req) => {
    const dev = await requireDevice(app, req);
    if (dev.deviceId !== req.params.deviceId) return err(403, "device mismatch", "FORBIDDEN");
    const since = Number(req.query.get("since") ?? "0");
    const timeout = Math.min(Math.max(Number(req.query.get("timeout") ?? "25000"), 0), 60000);
    const deadline = Date.now() + timeout;
    // Wake on this device's nudges; loop to absorb spurious wakes until deadline.
    await app.devices.heartbeat(dev.deviceId, await app.policy.clampSyncedVersion(dev.deviceId, since));
    for (;;) {
      const snap = await app.policy.syncSince(dev.familyId, dev.childId, dev.deviceId, since);
      if (snap) {
        await app.devices.heartbeat(dev.deviceId, snap.version);
        return ok(snap);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return ok({ upToDate: true });
      await app.hub.wait(`device:${dev.deviceId}`, remaining);
    }
  });

  // --- notification endpoints ---
  r.post("/v1/me/endpoints", async (req) => {
    const userId = await requireUser(app, req);
    const b = await v.readBody(req, bodies.endpoint);
    const ep = await app.repo.addNotificationEndpoint({
      id: crypto.randomUUID(), userId, kind: b.kind, token: b.token, createdAt: new Date().toISOString(),
    });
    return ok(ep, 201);
  });

  return r;
}

export type { HttpResponse };
