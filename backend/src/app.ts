/**
 * App container: assembles the repository, notifier, signing key, and services.
 * Transport adapters (node:http, Workers) build one of these and route into it.
 */
import type { Repository } from "./store/repository.js";
import { MemoryStore } from "./store/memory.js";
import { ConsoleNotifier, EmailNotifier, HubNotifier, type Notifier } from "./push/notifier.js";
import { FetchMailSender, NullMailSender, type MailSender } from "./push/mail.js";
import { EventHub } from "./push/hub.js";
import { generateSigningKeyPair } from "./domain/signing.js";
import {
  AuthService, FamilyService, EnrollmentService, PolicyService, ApprovalService, DeviceService,
} from "./domain/services.js";
import { RepositoryCategoryProvider, seedCategoriesIfEmpty, type CategoryProvider } from "./categories/provider.js";
import { NullResolver, type CnameResolver } from "./categories/resolver.js";

export interface AppConfig {
  /** HMAC secret for bearer tokens. */
  authSecret: string;
  /** Ops secret gating the GLOBAL category-dataset import. Unset = disabled. */
  categoryAdminToken?: string;
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
  readonly auth: AuthService;
  readonly family: FamilyService;
  readonly enrollment: EnrollmentService;
  readonly devices: DeviceService;
  readonly policy: PolicyService;
  readonly approvals: ApprovalService;
  readonly categories: CategoryProvider;
  readonly cnameResolver: CnameResolver;

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
    this.categories = new RepositoryCategoryProvider(repo);
    this.cnameResolver = resolver;
    this.auth = new AuthService(repo, notifier, mail);
    this.family = new FamilyService(repo);
    this.enrollment = new EnrollmentService(repo);
    this.devices = new DeviceService(repo);
    this.policy = new PolicyService(repo, signingPrivateKeyB64, this.categories);
    this.approvals = new ApprovalService(repo, notifier, hub);
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
    // Wrap the base notifier so device nudges wake long-poll waiters on the hub.
    const notifier = new HubNotifier(base, hub);
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
