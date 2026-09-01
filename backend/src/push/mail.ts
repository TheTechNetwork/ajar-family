/**
 * Email delivery, dependency-free.
 *
 * We do not speak SMTP (that would mean a dependency and a long-lived socket
 * budget the Workers runtime does not have). Instead a `MailSender` posts a
 * small JSON envelope to a configurable HTTPS endpoint — every transactional
 * provider (Postmark, Resend, SendGrid, Mailgun, SES via API Gateway) and any
 * in-house relay accepts that shape, and `fetch` exists on both runtimes.
 *
 * The interface is the point: `EmailNotifier` depends on `MailSender`, so tests
 * run fully offline against `InMemoryMailSender` and a deployment with nothing
 * configured gets `NullMailSender` (drops, loudly, once) instead of a crash.
 */

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain text. We deliberately send no HTML: less to get wrong, nothing to
   *  leak via remote images, and it renders in every client. */
  text: string;
}

export interface MailSender {
  send(msg: MailMessage): Promise<void>;
}

/** Default when no provider is configured: accept and drop. */
export class NullMailSender implements MailSender {
  private warned = false;
  async send(msg: MailMessage): Promise<void> {
    if (!this.warned) {
      this.warned = true;
      // eslint-disable-next-line no-console
      console.warn("[mail] no MAIL_ENDPOINT configured — dropping outbound email (first of possibly many).");
    }
    // eslint-disable-next-line no-console
    console.log(`[mail:dropped] to=${msg.to} subject=${msg.subject}`);
  }
}

/** Records instead of sending. Used by tests and local dev. */
export class InMemoryMailSender implements MailSender {
  public sent: MailMessage[] = [];
  async send(msg: MailMessage): Promise<void> { this.sent.push(msg); }
}

/**
 * Cloudflare Email Sending, via the Worker's `send_email` binding.
 *
 * Preferred over FetchMailSender on Workers for one reason that outranks
 * convenience: there is no long-lived bearer token. MAIL_TOKEN is a credential
 * for a third party that can read every subject line we send, and it is the kind
 * of secret that leaks and then has to be rotated everywhere at once. This has
 * none — the binding is authorised by being bound.
 *
 * The sender address must belong to a domain onboarded to Email Service, and a
 * `from` that is not verified fails with E_SENDER_NOT_VERIFIED. That is a
 * configuration error, not a transient one, so it is worth reading the message
 * rather than assuming a retry helps.
 */
export interface EmailBinding {
  send(msg: { from: string; to: string; subject: string; text?: string; html?: string }):
    Promise<{ messageId: string }>;
}

export class WorkersEmailSender implements MailSender {
  constructor(private binding: EmailBinding, private from: string) {}

  async send(msg: MailMessage): Promise<void> {
    // text only, deliberately, for the same reasons FetchMailSender gives: less
    // to get wrong, no remote images to leak a read receipt, renders everywhere.
    await this.binding.send({
      from: this.from, to: msg.to, subject: msg.subject, text: msg.text,
    });
  }
}

export interface FetchMailSenderOptions {
  /** Absolute https URL of the provider's send endpoint. */
  endpoint: string;
  /** Bearer credential for the endpoint. */
  token: string;
  /** From address, e.g. "Ajar <no-reply@ajar.family>". */
  from?: string;
  /** Injectable for tests; defaults to the runtime's global fetch. */
  fetchImpl?: typeof fetch;
  /** Abort after this long (ms) so a hung provider cannot stall an approval. */
  timeoutMs?: number;
}

/**
 * Posts `{ from, to, subject, text }` as JSON with `Authorization: Bearer`.
 * Failures are logged and swallowed: a provider outage must never turn a child's
 * access request into a 500. Delivery is best-effort by construction — see
 * docs/SECURITY.md for the residual risk that entails.
 */
export class FetchMailSender implements MailSender {
  private readonly fetchImpl: typeof fetch;
  private readonly from: string;
  private readonly timeoutMs: number;

  constructor(private opts: FetchMailSenderOptions) {
    if (!opts.endpoint || !opts.token) throw new Error("FetchMailSender requires endpoint and token");
    this.fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
    this.from = opts.from ?? "Ajar <no-reply@ajar.family>";
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async send(msg: MailMessage): Promise<void> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.opts.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.token}` },
        body: JSON.stringify({ from: this.from, to: msg.to, subject: msg.subject, text: msg.text }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.error(`[mail] provider rejected message to ${msg.to}: HTTP ${res.status}`);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[mail] delivery to ${msg.to} failed:`, (e as Error).message);
    } finally {
      clearTimeout(timer);
    }
  }
}
