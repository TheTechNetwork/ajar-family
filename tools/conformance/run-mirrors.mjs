/**
 * Runs the shared conformance corpus against the hand-written JS mirrors of the
 * evaluator (Windows MV3 + macOS Safari), which cannot be imported normally
 * because they call browser-extension APIs at module scope. We stub just enough
 * of `chrome`/`browser` to import them, then execute the SAME vectors the shared
 * TypeScript is held to. Any disagreement fails CI.
 *
 * This is the guard against silent mirror drift — the failure mode where each
 * implementation's own tests pass while the platforms disagree about what is
 * actually blocked.
 *
 *   node tools/conformance/run-mirrors.mjs
 */
import { VECTORS } from "../../shared/dist/conformance/vectors.js";

function stubExtensionApis() {
  const noop = () => {};
  const listener = { addListener: noop, removeListener: noop };
  const api = {
    runtime: { connectNative: () => ({ onMessage: listener, onDisconnect: listener, postMessage: noop }),
               onMessage: listener, getURL: (p) => `chrome-extension://test/${p}`, lastError: null },
    storage: { local: { get: (_k, cb) => { if (typeof cb === "function") cb({}); return Promise.resolve({}); },
                        set: () => Promise.resolve() },
               onChanged: listener },
    webRequest: { onBeforeRequest: listener },
    webNavigation: { onBeforeNavigate: listener, onCommitted: listener, onHistoryStateUpdated: listener },
    tabs: { update: noop, query: () => Promise.resolve([]) },
    declarativeNetRequest: { updateDynamicRules: () => Promise.resolve() },
  };
  globalThis.chrome = api;
  globalThis.browser = api;
  if (!globalThis.performance) globalThis.performance = { now: () => 0 };
  // The mirrors fetch policy/filters on load; keep them offline and quiet.
  globalThis.fetch = () => Promise.reject(new Error("offline in conformance run"));
}

const MIRRORS = [
  { id: "windows", path: "../../windows/extension/background.js" },
  { id: "macos", path: "../../apple/SafariExtension/Extension/background.js" },
];

stubExtensionApis();

let failures = 0, checked = 0;
for (const m of MIRRORS) {
  const mod = await import(new URL(m.path, import.meta.url).href);
  if (typeof mod.evaluate !== "function") {
    console.error(`FAIL ${m.id}: does not export evaluate()`);
    failures++; continue;
  }
  for (const v of VECTORS) {
    if (v.skipFor?.includes(m.id)) continue;
    checked++;
    let got;
    try { got = mod.evaluate(v.snapshot, v.ctx); }
    catch (e) { console.error(`FAIL [${m.id}] ${v.name}\n  threw: ${e.message}`); failures++; continue; }
    if (got.action !== v.expect.action) {
      console.error(`FAIL [${m.id}] ${v.name}\n  expected ${v.expect.action}, got ${got.action} (reason=${got.reason})`);
      failures++;
    }
  }
}
console.log(`conformance: ${checked - failures}/${checked} vector-checks passed across ${MIRRORS.length} mirrors`);
if (failures) { console.error(`\n${failures} conformance failure(s) — a mirror has drifted from shared/policy/policy-model.ts`); process.exit(1); }
