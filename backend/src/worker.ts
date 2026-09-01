/**
 * Cloudflare Workers entrypoint (fetch handler). Reuses the same App + Router as
 * the Node server. Signing uses WebCrypto Ed25519, which Workers supports.
 *
 * It also serves the marketing site, the signup flow and the parent console from
 * the `[assets]` binding, for one reason: signup hands off to the console through
 * localStorage, which is per-origin. The API is already on api.ajar.family, so
 * putting the pages anywhere else would break that handoff silently. Routing
 * mirrors node-server.ts so the two adapters cannot drift.
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
  /**
   * Static site + parent console, uploaded by `[assets]` in wrangler.toml.
   * Typed structurally rather than as workers-types' `Fetcher` so the backend
   * keeps zero dependencies. Optional because a Worker deployed from a config
   * without the block still has to build and serve the API.
   */
  ASSETS?: { fetch(request: Request): Promise<Response> };
}

/**
 * Public path -> the path the asset actually sits at, in preference order.
 *
 * This is `tryServeStatic` in node-server.ts, transposed. The two adapters have
 * to agree: a parent's browser cannot tell them apart, and a route that only
 * works locally is a route nobody tests. The difference is that on Workers there
 * is one flat asset store instead of two directories, so the directory names are
 * part of the stored path — hence the `/site/` and `/parent/` prefixes here
 * where node-server picks between SITE_DIR and UI_DIR.
 *
 * The console keeps its `/parent/` prefix because its markup references `app.js`
 * and `tokens.css` RELATIVELY; the site could not survive a prefix, so it took
 * the root and the console moved. See web/site/README.md.
 */
export function assetCandidates(pathname: string): string[] {
  const consolePath = pathname === "/parent" ? "/parent/" : pathname;
  if (consolePath.startsWith("/parent/")) {
    return [`/parent/${consolePath.slice("/parent/".length) || "index.html"}`];
  }
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  // Site first, then the console dir — so a deep link to a console asset that
  // predates the /parent/ prefix still resolves instead of 404ing. It is also
  // what makes `/parent` (no trailing slash) work: the page is served there, the
  // browser resolves `app.js` against `/`, and this fallback finds it.
  return [`/site/${rel}`, `/parent/${rel}`];
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

/**
 * Ask the assets binding for the first candidate that exists. Returns null when
 * nothing matches, so the caller can fall through to the API router — which is
 * what still produces /blocked and the JSON 404.
 *
 * `not_found_handling = "none"` in wrangler.toml is what makes a miss a 404 here
 * rather than a 200 with some fallback page; if that setting changes, this
 * function silently starts claiming every path exists.
 */
async function serveAsset(request: Request, url: URL, env: Env, cors: Record<string, string>): Promise<Response | null> {
  if (!env.ASSETS) return null;
  for (const candidate of assetCandidates(url.pathname)) {
    // A fresh Request so the asset store is asked for the STORED path, not the
    // public one. Method and headers are carried over; a GET has no body.
    const res = await env.ASSETS.fetch(new Request(new URL(candidate, url.origin), request));
    if (res.status === 404) continue;
    // Response headers off the binding are immutable, so copy before adding the
    // same CORS headers every other response on this Worker carries.
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  }
  return null;
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

    // Static site + console for non-API GETs; fall through to the API otherwise.
    // Same shape and same order as node-server.ts, deliberately: GET only, and
    // never for /v1, so no static file can shadow an API route however the web/
    // folder grows.
    //
    // This sits AFTER the blocked.* guard, which is the whole reason
    // wrangler.toml sets run_worker_first. `blocked.*` reaches here only for
    // /blocked, and that path is not an asset — but the guard, not the absence
    // of a file, is what keeps the site off that hostname.
    if (request.method === "GET" && !url.pathname.startsWith("/v1")) {
      const asset = await serveAsset(request, url, env, CORS);
      if (asset) return asset;
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
