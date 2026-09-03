/**
 * Application services: family/roles, enrollment, policy assembly + signed sync,
 * and the access-request → approval → temporary-rule flow. These reproduce the
 * shared evaluation model's inputs; the device runs the shared `evaluate()`.
 */
import { randomUUID } from "node:crypto";
import type { Repository } from "../store/repository.js";
import type { Notifier } from "../push/notifier.js";
import type { MailSender } from "../push/mail.js";
import type { EventHub } from "../push/hub.js";
import { signSnapshot, signCanonical } from "./signing.js";
import { CATEGORY_DATA_ATTRIBUTION, type CategoryFilterSet } from "@ajar/shared/categories";
import type {
  User, Session, Family, FamilyMembership, Child, Device, EnrollmentToken,
  AccessRequest, ApprovalDecision, Role, Platform, ApprovalScope, ApprovalDuration,
  PolicyRule, TemporaryRule, TemporaryGrant, DefaultPolicy, PolicyTargetType, RuleScope,
  NotificationEndpoint, PasswordResetToken, EmailVerificationToken, PendingRegistration,
} from "./model.js";
import type { DevicePolicySnapshot } from "@ajar/shared/policy";
import { childRequestTargetError } from "@ajar/shared/policy/targets";
import type { CategoryProvider } from "../categories/provider.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { endOfLocalDayIso, isValidTimeZone, safeTimeZone } from "./time.js";

const now = () => new Date().toISOString();
const uid = () => randomUUID();

// Enrollment code: 8 chars from a 32-symbol unambiguous alphabet (no 0/O/1/I/L)
// drawn from a CSPRNG => ~40 bits of entropy. With a 15-min TTL and rate-limited
// redemption this is not brute-forceable (vs. the old 6-digit Math.random code).
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function enrollmentCode(len = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i]! & 31];
  return out;
}

/** base64url(SHA-256(x)) — used to store password-reset tokens hashed at rest. */
async function sha256b64url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(new Uint8Array(digest)).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 32 CSPRNG bytes, base64url — ~256 bits, not guessable, safe in a URL. */
function secretToken(bytes = 32): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The body of a confirmation email. Written for a parent: no "token", no
 *  "endpoint", and it says plainly what happens if they ignore it. */
function verifyText(raw: string, urlBase?: string): string {
  const link = urlBase ? `${urlBase}${urlBase.includes("?") ? "&" : "?"}verify=${raw}` : undefined;
  return `Use this code within ${VERIFY_TTL_MINUTES} minutes to confirm this address.\n`
    + "If you did not ask for this, ignore this message — no account has been created "
    + `and nothing has changed.\n\n${raw}`
    + (link ? `\n\n${link}` : "");
}

