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
import { resolve, normalize, join, extname, dirname, sep } from "node:path";
import type { App } from "../app.js";
import { buildRouter } from "./api.js";
import { corsHeaders, type HttpRequest, type Router } from "./router.js";

// Permissive by default; set ALLOWED_ORIGIN to lock CORS to one origin.
const CORS_HEADERS = corsHeaders(process.env.ALLOWED_ORIGIN);

// Where the static parent console lives. PARENT_UI_DIR wins (empty string
// disables static serving). Otherwise pick the first directory that exists among
// the repo layout (run from backend/) and locations beside a shipped binary, so
// the single-executable release (backend + a web/ folder) just works.
//
// TWO surfaces are served, and they must stay on ONE origin: the marketing +
// signup site at `/` and the console at `/parent/`. Signup writes the same
// localStorage keys the console reads, and localStorage is per-origin — split
// them across hosts and a parent finishes signing up only to land on a login
// screen. The console moved from `/` to `/parent/` rather than the other way
// round because its markup references `app.js` and `tokens.css` RELATIVELY, so
// it keeps working under a prefix while the site could not.
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
/** The site lives beside the console. Empty when the console dir is unknown. */
const SITE_DIR = UI_DIR ? resolve(UI_DIR, "..", "site") : "";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json",
};

export type Served = { body: Buffer; full: string };

/** Read one file from `dir`, refusing anything the relative path escapes to. */
export async function readUnder(dir: string, rel: string): Promise<Served | null> {
  if (!dir) return null;
  const full = normalize(join(dir, rel));
  // Compare against dir + separator. Without it a sibling directory whose name
  // merely STARTS with dir's — /web/site-old against /web/site — passes.
  if (full !== dir && !full.startsWith(dir.endsWith(sep) ? dir : dir + sep)) return null;
  try {
    return { body: await readFile(full), full };
  } catch {
    return null;
  }
}

async function tryServeStatic(pathname: string, nres: ServerResponse): Promise<boolean> {
  if (!UI_DIR) return false;

  // The console keeps its own prefix so its relative asset paths still resolve.
  const consolePath = pathname === "/parent" ? "/parent/" : pathname;
  let hit: Served | null;
  if (consolePath.startsWith("/parent/")) {
    hit = await readUnder(UI_DIR, consolePath.slice("/parent/".length) || "index.html");
  } else {
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    // Site first, then the console dir — so a deep link to a console asset that
    // predates the /parent/ prefix still resolves instead of 404ing.
    hit = (await readUnder(SITE_DIR, rel)) ?? (await readUnder(UI_DIR, rel));
  }
  if (!hit) return false;

  nres.writeHead(200, { "content-type": MIME[extname(hit.full)] ?? "application/octet-stream", ...CORS_HEADERS });
  nres.end(hit.body);
  return true;
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
    const raw = typeof res.body === "string" && res.headers?.["content-type"] !== undefined;
    nres.writeHead(res.status, {
      "content-type": "application/json", ...(res.headers ?? {}), ...CORS_HEADERS,
    });
    nres.end(raw ? (res.body as string) : JSON.stringify(res.body));
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
