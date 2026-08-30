/**
 * The safety floor — resources a filter must NEVER block, at any tier.
 *
 * Under a default-deny posture a child who needs a crisis line faces a choice
 * between not getting help and disclosing a dangerous fact about themselves to
 * every approver in the family (an access request fans out to all of them). For
 * a child in an abusive home, or a closeted teen, "ask a parent to unlock it" is
 * not a neutral cost — it can be the thing that stops them asking for help at
 * all. Category feeds are also documented to over-block LGBTQ+ and sexual-health
 * resources, so this cannot be left to the categorizer's discretion.
 *
 * So these hosts resolve to ALLOW *above every other tier* — above device rules,
 * above a temporary block, above default-deny. A parent cannot switch this off;
 * that is deliberate and is published in the product's documentation rather than
 * hidden. It is a floor, not a category.
 *
 * Reaching one of these is NOT reported to parents (see docs/ARCHITECTURE.md
 * §Privacy): a floor that is surveilled is not a floor.
 *
 * Scope discipline: crisis/emergency/public-health only. This list is not a
 * general allowlist and must not grow into one — anything that is merely
 * "useful" belongs in ordinary policy.
 */
export const SAFETY_FLOOR_DOMAINS: string[] = [
  // Crisis & suicide prevention
  "988lifeline.org", "suicidepreventionlifeline.org", "crisistextline.org",
  "befrienders.org", "findahelpline.com", "samaritans.org", "papyrus-uk.org",
  // Youth-specific
  "thetrevorproject.org", "childline.org.uk", "kidshelpphone.ca",
  "childhelphotline.org", "youthline.co.nz",
  // Abuse, assault, trafficking
  "rainn.org", "thehotline.org", "childhelp.org", "humantraffickinghotline.org",
  // Public health authorities
];

/** True if `host` (or a parent domain of it) is on the safety floor. */
export function isSafetyFloorHost(host: string): boolean {
  const h = (host || "").replace(/^www\./i, "").toLowerCase();
  if (!h) return false;
  return SAFETY_FLOOR_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}