/** Cheap structural check — we never claim to validate deliverability. */
export function looksLikeEmail(email: unknown): email is string {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

export class DomainError extends Error {
  constructor(message: string, public code = "BAD_REQUEST") { super(message); }
}

// ---------------------------------------------------------------------------
// Auth — self-contained password credentials, no external identity provider.
// ---------------------------------------------------------------------------

/** How long a password-reset token is usable. Short: it is emailed in clear. */
export const RESET_TTL_MINUTES = 30;

/**
 * How long a sign-up or verification link is usable. Also short, and for the
 * same reason — it travels in clear text through an inbox that is often read on
 * a shared screen. Asking again is one form submit and costs the parent nothing,
 * so there is no reason to leave one of these lying around for a day.
 */
export const VERIFY_TTL_MINUTES = 60;

/**
 * Every email this flow sends carries the SAME subject, whether it confirms a
 * new sign-up, tells an existing owner someone tried to reuse their address, or
 * re-sends a confirmation. The mail provider is a third party that can read
 * subject lines (docs/SECURITY.md), and three different subjects would hand it
 * exactly the answer the 202 is there to withhold.
 */
const VERIFY_SUBJECT = "Confirm your email for Ajar";

export class AuthService {
  constructor(private repo: Repository, private notifier?: Notifier, private mail?: MailSender) {}

  /**
   * Create a parent account outright. This is the ACCOUNT-CREATION primitive and
   * is no longer the HTTP registration path: `POST /v1/auth/register` goes
   * through `requestRegistration` + `completeVerification` so that it answers the
   * same whether or not the address is taken. Kept public because creating an
   * account directly is exactly what a test, a seed script or an ops tool wants.
   */
  async register(email: string, password: string, displayName: string,
                 opts: { passwordHash?: string; emailVerifiedAt?: string } = {}): Promise<User> {
    if (!email || !displayName) throw new DomainError("email and displayName required");
    if (!looksLikeEmail(email)) throw new DomainError("a valid email address is required");
    // Generic message (don't confirm which specific field is taken). The HTTP
    // path never surfaces this — it cannot, or register would be an oracle again.
    if (await this.repo.getUserByEmail(email)) throw new DomainError("could not create an account with those details", "CONFLICT");
    const passwordHash = opts.passwordHash ?? await hashPassword(password); // throws on too-short
    const user = await this.repo.createUser({
      id: uid(), email, displayName, passwordHash, tokenVersion: 0,
      emailVerifiedAt: opts.emailVerifiedAt, createdAt: now(),
    });
    // Register the parent's email as a notification endpoint. The original
    // reason — that a family could otherwise run for weeks with every "your
    // child asked for something" fanned out to nobody — no longer applies:
    // asks deliberately do not go by email (see createRequest). What this
    // endpoint carries now is the account lifecycle, which genuinely belongs in
    // an inbox: password resets, and confirming the address itself.
    await this.registerEmailEndpoint(user);
    return user;
  }


  /**
   * Send a message the CALLER is waiting on, turning a delivery failure into an
   * honest 503 instead of an unhandled throw.
   *
   * Live evidence for why this exists: with the sending domain not yet onboarded
   * to Email Service, `POST /v1/auth/register` answered
   * `{"error":"internal error","code":"INTERNAL"}` — a generic 500 that tells a
   * parent nothing and an operator nothing either, for what is a one-line
   * configuration fix. Every route that sent mail 500'd; every route that
   * returned before sending was fine.
   *
   * ONLY for flows where the email IS the deliverable. Notifications stay
   * best-effort and swallowed (docs/SECURITY.md): a child's access request must
   * not fail because the mail provider is down.
   */
  private async sendOrFail(msg: { to: string; subject: string; text: string }): Promise<void> {
    if (!this.mail) return;
    try {
      await this.mail.send(msg);
    } catch (e) {
      // The cause belongs in the log, where it names the real problem
      // (E_SENDER_NOT_VERIFIED means the domain is not onboarded), and never in
      // the response, which would disclose our provider and configuration.
      // eslint-disable-next-line no-console
      console.error("[mail] delivery FAILED on a path that depends on it —"
        + " check MAIL_FROM's domain is onboarded to Email Service:", e);
      throw new DomainError(
        "We could not send the confirmation email just now. Please try again in a few minutes.",
        "SERVICE_UNAVAILABLE",
      );
    }
  }

  /**
   * Send a message NOBODY is waiting on, swallowing any failure.
   *
   * This is not laziness, it is the non-enumeration contract. `requestPasswordReset`
   * and `requestEmailVerification` return early and send nothing for an address
   * that has no account, and always answer 202. If a send failure propagated
   * from those, then while mail was broken 202 would mean "no such account" and
   * 503 would mean "that account exists" — turning an outage into an oracle over
   * every address in the database. So they lose the mail and say nothing, and
   * the operator gets the log.
   *
   * `requestRegistration` is different and uses sendOrFail: BOTH of its branches
   * send, so failing is symmetric and discloses nothing — and a registration
   * that cannot deliver its code has not happened at all.
   */
  private async sendBestEffort(msg: { to: string; subject: string; text: string }): Promise<void> {
    if (!this.mail) return;
    try {
      await this.mail.send(msg);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[mail] delivery failed (swallowed to preserve the always-202 contract):", e);
    }
  }

  /** Idempotently ensure this user has an EMAIL endpoint for their address. */
  async registerEmailEndpoint(user: User): Promise<NotificationEndpoint | null> {
    if (!looksLikeEmail(user.email)) return null;
    const existing = await this.repo.listNotificationEndpoints(user.id);
    const already = existing.find((e) => e.kind === "EMAIL" && e.token === user.email);
    if (already) return already;
    return this.repo.addNotificationEndpoint({
      id: uid(), userId: user.id, kind: "EMAIL", token: user.email, createdAt: now(),
    });
  }

  // --- email verification + non-enumerating sign-up ------------------------

  /**
   * Ask to create an account. ALWAYS resolves, so the caller can answer 202 with
   * one body whatever happened — registering used to answer 201 for a free
   * address and 409 for a taken one, which is a working "does this person have
   * an account here?" oracle for anyone holding a list of addresses.
   *
   * NOTHING is written to `users` here. A free address gets a PendingRegistration
   * (password already hashed, token stored only as its SHA-256) and an email with
   * the link; a taken address gets an email to its owner saying someone tried,
   * and no row at all. So the answer exists only in that inbox — and a squatter
   * cannot park on an address they do not control, because the pending row
   * expires and never stands between the real owner and signing up.
   *
   * Both branches hash the password, read the user table once, and send exactly
   * one message with the same subject, so the coarse timing tell is gone as well.
   */
  async requestRegistration(email: string, password: string, displayName: string,
                            opts: { verifyUrlBase?: string } = {}): Promise<void> {
    if (!looksLikeEmail(email)) throw new DomainError("a valid email address is required");
    if (!displayName) throw new DomainError("a name is required");
    // Deliberately BEFORE the lookup and unconditional: PBKDF2 is by far the most
    // expensive thing on this path, and doing it in only one branch would put the
    // answer straight back into the response time.
    const passwordHash = await hashPassword(password); // throws on too-short
    const existing = await this.repo.getUserByEmail(email);

    if (existing) {
      // The one place the truth is told, and only to the mailbox that owns it.
      await this.sendOrFail({
        to: email,
        subject: VERIFY_SUBJECT,
        text: "Someone asked to create an Ajar account with this address, and it already has one.\n\n"
          + "If that was you, sign in instead — or use \"Forgot password\" if you cannot remember it.\n"
          + "If it was not you, nothing has changed and there is nothing to do.",
      });
      return;
    }

    await this.repo.invalidatePendingRegistrationsForEmail(email, now());
    const raw = secretToken();
    const pending: PendingRegistration = {
      id: uid(), email, displayName, passwordHash, tokenHash: await sha256b64url(raw),
      expiresAt: new Date(Date.now() + VERIFY_TTL_MINUTES * 60_000).toISOString(),
      createdAt: now(),
    };
    await this.repo.createPendingRegistration(pending);
    await this.sendOrFail({ to: email, subject: VERIFY_SUBJECT, text: verifyText(raw, opts.verifyUrlBase) });
  }

  /**
   * Re-send a confirmation for an account that already exists — the path for an
   * alpha parent who registered before any of this existed, and for anyone whose
   * link expired. Silent and always-resolving for the same reason as
   * `requestPasswordReset`: the caller answers 202 either way.
   */
  async requestEmailVerification(email: string, opts: { verifyUrlBase?: string } = {}): Promise<void> {
    const user = looksLikeEmail(email) ? await this.repo.getUserByEmail(email) : null;
    if (!user || user.emailVerifiedAt) return; // nobody to prove it, or nothing to prove
    await this.repo.invalidateEmailVerificationTokensForUser(user.id, now());
    const raw = secretToken();
    const token: EmailVerificationToken = {
      id: uid(), userId: user.id, tokenHash: await sha256b64url(raw),
      expiresAt: new Date(Date.now() + VERIFY_TTL_MINUTES * 60_000).toISOString(),
      createdAt: now(),
    };
    await this.repo.createEmailVerificationToken(token);
    await this.sendBestEffort({ to: user.email, subject: VERIFY_SUBJECT, text: verifyText(raw, opts.verifyUrlBase) });
  }

  /**
   * Redeem a code from either kind of confirmation email. Single-use and
   * TTL-bounded, and any sibling token is burned with it, so a link that was
   * forwarded or sat in a mail archive is dead the moment one of them is used.
   *
   * `created` separates the two outcomes for the caller: a sign-up that has just
   * become an account (the parent is signed straight in — they proved the address
   * seconds ago, and making them retype the password they chose two minutes
   * earlier buys nothing) from an existing account confirming itself.
   */
  async completeVerification(rawToken: string): Promise<{ user: User; created: boolean }> {
    const invalid = () => new DomainError("this confirmation link is invalid or has expired", "UNAUTHORIZED");
    if (typeof rawToken !== "string" || rawToken.length < 16) throw invalid();
    const hash = await sha256b64url(rawToken);
    const live = (rec: { usedAt?: string; expiresAt: string }) => !rec.usedAt && Date.parse(rec.expiresAt) > Date.now();

    const pending = await this.repo.getPendingRegistrationByHash(hash);
    if (pending) {
      if (!live(pending)) throw invalid();
      await this.repo.updatePendingRegistration({ ...pending, usedAt: now() });
      await this.repo.invalidatePendingRegistrationsForEmail(pending.email, now());
      // Someone finished a sign-up for this address in the meantime (or the
      // parent registered twice and opened the older link). Not worth hiding —
      // whoever holds this token holds the inbox.
      if (await this.repo.getUserByEmail(pending.email))
        throw new DomainError("that address already has an account — sign in instead", "CONFLICT");
      const user = await this.register(pending.email, "", pending.displayName,
        { passwordHash: pending.passwordHash, emailVerifiedAt: now() });
      return { user, created: true };
    }

    const token = await this.repo.getEmailVerificationTokenByHash(hash);
    if (!token || !live(token)) throw invalid();
    const user = await this.repo.getUser(token.userId);
    if (!user) throw invalid();
    await this.repo.updateEmailVerificationToken({ ...token, usedAt: now() });
    await this.repo.invalidateEmailVerificationTokensForUser(user.id, now());
    // Already verified is a no-op, not a refusal: two taps on the same link in a
    // mail client must not read as an error to a parent.
    const verified = user.emailVerifiedAt ? user : await this.repo.updateUser({ ...user, emailVerifiedAt: now() });
    await this.registerEmailEndpoint(verified);
    return { user: verified, created: false };
  }

  // --- password reset ------------------------------------------------------

  /**
   * Start a reset. ALWAYS resolves — the caller returns 202 whether or not the
   * address is known, so this endpoint cannot be used to enumerate accounts.
   * The raw token is generated here, emailed, and never stored: only its SHA-256
   * goes to the database, so a dump of `password_reset_tokens` is not a set of
   * account takeovers. Any previously issued token is burned first, so a stolen
   * old email cannot be replayed after the user asks again.
   */
  async requestPasswordReset(email: string, opts: { resetUrlBase?: string } = {}): Promise<void> {
    const user = looksLikeEmail(email) ? await this.repo.getUserByEmail(email) : null;
    if (!user) return; // silent by design
    await this.repo.invalidatePasswordResetTokensForUser(user.id, now());
    const raw = secretToken();
    const token: PasswordResetToken = {
      id: uid(), userId: user.id, tokenHash: await sha256b64url(raw),
      expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000).toISOString(),
      createdAt: now(),
    };
    await this.repo.createPasswordResetToken(token);
    const link = opts.resetUrlBase ? `${opts.resetUrlBase}${opts.resetUrlBase.includes("?") ? "&" : "?"}token=${raw}` : undefined;
    for (const ep of await this.repo.listNotificationEndpoints(user.id)) {
      if (ep.kind !== "EMAIL") continue; // a reset link belongs in an inbox, not a push banner
      await this.notifier?.send(ep, {
        title: "Reset your Ajar password",
        body: `Use this code within ${RESET_TTL_MINUTES} minutes to set a new password. `
          + `If you did not ask for this, ignore this message — nothing has changed.\n\n${raw}`,
        data: { kind: "password_reset", ...(link ? { actionUrl: link } : {}) },
      });
    }
  }

  /**
   * Finish a reset. Single-use, TTL-bounded, and it bumps `tokenVersion` and
   * revokes every session — so if the reset was triggered because the account
   * was compromised, the attacker's tokens die at the same instant.
   */
  async resetPassword(rawToken: string, newPassword: string): Promise<User> {
    const invalid = () => new DomainError("this reset link is invalid or has expired", "UNAUTHORIZED");
    if (typeof rawToken !== "string" || rawToken.length < 16) throw invalid();
    const rec = await this.repo.getPasswordResetTokenByHash(await sha256b64url(rawToken));
    if (!rec || rec.usedAt || Date.parse(rec.expiresAt) <= Date.now()) throw invalid();
    const user = await this.repo.getUser(rec.userId);
    if (!user) throw invalid();
    const passwordHash = await hashPassword(newPassword); // throws on too-short, BEFORE burning the token
    await this.repo.updatePasswordResetToken({ ...rec, usedAt: now() });
    await this.repo.invalidatePasswordResetTokensForUser(user.id, now());
    for (const sess of await this.repo.listSessionsForUser(user.id)) {
      if (!sess.revokedAt) await this.repo.updateSession({ ...sess, revokedAt: now() });
    }
    return this.repo.updateUser({ ...user, passwordHash, tokenVersion: user.tokenVersion + 1 });
  }

  /** Verify email + password. One generic error either way (no user enumeration). */
  async authenticate(email: string, password: string): Promise<User> {
    const user = await this.repo.getUserByEmail(email);
    const okUser = user && (await verifyPassword(password, user.passwordHash));
    if (!user || !okUser) throw new DomainError("invalid email or password", "UNAUTHORIZED");
    return user;
  }

  /** Change password after confirming the current one; bumps tokenVersion so all
   *  other outstanding sessions are revoked. Returns the updated user. */
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<User> {
    const user = await this.repo.getUser(userId);
    if (!user) throw new DomainError("unknown user", "NOT_FOUND");
    if (!(await verifyPassword(currentPassword, user.passwordHash)))
      throw new DomainError("current password is incorrect", "UNAUTHORIZED");
    const passwordHash = await hashPassword(newPassword);
    for (const s of await this.repo.listSessionsForUser(userId)) {
      if (!s.revokedAt) await this.repo.updateSession({ ...s, revokedAt: now() });
    }
    return this.repo.updateUser({ ...user, passwordHash, tokenVersion: user.tokenVersion + 1 });
  }

  /**
   * Close an account and erase what belongs to it.
   *
   * WHY IT EXISTS. An app that lets someone create an account has to let them
   * delete it from inside the app (App Store 5.1.1(v)), and a service holding a
   * record of what a named child was told they could not look at has a stronger
   * reason than the rule. There was no way to do either.
   *
   * WHAT GOES WITH IT — the part that needs a decision rather than a DELETE.
   * A family is not this person's property; it may have another parent in it and
   * children whose devices are enforcing policy right now. So:
   *
   *   - a family where somebody ELSE is also an OWNER survives, minus this
   *     person's membership. Their co-parent keeps the children, the devices and
   *     the rules, and nothing on a child's device changes.
   *   - a family where this person is the last OWNER is erased with them:
   *     children, devices, rules, grants, requests, decisions, enrollment codes
   *     and the audit log. Leaving it would leave a family nobody can administer
   *     and, worse, a record of a specific child's blocked requests belonging to
   *     an account that no longer exists.
   *
   * The devices of an erased family stop being able to authenticate, because
   * every request checks the device row still exists. They keep enforcing the
   * last policy they hold, offline, which is the same thing they do when the
   * network is down — there is no way to reach out and wipe them, and a filter
   * that failed open on deletion would be a worse answer.
   *
   * Re-authentication is required. This is the most destructive thing the API
   * can do, and a live session on a shared computer should not be enough.
   */
  async deleteAccount(userId: string, password: string): Promise<{ familiesDeleted: number }> {
    const user = await this.repo.getUser(userId);
    if (!user) throw new DomainError("unknown user", "NOT_FOUND");
    if (!(await verifyPassword(password, user.passwordHash)))
      throw new DomainError("that password is incorrect", "UNAUTHORIZED");

    let familiesDeleted = 0;
    for (const m of await this.repo.listMembershipsForUser(userId)) {
      if (m.role !== "OWNER") continue;
      const others = await this.repo.listMemberships(m.familyId);
      const anotherOwner = others.some((o) => o.userId !== userId && o.role === "OWNER");
      if (anotherOwner) continue;
      await this.repo.deleteFamilyCascade(m.familyId);
      familiesDeleted += 1;
    }
    await this.repo.deleteUserCascade(userId);
    return { familiesDeleted };
  }

  /** Sign out EVERYWHERE: bump tokenVersion (kills all tokens) and mark every
   *  session record revoked so the session list reflects it. */
  async revokeAllSessions(userId: string): Promise<User> {
    const user = await this.repo.getUser(userId);
    if (!user) throw new DomainError("unknown user", "NOT_FOUND");
    for (const s of await this.repo.listSessionsForUser(userId)) {
      if (!s.revokedAt) await this.repo.updateSession({ ...s, revokedAt: now() });
    }
    return this.repo.updateUser({ ...user, tokenVersion: user.tokenVersion + 1 });
  }

  /** Load a user and confirm the token's version is still current (not revoked). */
  async userForToken(userId: string, tv: number): Promise<User> {
    const user = await this.repo.getUser(userId);
    if (!user || user.tokenVersion !== tv) throw new DomainError("session expired", "UNAUTHORIZED");
    return user;
  }

  // --- per-device sessions -------------------------------------------------

  /** Create a session for a new sign-in; its id (sid) is embedded in the tokens. */
  async startSession(userId: string, label: string, ttlSeconds: number): Promise<Session> {
    const t = now();
    return this.repo.createSession({
      id: uid(), userId, label: (label || "Unknown device").slice(0, 120),
      createdAt: t, lastUsedAt: t, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    });
  }

  /** True if a session is present, not revoked, and not expired. */
  async sessionActive(sid: string): Promise<boolean> {
    const s = await this.repo.getSession(sid);
    return !!s && !s.revokedAt && Date.parse(s.expiresAt) > Date.now();
  }

  /** Validate a refresh: user's tv matches, session live & owned; touch lastUsedAt. */
  async refreshSession(userId: string, tv: number, sid: string | undefined): Promise<{ user: User; sid: string }> {
    const user = await this.userForToken(userId, tv);
    if (!sid) throw new DomainError("session expired", "UNAUTHORIZED"); // pre-session token
    const s = await this.repo.getSession(sid);
    if (!s || s.userId !== userId || s.revokedAt || Date.parse(s.expiresAt) <= Date.now())
      throw new DomainError("session expired", "UNAUTHORIZED");
    await this.repo.updateSession({ ...s, lastUsedAt: now() });
    return { user, sid };
  }

  /** Active (non-revoked, non-expired) sessions for the user. */
  async listSessions(userId: string): Promise<Session[]> {
    const nowMs = Date.now();
    return (await this.repo.listSessionsForUser(userId))
      .filter((s) => !s.revokedAt && Date.parse(s.expiresAt) > nowMs);
  }

  /** Revoke ONE session (this device only). Verifies ownership. */
  async revokeSession(userId: string, sid: string): Promise<void> {
    const s = await this.repo.getSession(sid);
    if (!s || s.userId !== userId) throw new DomainError("unknown session", "NOT_FOUND");
    if (!s.revokedAt) await this.repo.updateSession({ ...s, revokedAt: now() });
  }
}

