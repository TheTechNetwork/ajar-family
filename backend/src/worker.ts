/**
 * Cloudflare Workers entrypoint (fetch handler). Reuses the same App + Router as
 * the Node server. Signing uses WebCrypto Ed25519, which Workers supports.
 *
 * PERSISTENCE NOTE (alpha): this uses the in-memory store, which lives only for
 * the lifetime of a warm isolate and is NOT shared across isolates or restarts.
 * That is fine for a single-isolate demo but NOT durable. The production path is
 * a D1 (SQLite) or KV-backed Repository implementation selected here from `env`;
 * see docs/DEPLOYMENT.md. Secrets (AUTH_SECRET, SIGNING_*_KEY_B64) come from
 * `wrangler secret put`.
 */
import { App } from "./app.js";
import { buildRouter } from "./http/api.js";
import type { HttpRequest, Router } from "./http/router.js";

export interface Env {
  AUTH_SECRET?: string;
  SIGNING_PUBLIC_KEY_B64?: string;
  SIGNING_PRIVATE_KEY_B64?: string;
}

let appPromise: Promise<App> | null = null;
let router: Router | null = null;

async function getRouter(env: Env): Promise<Router> {
  if (!appPromise) {
    appPromise = App.create({
      config: {
        authSecret: env.AUTH_SECRET ?? "dev-insecure-secret-change-me",
        signingPublicKeyB64: env.SIGNING_PUBLIC_KEY_B64,
        signingPrivateKeyB64: env.SIGNING_PRIVATE_KEY_B64,
      },
    });
  }
  if (!router) router = buildRouter(await appPromise);
  return router;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    let rawBody = "";
    if (request.method !== "GET" && request.method !== "HEAD") rawBody = await request.text();

    const req: HttpRequest = {
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      headers,
      params: {},
      json: async () => (rawBody ? JSON.parse(rawBody) : {}),
    };
    const r = await (await getRouter(env)).handle(req);
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  },
};
