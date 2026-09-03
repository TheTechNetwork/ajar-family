/**
 * CI signing setup for Ajar — idempotent, re-runnable.
 *
 *   node tools/apple/setup-ci.mjs
 *
 * Creates an Apple Distribution certificate from the LOCAL CSR (so we hold the
 * private key — the team's existing distribution certs are cloud-managed and
 * Apple holds those keys, which is why they cannot be exported as a .p12),
 * assembles the .p12, mints an App Store profile per target bound to that
 * certificate, and sets every GitHub secret and variable the TestFlight
 * workflows need.
 *
 * Prints NO key material. Values go to `gh` over stdin.
 *
 * ## Why this lives in the repository now
 *
 * It ran from `~/.ajar-signing` on one laptop, so nothing here recorded that
 * provisioning was automated at all. `APPLE_ACCOUNT_SETUP.md` §5 described a
 * manual portal flow nobody had performed, §3 claimed CI minted profiles by
 * itself, and when the Safari extension became a fourth signable target the
 * TestFlight run stopped at `Not configured: APPLE_PROFILE_SAFARI(secret)` with
 * no obvious way forward. The script is the actual process; it belongs where the
 * process is documented.
 *
 * Credentials are NOT here. `~/.ajar-signing` still holds the CSR, its private
 * key and the ASC `.p8`; this reads them from there (`AJAR_SIGNING_DIR` to move
 * it) and never copies them into the tree.
 */
import { asc, SIGNING_DIR as DIR, KEY_ID, ISSUER } from "./asc.mjs";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const TEAM = process.env.APPLE_TEAM_ID ?? "2BPX4R682U";

// The App Group every Ajar target shares. A profile that does not carry it looks
// valid and then fails to sign, so it is asserted below rather than assumed.
const APP_GROUP = "group.family.ajar.filter";

// Post-rename ids. The extensions dropped the "Filter" prefix — they are
// .DataProvider and .ControlProvider, not .FilterDataProvider.
const TARGETS = [
  { bundle: "family.ajar.filter",                 secret: "APPLE_PROFILE_APP",     name: "Ajar", appGroup: true },
  { bundle: "family.ajar.filter.DataProvider",    secret: "APPLE_PROFILE_DATA",    name: "Ajar Data Provider", appGroup: true },
  { bundle: "family.ajar.filter.ControlProvider", secret: "APPLE_PROFILE_CONTROL", name: "Ajar Control Provider", appGroup: true },
  // Added when the Safari Web Extension became a target INSIDE the filter app
  // (ADR-018): one app, one enrolment, one device identity. It is a fourth
  // signable target, so it needs a fourth App ID, profile and secret — a profile
  // is bound to exactly one App ID, and the wildcard App ID that would span
  // several cannot carry App Groups, which is the entitlement it exists to use.
  { bundle: "family.ajar.filter.SafariExtension", secret: "APPLE_PROFILE_SAFARI",  name: "Ajar Safari Extension", appGroup: true },
  // The parent app is a separate product with its own ASC record. One target,
  // no extensions, no App Group — so one profile and one secret.
  { bundle: "family.ajar.parent",                 secret: "APPLE_PROFILE_PARENT",  name: "Ajar Parent", appGroup: false },
];

// The repo moved to an org and was renamed.
const REPO = process.env.AJAR_REPO ?? "TheTechNetwork/ajar-family";

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts });
const ghSet = (name, value, kind = "secret") =>
  execFileSync("gh", [kind, "set", name, "--repo", REPO], { input: value, encoding: "utf8" });

// ---------------------------------------------------------------- certificate
let certId;
if (existsSync(`${DIR}/cert-id.txt`) && existsSync(`${DIR}/dist.cer`)) {
  certId = readFileSync(`${DIR}/cert-id.txt`, "utf8").trim();
  console.log(`reusing certificate ${certId}`);
} else {
  const csr = readFileSync(`${DIR}/dist.csr`, "utf8");
  const r = await asc("POST", "/v1/certificates", {
    data: { type: "certificates", attributes: { certificateType: "DISTRIBUTION", csrContent: csr } },
  });
  certId = r.data.id;
  writeFileSync(`${DIR}/dist.cer`, Buffer.from(r.data.attributes.certificateContent, "base64"));
  writeFileSync(`${DIR}/cert-id.txt`, certId);
  console.log(`created certificate ${certId} — ${r.data.attributes.displayName}, expires ${r.data.attributes.expirationDate?.slice(0, 10)}`);
}

// ------------------------------------------------------------------------ p12
sh("openssl", ["x509", "-inform", "DER", "-in", `${DIR}/dist.cer`, "-out", `${DIR}/dist.pem`]);

// The Apple WWDR intermediate, so the .p12 carries a complete chain. Without it
// codesign depends on the runner already trusting the issuer; with it the
// keychain has everything it needs.
let certfile = [];
try {
  const wwdr = await fetch("https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer");
  if (wwdr.ok) {
    writeFileSync(`${DIR}/wwdr.cer`, Buffer.from(await wwdr.arrayBuffer()));
    sh("openssl", ["x509", "-inform", "DER", "-in", `${DIR}/wwdr.cer`, "-out", `${DIR}/wwdr.pem`]);
    certfile = ["-certfile", `${DIR}/wwdr.pem`];
    console.log("bundling the Apple WWDR G3 intermediate into the .p12");
  }
} catch { console.log("could not fetch the WWDR intermediate — continuing without it"); }