// ---------------------------------------------------------------------------
// Roles / authorization
// ---------------------------------------------------------------------------

export function canApprove(role: Role): boolean {
  return role === "OWNER" || role === "PARENT" || role === "LIMITED_GUARDIAN";
}
export function canManagePolicy(role: Role): boolean {
  return role === "OWNER" || role === "PARENT";
}
export function canManageParents(role: Role): boolean {
  return role === "OWNER";
}
const ROLES: Role[] = ["OWNER", "PARENT", "LIMITED_GUARDIAN"];

export class FamilyService {
  constructor(private repo: Repository) {}

  async createUser(email: string, displayName: string): Promise<User> {
    const existing = await this.repo.getUserByEmail(email);
    if (existing) return existing;
    return this.repo.createUser({ id: uid(), email, displayName, tokenVersion: 0, createdAt: now() });
  }

  async createFamily(name: string, ownerUserId: string): Promise<Family> {
    const fam = await this.repo.createFamily({ id: uid(), name, createdAt: now() });
    await this.repo.addMembership({
      id: uid(), familyId: fam.id, userId: ownerUserId, role: "OWNER",
      assignedChildIds: [], createdAt: now(),
    });
    await this.audit(fam.id, ownerUserId, "family.created", { name });
    return fam;
  }

  /**
   * Add a co-parent/guardian by USER ID.
   *
   * Everything here used to be taken on trust: an unknown id produced a
   * membership row pointing at nobody, which still showed up in the family's
   * member list and counted as an approver while being an account nobody can
   * ever sign into. A typo'd child id likewise made a LIMITED_GUARDIAN scoped to
   * a child that does not exist. All of it is validated now.
   */
  async addParent(familyId: string, actingUserId: string, newUserId: string, role: Role,
                  assignedChildIds: string[] = []): Promise<FamilyMembership> {
    await this.requireRole(familyId, actingUserId, canManageParents, "manage parents");
    if (!ROLES.includes(role)) throw new DomainError(`unknown role ${String(role)}`);
    if (!newUserId || typeof newUserId !== "string") throw new DomainError("userId or email required");

    const user = await this.repo.getUser(newUserId);
    if (!user) throw new DomainError("no Ajar account with that id — invite them by email instead", "NOT_FOUND");
    if (await this.repo.getMembership(familyId, user.id))
      throw new DomainError("that person is already in this family", "CONFLICT");

    const assigned = [...new Set(assignedChildIds ?? [])];
    for (const childId of assigned) {
      const child = await this.repo.getChild(childId);
      if (!child || child.familyId !== familyId)
        throw new DomainError(`child ${childId} is not in this family`, "NOT_FOUND");
    }
    // Only a LIMITED_GUARDIAN is narrowed to specific children; on OWNER/PARENT
    // an assignment list reads as a restriction that nothing actually enforces.
    if (role !== "LIMITED_GUARDIAN" && assigned.length > 0)
      throw new DomainError("assignedChildIds only applies to LIMITED_GUARDIAN");

    const m = await this.repo.addMembership({
      id: uid(), familyId, userId: user.id, role, assignedChildIds: assigned, createdAt: now(),
    });
    await this.audit(familyId, actingUserId, "family.parent_added", { newUserId: user.id, role });
    return m;
  }

