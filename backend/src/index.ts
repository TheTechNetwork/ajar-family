/**
 * Local / self-host / single-binary entrypoint (Node or a bundled SEA binary).
 * `npm run start` after `npm run build`, or run the prebuilt executable from a
 * GitHub release (no Node toolchain — see docs/INSTALL.md). Cloudflare Workers
 * uses src/worker.ts instead.
 *
 * No top-level await so this file bundles to CommonJS for the single-executable
 * build (esbuild → Node SEA).
 */
import { App } from "./app.js";
import { NodeCnameResolver } from "./categories/resolver.js";
import { createNodeServer } from "./http/node-server.js";
import { createNodeSqlite } from "./store/sql/database.js";
import { SqlStore } from "./store/sql/sql-store.js";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8787);

  // DATABASE_FILE → durable SQLite (survives restart). Unset → in-memory (dev).
  const durable = !!process.env.DATABASE_FILE;
  const repo = durable
    ? await SqlStore.create(await createNodeSqlite(process.env.DATABASE_FILE!))
    : undefined;

  // Fail closed: a durable deployment must set AUTH_SECRET, or every token is
  // forgeable via the public default. The in-memory dev path still allows it.
  if (!process.env.AUTH_SECRET && durable && process.env.ALLOW_INSECURE_AUTH !== "1") {
    // eslint-disable-next-line no-console
    console.error("Refusing to start: set AUTH_SECRET when DATABASE_FILE is configured (or ALLOW_INSECURE_AUTH=1 to override for local testing).");
    process.exit(1);
  }

  const app = await App.create({
    repo,
    config: {
      authSecret: process.env.AUTH_SECRET ?? "dev-insecure-secret-change-me",
      signingPublicKeyB64: process.env.SIGNING_PUBLIC_KEY_B64,
      signingPrivateKeyB64: process.env.SIGNING_PRIVATE_KEY_B64,
      categoryAdminToken: process.env.CATEGORY_ADMIN_TOKEN,
      // Real notification delivery. Both must be set; otherwise outbound email
      // is dropped with a warning (see push/mail.ts) rather than silently faked.
      mailEndpoint: process.env.MAIL_ENDPOINT,
      mailToken: process.env.MAIL_TOKEN,
      mailFrom: process.env.MAIL_FROM,
      resetUrlBase: process.env.PASSWORD_RESET_URL,
      verifyUrlBase: process.env.VERIFY_EMAIL_URL,
    },
    // Follow CNAME chains for category lookups via the host's system resolver.
    cnameResolver: new NodeCnameResolver(),
  });

  createNodeServer(app).listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Ajar backend (alpha) on http://localhost:${port}  ·  parent console at /`);
    if (!process.env.SIGNING_PRIVATE_KEY_B64) {
      // eslint-disable-next-line no-console
      console.log("WARNING: ephemeral policy-signing key (dev only). Set SIGNING_*_KEY_B64 for stable verification.");
    }
    if (process.env.AUTH_SECRET === undefined) {
      // eslint-disable-next-line no-console
      console.log("WARNING: using the default AUTH_SECRET. Set AUTH_SECRET for anything real.");
    }
    if (!process.env.MAIL_ENDPOINT || !process.env.MAIL_TOKEN) {
      // eslint-disable-next-line no-console
      console.log("WARNING: MAIL_ENDPOINT/MAIL_TOKEN are unset — nobody will receive request or password-reset emails,");
      // eslint-disable-next-line no-console
      console.log("         and NOBODY CAN SIGN UP: creating an account needs the confirmation link we cannot send.");
    }
  });
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("failed to start:", e);
  process.exit(1);
});
