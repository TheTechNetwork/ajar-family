/**
 * Passkey (WebAuthn) ceremonies for parent accounts.
 *
 * WHY A DEPENDENCY LIVES HERE, in a repo that has otherwise had none. The
 * primitives were never the risk — WebCrypto does ECDSA and SHA-256 either way.
 * The risk is everything AROUND them: CBOR over attacker-controlled bytes, COSE
 * key marshalling, DER-to-raw signature conversion (which fails for roughly half
 * of all signatures if you mishandle the leading zero byte, and so reads as a
 * flaky authenticator rather than a bug), and the ceremony checks themselves —
 * origin, rpIdHash, challenge, user-verification. Getting any one of those wrong
 * is an authentication bypass, and a bespoke implementation would be reviewed by
 * the same eyes that wrote it. @simplewebauthn/server is the implementation the
 * rest of the world has already found the bugs in.
 *
 * Pinned to an exact version; the lockfile is committed. It is the only runtime
 * dependency in the repository, and it sits on the auth path, so treat a bump
 * the way you would treat a change to this file.
 */
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type { Repository } from "../store/repository.js";
import type { WebAuthnCredential } from "./model.js";
import { DomainError } from "./services.js";

/** How long a ceremony may stay open. A live browser conversation, not a link. */
export const CHALLENGE_TTL_MS = 5 * 60_000;

const now = () => new Date().toISOString();

export interface PasskeyConfig {
  /** The registrable domain, e.g. "ajar.family". NOT a URL, no scheme, no port. */
  rpId: string;
  /** Exact origin the browser will report, e.g. "https://ajar.family". */
  origin: string;
  /** Shown in the platform's own prompt. */
  rpName: string;
}

export class PasskeyService {
  constructor(private repo: Repository, private cfg: PasskeyConfig) {}

  private async keepChallenge(challenge: string, kind: "REGISTER" | "AUTHENTICATE", userId?: string) {
    await this.repo.createWebAuthnChallenge({
      challenge, userId, kind,
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
      createdAt: now(),
    });
  }

  /**
   * Redeem a challenge: single use, right kind, not expired, and bound to the
   * user we think we are talking to. `takeWebAuthnChallenge` deletes as it
   * reads, so a replay finds nothing.
   */
  private async spendChallenge(challenge: string, kind: "REGISTER" | "AUTHENTICATE", userId?: string) {
    const row = await this.repo.takeWebAuthnChallenge(challenge);
    if (!row) throw new DomainError("that sign-in attempt has expired — please try again", "UNAUTHORIZED");
    if (row.kind !== kind) throw new DomainError("that sign-in attempt has expired — please try again", "UNAUTHORIZED");
    if (Date.parse(row.expiresAt) <= Date.now()) {
      throw new DomainError("that sign-in attempt has expired — please try again", "UNAUTHORIZED");
    }
    // Every challenge we issue is bound to a user — a registration challenge to
    // the account enrolling, a sign-in challenge to the account whose password
    // was just accepted. Letting one be redeemed by a different session would
    // register an attacker's key on someone's account, or settle their second
    // factor with a passkey ceremony run somewhere else entirely.
    if (row.userId !== userId) {
      throw new DomainError("that sign-in attempt has expired — please try again", "UNAUTHORIZED");
    }
    return row;
  }

  // --- registration --------------------------------------------------------

  async registerOptions(user: { id: string; email: string; displayName: string }) {
    const existing = await this.repo.listWebAuthnCredentials(user.id);
    const options = await generateRegistrationOptions({
      rpName: this.cfg.rpName,
      rpID: this.cfg.rpId,
      userName: user.email,
      userDisplayName: user.displayName,
      // No attestation. We are not verifying which authenticator model this is —
      // that is an enterprise concern, and asking for it shows the user an extra
      // privacy prompt to gather something we would not act on.
      attestationType: "none",
      // Stops a parent silently registering the same key twice and thinking they
      // have two.
      excludeCredentials: existing.map((c) => ({ id: c.id })),
      authenticatorSelection: {
        residentKey: "preferred",
        // "preferred", not "required": on a platform that cannot do biometrics
        // this would otherwise refuse to enrol at all, and a parent locked out of
        // their own account is not a security win.
        userVerification: "preferred",
      },
    });
    await this.keepChallenge(options.challenge, "REGISTER", user.id);
    return options;
  }