  /**
   * Invite a co-parent by EMAIL — the identifier a parent actually knows.
   *
   * The account must already exist. We deliberately do NOT mint a shell user:
   * a password-less placeholder is an account nobody can sign into that
   * nonetheless holds approval rights over a child, which is exactly the
   * dangling membership this replaces. Inviting a true outsider needs an emailed
   * acceptance token (see docs/SECURITY.md); until that exists we fail with an
   * actionable message rather than pretending the invite landed.
   */
  async inviteParentByEmail(familyId: string, actingUserId: string, email: string, role: Role,
                            assignedChildIds: string[] = []): Promise<FamilyMembership> {
    await this.requireRole(familyId, actingUserId, canManageParents, "manage parents");
    if (!looksLikeEmail(email)) throw new DomainError("a valid email address is required");
    const user = await this.repo.getUserByEmail(email.trim());
    if (!user)
      throw new DomainError("no Ajar account uses that email — ask them to sign up first, then add them", "NOT_FOUND");
    return this.addParent(familyId, actingUserId, user.id, role, assignedChildIds);
  }

  async addChild(familyId: string, actingUserId: string, displayName: string, timezone = "UTC"): Promise<Child> {
    await this.requireRole(familyId, actingUserId, canManagePolicy, "add child");
    if (!displayName) throw new DomainError("displayName required");
    // Reject a bad zone loudly at write time. Storing "PST" and silently falling
    // back to UTC is how "until the end of the day" quietly comes to mean
    // something other than what the parent chose.
    if (!isValidTimeZone(timezone)) throw new DomainError(`unknown IANA time zone: ${String(timezone)}`);
    const child = await this.repo.createChild({
      id: uid(), familyId, displayName, timezone, createdAt: now(),
    });
    // Default posture: default-deny YouTube, default-allow the rest of the web.
    await this.repo.setDefaultPolicy(familyId, child.id, { webDefault: "ALLOW", youTubeDefault: "BLOCK" });
    await this.repo.bumpPolicyVersion(familyId, child.id);
    await this.audit(familyId, actingUserId, "child.added", { childId: child.id, displayName, timezone });
    return child;
  }

  /** Change a child's IANA time zone (moving house, or fixing a bad guess). */
  async setChildTimezone(familyId: string, actingUserId: string, childId: string, timezone: string): Promise<Child> {
    await this.requireRole(familyId, actingUserId, canManagePolicy, "update child");
    const child = await this.repo.getChild(childId);
    if (!child || child.familyId !== familyId) throw new DomainError("unknown child", "NOT_FOUND");
    if (!isValidTimeZone(timezone)) throw new DomainError(`unknown IANA time zone: ${String(timezone)}`);
    const updated: Child = { ...child, timezone };
    await this.repo.createChild(updated); // id-keyed upsert in both stores
    await this.audit(familyId, actingUserId, "child.updated", { childId, timezone });
    return updated;
  }

  /**
   * Erase a child and everything attached to them: devices, their rules,
   * temporary grants, requests, default policy, and any guardian assignment
   * naming them. Before this there was no way to remove a child at all — a
   * product gap and a data-retention problem (a family could not exercise
   * erasure without us running SQL by hand).
   */
  async removeChild(familyId: string, actingUserId: string, childId: string): Promise<void> {
    await this.requireRole(familyId, actingUserId, canManagePolicy, "remove child");
    const child = await this.repo.getChild(childId);
    if (!child || child.familyId !== familyId) throw new DomainError("unknown child", "NOT_FOUND");
    const devices = await this.repo.listDevicesForChild(childId);
    await this.repo.deleteChildCascade(familyId, childId);
    await this.audit(familyId, actingUserId, "child.removed",
      { childId, displayName: child.displayName, devicesRemoved: devices.length });
  }

  async membership(familyId: string, userId: string): Promise<FamilyMembership> {
    const m = await this.repo.getMembership(familyId, userId);
    if (!m) throw new DomainError("not a member of this family", "FORBIDDEN");
    return m;
  }

  /**
   * The children this membership may see. `null` means "every child".
   *
   * LIMITED_GUARDIAN is the deliberately narrow role — a babysitter, a
   * step-parent, an ex-partner — and `model.ts` describes `assignedChildIds` as
   * "the children they may see/act on". `DeviceService.listWithStatus` and
   * `ApprovalService.decide` honoured that; the request feed, the child list,
   * the rule list and the audit log did not, and each of them returned the whole
   * family.
   *
   * That leak was not abstract: an access request carries the URL, the title and
   * the child's own free-text reason for wanting it. A guardian assigned to one
   * child could read every other child's asks, verbatim. Given what the safety
   * floor says about the cost of a child being seen, that is the most sensitive
   * data this product holds.
   */
  async visibleChildIds(familyId: string, userId: string): Promise<Set<string> | null> {
    const m = await this.membership(familyId, userId);
    return m.role === "LIMITED_GUARDIAN" ? new Set(m.assignedChildIds) : null;
  }

  private async requireRole(familyId: string, userId: string,
                            pred: (r: Role) => boolean, action: string) {
    const m = await this.membership(familyId, userId);
    if (!pred(m.role)) throw new DomainError(`role ${m.role} cannot ${action}`, "FORBIDDEN");
    return m;
  }

  private async audit(familyId: string, actorId: string, kind: string, detail: Record<string, unknown>) {
    await this.repo.addAuditEvent({ id: uid(), familyId, actorId, kind, detail, createdAt: now() });
  }
}

// ---------------------------------------------------------------------------
// Enrollment (short-lived, single-use token → device + device keypair)
// ---------------------------------------------------------------------------

export class EnrollmentService {
  constructor(private repo: Repository) {}

  async createToken(familyId: string, actingUserId: string, childId: string,
                    platform: Platform, ttlMinutes = 15): Promise<EnrollmentToken> {
    const m = await this.repo.getMembership(familyId, actingUserId);
    if (!m || !canManagePolicy(m.role)) throw new DomainError("cannot enroll devices", "FORBIDDEN");
    const child = await this.repo.getChild(childId);
    if (!child || child.familyId !== familyId) throw new DomainError("unknown child");
    const code = enrollmentCode(); // crypto-strong, ~40 bits (see below)
    return this.repo.createEnrollmentToken({
      id: uid(), code, familyId, childId, platform,
      expiresAt: new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
      createdBy: actingUserId,
    });
  }

  /** Redeemed by the child device, which supplies the public key it generated. */
  async redeem(code: string, devicePublicKey: string, displayName: string): Promise<Device> {
    const tok = await this.repo.getEnrollmentTokenByCode(code);
    if (!tok) throw new DomainError("invalid code", "NOT_FOUND");
    if (tok.redeemedAt) throw new DomainError("code already used", "GONE");
    if (Date.parse(tok.expiresAt) < Date.now()) throw new DomainError("code expired", "GONE");

    const device = await this.repo.createDevice({
      id: uid(), familyId: tok.familyId, childId: tok.childId, platform: tok.platform,
      displayName, devicePublicKey, enrolledAt: now(), lastSyncedVersion: 0,
    });
    tok.redeemedAt = now();
    await this.repo.updateEnrollmentToken(tok);
    await this.repo.addAuditEvent({
      id: uid(), familyId: tok.familyId, actorId: device.id, kind: "device.enrolled",
      detail: { childId: tok.childId, platform: tok.platform }, createdAt: now(),
    });
    return device;
  }
}

// ---------------------------------------------------------------------------
// Device lifecycle: heartbeat, visibility, erasure
// ---------------------------------------------------------------------------

/** A device silent for longer than this is reported as stale to the parent. */
export const DEVICE_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface DeviceStatus extends Device {
  /** Current policy version for this device's child. */
  currentVersion: number;
  /** True when the device has pulled the current version. */
  upToDate: boolean;
  /** True when we have not heard from the device within DEVICE_STALE_AFTER_MS.
   *  This is the honest answer to "is protection actually running?" — the only
   *  thing the backend can know is whether the device is still talking to it. */
  stale: boolean;
}

export class DeviceService {
  constructor(private repo: Repository) {}

  /**
   * Record that a device contacted us, and what version it took away.
   *
   * `lastSyncedVersion` used to be written once at enrollment and never again,
   * so a device that was uninstalled, blocked by a firewall, or simply switched
   * off looked exactly like a healthy one. Every policy fetch now updates both
   * the version and `lastSeenAt`, which is what makes the parent-facing device
   * list mean something.
   */
  async heartbeat(deviceId: string, syncedVersion?: number): Promise<Device | null> {
    const device = await this.repo.getDevice(deviceId);
    if (!device) return null;
    const next: Device = {
      ...device,
      lastSeenAt: now(),
      // Never move the recorded version backwards (a device may re-request an
      // older `since` while retrying).
      lastSyncedVersion: typeof syncedVersion === "number" && Number.isFinite(syncedVersion)
        ? Math.max(device.lastSyncedVersion, syncedVersion)
        : device.lastSyncedVersion,
    };
    return this.repo.updateDevice(next);
  }

