/**
 * Tiny transport-agnostic router. Adapters (node:http, Workers fetch) convert
 * their native request into `HttpRequest` and render `HttpResponse` back.
 */
export interface HttpRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  /**
   * The query string exactly as it arrived, without the leading `?` — parsed by
   * nobody, decoded by nobody.
   *
   * `query` is right for every route but one. The iOS content filter builds the
   * block page's URL by substituting the blocked flow URL into `?u=…` WITHOUT
   * percent-encoding it (the substitution is the system's, not ours), so a
   * target carrying its own query arrives with live `&`s and `URLSearchParams`
   * splits it into pieces. See `/blocked` in http/api.ts.
   *
   * Optional because a test harness constructing an HttpRequest by hand has no
   * raw string to give; the one route that needs it falls back to `query`.
   */
  rawQuery?: string;
  headers: Record<string, string>;
  json<T = unknown>(): Promise<T>;
  params: Record<string, string>;
}

export interface HttpResponse {
  status: number;
  body: unknown;
  /**
   * Extra response headers. Set a non-JSON `content-type` here and the transport
   * adapters send `body` verbatim instead of JSON-encoding it — which is how the
   * one HTML route in this API (the Request-Access block page) is served without
   * giving every JSON route a second code path.
   */
  headers?: Record<string, string>;
}

export type Handler = (req: HttpRequest) => Promise<HttpResponse>;

interface Route { method: string; parts: string[]; handler: Handler }

export const ok = (body: unknown, status = 200): HttpResponse => ({ status, body });
/** An HTML page. `markup` is sent as-is — callers must escape interpolations. */
export const html = (markup: string, status = 200): HttpResponse =>
  ({ status, body: markup, headers: { "content-type": "text/html; charset=utf-8" } });
export const err = (status: number, message: string, code?: string): HttpResponse =>
  ({ status, body: { error: message, code } });

/**
 * Permissive CORS for the alpha so a web parent UI on another origin can call the
 * API (the browser extension bypasses CORS via host permissions and doesn't need
 * this). Bearer-token auth, no cookies, so `*` is safe. Production should restrict
 * the origin. Applied by both transport adapters; OPTIONS preflight is answered
 * transport-side with 204.
 */
export function corsHeaders(origin = "*"): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-max-age": "86400",
    ...(origin === "*" ? {} : { vary: "Origin" }),
  };
}
/** Default permissive CORS (bearer tokens, no cookies, so `*` is safe). Set an
 *  explicit origin via ALLOWED_ORIGIN (Node) / env.ALLOWED_ORIGIN (Workers) to
 *  lock it down for production. */
export const CORS_HEADERS: Record<string, string> = corsHeaders();

/** A pre-dispatch guard: return a response to short-circuit, or null to continue. */
export type PreGuard = (req: HttpRequest) => HttpResponse | null | Promise<HttpResponse | null>;

export class Router {
  private routes: Route[] = [];
  private guards: PreGuard[] = [];

  /** Register a guard that runs on every request before route matching (e.g. a
   *  baseline rate limit). Guards run in order; the first to return a response wins. */
  before(guard: PreGuard): this { this.guards.push(guard); return this; }

  add(method: string, path: string, handler: Handler): this {
    this.routes.push({ method: method.toUpperCase(), parts: split(path), handler });
    return this;
  }
  get(p: string, h: Handler) { return this.add("GET", p, h); }
  post(p: string, h: Handler) { return this.add("POST", p, h); }
  put(p: string, h: Handler) { return this.add("PUT", p, h); }
  del(p: string, h: Handler) { return this.add("DELETE", p, h); }

  /** Registered routes as `{ method, path }` (path with `:param` segments).
   *  Used by the OpenAPI contract test to detect spec/route drift. */
  list(): Array<{ method: string; path: string }> {
    return this.routes.map((r) => ({ method: r.method, path: "/" + r.parts.join("/") }));
  }

  async handle(req: HttpRequest): Promise<HttpResponse> {
    for (const g of this.guards) {
      const short = await g(req);
      if (short) return short;
    }
    const reqParts = split(req.path);
    for (const r of this.routes) {
      if (r.method !== req.method.toUpperCase()) continue;
      const params = match(r.parts, reqParts);
      if (!params) continue;
      req.params = params;
      try {
        return await r.handler(req);
      } catch (e) {
        const anyE = e as { code?: string; message?: string };
        // A DomainError is a DELIBERATE refusal: its code is one we publish and
        // its message is written to be read by a parent. Anything else is a bug
        // in this server, and NEITHER its message nor a 4xx belongs in the reply.
        //
        // This used to echo `e.message` whatever `e` was. A malformed approval
        // duration therefore returned "Cannot destructure property 'expiresAt'
        // of 'durationToExpiry(...)' as it is undefined" to a parent — an
        // internal TypeError shown to a user. Worse, `codeToStatus(undefined)`
        // falls through to 400, so every server bug was reported as a CLIENT
        // error: a 500 never appeared, and nothing alerting on 5xx could see it.
        if (anyE.code !== undefined && CLIENT_FACING_CODES.has(anyE.code)) {
          return err(codeToStatus(anyE.code), anyE.message ?? "error", anyE.code);
        }
        // Server-side only: the detail stays in the logs, where it is useful and
        // not disclosed. Method and path only — never headers or the body.
        console.error(`[router] unhandled error ${req.method} ${req.path}`, e);
        return err(500, "internal error", "INTERNAL");
      }
    }
    return err(404, "not found", "NOT_FOUND");
  }
}

function split(path: string): string[] {
  return path.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
}

function match(routeParts: string[], reqParts: string[]): Record<string, string> | null {
  if (routeParts.length !== reqParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < routeParts.length; i++) {
    const rp = routeParts[i]!, qp = reqParts[i]!;
    if (rp.startsWith(":")) params[rp.slice(1)] = decodeURIComponent(qp);
    else if (rp !== qp) return null;
  }
  return params;
}

/** Codes a handler may deliberately surface to a client. Anything outside this
 *  set is treated as a bug and answered with a generic 500 — see the catch in
 *  `handle`. Keep in step with `DomainError`'s codes. */
// Codes whose MESSAGE is safe and useful to show a caller. Mostly client
// errors; SERVICE_UNAVAILABLE is the exception and is deliberate — it says a
// dependency of ours is down, which is our fault, but "we could not send the
// email, try again shortly" is worth infinitely more to a parent than the
// generic 500 they used to get.
const CLIENT_FACING_CODES = new Set([
  "BAD_REQUEST", "UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "CONFLICT", "GONE",
  "SERVICE_UNAVAILABLE",
]);

function codeToStatus(code?: string): number {
  switch (code) {
    case "FORBIDDEN": return 403;
    case "NOT_FOUND": return 404;
    case "CONFLICT": return 409;
    case "GONE": return 410;
    case "UNAUTHORIZED": return 401;
    case "SERVICE_UNAVAILABLE": return 503;
    default: return 400;
  }
}