  async register(userId: string, response: unknown, label: string): Promise<WebAuthnCredential> {
    const challenge = (response as { response?: { clientDataJSON?: string } })?.response?.clientDataJSON
      ? decodeChallenge(response)
      : undefined;
    if (!challenge) throw new DomainError("that response could not be read", "BAD_REQUEST");
    await this.spendChallenge(challenge, "REGISTER", userId);

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: response as never,
        expectedChallenge: challenge,
        expectedOrigin: this.cfg.origin,
        expectedRPID: this.cfg.rpId,
        requireUserVerification: false,
      });
    } catch (e) {
      // The library's message names the exact check that failed; that belongs in
      // the log, not in a response to whoever is trying.
      // eslint-disable-next-line no-console
      console.error("[passkey] registration verification failed:", e);
      throw new DomainError("that passkey could not be verified", "UNAUTHORIZED");
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw new DomainError("that passkey could not be verified", "UNAUTHORIZED");
    }

    const { credential, credentialBackedUp } = verification.registrationInfo;
    return this.repo.createWebAuthnCredential({
      id: credential.id,
      userId,
      publicKeyCose: Buffer.from(credential.publicKey).toString("base64url"),
      alg: -7, // recorded for diagnostics; the library re-reads it from the key
      signCount: credential.counter,
      label: label.slice(0, 64) || "Passkey",
      backedUp: credentialBackedUp,
      createdAt: now(),
    });
  }

  // --- authentication ------------------------------------------------------

  /**
   * Options for the SECOND half of a sign-in. The caller has already proved the
   * password, so we know who this is and the challenge is bound to them.
   *
   * `allowCredentials` names that user's own passkeys, which is safe precisely
   * because this is not the first step: reaching it already required the
   * password, so the list answers nothing to someone who does not have it.
   */
  async loginOptions(user: { id: string }) {
    const credentials = await this.repo.listWebAuthnCredentials(user.id);
    if (credentials.length === 0) {
      throw new DomainError("this account has no passkey enrolled", "BAD_REQUEST");
    }
    const options = await generateAuthenticationOptions({
      rpID: this.cfg.rpId,
      allowCredentials: credentials.map((c) => ({ id: c.id })),
      userVerification: "preferred",
    });
    await this.keepChallenge(options.challenge, "AUTHENTICATE", user.id);
    return options;
  }

  async login(userId: string, response: unknown): Promise<{ userId: string; credential: WebAuthnCredential }> {
    const challenge = decodeChallenge(response);
    if (!challenge) throw new DomainError("that response could not be read", "BAD_REQUEST");
    await this.spendChallenge(challenge, "AUTHENTICATE", userId);

    const id = (response as { id?: string }).id;
    if (!id) throw new DomainError("that response could not be read", "BAD_REQUEST");
    const stored = await this.repo.getWebAuthnCredential(id);
    // Same message whether the credential is unknown or the signature is wrong:
    // the difference would say whether a given passkey is registered here.
    if (!stored) throw new DomainError("that passkey was not recognised", "UNAUTHORIZED");
    // The challenge was bound to this account and so is the credential. Without
    // this line, anyone holding ANY passkey enrolled with Ajar could finish a
    // sign-in that started with someone else's password.
    if (stored.userId !== userId) throw new DomainError("that passkey was not recognised", "UNAUTHORIZED");

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: response as never,
        expectedChallenge: challenge,
        expectedOrigin: this.cfg.origin,
        expectedRPID: this.cfg.rpId,
        credential: {
          id: stored.id,
          publicKey: new Uint8Array(Buffer.from(stored.publicKeyCose, "base64url")),
          counter: stored.signCount,
        },
        requireUserVerification: false,
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[passkey] authentication verification failed:", e);
      throw new DomainError("that passkey was not recognised", "UNAUTHORIZED");
    }
    if (!verification.verified) throw new DomainError("that passkey was not recognised", "UNAUTHORIZED");

    // Counter regression is the clone signal: a counter that does not move
    // forward means the same credential is being used from two places.
    //
    // BE HONEST ABOUT WHAT THIS LINE DOES. The library already rejects this, and
    // more strictly than we do — it throws whenever the reported counter is <=
    // the stored one and either is non-zero, so the branch below never fires
    // today and the catch above is what actually turns a clone into a 401. It is
    // kept as a second line for the version bump that loosens that check, and
    // for the day this file talks to a different verifier. Synced passkeys report
    // 0 forever, which is why 0 -> 0 has to stay legal in both checks; treating
    // it as regression would lock out most parents on their second sign-in.
    const next = verification.authenticationInfo.newCounter;
    if (stored.signCount > 0 && next < stored.signCount) {
      // eslint-disable-next-line no-console
      console.error(`[passkey] counter went backwards for ${stored.id}: ${stored.signCount} -> ${next}`);
      throw new DomainError("that passkey was not recognised", "UNAUTHORIZED");
    }
    const updated = await this.repo.updateWebAuthnCredential({ ...stored, signCount: next, lastUsedAt: now() });
    return { userId: stored.userId, credential: updated };
  }

  list(userId: string) { return this.repo.listWebAuthnCredentials(userId); }

  /**
   * Remove a passkey — but never the last one. A passkey is required to sign in,
   * so deleting the only one is not a security decision a parent can meaningfully
   * consent to in a dialog; it is locking themselves out of their children's
   * controls. Enrol the replacement first.
   */
  async remove(userId: string, credentialId: string): Promise<void> {
    const stored = await this.repo.getWebAuthnCredential(credentialId);
    if (!stored || stored.userId !== userId) throw new DomainError("no such passkey", "NOT_FOUND");
    const all = await this.repo.listWebAuthnCredentials(userId);
    if (all.length <= 1) {
      throw new DomainError(
        "add another passkey before removing this one — it is the only way you can sign in",
        "CONFLICT");
    }
    await this.repo.deleteWebAuthnCredential(credentialId);
  }
}

/** Pull the challenge the browser echoed back, so we can look the ceremony up. */
function decodeChallenge(response: unknown): string | undefined {
  const b64 = (response as { response?: { clientDataJSON?: string } })?.response?.clientDataJSON;
  if (typeof b64 !== "string") return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as { challenge?: unknown };
    return typeof parsed.challenge === "string" ? parsed.challenge : undefined;
  } catch {
    return undefined;
  }
}