  /** Devices in a family with sync/liveness status, for the parent console. */
  async listWithStatus(familyId: string, actingUserId: string): Promise<DeviceStatus[]> {
    const m = await this.repo.getMembership(familyId, actingUserId);
    if (!m) throw new DomainError("not a member of this family", "FORBIDDEN");
    const devices = await this.repo.listDevices(familyId);
    const visible = m.role === "LIMITED_GUARDIAN"
      ? devices.filter((d) => m.assignedChildIds.includes(d.childId))
      : devices;
    const nowMs = Date.now();
    const versions = new Map<string, number>();
    const out: DeviceStatus[] = [];
    for (const d of visible) {
      if (!versions.has(d.childId)) versions.set(d.childId, await this.repo.getPolicyVersion(familyId, d.childId));
      const currentVersion = versions.get(d.childId)!;
      const seen = d.lastSeenAt ? Date.parse(d.lastSeenAt) : Date.parse(d.enrolledAt);
      out.push({
        ...d, currentVersion,
        upToDate: d.lastSyncedVersion >= currentVersion,
        stale: !Number.isFinite(seen) || nowMs - seen > DEVICE_STALE_AFTER_MS,
      });
    }
    return out;
  }

  /** Erase one device and its device-scoped rules, grants and requests. */
  async remove(familyId: string, actingUserId: string, deviceId: string): Promise<void> {
    const m = await this.repo.getMembership(familyId, actingUserId);
    if (!m || !canManagePolicy(m.role)) throw new DomainError("cannot remove devices", "FORBIDDEN");
    const device = await this.repo.getDevice(deviceId);
    if (!device || device.familyId !== familyId) throw new DomainError("unknown device", "NOT_FOUND");
    await this.repo.deleteDeviceCascade(familyId, deviceId);
    // The child's remaining devices must notice the policy changed underneath.
    await this.repo.bumpPolicyVersion(familyId, device.childId);
    await this.repo.addAuditEvent({
      id: uid(), familyId, actorId: actingUserId, kind: "device.removed",
      detail: { deviceId, childId: device.childId, displayName: device.displayName }, createdAt: now(),
    });
  }
}

// ---------------------------------------------------------------------------
// Policy assembly + signed, versioned sync
// ---------------------------------------------------------------------------

export class PolicyService {
  constructor(
    private repo: Repository,
    private signingPrivateKeyB64: string,
    private categories: CategoryProvider,
  ) {}

  /**
   * The posture a child is on right now.
   *
   * There was a setter and no getter, so the only way to see what a child's
   * defaults were was to build their device's snapshot. A console cannot offer a
   * control it can't show the current value of, which is one reason nothing ever
   * called `setDefaults`.
   */
  async getDefaults(familyId: string, actingUserId: string, childId: string): Promise<DefaultPolicy> {
    const m = await this.repo.getMembership(familyId, actingUserId);
    if (!m) throw new DomainError("not a member of this family", "FORBIDDEN");
    if (m.role === "LIMITED_GUARDIAN" && !m.assignedChildIds.includes(childId)) {
      throw new DomainError("not this guardian's child", "FORBIDDEN");
    }
    return (await this.repo.getDefaultPolicy(familyId, childId))
      ?? { webDefault: "ALLOW", youTubeDefault: "BLOCK" };
  }

  async setDefaults(familyId: string, actingUserId: string, childId: string, d: DefaultPolicy) {
    await this.requireManage(familyId, actingUserId);
    await this.repo.setDefaultPolicy(familyId, childId, d);
    await this.repo.bumpPolicyVersion(familyId, childId);
  }

  async addRule(familyId: string, actingUserId: string, rule: Omit<PolicyRule, "id" | "createdAt" | "createdBy">): Promise<PolicyRule> {
    await this.requireManage(familyId, actingUserId);
    const created = await this.repo.createRule({ ...rule, id: uid(), createdAt: now(), createdBy: actingUserId });
    await this.bumpForScope(familyId, rule.scope);
    return created;
  }

  /**
   * The live grants a parent could still want back.
   *
   * Expired and consumed ones are filtered out here rather than shown greyed:
   * a grant that has run out is not a thing to act on, and a list that mixes
   * "still open" with "over" is a list a parent has to read carefully at the
   * exact moment they are worried.
   */
  async listActiveGrants(familyId: string, actingUserId: string, nowMs = Date.now()) {
    const m = await this.repo.getMembership(familyId, actingUserId);
    if (!m) throw new DomainError("not a member of this family", "FORBIDDEN");
    const visible = m.role === "LIMITED_GUARDIAN" ? new Set(m.assignedChildIds) : null;
    return (await this.repo.listTemporaryRules(familyId))
      .filter((t) => !t.consumedAt && Date.parse(t.expiresAt) > nowMs)
      .filter((t) => !visible || (t.scope.childId ? visible.has(t.scope.childId) : false))
      .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
  }

  /**
   * Take back a live grant before it runs out.
   *
   * THERE WAS NO WAY TO DO THIS. A permanent decision could be deleted, but a
   * timed one could not — the console said so in a comment and shrugged. So a
   * parent who tapped "30 minutes" by accident, or approved something and then
   * learned more about it, had to wait it out. The moment a parent most wants a
   * control is the moment they realise they got it wrong.
   *
   * Deleted, not marked consumed: "consumed" means a ONCE grant was spent, and
   * reusing it here would make the audit log say the child used something they
   * never opened.
   */
  async revokeGrant(familyId: string, actingUserId: string, grantId: string): Promise<void> {
    await this.requireManage(familyId, actingUserId);
    const grant = (await this.repo.listTemporaryRules(familyId)).find((t) => t.id === grantId);
    if (!grant) throw new DomainError("unknown grant", "NOT_FOUND");
    await this.repo.deleteTemporaryRule(familyId, grantId);
    // Devices must find out. Without this the child keeps the grant until their
    // next full sync, which is exactly the window a parent is trying to close.
    await this.bumpForScope(familyId, grant.scope);
    await this.repo.addAuditEvent({
      id: uid(), familyId, actorId: actingUserId, kind: "grant.revoked",
      detail: { grantId, target: grant.target, value: grant.value, childId: grant.scope.childId },
      createdAt: now(),
    });
  }

  async removeRule(familyId: string, actingUserId: string, ruleId: string) {
    await this.requireManage(familyId, actingUserId);
    await this.repo.deleteRule(familyId, ruleId);
    for (const child of await this.repo.listChildren(familyId))
      await this.repo.bumpPolicyVersion(familyId, child.id);
  }

  /** Build + sign the snapshot for one child+device at the current version. */
  async buildSnapshot(familyId: string, childId: string, deviceId: string): Promise<DevicePolicySnapshot> {
    const defaults = (await this.repo.getDefaultPolicy(familyId, childId))
      ?? { webDefault: "ALLOW", youTubeDefault: "BLOCK" };
    const nowMs = Date.now();
    const rules = (await this.repo.listRules(familyId))
      .filter((r) => this.appliesToChildDevice(r.scope, childId, deviceId));
    const temporaryRules = (await this.repo.listTemporaryRules(familyId))
      .filter((t) => this.appliesToChildDevice(t.scope, childId, deviceId))
      .filter((t) => Date.parse(t.expiresAt) > nowMs) // drop already-expired
      // A "just once" grant the device reported as used is gone from every
      // subsequent snapshot — that is what makes ONCE single-use rather than an
      // unlimited-replay window (see ApprovalService.consumeGrant).
      .filter((t) => !t.consumedAt)
      // Ship the SHARED TemporaryRule shape: `consumedAt` is server-side state
      // and must not appear in the signed payload devices verify.
      .map(({ consumedAt: _consumed, ...rule }): TemporaryRule => rule);
    const version = await this.repo.getPolicyVersion(familyId, childId);

    // Inline ONLY the categories this policy actually enforces (referenced by a
    // CATEGORY rule, standing or temporary), sourced from the datastore-backed
    // provider — not a hardcoded map, and bounded to what this device needs.
    const activeCategories = [...new Set(
      [...rules, ...temporaryRules]
        .filter((r) => r.target === "CATEGORY")
        .map((r) => r.value),
    )];
    const categories = activeCategories.length > 0
      ? await this.categories.categoryMap(activeCategories)
      : undefined;

    const unsigned: DevicePolicySnapshot = {
      version, familyId, childId, deviceId, defaults, rules, temporaryRules,
      ...(categories ? { categories } : {}),
      issuedAt: now(), signature: "",
    };
    unsigned.signature = await signSnapshot(unsigned, this.signingPrivateKeyB64);
    return unsigned;
  }

  /** Incremental sync: null when the device is already current. */
  async syncSince(familyId: string, childId: string, deviceId: string, sinceVersion: number):
    Promise<DevicePolicySnapshot | null> {
    const version = await this.repo.getPolicyVersion(familyId, childId);
    // CLAMP THE DEVICE'S CLAIM. `since` is an unbounded number from the child's
    // device. Unclamped, `?since=999999999` made `version <= sinceVersion` true
    // forever: the device was told "up to date" and never received another
    // policy, while `DeviceService.heartbeat` stored 999999999 as the version it
    // held — behind a `Math.max` that never moves backwards, so it was
    // permanent. The console then showed that device green, "up to date",
    // "protection running", for the rest of its life, and every new block the
    // parent added went nowhere. Both halves of the lie came from one
    // unvalidated query parameter.
    const claimed = await this.clampSyncedVersion(deviceId, sinceVersion);
    if (version <= claimed) return null;
    return this.buildSnapshot(familyId, childId, deviceId);
  }

