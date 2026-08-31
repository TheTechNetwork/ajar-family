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
import { DohCnameResolver } from "./categories/resolver.js";
import { buildRouter } from "./http/api.js";
import { corsHeaders, type HttpRequest, type Router } from "./http/router.js";
import { createD1, type D1Like } from "./store/sql/database.js";
import { SqlStore } from "./store/sql/sql-store.js";

export interface Env {
  AUTH_SECRET?: string;
  SIGNING_PUBLIC_KEY_B64?: string;
  SIGNING_PRIVATE_KEY_B64?: string;
  /** Bind a D1 database as `DB` in wrangler.toml for durable, cross-isolate state. */
  DB?: D1Like;
  /** Lock CORS to a specific origin in production (default `*`). */
  ALLOWED_ORIGIN?: string;
  /** Outbound email (both required for delivery) — see backend/src/push/mail.ts. */
  MAIL_ENDPOINT?: string;
  MAIL_TOKEN?: string;
  MAIL_FROM?: string;
  /** Parent-console URL that completes a password reset (`?token=` appended). */
  PASSWORD_RESET_URL?: string;
  /** Ops secret gating the global category-dataset import. */
  CATEGORY_ADMIN_TOKEN?: string;
}

let appPromise: Promise<App> | null = null;
let router: Router | null = null;

async function getRouter(env: Env): Promise<Router> {
  if (!appPromise) {
    appPromise = (async () => {
      // Prefer durable D1 when bound; otherwise per-isolate in-memory (demo only).
      const repo = env.DB ? await SqlStore.create(createD1(env.DB)) : undefined;
      return App.create({
        repo,
        config: {
          authSecret: env.AUTH_SECRET!, // guaranteed present: fetch() rejects when unset
          signingPublicKeyB64: env.SIGNING_PUBLIC_KEY_B64,
          signingPrivateKeyB64: env.SIGNING_PRIVATE_KEY_B64,
          categoryAdminToken: env.CATEGORY_ADMIN_TOKEN,
          mailEndpoint: env.MAIL_ENDPOINT,
          mailToken: env.MAIL_TOKEN,
          mailFrom: env.MAIL_FROM,
          resetUrlBase: env.PASSWORD_RESET_URL,
        },
        // Workers has no raw DNS — follow CNAME chains over DNS-over-HTTPS.
        cnameResolver: new DohCnameResolver(),
      });
    })();
  }
  if (!router) router = buildRouter(await appPromise);
  return router;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const CORS = corsHeaders(env.ALLOWED_ORIGIN);
    // CORS preflight.
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    // Fail closed: never run with forgeable tokens. On Workers AUTH_SECRET is a
    // required secret (`wrangler secret put AUTH_SECRET`) — no insecure default.
    if (!env.AUTH_SECRET) {
      return new Response(JSON.stringify({ error: "server misconfigured: AUTH_SECRET is not set", code: "MISCONFIGURED" }),
        { status: 500, headers: { "content-type": "application/json", ...CORS } });
    }

    const url = new URL(request.url);

    // Host-based surface split. `blocked.*` exists to serve ONE page: iOS bakes
    // that hostname into shipped builds via the content filter's
    // `remediationMap`, which makes it the hardest hostname here to ever change,
    // and it is fetched by an unauthenticated browser while a filter is actively
    // blocking traffic. Refusing every other path on it keeps the auth and
    // policy surface off the one origin that is both permanently pinned and
    // reachable in that state — rather than relying on nobody noticing the API
    // answers there too. The API lives on `api.*`.
    if (url.hostname.startsWith("blocked.") && url.pathname !== "/blocked") {
      return new Response(
        JSON.stringify({ error: "this host serves the block page only", code: "NOT_FOUND" }),
        { status: 404, headers: { "content-type": "application/json", ...CORS } });
    }

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
    // A handler that set its own content-type (the HTML block page) has already
    // produced a string body; everything else is JSON-encoded as before.
    const raw = typeof r.body === "string" && r.headers?.["content-type"] !== undefined;
    return new Response(raw ? (r.body as string) : JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json", ...(r.headers ?? {}), ...CORS },
    });
  },
};
