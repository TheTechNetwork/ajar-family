/**
 * App container: assembles the repository, notifier, signing key, and services.
 * Transport adapters (node:http, Workers) build one of these and route into it.
 */
import type { Repository } from "./store/repository.js";
import { MemoryStore } from "./store/memory.js";
import { BestEffortNotifier, ConsoleNotifier, EmailNotifier, HubNotifier, type Notifier } from "./push/notifier.js";
import { FetchMailSender, NullMailSender, type MailSender } from "./push/mail.js";
import { EventHub } from "./push/hub.js";
import { generateSigningKeyPair } from "./domain/signing.js";
import {
  AuthService, FamilyService, EnrollmentService, PolicyService, ApprovalService, DeviceService,
} from "./domain/services.js";
import { PasskeyService } from "./domain/passkeys.js";
import { RepositoryCategoryProvider, seedCategoriesIfEmpty, type CategoryProvider } from "./categories/provider.js";
import { NullResolver, type CnameResolver } from "./categories/resolver.js";

export interface AppConfig {
  /** HMAC secret for bearer tokens. */
  authSecret: string;
  /** Ops secret gating the GLOBAL category-dataset import. Unset = disabled. */
  categoryAdminToken?: string;
  /**
   * True when a reverse proxy YOU control overwrites `x-forwarded-for` /
   * `x-real-ip` on every inbound request.
   *
   * Off by default, and it must stay off for a server reachable directly from
   * the internet: those headers are client input, and rate limiting keyed on
   * them is no rate limiting at all — a rotating value gives every login attempt
   * a fresh bucket. Cloudflare's `cf-connecting-ip` is trusted regardless,
   * because the edge sets it and strips any client copy.
   */
  trustProxyHeaders?: boolean;
  /** Base64 SPKI/PKCS8 policy-signing keypair. Generated if omitted (dev only). */
  signingPublicKeyB64?: string;
  signingPrivateKeyB64?: string;

  /**
   * Outbound email. Both must be set for real delivery; with either missing the
   * app runs with a NullMailSender and says so, rather than pretending mail
   * works. See push/mail.ts for the JSON envelope we POST.
   */
  mailEndpoint?: string;
  mailToken?: string;
  mailFrom?: string;
  /** Base URL of the parent console page that completes a password reset;
   *  the emailed link is `<base>?token=<raw>`. Omitted = code-only email. */
  resetUrlBase?: string;
  /** Base URL of the parent console page that completes email confirmation;
   *  the emailed link is `<base>?verify=<raw>`. Omitted = code-only email. */
  verifyUrlBase?: string;

  /**
   * WebAuthn relying-party identity. These are not cosmetic and they are not
   * guessable at runtime: a passkey is bound to the rpId it was created under,
   * and the browser refuses a ceremony whose rpId is not a suffix of the page's
   * own origin. Change either after parents have enrolled and every existing
   * passkey stops working — there is no migration.
   *
   * `passkeyRpId` is a registrable domain, no scheme and no port
   * ("ajar.family"); `passkeyOrigin` is the exact origin the browser reports
   * ("https://ajar.family"). They must describe the SAME host the console is
   * served from, which is why the site, the signup flow and the API all live on
   * one Worker on one origin.
   *
   * The defaults are local-development values and are wrong everywhere else.
   * Production sets them in wrangler.toml [vars]; a durable deployment that
   * leaves them alone gets a startup warning rather than silent breakage.
   */
  passkeyRpId?: string;
  passkeyOrigin?: string;
  passkeyRpName?: string;
  /**
   * Apple application identifiers allowed to use this rpId's passkeys, as
   * `<TeamID>.<bundle id>` — e.g. `ABCDE12345.family.ajar.parent`. Comma
   * separated in the environment (APPLE_APP_IDS).
   *
   * Empty means the apple-app-site-association route 404s. That is deliberate:
   * an EMPTY apps list is a positive statement to Apple that no app may claim
   * this domain, and it is cached. "Not configured" and "configured to refuse"
   * must not look the same.
   */
  appleAppIds?: string;
}

