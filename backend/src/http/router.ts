/**
 * Tiny transport-agnostic router. Adapters (node:http, Workers fetch) convert
 * their native request into `HttpRequest` and render `HttpResponse` back.
 */
export interface HttpRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  json<T = unknown>(): Promise<T>;
  params: Record<string, string>;
}

export interface HttpResponse {
  status: number;
  body: unknown;
}

export type Handler = (req: HttpRequest) => Promise<HttpResponse>;

interface Route { method: string; parts: string[]; handler: Handler }

export const ok = (body: unknown, status = 200): HttpResponse => ({ status, body });
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

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler): this {
    this.routes.push({ method: method.toUpperCase(), parts: split(path), handler });
    return this;
  }
  get(p: string, h: Handler) { return this.add("GET", p, h); }
  post(p: string, h: Handler) { return this.add("POST", p, h); }
  del(p: string, h: Handler) { return this.add("DELETE", p, h); }

  /** Registered routes as `{ method, path }` (path with `:param` segments).
   *  Used by the OpenAPI contract test to detect spec/route drift. */
  list(): Array<{ method: string; path: string }> {
    return this.routes.map((r) => ({ method: r.method, path: "/" + r.parts.join("/") }));
  }

  async handle(req: HttpRequest): Promise<HttpResponse> {
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
        const status = codeToStatus(anyE.code);
        return err(status, anyE.message ?? "error", anyE.code);
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

function codeToStatus(code?: string): number {
  switch (code) {
    case "FORBIDDEN": return 403;
    case "NOT_FOUND": return 404;
    case "CONFLICT": return 409;
    case "GONE": return 410;
    case "UNAUTHORIZED": return 401;
    default: return 400;
  }
}
