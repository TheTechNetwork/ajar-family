/**
 * Print the next CFBundleVersion to use for an App Store Connect upload.
 *
 *   ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_P8=… BUNDLE_ID=… node asc-next-build.mjs
 *
 * ## Why this exists
 *
 * The workflow used `github.run_number`. That is a per-workflow counter which
 * knows nothing about builds uploaded any other way, so the first CI run asked
 * App Store Connect to accept build `1` — a number a manual Xcode upload had
 * already used — and the upload failed after a full archive and export:
 *
 *   ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE
 *   The bundle version must be higher than the previously uploaded version: '1'
 *
 * Asking Apple for the highest build it already holds is the only source that
 * cannot drift, because it is the same registry that rejects the duplicate. It
 * also self-heals: upload by hand from Xcode, and the next CI run steps over it
 * instead of colliding.
 *
 * ## Fallback
 *
 * If the query fails (network, a key without App Manager, an app record that
 * does not exist yet) this prints a MONOTONIC timestamp rather than failing the
 * build: whole minutes since 2026-01-01, which is ~7 digits now and stays inside
 * the 32-bit range Apple accepts for a CFBundleVersion component until well past
 * 2100. It deliberately does NOT fall back to run_number — that is the value
 * that caused the collision, and a fallback that reintroduces the bug is worse
 * than no fallback at all.
 */
import { createSign } from "node:crypto";

const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8, BUNDLE_ID } = process.env;

const EPOCH_2026 = Date.UTC(2026, 0, 1);
const timestampFallback = () => String(Math.floor((Date.now() - EPOCH_2026) / 60000));

function token() {
  const b64u = (b) => Buffer.from(b).toString("base64url");
  const header = b64u(JSON.stringify({ alg: "ES256", kid: ASC_KEY_ID, typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64u(JSON.stringify({
    iss: ASC_ISSUER_ID, iat: now, exp: now + 600, aud: "appstoreconnect-v1",
  }));
  const signer = createSign("SHA256");
  signer.update(`${header}.${payload}`);
  // `ieee-p1363` is the raw r||s form JWS requires. node's default DER encoding
  // is accepted by nothing and surfaces as a bare 401.
  const sig = signer.sign({ key: ASC_KEY_P8, dsaEncoding: "ieee-p1363" });
  return `${header}.${payload}.${sig.toString("base64url")}`;
}

async function asc(path) {
  const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    headers: { authorization: `Bearer ${token()}` },
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

try {
  if (!ASC_KEY_ID || !ASC_ISSUER_ID || !ASC_KEY_P8 || !BUNDLE_ID) {
    throw new Error("ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8 and BUNDLE_ID are all required");
  }
  const apps = await asc(`/v1/apps?filter[bundleId]=${encodeURIComponent(BUNDLE_ID)}&limit=1`);
  const app = apps.data?.[0];
  if (!app) throw new Error(`no App Store Connect record for ${BUNDLE_ID}`);

  // Every build, not just the newest train: a version is unique per app, so a
  // build left behind on an older marketing version still blocks its number.
  const builds = await asc(`/v1/builds?filter[app]=${app.id}&limit=200&sort=-uploadedDate`);
  const highest = (builds.data ?? [])
    .map((b) => Number.parseInt(b.attributes?.version ?? "", 10))
    .filter(Number.isFinite)
    .reduce((a, b) => Math.max(a, b), 0);

  // Never go backwards if Apple reports nothing: an empty list on a brand-new
  // record legitimately means 0, and 1 is then correct.
  console.log(String(highest + 1));
} catch (e) {
  process.stderr.write(`asc-next-build: falling back to a timestamp — ${e.message}\n`);
  console.log(timestampFallback());
}
