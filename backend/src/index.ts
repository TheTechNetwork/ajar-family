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
import { createNodeServer } from "./http/node-server.js";
import { createNodeSqlite } from "./store/sql/database.js";
import { SqlStore } from "./store/sql/sql-store.js";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8787);

  // DATABASE_FILE → durable SQLite (survives restart). Unset → in-memory (dev).
  const repo = process.env.DATABASE_FILE
    ? await SqlStore.create(await createNodeSqlite(process.env.DATABASE_FILE))
    : undefined;

  const app = await App.create({
    repo,
    config: {
      authSecret: process.env.AUTH_SECRET ?? "dev-insecure-secret-change-me",
      signingPublicKeyB64: process.env.SIGNING_PUBLIC_KEY_B64,
      signingPrivateKeyB64: process.env.SIGNING_PRIVATE_KEY_B64,
    },
  });

  createNodeServer(app).listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`contentfilter backend (alpha) on http://localhost:${port}  ·  parent console at /`);
    if (!process.env.SIGNING_PRIVATE_KEY_B64) {
      // eslint-disable-next-line no-console
      console.log("WARNING: ephemeral policy-signing key (dev only). Set SIGNING_*_KEY_B64 for stable verification.");
    }
    if (process.env.AUTH_SECRET === undefined) {
      // eslint-disable-next-line no-console
      console.log("WARNING: using the default AUTH_SECRET. Set AUTH_SECRET for anything real.");
    }
  });
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("failed to start:", e);
  process.exit(1);
});