// Hex, not base64: this password travels through a GitHub secret into
// `security import -P` on the runner. Base64 can contain / and +, which are
// exactly the characters that get mangled somewhere in that chain and produce
// an "MAC verification failed" that looks like a corrupt .p12.
const p12pw = sh("openssl", ["rand", "-hex", "24"]).trim();
// `-legacy` matters: OpenSSL 3 defaults to AES-256-CBC + PBKDF2, which macOS
// `security import` on the runner can reject outright. The legacy algorithms are
// what Keychain Access itself writes, so they import without argument.
const p12args = ["pkcs12", "-export", "-inkey", `${DIR}/dist.key`, "-in", `${DIR}/dist.pem`,
                 ...certfile, "-out", `${DIR}/dist.p12`, "-passout", `pass:${p12pw}`];
try { sh("openssl", [...p12args.slice(0, 1), "-legacy", ...p12args.slice(1)]); console.log("built dist.p12 (legacy algorithms)"); }
catch { sh("openssl", p12args); console.log("built dist.p12"); }

// Prove the .p12 actually contains the private key before shipping it as a
// secret. A cert-only .p12 imports fine and then fails to sign, which is a
// miserable failure to debug from a CI log.
// Read it back with -legacy FIRST. The file was written with legacy algorithms,
// and OpenSSL 3 cannot parse those without the legacy provider — so the obvious
// probe fails on a .p12 that is perfectly good, which is what happened here.
let probe = "";
for (const args of [["pkcs12", "-legacy", "-in", `${DIR}/dist.p12`, "-nodes", "-passin", `pass:${p12pw}`],
                    ["pkcs12", "-in", `${DIR}/dist.p12`, "-nodes", "-passin", `pass:${p12pw}`]]) {
  try { probe = sh("openssl", args, { stdio: ["ignore", "pipe", "ignore"] }); break; } catch {}
}
if (!probe.includes("PRIVATE KEY")) throw new Error("the .p12 has no private key in it — refusing to continue");
console.log("verified: the .p12 contains its private key");

// -------------------------------------------------------------------- profiles
const bundles = (await asc("GET", "/v1/bundleIds?limit=200")).data;
const existing = (await asc("GET", "/v1/profiles?limit=200")).data;

for (const t of TARGETS) {
  let bundle = bundles.find((b) => b.attributes.identifier === t.bundle);

  // Register a target the team does not have yet. This used to throw, which is
  // what a new target hit: the script refused, the portal was the only way
  // forward, and nothing said so. Creating it here keeps "add a target" a code
  // change rather than a click somewhere nobody wrote down.
  if (!bundle) {
    const r = await asc("POST", "/v1/bundleIds", {
      data: { type: "bundleIds", attributes: { identifier: t.bundle, name: t.name, platform: "IOS" } },
    });
    bundle = r.data;
    console.log(`registered bundle id ${t.bundle} (${bundle.id})`);
  }

  // App Groups has to be ENABLED on the App ID before a profile is generated —
  // a profile bakes in the entitlements present at generation time, so enabling
  // it afterwards means regenerating, not editing the .entitlements file.
  // Already-enabled returns a conflict, which is success on a re-run.
  if (t.appGroup) {
    try {
      await asc("POST", "/v1/bundleIdCapabilities", {
        data: {
          type: "bundleIdCapabilities",
          attributes: { capabilityType: "APP_GROUPS" },
          relationships: { bundleId: { data: { type: "bundleIds", id: bundle.id } } },
        },
      });
      console.log(`  enabled APP_GROUPS on ${t.bundle}`);
    } catch (e) {
      if (!/409|already|exist/i.test(String(e.message))) throw e;
    }
  }

  const name = `Ajar CI App Store ${t.bundle}`;

  // A profile is immutable: to bind it to the new certificate the old one of the
  // same name has to go, or Apple refuses the name as taken.
  for (const p of existing.filter((p) => p.attributes.name === name)) {
    await asc("DELETE", `/v1/profiles/${p.id}`);
    console.log(`  removed previous profile ${p.id}`);
  }

  const r = await asc("POST", "/v1/profiles", {
    data: {
      type: "profiles",
      attributes: { name, profileType: "IOS_APP_STORE" },
      relationships: {
        bundleId: { data: { type: "bundleIds", id: bundle.id } },
        certificates: { data: [{ type: "certificates", id: certId }] },
      },
    },
  });
  const content = r.data.attributes.profileContent; // already base64

  // ASSERT the App Group actually made it in. Enabling the capability via the
  // API does not always select WHICH group — that part can still need the
  // portal — and a profile missing it looks completely valid until codesign
  // rejects it twenty minutes into an archive. The entitlements live as plain
  // text inside the CMS blob, so a substring is enough and needs no Mac tooling.
  if (t.appGroup && !Buffer.from(content, "base64").includes(APP_GROUP)) {
    throw new Error(
      `the profile minted for ${t.bundle} does not carry ${APP_GROUP}.\n` +
      `  Enable App Groups on that App ID in the portal and select ${APP_GROUP},\n` +
      `  then re-run. The API can turn the capability on but not always choose the group.`,
    );
  }

  writeFileSync(`${DIR}/${t.secret}.mobileprovision`, Buffer.from(content, "base64"));
  ghSet(t.secret, content);
  console.log(`${t.secret}: ${t.bundle} -> profile ${r.data.id}, secret set${t.appGroup ? `, carries ${APP_GROUP}` : ""}`);
}

// --------------------------------------------------------------------- secrets
ghSet("APPLE_DIST_P12", readFileSync(`${DIR}/dist.p12`).toString("base64"));
ghSet("APPLE_DIST_P12_PASSWORD", p12pw);
ghSet("ASC_KEY_ID", KEY_ID);
ghSet("ASC_ISSUER_ID", ISSUER);
ghSet("ASC_KEY_P8", readFileSync(`${DIR}/AuthKey_${KEY_ID}.p8`, "utf8")); // raw PEM, NOT base64
ghSet("APPLE_TEAM_ID", TEAM, "variable");

console.log("\nAll secrets set. Verify with: gh secret list");