export class App {
  readonly repo: Repository;
  readonly notifier: Notifier;
  readonly mail: MailSender;
  /** Where a password-reset email should point (parent console). */
  readonly resetUrlBase?: string;
  /** Where a confirm-your-email link should point (parent console). */
  readonly verifyUrlBase?: string;
  readonly hub: EventHub;
  readonly authSecret: string;
  readonly signingPublicKeyB64: string;
  readonly categoryAdminToken?: string;
  readonly trustProxyHeaders: boolean;
  readonly auth: AuthService;
  readonly family: FamilyService;
  readonly enrollment: EnrollmentService;
  readonly devices: DeviceService;
  readonly policy: PolicyService;
  readonly approvals: ApprovalService;
  readonly categories: CategoryProvider;
  readonly cnameResolver: CnameResolver;
  readonly passkeys: PasskeyService;
  /** Parsed `appleAppIds`; empty when unset. */
  readonly appleAppIds: string[];

  private constructor(repo: Repository, notifier: Notifier, mail: MailSender, hub: EventHub, cfg: AppConfig,
                      signingPublicKeyB64: string, signingPrivateKeyB64: string, resolver: CnameResolver) {
    this.repo = repo;
    this.notifier = notifier;
    this.mail = mail;
    this.resetUrlBase = cfg.resetUrlBase;
    this.verifyUrlBase = cfg.verifyUrlBase;
    this.hub = hub;
    this.authSecret = cfg.authSecret;
    this.signingPublicKeyB64 = signingPublicKeyB64;
    this.categoryAdminToken = cfg.categoryAdminToken;
    this.trustProxyHeaders = cfg.trustProxyHeaders === true;
    this.categories = new RepositoryCategoryProvider(repo);
    this.cnameResolver = resolver;
    this.auth = new AuthService(repo, notifier, mail);
    this.family = new FamilyService(repo);
    this.enrollment = new EnrollmentService(repo);
    this.devices = new DeviceService(repo);
    this.policy = new PolicyService(repo, signingPrivateKeyB64, this.categories);
    this.approvals = new ApprovalService(repo, notifier, hub);
    this.appleAppIds = (cfg.appleAppIds ?? "")
      .split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    this.passkeys = new PasskeyService(repo, {
      rpId: cfg.passkeyRpId ?? "localhost",
      origin: cfg.passkeyOrigin ?? "http://localhost:8787",
      rpName: cfg.passkeyRpName ?? "Ajar",
    });
  }

  static async create(opts: {
    repo?: Repository; notifier?: Notifier; mail?: MailSender;
    config: AppConfig; cnameResolver?: CnameResolver;
  }): Promise<App> {
    const repo = opts.repo ?? new MemoryStore();
    const hub = new EventHub();
    // Real email delivery whenever a provider is configured (MAIL_ENDPOINT +
    // MAIL_TOKEN); tests inject an in-memory MailSender; otherwise nothing is
    // configured and outbound mail is dropped with a warning rather than faked.
    // Order matters. An injected sender wins (tests, and the Worker passing its
    // own Email Sending binding); then a configured HTTPS provider; then nothing
    // is configured and mail is dropped LOUDLY rather than faked.
    const mail = opts.mail
      ?? (opts.config.mailEndpoint && opts.config.mailToken
        ? new FetchMailSender({
            endpoint: opts.config.mailEndpoint, token: opts.config.mailToken, from: opts.config.mailFrom,
          })
        : new NullMailSender());
    // EMAIL endpoints go through the mail sender; every other kind falls back to
    // the console notifier (APNs / Web Push are documented adapters, not stubs).
    const base = opts.notifier ?? new EmailNotifier(mail, new ConsoleNotifier());
    // BestEffort INSIDE Hub, and the order is load-bearing: HubNotifier awaits
    // the sender before waking the long-poll, so a swallow that sat outside it
    // would still let a mail outage skip the device wake — turning a mail
    // problem into a policy-propagation problem.
    const notifier = new HubNotifier(new BestEffortNotifier(base), hub);
    let pub = opts.config.signingPublicKeyB64;
    let priv = opts.config.signingPrivateKeyB64;
    if (!pub || !priv) {
      const kp = await generateSigningKeyPair();
      pub = kp.publicKeyB64; priv = kp.privateKeyB64;
    }
    const app = new App(repo, notifier, mail, hub, opts.config, pub, priv, opts.cnameResolver ?? new NullResolver());
    // Seed the categorization dataset from the bundled starter list on first
    // boot only (no-op once a feed has been imported). Data, not hardcoding.
    await seedCategoriesIfEmpty(app.categories);
    return app;
  }
}
