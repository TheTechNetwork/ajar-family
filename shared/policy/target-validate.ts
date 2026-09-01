/**
 * What a CHILD's device is allowed to ask for, and what shape the value must be.
 *
 * WHY THIS EXISTS. `POST /v1/requests` is authenticated by a DEVICE token — the
 * child holds it — and it carried `targetType` and `targetValue` straight
 * through to the rule a parent's approval mints. Nothing in between checked
 * either one. So a child's device could post
 *
 *     { targetType: "URL_PATTERN", targetValue: "*",
 *       title: "Khan Academy — Algebra 1 practice" }
 *
 * the console would show the TITLE as the headline with the real target folded
 * into a collapsed panel, the parent would tap the green button, and the
 * resulting temporary rule — evaluated above every standing rule — allowed the
 * entire web for the grant's lifetime. It beat their explicit DOMAIN blocks,
 * their CATEGORY blocks and a default-deny posture, and it could be renewed on
 * every ask. `{ targetType: "CATEGORY", targetValue: "adult" }` and
 * `{ targetType: "DOMAIN", targetValue: "com" }` were the same move.
 *
 * Two rules follow, and they are separate:
 *
 *   1. A child may only ask about a SPECIFIC THING they hit. URL_PATTERN and
 *      CATEGORY are parent-authoring constructs — ways of describing a class of
 *      pages — and nothing a child bumps into needs one to be named.
 *   2. The value must be the shape its type claims. "*" is not a pattern a child
 *      may send, "com" is not a domain, and a 400-character string is not a
 *      video id.
 *
 * A parent creating a rule directly is a different code path and keeps the full
 * vocabulary. This constrains only what a device may put in front of them.
 */
import type { PolicyTargetType } from "./policy-model.js";

/** Target types a child's device may name in an access request. */
export const CHILD_REQUESTABLE_TARGETS: readonly PolicyTargetType[] = [
  "URL",
  "DOMAIN",
  "YOUTUBE_VIDEO",
  "YOUTUBE_CHANNEL",
  "YOUTUBE_PLAYLIST",
  "APPLICATION",
];

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const CHANNEL_HANDLE_RE = /^@[A-Za-z0-9._-]{1,60}$/;
const CHANNEL_PATH_RE = /^(?:c|user)\/[A-Za-z0-9._-]{1,60}$/;
const PLAYLIST_ID_RE = /^(?:PL|UU|LL|FL|RD|OL|EL)[A-Za-z0-9_-]{10,50}$/;
/** A bundle id / package name: dotted, no spaces. Deliberately permissive. */
const APP_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;

/**
 * A hostname with at least two labels and a plausible TLD.
 *
 * The two-label floor is the same guard `shared/categories` documents for its
 * own lookups: a bare TLD is never a thing a person means to name, and
 * `DOMAIN:"com"` matches every `.com` host in the DOMAIN tier, which does its
 * own suffix match and does not share that guard.
 */
function isPlausibleHost(value: string): boolean {
  if (value.length > 253 || /[\s*/\\@:]/.test(value)) return false;
  const labels = value.split(".");
  if (labels.length < 2) return false;
  if (!/^[a-z]{2,63}$/i.test(labels[labels.length - 1])) return false;
  return labels.every((l) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(l));
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
  } catch {
    return false;
  }
}

/**
 * Is `value` the shape `type` claims, for a request originating on a device?
 *
 * Shape only — it says nothing about whether the thing exists or should be
 * allowed. That is the parent's call, which is the point: they should be
 * deciding about one nameable thing, not about a wildcard wearing a title.
 */
export function isValidChildRequestTarget(type: PolicyTargetType, value: string): boolean {
  if (!CHILD_REQUESTABLE_TARGETS.includes(type)) return false;
  const v = value.trim();
  if (!v || v !== value) return false;

  switch (type) {
    case "URL":
      return v.length <= 2048 && isHttpUrl(v);
    case "DOMAIN":
      return isPlausibleHost(v);
    case "YOUTUBE_VIDEO":
      return VIDEO_ID_RE.test(v);
    case "YOUTUBE_CHANNEL":
      return CHANNEL_ID_RE.test(v) || CHANNEL_HANDLE_RE.test(v) || CHANNEL_PATH_RE.test(v);
    case "YOUTUBE_PLAYLIST":
      return PLAYLIST_ID_RE.test(v);
    case "APPLICATION":
      return APP_ID_RE.test(v);
    default:
      return false;
  }
}

/** Why a target was refused, in words a client can show. */
export function childRequestTargetError(type: PolicyTargetType, value: string): string | null {
  if (isValidChildRequestTarget(type, value)) return null;
  if (!CHILD_REQUESTABLE_TARGETS.includes(type)) {
    return `a device cannot ask about ${type} — only a specific page, site, video, channel, playlist or app`;
  }
  return `${JSON.stringify(value)} is not a valid ${type}`;
}