  /**
   * What a device may legitimately claim to hold.
   *
   * Never MORE than the server has actually sent it — that is the whole point.
   * A device reporting LESS is honest and useful (it lost its cache and wants a
   * full snapshot), so downward claims pass through; upward ones are the attack
   * and are clamped to the server's own record.
   */
  async clampSyncedVersion(deviceId: string, claimed: number): Promise<number> {
    const device = await this.repo.getDevice(deviceId);
    const ceiling = device?.lastSyncedVersion ?? 0;
    const asked = Number.isFinite(claimed) ? claimed : 0;
    return Math.min(Math.max(asked, 0), ceiling);
  }

  /**
   * The compact category-membership asset a device downloads and caches
   * separately from its policy: per-category Bloom filters, signed with the same
   * key as snapshots and versioned so the device only re-fetches on change. This
   * is what lets a client enforce "block all social" over a huge domain set with
   * no per-URL backend call and no multi-megabyte domain list in the app.
   */
  async categoryFilterAsset(since?: number, scope?: { familyId: string; childId: string; deviceId: string }):
    Promise<{ upToDate: true } | { set: CategoryFilterSet; signature: string }> {
    const version = await this.categories.version();
    if (since !== undefined && since >= 0 && version <= since) return { upToDate: true };

    // Ship ONLY the categories this device's policy actually enforces. Sending
    // every category is worse twice over: the download and the resident memory
    // grow with categories the family never selected (an iOS Network Extension
    // is jetsam-killed around 50MB), and every extra filter compounds the
    // false-positive rate — each spurious hit is a real block the child has to
    // ask their way out of. A family enforcing one category should carry one.
    const enforced = scope ? await this.enforcedCategories(scope) : undefined;
    if (enforced && enforced.length === 0) {
      const empty = { version, filters: {}, attribution: CATEGORY_DATA_ATTRIBUTION };
      return { set: empty, signature: await signCanonical(empty, this.signingPrivateKeyB64) };
    }
    const set = await this.categories.compileFilters(enforced);
    const signature = await signCanonical(set, this.signingPrivateKeyB64);
    return { set, signature };
  }

  /** Category slugs named by any rule that applies to this child+device. */
  private async enforcedCategories(scope: { familyId: string; childId: string; deviceId: string }): Promise<string[]> {
    const applies = (s: RuleScope) => this.appliesToChildDevice(s, scope.childId, scope.deviceId);
    const rules = (await this.repo.listRules(scope.familyId)).filter((r) => applies(r.scope));
    const temps = (await this.repo.listTemporaryRules(scope.familyId)).filter((t) => applies(t.scope));
    return [...new Set([...rules, ...temps].filter((r) => r.target === "CATEGORY").map((r) => r.value))];
  }

  private appliesToChildDevice(scope: RuleScope, childId: string, deviceId: string): boolean {
    if (scope.childId && scope.childId !== childId) return false;
    if (scope.deviceId && scope.deviceId !== deviceId) return false;
    return true;
  }

  private async bumpForScope(familyId: string, scope: RuleScope) {
    if (scope.childId) { await this.repo.bumpPolicyVersion(familyId, scope.childId); return; }
    for (const child of await this.repo.listChildren(familyId))
      await this.repo.bumpPolicyVersion(familyId, child.id);
  }

  private async requireManage(familyId: string, userId: string) {
    const m = await this.repo.getMembership(familyId, userId);
    if (!m || !canManagePolicy(m.role)) throw new DomainError("cannot manage policy", "FORBIDDEN");
  }
}

// ---------------------------------------------------------------------------
// Access requests → approvals → temporary/standing rules
// ---------------------------------------------------------------------------

/** Outer bound on an unconsumed "just once" grant. See ApprovalService.consumeGrant. */
/**
 * The referring host, cleaned up, or nothing.
 *
 * DISPLAY ONLY — see `AccessRequest.referrerHost`. It never reaches the
 * evaluator and never widens a rule; the only thing riding on this function is
 * whether a parent is shown a plausible hostname or nothing at all.
 *
 * Anything that is not a plausible host is DROPPED rather than shown. A device
 * that sends junk, a full URL, or a sentence gets no referrer line — which is
 * the honest outcome, because a parent reading "from <something odd>" would be
 * being told something the product cannot stand behind. Accepts a full URL too,
 * since a client sending `document.referrer` verbatim is the obvious mistake to
 * absorb rather than punish.
 */
export function normalizeReferrerHost(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let v = raw.trim();
  if (!v) return undefined;
  // A client that sent the whole referrer: take its host and drop the rest,
  // which is the part we deliberately do not carry.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
    try { v = new URL(v).hostname; } catch { return undefined; }
  }
  v = v.replace(/\.$/, "").replace(/^www\./i, "").toLowerCase();
  if (v.length > 253 || v.length === 0) return undefined;
  const labels = v.split(".");
  if (labels.length < 2) return undefined;                       // no bare TLDs, no "localhost"
  if (!/^[a-z]{2,63}$/.test(labels[labels.length - 1]!)) return undefined;
  if (!labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return undefined;
  return v;
}

export const ONCE_GRANT_TTL_MS = 5 * 60_000;

/**
 * How long an unanswered ask stays worth answering.
 *
 * `AccessRequestStatus` has declared "EXPIRED" since the model was written, and
 * `GET .../requests?status=EXPIRED` is published in the OpenAPI — and NOTHING
 * EVER SET IT. There is no sweeper and no TTL, so an ask stayed PENDING for
 * ever: the console's "Waiting on you" list only grew, filling with things a
 * child wanted three weeks ago and has long since stopped caring about, and the
 * count beside it stopped meaning anything.
 *
 * The child's side already gives up honestly — the iOS app after ~10 minutes,
 * the block pages on their own timer — so the ask a parent is looking at was
 * already abandoned on the other end. Three days is long enough that a parent
 * away for a weekend still sees it, and short enough that the list is about now.
 */
export const REQUEST_EXPIRES_AFTER_MS = 3 * 24 * 60 * 60_000;

/**
 * Turn a duration into a concrete expiry, in the CHILD's time zone.
 *
 * `timeZone` matters for exactly one case and it is the case parents pick most:
 * UNTIL_END_OF_DAY. This used to be `setUTCHours(23,59,59,999)`, i.e. UTC
 * midnight — 5pm in California, 9am the next morning in Sydney. The parent chose
 * "until bedtime" and the child was cut off after school, or handed most of a
 * second day. Now it is the last millisecond of the child's own calendar day
 * (DST-aware, via Intl — see domain/time.ts).
 */
export function durationToExpiry(
  d: ApprovalDuration, timeZone = "UTC", from = Date.now(),
): { expiresAt?: string; standing: boolean } {
  switch (d?.kind) {
    case "ALWAYS": return { standing: true };
    // Backstop only: a ONCE grant normally ends when the device reports it used.
    case "ONCE": return { expiresAt: new Date(from + ONCE_GRANT_TTL_MS).toISOString(), standing: false };
    case "MINUTES": {
      // Validated, not trusted: `minutes` arrives as JSON from a parent client.
      // NaN or Infinity would produce an Invalid Date whose toISOString() throws,
      // and a negative value would mint a grant that expired before it existed.
      if (typeof d.minutes !== "number" || !Number.isFinite(d.minutes) || d.minutes <= 0) {
        throw new DomainError("approval duration MINUTES needs a positive number of minutes", "BAD_REQUEST");
      }
      return { expiresAt: new Date(from + d.minutes * 60_000).toISOString(), standing: false };
    }
    case "UNTIL_END_OF_DAY": return { expiresAt: endOfLocalDayIso(from, timeZone), standing: false };
    default:
      // TypeScript's exhaustiveness check does not reach the HTTP boundary: the
      // body is untrusted JSON. Without this the switch fell through returning
      // undefined, and the caller's `const { expiresAt, standing } = ...`
      // destructure threw a TypeError that surfaced to the parent as
      // "Cannot destructure property 'expiresAt' of ... as it is undefined" —
      // an internal message for what is simply a malformed request. Observed
      // against the live deployment by sending `"duration":"FOREVER"` (a bare
      // string where the API takes `{ kind }`).
      throw new DomainError(
        `unknown approval duration: ${JSON.stringify((d as { kind?: unknown } | undefined)?.kind ?? d)}`,
        "BAD_REQUEST");
  }
}

/**
 * The narrowest-useful approval scope for what the child actually asked for.
 *
 * This MUST be derived from the request. A THIS_VIDEO grant becomes a
 * YOUTUBE_VIDEO rule whose value is matched against a canonical video id, so
 * applying it to a DOMAIN/CATEGORY/URL request mints a rule that can never
 * match: the parent is told "unlocked" and the child stays blocked.
 *
 * Note CATEGORY: a child blocked by "all social media" is granted THIS site,
 * never the whole category — say yes to the thing asked for, nothing wider.
 */
