/**
 * App container: assembles the repository, notifier, signing key, and services.
 * Transport adapters (node:http, Workers) build one of these and route into it.
 */
import type { Repository } from "./store/repository.js";
import { MemoryStore } from "./store/memory.js";
import { ConsoleNotifier, HubNotifier, type Notifier } from "./push/notifier.js";
import { EventHub } from "./push/hub.js";
import { generateSigningKeyPair } from "./domain/signing.js";
import {
  AuthService, FamilyService, EnrollmentService, PolicyService, ApprovalService,
} from "./domain/services.js";
import { RepositoryCategoryProvider, seedCategoriesIfEmpty, type CategoryProvider } from "./categories/provider.js";
import { NullResolver, type CnameResolver } from "./categories/resolver.js";

export interface AppConfig {
  /** HMAC secret for bearer tokens. */
  authSecret: string;
  /** Base64 SPKI/PKCS8 policy-signing keypair. Generated if omitted (dev only). */
  signingPublicKeyB64?: string;
  signingPrivateKeyB64?: string;
}

export class App {
  readonly repo: Repository;
  readonly notifier: Notifier;
  readonly hub: EventHub;
  readonly authSecret: string;
  readonly signingPublicKeyB64: string;
  readonly auth: AuthService;
  readonly family: FamilyService;
  readonly enrollment: EnrollmentService;
  readonly policy: PolicyService;
  readonly approvals: ApprovalService;
  readonly categories: CategoryProvider;
  readonly cnameResolver: CnameResolver;

  private constructor(repo: Repository, notifier: Notifier, hub: EventHub, cfg: AppConfig,
                      signingPublicKeyB64: string, signingPrivateKeyB64: string, resolver: CnameResolver) {
    this.repo = repo;
    this.notifier = notifier;
    this.hub = hub;
    this.authSecret = cfg.authSecret;
    this.signingPublicKeyB64 = signingPublicKeyB64;
    this.categories = new RepositoryCategoryProvider(repo);
    this.cnameResolver = resolver;
    this.auth = new AuthService(repo);
    this.family = new FamilyService(repo);
    this.enrollment = new EnrollmentService(repo);
    this.policy = new PolicyService(repo, signingPrivateKeyB64, this.categories);
    this.approvals = new ApprovalService(repo, notifier, hub);
  }

  static async create(opts: {
    repo?: Repository; notifier?: Notifier; config: AppConfig; cnameResolver?: CnameResolver;
  }): Promise<App> {
    const repo = opts.repo ?? new MemoryStore();
    const hub = new EventHub();
    // Wrap the base notifier so device nudges wake long-poll waiters on the hub.
    const notifier = new HubNotifier(opts.notifier ?? new ConsoleNotifier(), hub);
    let pub = opts.config.signingPublicKeyB64;
    let priv = opts.config.signingPrivateKeyB64;
    if (!pub || !priv) {
      const kp = await generateSigningKeyPair();
      pub = kp.publicKeyB64; priv = kp.privateKeyB64;
    }
    const app = new App(repo, notifier, hub, opts.config, pub, priv, opts.cnameResolver ?? new NullResolver());
    // Seed the categorization dataset from the bundled starter list on first
    // boot only (no-op once a feed has been imported). Data, not hardcoding.
    await seedCategoriesIfEmpty(app.categories);
    return app;
  }
}
