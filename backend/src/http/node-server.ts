/**
 * node:http adapter — local dev, self-host, and the single-binary build. Serves
 * the JSON API AND (optionally) the static parent console, so a self-hoster runs
 * ONE process with no separate web server and no Node toolchain on the box
 * (see docs/INSTALL.md). Converts native requests into the transport-agnostic
 * HttpRequest.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, normalize, join, extname, dirname } from "node:path";
import type { App } from "../app.js";
import { buildRouter } from "./api.js";
import { corsHeaders, type HttpRequest, type Router } from "./router.js";

// Permissive by default; set ALLOWED_ORIGIN to lock CORS to one origin.
const CORS_HEADERS = corsHeaders(process.env.ALLOWED_ORIGIN);

// Where the static parent console lives. PARENT_UI_DIR wins (empty string
// disables static serving). Otherwise pick the first directory that exists among
// the repo layout (run from backend/) and locations beside a shipped binary, so
// the single-executable release (backend + a web/ folder) just works.
function resolveUiDir(): string {
  if (process.env.PARENT_UI_DIR !== undefined) {
    return process.env.PARENT_UI_DIR ? resolve(process.env.PARENT_UI_DIR) : "";
  }
  const exeDir = dirname(process.execPath);
  for (const c of [
    resolve(process.cwd(), "../web/parent"),
    resolve(process.cwd(), "web/parent"),
    join(exeDir, "web", "parent"),
    join(exeDir, "web"),
  ]) {
    if (existsSync(join(c, "index.html"))) return c;
  }
  return "";
}
const UI_DIR = resolveUiDir();

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json",
};

async function tryServeStatic(pathname: string, nres: ServerResponse): Promise<boolean> {
  if (!UI_DIR) return false;
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const full = normalize(join(UI_DIR, rel));
  if (!full.startsWith(UI_DIR)) return false; // path-traversal guard
  try {
    const body = await readFile(full);
    nres.writeHead(200, { "content-type": MIME[extname(full)] ?? "application/octet-stream", ...CORS_HEADERS });
    nres.end(body);
    return true;
  } catch {
    return false;
  }
}

function routeApi(nreq: IncomingMessage, nres: ServerResponse, router: Router) {
  const chunks: Buffer[] = [];
  nreq.on("data", (c) => chunks.push(c as Buffer));
  nreq.on("end", async () => {
    const url = new URL(nreq.url ?? "/", "http://localhost");
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(nreq.headers)) if (typeof v === "string") headers[k.toLowerCase()] = v;
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const req: HttpRequest = {
      method: nreq.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      headers,
      params: {},
      json: async () => (rawBody ? JSON.parse(rawBody) : {}),
    };
    const res = await router.handle(req);
    nres.writeHead(res.status, { "content-type": "application/json", ...CORS_HEADERS });
    nres.end(JSON.stringify(res.body));
  });
}

export function createNodeServer(app: App) {
  const router = buildRouter(app);

  return createServer(async (nreq: IncomingMessage, nres: ServerResponse) => {
    if (nreq.method === "OPTIONS") {
      nres.writeHead(204, CORS_HEADERS);
      nres.end();
      return;
    }
    const pathname = (nreq.url ?? "/").split("?")[0]!;
    // Static parent console for non-API GETs; fall through to the API otherwise.
    if ((nreq.method ?? "GET") === "GET" && !pathname.startsWith("/v1")) {
      if (await tryServeStatic(pathname, nres)) return;
    }
    routeApi(nreq, nres, router);
  });
}