export function defaultScopeFor(targetType: PolicyTargetType): ApprovalScope {
  switch (targetType) {
    case "YOUTUBE_VIDEO": return "THIS_VIDEO";
    case "YOUTUBE_CHANNEL": return "THIS_CHANNEL";
    case "URL":
    case "URL_PATTERN": return "THIS_URL";
    case "DOMAIN":
    case "CATEGORY": return "THIS_DOMAIN";
    default: return "THIS_CHILD"; // YOUTUBE_PLAYLIST, APPLICATION: grant exactly the target
  }
}

/**
 * Scopes that can produce a rule that ACTUALLY MATCHES this request. Offering a
 * scope outside this set is how "approved" silently fails to unblock: e.g.
 * THIS_CHANNEL on a video request would build YOUTUBE_CHANNEL:<video id>, and a
 * channel rule is never compared against a video id.
 */
export function applicableScopes(req: AccessRequest): ApprovalScope[] {
  const out: ApprovalScope[] = [];
  if (req.targetType === "YOUTUBE_VIDEO") out.push("THIS_VIDEO");
  if (req.targetType === "YOUTUBE_CHANNEL") out.push("THIS_CHANNEL");
  if (req.url) out.push("THIS_URL");
  if (hostOf(req)) out.push("THIS_DOMAIN");
  // These re-use the request's own target verbatim, so they always match.
  out.push("THIS_REQUEST", "THIS_DEVICE", "THIS_CHILD", "WHOLE_FAMILY");
  return out;
}

function hostOf(req: AccessRequest): string {
  if (req.targetType === "DOMAIN") return req.targetValue;
  try { return req.url ? new URL(req.url).hostname.replace(/^www\./, "") : ""; } catch { return ""; }
}

/** Map an approval scope + the request onto a concrete (target, rule scope). */
export function mapScope(req: AccessRequest, scope: ApprovalScope):
  { targetType: PolicyTargetType; targetValue: string; ruleScope: Omit<RuleScope, "type"> & { type: RuleScope["type"] } } {
  if (!applicableScopes(req).includes(scope)) {
    // Fail loudly instead of creating a rule the evaluator can never match.
    throw new DomainError(
      `approval scope ${scope} does not apply to a ${req.targetType} request`, "BAD_REQUEST");
  }
  const familyScope = { type: "FAMILY" as const, familyId: req.familyId };
  const childScope = { type: "CHILD" as const, familyId: req.familyId, childId: req.childId };
  const deviceScope = { type: "DEVICE" as const, familyId: req.familyId, childId: req.childId, deviceId: req.deviceId };
  const host = hostOf(req);

  switch (scope) {
    case "THIS_URL":
      return { targetType: "URL", targetValue: req.url ?? req.targetValue, ruleScope: childScope };
    case "THIS_VIDEO":
      return { targetType: "YOUTUBE_VIDEO", targetValue: req.targetValue, ruleScope: childScope };
    case "THIS_CHANNEL":
      return { targetType: "YOUTUBE_CHANNEL", targetValue: req.targetValue, ruleScope: childScope };
    case "THIS_DOMAIN":
      return { targetType: "DOMAIN", targetValue: host || req.targetValue, ruleScope: childScope };
    case "THIS_DEVICE":
      return { targetType: req.targetType, targetValue: req.targetValue, ruleScope: deviceScope };
    case "THIS_CHILD":
      return { targetType: req.targetType, targetValue: req.targetValue, ruleScope: childScope };
    case "WHOLE_FAMILY":
      return { targetType: req.targetType, targetValue: req.targetValue, ruleScope: familyScope };
    case "THIS_REQUEST":
    default:
      return { targetType: req.targetType, targetValue: req.targetValue, ruleScope: deviceScope };
  }
}

export class ApprovalService {
  constructor(private repo: Repository, private notifier: Notifier, private hub?: EventHub) {}

  /** Called by the child device when it hits blocked content. */
  async createRequest(input: {
    familyId: string; childId: string; deviceId: string;
    targetType: PolicyTargetType; targetValue: string; title?: string; url?: string; reason?: string;
    referrerHost?: string;
  }): Promise<AccessRequest> {
    const device = await this.repo.getDevice(input.deviceId);
    if (!device || device.familyId !== input.familyId || device.childId !== input.childId)
      throw new DomainError("device/child mismatch", "FORBIDDEN");

    // THE TARGET IS THE CHILD'S INPUT, and it becomes the rule a parent's tap
    // mints. This route is authenticated by a DEVICE token, so both fields cross
    // the trust boundary from the person the product exists to constrain, and
    // nothing used to check either one.
    //
    // A device could post { targetType: "URL_PATTERN", targetValue: "*" } under
    // a title like "Khan Academy — Algebra 1 practice". The console shows the
    // title as the headline with the real target inside a collapsed panel; the
    // parent taps the green button; the temporary rule that appears is evaluated
    // ABOVE every standing rule, so for the grant's lifetime the entire web was
    // open — over their explicit domain blocks, their category blocks and a
    // default-deny posture — and it could be renewed on every ask.
    // { "CATEGORY", "adult" } and { "DOMAIN", "com" } were the same move.
    //
    // Enforced here rather than at the route so it holds for every caller, and
    // it constrains only what a DEVICE may put in front of a parent: a parent
    // authoring a rule directly keeps the full vocabulary.
    const targetError = childRequestTargetError(input.targetType, input.targetValue);
    if (targetError) throw new DomainError(targetError);

    // DEDUPE. A blocked page in a browser is not one request: the child reloads,
    // the page retries its sub-resources, a tab restores on wake. Each of those
    // used to mint a fresh AccessRequest AND a fresh notification to every
    // parent, so a single blocked site could bury the console (and a parent's
    // inbox) under dozens of identical rows — and the parent then had to decide
    // each one. An identical still-PENDING ask is the SAME ask: return it.
    const duplicate = (await this.repo.listAccessRequests(input.familyId, "PENDING")).find(
      (r) => r.childId === input.childId && r.deviceId === input.deviceId
        && r.targetType === input.targetType && r.targetValue === input.targetValue,
    );
    if (duplicate) {
      // A later re-file often carries better context than the first bare one
      // (the page title arrives after the block). Keep the richer version, but
      // never notify again and never create a second row.
      const enriched = {
        ...duplicate,
        title: duplicate.title ?? input.title,
        url: duplicate.url ?? input.url,
        reason: duplicate.reason ?? input.reason,
        // FIRST referrer wins, like the rest of this block. A re-file after the
        // child has wandered elsewhere would otherwise rewrite where they were
        // when they hit it, which is the one thing this field is for.
        referrerHost: duplicate.referrerHost ?? normalizeReferrerHost(input.referrerHost),
      };
      const changed = enriched.title !== duplicate.title || enriched.url !== duplicate.url
        || enriched.reason !== duplicate.reason || enriched.referrerHost !== duplicate.referrerHost;
      if (changed) await this.repo.updateAccessRequest(enriched);
      return enriched;
    }

    const req = await this.repo.createAccessRequest({
      id: uid(), familyId: input.familyId, childId: input.childId, deviceId: input.deviceId,
      targetType: input.targetType, targetValue: input.targetValue,
      title: input.title, url: input.url, reason: input.reason,
      referrerHost: normalizeReferrerHost(input.referrerHost),
      status: "PENDING", createdAt: now(),
    });
    await this.repo.addAuditEvent({
      id: uid(), familyId: req.familyId, actorId: input.deviceId, kind: "request.created",
      detail: { requestId: req.id, target: `${input.targetType}:${input.targetValue}` }, createdAt: now(),
    });
    // Notify all authorized parents (OWNER/PARENT, and LIMITED_GUARDIANs assigned this child).
    const child = await this.repo.getChild(input.childId);
    for (const m of await this.repo.listMemberships(input.familyId)) {
      if (!canApprove(m.role)) continue;
      if (m.role === "LIMITED_GUARDIAN" && !m.assignedChildIds.includes(input.childId)) continue;
      for (const ep of await this.repo.listNotificationEndpoints(m.userId)) {
        // An ask belongs in a push, not an inbox — the exact inverse of the rule
        // on the password-reset path below, and for the same reason: the medium
        // has to match the message.
        //
        // The product promise is "say yes faster", measured in seconds, before
        // the impulse wins. Email is the wrong instrument for that at every
        // level: it lands in a pile, it has no receipt, it arrives whenever the
        // provider gets to it, and one email per ask turns a busy afternoon into
        // an inbox a parent stops reading — which is the same as no notification
        // at all, only noisier.
        //
        // It also coupled the CORE LOOP to a mail provider. That is not
        // hypothetical: an unverified sending domain made a child's "Ask to
        // unlock" return 500. A request path that never touches mail cannot fail
        // that way at all, which is a better fix than catching the error.
        //
        // The real-time channel is the hub notify below, which every parent
        // client already long-polls. APNs and Web Push are the transports that
        // reach a parent whose client is closed; they are documented adapters,
        // not implemented (docs/SECURITY.md), so until they land a parent is
        // reached while a client is open and not otherwise. That gap is worth
        // naming honestly — it is not worth papering over with email.
        if (ep.kind === "EMAIL") continue;
        await this.notifier.send(ep, {
          title: `${child?.displayName ?? "Your child"} requested access`,
          body: input.title ?? `${input.targetType} ${input.targetValue}`,
          data: { requestId: req.id, kind: "access_request" },
        });
      }
    }
    // Wake any parent long-poll waiting on this family's pending-request feed.
    this.hub?.notify(`family:${input.familyId}`);
    return req;
  }

