import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decideEnrollment,
  decideUnenroll,
  isAllowedBackendUrl,
  normalizeBackendUrl,
} from "./trust-anchor.js";
import {
  ENROLL_VECTORS,
  UNENROLL_VECTORS,
  URL_VECTORS,
  VECTOR_BUNDLED_URL,
} from "./trust-vectors.js";

describe("trust anchor — enrollment", () => {
  for (const v of ENROLL_VECTORS) {
    it(v.name, () => {
      assert.deepEqual(decideEnrollment(v.attempt), v.expect);
    });
  }
});

describe("trust anchor — disconnect", () => {
  for (const v of UNENROLL_VECTORS) {
    it(v.name, () => {
      assert.deepEqual(decideUnenroll(v.input), v.expect);
    });
  }
});

describe("trust anchor — allowed addresses", () => {
  for (const v of URL_VECTORS) {
    it(v.name, () => {
      assert.equal(
        isAllowedBackendUrl(v.url, { bundledUrl: VECTOR_BUNDLED_URL, devMode: v.devMode }),
        v.expect,
      );
    });
  }
});

describe("normalizeBackendUrl", () => {
  it("strips trailing slashes and keeps a path prefix", () => {
    assert.equal(normalizeBackendUrl("https://h.example/api//"), "https://h.example/api");
  });
  it("lowercases the host but not the path", () => {
    assert.equal(normalizeBackendUrl("https://API.Example/Api"), "https://api.example/Api");
  });
  it("keeps a non-default port", () => {
    assert.equal(normalizeBackendUrl("http://localhost:8787/"), "http://localhost:8787");
  });
  it("rejects non-http(s) and junk", () => {
    for (const bad of ["", "   ", "ftp://h.example", "javascript:alert(1)", "not a url", null, undefined]) {
      assert.equal(normalizeBackendUrl(bad as string), null, String(bad));
    }
  });
});

describe("the specific hole this closes", () => {
  const pin = { v: 1 as const, backendUrl: "https://api.ajar.family", signingKeyB64: "REAL==" };

  it("an unenrolled device still refuses a new signer without the word", () => {
    // Disconnect wipes the device config but NOT the pin, so the re-connect the
    // child does next is judged against the anchor a parent set.
    const d = decideEnrollment({
      pin, backendUrl: "https://allow-all.example", signingKeyB64: "FAKE==", unlocked: false,
    });
    assert.equal(d.ok, false);
    assert.equal(d.reason, "needs-parent-word");
  });

  it("the refusal happens before the enrollment code is redeemed", () => {
    // signingKeyB64 === null is the pre-flight call, i.e. before the POST.
    const d = decideEnrollment({
      pin, backendUrl: "https://allow-all.example", signingKeyB64: null, unlocked: false,
    });
    assert.equal(d.ok, false);
  });

  it("a correctly-signed snapshot from the wrong signer is still the wrong signer", () => {
    // The point of pinning: "valid signature" and "signature by the key this
    // family enrolled with" are different claims. Only the second one is checked
    // once a pin exists.
    const d = decideEnrollment({
      pin, backendUrl: "https://api.ajar.family", signingKeyB64: "ALSO-VALID-BUT-NOT-OURS==", unlocked: false,
    });
    assert.equal(d.ok, false);
  });
});
