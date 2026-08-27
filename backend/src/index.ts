/**
 * Local entrypoint (Node). `npm run start` after `npm run build`.
 * Cloudflare Workers uses src/worker.ts instead.
 */
import { App } from "./app.js";
import { createNodeServer } from "./http/node-server.js";
import { createNodeSqlite } from "./store/sql/database.js";
import { SqlStore } from "./store/sql/sql-store.js";

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
  console.log(`contentfilter backend (alpha) listening on :${port}`);
  if (!process.env.SIGNING_PRIVATE_KEY_B64) {
    // eslint-disable-next-line no-console
    console.log("WARNING: using an ephemeral policy-signing key (dev only). Set SIGNING_*_KEY_B64 for stable verification.");
  }
});
