/**
 * Passkey ceremonies in the browser, for both the console and the signup flow.
 *
 * This file is deliberately small and does no crypto. Everything security-
 * relevant happens in two places: the browser's own WebAuthn implementation,
 * and the server (backend/src/domain/passkeys.ts). What lives here is the
 * shuttling of base64url strings in and out of the ArrayBuffers the DOM API
 * insists on — plus the error handling, which is most of the value, because
 * WebAuthn's failure modes reach the page as one opaque exception type and a
 * parent needs to be told which of them happened.
 *
 * Loaded as a plain script by BOTH /parent/index.html and /signup.html and
 * exposed on `window.AjarPasskeys`, because those two pages are served from one
 * origin — the same constraint that already makes the localStorage handoff work.
 *
 * `request(path, opts)` is injected rather than imported: the two pages each have
 * their own fetch wrapper with their own auth and error conventions, and this
 * file should not have opinions about either.
 */
(function () {
  "use strict";

  /** Whether this browser can do passkeys at all. */
  function supported() {
    return typeof window.PublicKeyCredential === "function"
      && !!navigator.credentials
      && typeof navigator.credentials.create === "function";
  }

  /** Whether this browser has a built-in authenticator (Face ID, Touch ID,
   *  Windows Hello). False does not mean "no passkeys" — a security key or a
   *  phone over Bluetooth still works — so this only ever softens wording. */
  async function hasPlatformAuthenticator() {
    try {
      return supported()
        && await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch { return false; }
  }

  // --- base64url <-> ArrayBuffer ---------------------------------------------
  // Used only when the browser lacks the JSON helpers below. Encoding, not
  // crypto: no secret is derived here and nothing is compared.

  function fromB64url(s) {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  function toB64url(buf) {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  /**
   * The server speaks the standard WebAuthn JSON shapes, so a current browser
   * converts them itself — `parseCreationOptionsFromJSON`, `toJSON()`. Those are
   * preferred wherever they exist: they track the spec as it grows fields, and
   * hand-conversion is exactly where a new field gets silently dropped.
   *
   * The manual paths below are the fallback for browsers that predate them.
   */
  function creationOptions(json) {
    if (typeof window.PublicKeyCredential.parseCreationOptionsFromJSON === "function") {
      return window.PublicKeyCredential.parseCreationOptionsFromJSON(json);
    }
    return Object.assign({}, json, {
      challenge: fromB64url(json.challenge),
      user: Object.assign({}, json.user, { id: fromB64url(json.user.id) }),
      excludeCredentials: (json.excludeCredentials || []).map((c) =>
        Object.assign({}, c, { id: fromB64url(c.id) })),
    });
  }

  function requestOptions(json) {
    if (typeof window.PublicKeyCredential.parseRequestOptionsFromJSON === "function") {
      return window.PublicKeyCredential.parseRequestOptionsFromJSON(json);
    }
    return Object.assign({}, json, {
      challenge: fromB64url(json.challenge),
      allowCredentials: (json.allowCredentials || []).map((c) =>
        Object.assign({}, c, { id: fromB64url(c.id) })),
    });
  }

  function registrationToJSON(cred) {
    if (typeof cred.toJSON === "function") return cred.toJSON();
    return {
      id: cred.id,
      rawId: toB64url(cred.rawId),
      type: cred.type,
      response: {
        attestationObject: toB64url(cred.response.attestationObject),
        clientDataJSON: toB64url(cred.response.clientDataJSON),
        transports: typeof cred.response.getTransports === "function" ? cred.response.getTransports() : undefined,
      },
      clientExtensionResults: {},
    };
  }

  function assertionToJSON(cred) {
    if (typeof cred.toJSON === "function") return cred.toJSON();
    return {
      id: cred.id,
      rawId: toB64url(cred.rawId),
      type: cred.type,
      response: {
        authenticatorData: toB64url(cred.response.authenticatorData),
        clientDataJSON: toB64url(cred.response.clientDataJSON),
        signature: toB64url(cred.response.signature),
        userHandle: cred.response.userHandle ? toB64url(cred.response.userHandle) : undefined,
      },
      clientExtensionResults: {},
    };
  }

  /**
   * Turn WebAuthn's one-exception-fits-all into something a parent can act on.
   *
   * Every one of these arrives as a DOMException, and the name is the only thing
   * separating "you cancelled" from "this browser will not do this here". Left
   * raw, they all read as an unexplained failure at the exact moment a parent is
   * being asked to trust a new security step.
   */
  function friendly(err, verb) {
    const name = err && err.name;
    if (name === "NotAllowedError") {
      // Cancelled, dismissed, or simply timed out — indistinguishable by design,
      // so the wording has to cover all three without accusing anyone.
      return new Error(`No passkey was ${verb === "create" ? "created" : "used"}. You can try again.`);
    }
    if (name === "InvalidStateError") {
      return new Error("That passkey is already on this account — pick a different device or key.");
    }
    if (name === "NotSupportedError") {
      return new Error("This device can't create a passkey. Try a phone, or a security key.");
    }
    if (name === "SecurityError") {
      // Almost always an insecure context or a mismatched rpId — a deployment
      // problem, not something the parent did.
      return new Error("Passkeys need a secure connection to ajar.family. If you're seeing this on the real site, please tell us.");
    }
    if (name === "AbortError") {
      return new Error("That took too long. Try again.");
    }
    return new Error(err && err.message ? err.message : "Something went wrong with the passkey. Try again.");
  }

  /**
   * Enrol a passkey on the signed-in account. `request` must send the caller's
   * session token; the two routes it hits both require one.
   */
  async function enroll(request, label) {
    if (!supported()) throw new Error("This browser doesn't support passkeys. Try Safari, Chrome or Edge.");
    const options = await request("/v1/me/passkeys/options", { method: "POST" });
    let credential;
    try {
      credential = await navigator.credentials.create({ publicKey: creationOptions(options) });
    } catch (err) {
      throw friendly(err, "create");
    }
    if (!credential) throw new Error("No passkey was created. You can try again.");
    return request("/v1/me/passkeys", {
      method: "POST",
      body: { credential: registrationToJSON(credential), label: label || defaultLabel() },
    });
  }

  /**
   * Finish a sign-in. `request` must send the `mfaToken` from /v1/auth/login —
   * nothing else is accepted by these two routes. Returns the token pair.
   */
  async function completeSignIn(request) {
    if (!supported()) throw new Error("This browser doesn't support passkeys. Try Safari, Chrome or Edge.");
    const options = await request("/v1/auth/passkeys/login/options", { method: "POST" });
    let credential;
    try {
      credential = await navigator.credentials.get({ publicKey: requestOptions(options) });
    } catch (err) {
      throw friendly(err, "get");
    }
    if (!credential) throw new Error("No passkey was used. You can try again.");
    return request("/v1/auth/passkeys/login", { method: "POST", body: { credential: assertionToJSON(credential) } });
  }

  /** A name the parent will recognise in a list, guessed from the platform.
   *  Wrong guesses are harmless — the label is editable nowhere yet and means
   *  nothing to the server. */
  function defaultLabel() {
    const ua = navigator.userAgent || "";
    if (/iPhone/.test(ua)) return "iPhone";
    if (/iPad/.test(ua)) return "iPad";
    if (/Macintosh/.test(ua)) return "Mac";
    if (/Android/.test(ua)) return "Android phone";
    if (/Windows/.test(ua)) return "Windows PC";
    return "Passkey";
  }

  window.AjarPasskeys = { supported, hasPlatformAuthenticator, enroll, completeSignIn, defaultLabel };
})();
