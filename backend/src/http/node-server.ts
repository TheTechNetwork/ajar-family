/**
 * node:http adapter — local dev and any Node host. Converts native requests into
 * the transport-agnostic HttpRequest and renders JSON responses.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { App } from "../app.js";
import { buildRouter } from "./api.js";
import { CORS_HEADERS, type HttpRequest } from "./router.js";

export function createNodeServer(app: App) {
  const router = buildRouter(app);

  return createServer((nreq: IncomingMessage, nres: ServerResponse) => {
    // CORS preflight — answer immediately, no routing.
    if (nreq.method === "OPTIONS") {
      nres.writeHead(204, CORS_HEADERS);
      nres.end();
      return;
    }
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
      const payload = JSON.stringify(res.body);
      nres.writeHead(res.status, { "content-type": "application/json", ...CORS_HEADERS });
      nres.end(payload);
    });
  });
}