  /**
   * Spend a single-use ("just once") grant. Called by the child's device the
   * moment it actually lets the grant through.
   *
   * WHY THIS EXISTS — and why the option kept its name. `grantKind: "ONCE"` was
   * decorative: it produced an ordinary 5-minute temporary rule with unlimited
   * replays inside the window, so "just once" meant "as many times as you like
   * for five minutes". The two honest options were to rename the option or to
   * make it real. Renaming was not available to this change: `grantKind` is part
   * of the SHARED policy contract (`shared/policy/policy-model.ts`) that the
   * Apple, Windows and extension adapters all compile against, and that file is
   * owned elsewhere — a rename there would be a cross-platform breaking change
   * landed unilaterally. So it is real instead: the device reports consumption,
   * the grant is marked spent server-side, the policy version bumps, and it is
   * dropped from every snapshot thereafter.
   *
   * RESIDUAL RISK, stated plainly: consumption is CLIENT-ATTESTED. A device that
   * never reports keeps the grant until the 5-minute TTL expires, so the TTL
   * remains the real backstop and "once" is best-effort against a cooperating
   * device, not a hostile one. Enforcing it against a hostile client would need
   * the device to hold no usable grant at all until it asks per-load, which
   * breaks offline enforcement — the product's core requirement. Documented in
   * docs/SECURITY.md.
   */
  async consumeGrant(deviceId: string, ruleId: string): Promise<TemporaryGrant> {
    const device = await this.repo.getDevice(deviceId);
    if (!device) throw new DomainError("unknown device", "NOT_FOUND");
    const grant = await this.repo.getTemporaryRule(ruleId);
    if (!grant || grant.scope.familyId !== device.familyId) throw new DomainError("unknown grant", "NOT_FOUND");
    // Only the child/device the grant actually applies to may spend it.
    if (grant.scope.childId && grant.scope.childId !== device.childId)
      throw new DomainError("grant does not apply to this device", "FORBIDDEN");
    if (grant.scope.deviceId && grant.scope.deviceId !== deviceId)
      throw new DomainError("grant does not apply to this device", "FORBIDDEN");
    if (grant.grantKind !== "ONCE")
      throw new DomainError("only a single-use grant can be consumed", "BAD_REQUEST");
    if (grant.consumedAt) throw new DomainError("grant already used", "GONE");

    const at = now();
    if (!(await this.repo.markTemporaryRuleConsumed(ruleId, at)))
      throw new DomainError("grant already used", "GONE");
    // Bump so every device for this child re-syncs and drops the spent grant.
    await this.repo.bumpPolicyVersion(device.familyId, device.childId);
    await this.repo.addAuditEvent({
      id: uid(), familyId: device.familyId, actorId: deviceId, kind: "grant.consumed",
      detail: { ruleId, requestId: grant.requestId, target: `${grant.target}:${grant.value}` }, createdAt: at,
    });
    this.hub?.notify(`device:${deviceId}`);
    return { ...grant, consumedAt: at };
  }

  /** Parent decides. Server-authoritative; records who decided; produces a rule. */
  /**
   * Age out asks nobody answered.
   *
   * Lazy rather than a background job: this backend runs on Workers as well as
   * a single binary, and a scheduled sweep exists on neither by default. Every
   * read of the request list pays for its own tidying, which is cheap and — more
   * to the point — cannot drift out of sync with what a parent is looking at.
   *
   * Returns the number expired, so a caller can decide whether to wake the feed.
   */
  async expireStaleRequests(familyId: string, nowMs = Date.now()): Promise<number> {
    const pending = await this.repo.listAccessRequests(familyId, "PENDING");
    let n = 0;
    for (const r of pending) {
      const age = nowMs - Date.parse(r.createdAt);
      if (!Number.isFinite(age) || age < REQUEST_EXPIRES_AFTER_MS) continue;
      await this.repo.updateAccessRequest({ ...r, status: "EXPIRED" });
      n++;
    }
    return n;
  }

  async decide(input: {
    familyId: string; requestId: string; decidedBy: string;
    decision: "ALLOW" | "BLOCK"; scope: ApprovalScope; duration: ApprovalDuration;
    policy: PolicyService;
  }): Promise<{ decision: ApprovalDecision; request: AccessRequest }> {
    const m = await this.repo.getMembership(input.familyId, input.decidedBy);
    if (!m || !canApprove(m.role)) throw new DomainError("cannot approve", "FORBIDDEN");

    const req = await this.repo.getAccessRequest(input.requestId);
    if (!req || req.familyId !== input.familyId) throw new DomainError("unknown request", "NOT_FOUND");
    if (req.status !== "PENDING") throw new DomainError("request already decided", "CONFLICT");
    if (m.role === "LIMITED_GUARDIAN" && !m.assignedChildIds.includes(req.childId))
      throw new DomainError("guardian not assigned this child", "FORBIDDEN");

    const { targetType, targetValue, ruleScope } = mapScope(req, input.scope);
    let producedRuleId: string | undefined;

    if (input.decision === "ALLOW") {
      // "Until the end of the day" means the CHILD's day, wherever they are.
      const child = await this.repo.getChild(req.childId);
      const { expiresAt, standing } = durationToExpiry(input.duration, safeTimeZone(child?.timezone));
      if (standing) {
        const rule = await input.policy.addRule(input.familyId, input.decidedBy, {
          target: targetType, value: targetValue, action: "ALLOW", scope: ruleScope, priority: 10,
        });
        producedRuleId = rule.id;
      } else {
        const t: TemporaryGrant = {
          id: uid(), target: targetType, value: targetValue, action: "ALLOW", scope: ruleScope,
          priority: 100, createdAt: now(), createdBy: input.decidedBy,
          startsAt: now(), expiresAt: expiresAt!, requestId: req.id, approvedBy: input.decidedBy,
          grantKind: input.duration.kind === "ONCE" ? "ONCE"
            : input.duration.kind === "UNTIL_END_OF_DAY" ? "UNTIL_END_OF_DAY" : "TIMED",
        };
        await this.repo.createTemporaryRule(t);
        await this.repo.bumpPolicyVersion(input.familyId, req.childId);
        producedRuleId = t.id;
      }
    } else {
      // Explicit deny. This USED to always mint a standing rule, so the softest,
      // easiest-to-mis-tap control in the product ("Not now") silently blocked a
      // target FOREVER — the restriction ratchet the UX review warned about,
      // where a tired parent quietly rebuilds the punitive wall this product
      // exists to replace. Honour the duration: only an explicit "for good"
      // (ALWAYS) is permanent; everything else is a time-boxed no.
      const child = await this.repo.getChild(req.childId);
      const { expiresAt, standing } = durationToExpiry(input.duration, safeTimeZone(child?.timezone));
      if (standing) {
        const rule = await input.policy.addRule(input.familyId, input.decidedBy, {
          target: targetType, value: targetValue, action: "BLOCK", scope: ruleScope, priority: 10,
        });
        producedRuleId = rule.id;
      } else {
        const t: TemporaryGrant = {
          id: uid(), target: targetType, value: targetValue, action: "BLOCK", scope: ruleScope,
          priority: 100, createdAt: now(), createdBy: input.decidedBy,
          startsAt: now(), expiresAt: expiresAt!, requestId: req.id, approvedBy: input.decidedBy,
          grantKind: input.duration.kind === "ONCE" ? "ONCE"
            : input.duration.kind === "UNTIL_END_OF_DAY" ? "UNTIL_END_OF_DAY" : "TIMED",
        };
        await this.repo.createTemporaryRule(t);
        await this.repo.bumpPolicyVersion(input.familyId, req.childId);
        producedRuleId = t.id;
      }
    }

    req.status = input.decision === "ALLOW" ? "APPROVED" : "DENIED";
    await this.repo.updateAccessRequest(req);

    const decision = await this.repo.createApprovalDecision({
      id: uid(), requestId: req.id, familyId: input.familyId, decidedBy: input.decidedBy,
      decision: input.decision, scope: input.scope, duration: input.duration,
      createdAt: now(), producedRuleId,
    });
    await this.repo.addAuditEvent({
      id: uid(), familyId: input.familyId, actorId: input.decidedBy, kind: "approval.decided",
      detail: { requestId: req.id, decision: input.decision, scope: input.scope, producedRuleId }, createdAt: now(),
    });

    // Nudge the child device to sync immediately.
    const device = await this.repo.getDevice(req.deviceId);
    if (device) {
      await this.notifier.send(
        { id: "device", userId: device.id, kind: "WEBSOCKET", token: device.id, createdAt: now() },
        { title: "policy_update", body: "sync", data: { kind: "policy_update", childId: req.childId } },
      );
    }
    // Wake parent consoles long-polling this family: the pending set just shrank.
    this.hub?.notify(`family:${input.familyId}`);
    return { decision, request: req };
  }
}
