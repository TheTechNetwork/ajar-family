/**
 * Emit backend/openapi.json from the built OpenAPI module, so the spec can be
 * imported into Swagger UI / Postman / codegen without running the server.
 * Run after `npm run build`. Kept in sync by the openapi.test.ts contract test.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { openapiDocument } = await import(join(here, "..", "dist", "http", "openapi.js"));
const out = join(here, "..", "openapi.json");
writeFileSync(out, JSON.stringify(openapiDocument, null, 2) + "\n");
// eslint-disable-next-line no-console
console.log(`wrote ${out}`);
