/**
 * OpenAPI 3.1 description of the Ajar backend REST API — the single source of
 * truth the iOS / macOS / Windows clients integrate against. Served live at
 * GET /openapi.json and emitted to backend/openapi.json by scripts/gen-openapi.mjs.
 *
 * A contract test (openapi.test.ts) asserts this document and the router expose
 * exactly the same set of (method, path) pairs, so the spec cannot silently drift.
 * Keep it in lockstep with buildRouter() in api.ts.
 */

// Reusable component schemas mirror the domain model (domain/model.ts) and the
// shared policy types (@ajar/shared/policy).
const schemas = {
  Error: {
    type: "object",
    properties: { error: { type: "string" }, code: { type: "string" } },
    required: ["error"],
  },
  Role: { type: "string", enum: ["OWNER", "PARENT", "LIMITED_GUARDIAN"] },
  Platform: { type: "string", enum: ["IOS", "IPADOS", "MACOS", "WINDOWS"] },
  RuleAction: { type: "string", enum: ["ALLOW", "BLOCK"] },
  PolicyTargetType: {
    type: "string",
    enum: ["DOMAIN", "URL", "URL_PATTERN", "YOUTUBE_VIDEO", "YOUTUBE_CHANNEL", "YOUTUBE_PLAYLIST", "CATEGORY", "APPLICATION"],
  },
  ApprovalScope: {
    type: "string",
    enum: ["THIS_REQUEST", "THIS_URL", "THIS_VIDEO", "THIS_CHANNEL", "THIS_DOMAIN", "THIS_DEVICE", "THIS_CHILD", "WHOLE_FAMILY"],
  },
  ApprovalDuration: {
    oneOf: [
      { type: "object", properties: { kind: { const: "MINUTES" }, minutes: { type: "integer" } }, required: ["kind", "minutes"] },
      { type: "object", properties: { kind: { const: "UNTIL_END_OF_DAY" } }, required: ["kind"] },
      {
        type: "object",
        description:
          "Single use. Produces a grant the device must report as consumed via POST /v1/devices/{deviceId}/grants/{ruleId}/consume; it is dropped from every snapshot from that moment. A 5-minute TTL is the backstop if the device never reports.",
        properties: { kind: { const: "ONCE" } }, required: ["kind"],
      },
      { type: "object", properties: { kind: { const: "ALWAYS" } }, required: ["kind"] },
    ],
  },
  RuleScope: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["FAMILY", "CHILD", "DEVICE"] },
      familyId: { type: "string" },
      childId: { type: "string" },
      deviceId: { type: "string" },
    },
    required: ["type", "familyId"],
  },
  User: {
    type: "object",
    properties: {
      id: { type: "string" }, email: { type: "string", format: "email" },
      displayName: { type: "string" }, createdAt: { type: "string", format: "date-time" },
    },
    required: ["id", "email", "displayName", "createdAt"],
  },
  Family: {
    type: "object",
    properties: { id: { type: "string" }, name: { type: "string" }, createdAt: { type: "string", format: "date-time" } },
    required: ["id", "name", "createdAt"],
  },
  FamilyMembership: {
    type: "object",
    properties: {
      id: { type: "string" }, familyId: { type: "string" }, userId: { type: "string" },
      role: { $ref: "#/components/schemas/Role" },
      assignedChildIds: { type: "array", items: { type: "string" } },
      createdAt: { type: "string", format: "date-time" },
    },
    required: ["id", "familyId", "userId", "role", "assignedChildIds", "createdAt"],
  },
  Child: {
    type: "object",
    properties: {
      id: { type: "string" }, familyId: { type: "string" },
      displayName: { type: "string" },
      timezone: {
        type: "string", default: "UTC",
        description: "IANA time zone (e.g. America/Los_Angeles). Determines when an UNTIL_END_OF_DAY approval expires — the child's local midnight, not UTC.",
      },
      createdAt: { type: "string", format: "date-time" },
    },
    required: ["id", "familyId", "displayName", "timezone", "createdAt"],
  },
  Device: {
    type: "object",
    properties: {
      id: { type: "string" }, familyId: { type: "string" }, childId: { type: "string" },
      platform: { $ref: "#/components/schemas/Platform" }, displayName: { type: "string" },
      devicePublicKey: { type: "string", description: "base64 raw Ed25519 public key" },
      enrolledAt: { type: "string", format: "date-time" },
      lastSyncedVersion: { type: "integer", description: "Policy version this device last actually pulled." },
      lastSeenAt: { type: "string", format: "date-time", description: "Last contact with the backend. Absent = never since enrollment." },
    },
    required: ["id", "familyId", "childId", "platform", "displayName", "devicePublicKey", "enrolledAt", "lastSyncedVersion"],
  },
  DeviceStatus: {
    allOf: [
      { $ref: "#/components/schemas/Device" },
      {
        type: "object",
        description: "A device plus whether protection is demonstrably still running on it.",
        properties: {
          currentVersion: { type: "integer", description: "Current policy version for this device's child." },
          upToDate: { type: "boolean", description: "The device has pulled the current version." },
          stale: { type: "boolean", description: "No contact for over 24 hours — treat protection as unverified." },
        },
        required: ["currentVersion", "upToDate", "stale"],
      },
    ],
  },
  PolicyRule: {
    type: "object",
    properties: {
      id: { type: "string" }, target: { $ref: "#/components/schemas/PolicyTargetType" },
      value: { type: "string" }, action: { $ref: "#/components/schemas/RuleAction" },
      scope: { $ref: "#/components/schemas/RuleScope" }, priority: { type: "integer" },
      createdAt: { type: "string", format: "date-time" }, createdBy: { type: "string" },
    },
    required: ["id", "target", "value", "action", "scope", "createdAt", "createdBy"],
  },
  TemporaryRule: {
    allOf: [
      { $ref: "#/components/schemas/PolicyRule" },
      {
        type: "object",
        properties: {
          startsAt: { type: "string", format: "date-time" },
          expiresAt: { type: "string", format: "date-time" },
          requestId: { type: "string" }, approvedBy: { type: "string" },
          grantKind: { type: "string", enum: ["TIMED", "ONCE", "UNTIL_END_OF_DAY"] },
        },
        required: ["startsAt", "expiresAt", "requestId", "approvedBy", "grantKind"],
      },
    ],
  },
  DefaultPolicy: {
    type: "object",
    properties: {
      webDefault: { $ref: "#/components/schemas/RuleAction" },
      youTubeDefault: { $ref: "#/components/schemas/RuleAction" },
    },
    required: ["webDefault", "youTubeDefault"],
  },
  DevicePolicySnapshot: {
    type: "object",
    description: "Signed, versioned policy snapshot for one child+device (the sync unit).",
    properties: {
      version: { type: "integer" }, familyId: { type: "string" }, childId: { type: "string" },
      deviceId: { type: "string" }, defaults: { $ref: "#/components/schemas/DefaultPolicy" },
      rules: { type: "array", items: { $ref: "#/components/schemas/PolicyRule" } },
      temporaryRules: { type: "array", items: { $ref: "#/components/schemas/TemporaryRule" } },
      categories: {
        type: "object",
        description: "Category → domain map for CATEGORY rules (e.g. { social: [...] }). Travels signed so clients enforce categories offline.",
        additionalProperties: { type: "array", items: { type: "string" } },
      },
      issuedAt: { type: "string", format: "date-time" },
      signature: { type: "string", description: "base64 Ed25519 over canonical JSON" },
    },
    required: ["version", "familyId", "childId", "deviceId", "defaults", "rules", "temporaryRules", "issuedAt", "signature"],
  },
  CategoryStat: {
    type: "object",
    properties: { category: { type: "string" }, domainCount: { type: "integer" } },
    required: ["category", "domainCount"],
  },
  CategoryDatasetImport: {
    type: "object",
    description: "Full replacement dataset: category slug → registrable domains.",
    properties: {
      categories: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } },
    },
    required: ["categories"],
  },
  SerializedBloom: {
    type: "object",
    description: "One category's Bloom filter: m bits, k hashes, n elements, base64 bit array.",
    properties: { m: { type: "integer" }, k: { type: "integer" }, n: { type: "integer" }, bits: { type: "string", description: "base64 of m/8 bytes" } },
    required: ["m", "k", "n", "bits"],
  },
  CategoryFilterSet: {
    type: "object",
    properties: {
      version: { type: "integer" },
      filters: { type: "object", additionalProperties: { $ref: "#/components/schemas/SerializedBloom" } },
      attribution: { $ref: "#/components/schemas/DatasetAttribution" },
    },
    required: ["version", "filters"],
  },
  DatasetAttribution: {
    type: "object",
    description:
      "Licence + credits for the source data these filters were compiled from. Inside the signed set on purpose: under CC BY-SA the attribution must accompany the adapted material, and signing makes stripping it tamper-evident. Recipients may redistribute the set under the same licence.",
    properties: {
      license: { type: "string", description: "SPDX id of the licence the SET is offered under" },
      sources: {
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" }, url: { type: "string" }, license: { type: "string" } },
          required: ["name", "url", "license"],
        },
      },
      notice: { type: "string" },
    },
    required: ["license", "sources", "notice"],
  },
  CategoryFilterAsset: {
    type: "object",
    description: "The signed filter set. Verify `signature` (Ed25519, base64) over the canonical JSON of `set` with the policy public key before use.",
    properties: { set: { $ref: "#/components/schemas/CategoryFilterSet" }, signature: { type: "string" } },
    required: ["set", "signature"],
  },
  AccessRequest: {
    type: "object",
    properties: {
      id: { type: "string" }, familyId: { type: "string" }, childId: { type: "string" }, deviceId: { type: "string" },
      targetType: { $ref: "#/components/schemas/PolicyTargetType" }, targetValue: { type: "string" },
      title: { type: "string" }, url: { type: "string" }, reason: { type: "string" },
      status: { type: "string", enum: ["PENDING", "APPROVED", "DENIED", "EXPIRED"] },
      createdAt: { type: "string", format: "date-time" },
    },
    required: ["id", "familyId", "childId", "deviceId", "targetType", "targetValue", "status", "createdAt"],
  },
  ApprovalDecision: {
    type: "object",
    properties: {
      id: { type: "string" }, requestId: { type: "string" }, familyId: { type: "string" },
      decidedBy: { type: "string" }, decision: { $ref: "#/components/schemas/RuleAction" },
      scope: { $ref: "#/components/schemas/ApprovalScope" }, duration: { $ref: "#/components/schemas/ApprovalDuration" },
      createdAt: { type: "string", format: "date-time" }, producedRuleId: { type: "string" },
    },
    required: ["id", "requestId", "familyId", "decidedBy", "decision", "scope", "duration", "createdAt"],
  },
  AuditEvent: {
    type: "object",
    properties: {
      id: { type: "string" }, familyId: { type: "string" }, actorId: { type: "string" },
      kind: { type: "string" }, detail: { type: "object", additionalProperties: true },
      createdAt: { type: "string", format: "date-time" },
    },
    required: ["id", "familyId", "kind", "detail", "createdAt"],
  },
  NotificationEndpoint: {
    type: "object",
    properties: {
      id: { type: "string" }, userId: { type: "string" },
      kind: { type: "string", enum: ["APNS", "WEBSOCKET", "CONSOLE", "EMAIL", "WEBPUSH"] },
      token: { type: "string", description: "APNs device token, Web Push subscription JSON, ws connection id, or — for EMAIL — the destination address." },
      createdAt: { type: "string", format: "date-time" },
    },
    required: ["id", "userId", "kind", "token", "createdAt"],
  },
  TokenResponse: {
    type: "object",
    description: "Access + refresh token pair. Send accessToken as `Authorization: Bearer <accessToken>`; when it expires, POST refreshToken to /v1/auth/refresh. Both tokens are bound to one session (device) — see /v1/me/sessions.",
    properties: {
      userId: { type: "string" }, tokenType: { const: "Bearer" }, expiresIn: { type: "integer", description: "access-token lifetime (seconds)" },
      accessToken: { type: "string" }, refreshToken: { type: "string" },
    },
    required: ["userId", "tokenType", "expiresIn", "accessToken", "refreshToken"],
  },
  MfaChallenge: {
    type: "object",
    description: "A half-finished sign-in. The password checked out, but the account has a passkey enrolled, so no session exists yet. Send `mfaToken` as `Authorization: Bearer <mfaToken>` to /v1/auth/passkeys/login/options and then /v1/auth/passkeys/login; nothing else accepts it.",
    properties: {
      mfaRequired: { const: true },
      methods: { type: "array", items: { type: "string", enum: ["passkey"] } },
      mfaToken: { type: "string" },
      expiresIn: { type: "integer", description: "mfaToken lifetime (seconds)" },
    },
    required: ["mfaRequired", "methods", "mfaToken", "expiresIn"],
  },
  Passkey: {
    type: "object",
    description: "One enrolled passkey. The public key is never returned.",
    properties: {
      id: { type: "string", description: "base64url credential id" },
      label: { type: "string" },
      backedUp: { type: "boolean", description: "synced to a cloud keychain — a lost device does not lose it" },
      createdAt: { type: "string", format: "date-time" },
      lastUsedAt: { type: "string", format: "date-time" },
    },
    required: ["id", "label", "backedUp", "createdAt"],
  },
  SessionSummary: {
    type: "object",
    description: "One signed-in device/session for the current user.",
    properties: {
      id: { type: "string" }, label: { type: "string" },
      createdAt: { type: "string", format: "date-time" }, lastUsedAt: { type: "string", format: "date-time" },
      current: { type: "boolean", description: "true if this is the calling token's session" },
    },
    required: ["id", "label", "createdAt", "lastUsedAt", "current"],
  },
} as const;

const userAuth = [{ bearerAuth: [] }];
const errorResponses = {
  "400": { description: "Bad request", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
  "401": { description: "Unauthenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
  "403": { description: "Forbidden", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
  "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
};
const json = (schema: unknown) => ({ "application/json": { schema } });
const familyIdParam = { name: "familyId", in: "path", required: true, schema: { type: "string" } };

export const openapiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Ajar API",
    version: "0.0.0-alpha",
    summary: "Say yes faster — family web-approval backend.",
    description:
      "Cross-platform parental URL-filtering backend: family model, policy engine, temporary approvals, access requests, and Ed25519-signed policy sync. Two bearer-token identities: **user tokens** (parents) and **device tokens** (issued at enrollment). Long-poll endpoints (`/policy/wait`, `/requests/wait`) deliver changes in seconds without streaming.",
  },
  servers: [
    { url: "http://localhost:8787", description: "Local / self-host" },
    { url: "https://api.ajar.family", description: "Production (Cloudflare Workers)" },
  ],
  tags: [
    { name: "system" }, { name: "auth" }, { name: "families" }, { name: "policy" },
    { name: "enrollment" }, { name: "requests" }, { name: "sync" }, { name: "notifications" },
    { name: "categories" },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http", scheme: "bearer",
        description: "HMAC bearer token. A **user token** (from /auth) or a **device token** (from /enroll/redeem), depending on the endpoint.",
      },
    },
    schemas,
  },
  paths: {
    "/v1/health": {
      get: { tags: ["system"], summary: "Liveness probe", security: [],
        responses: { "200": { description: "OK", content: json({ type: "object", properties: { status: { const: "ok" }, version: { type: "string" } } }) } } },
    },
    "/.well-known/apple-app-site-association": {
      get: { tags: ["system"], summary: "Apple App Site Association", security: [],
        description: "Lets the parent iOS/macOS app use the passkeys enrolled against PASSKEY_RP_ID. " +
          "Apple fetches this from https://<rpId>/.well-known/apple-app-site-association and will only " +
          "let a native app claim that relying party if it is listed here. Returns 404 while APPLE_APP_IDS " +
          "is unset: an EMPTY apps list is a positive, cached statement that no app may claim the domain, " +
          "which is not the same as \"not configured yet\".",
        responses: {
          "200": { description: "Associated application identifiers", content: json({
            type: "object",
            properties: { webcredentials: { type: "object", properties: {
              apps: { type: "array", items: { type: "string" },
                      description: "`<TeamID>.<bundle id>`, e.g. ABCDE12345.family.ajar.parent" } } } },
          }) },
          "404": { description: "No associated apps are configured on this deployment" },
        } },
    },
    "/v1/signing-key": {
      get: { tags: ["system"], summary: "Policy-signing public key", security: [],
        responses: { "200": { description: "Public key", content: json({ type: "object", properties: { publicKeyB64: { type: "string" }, alg: { const: "Ed25519" } } }) } } },
    },
    "/blocked": {
      get: { tags: ["system"], summary: "Request-Access block page (HTML, rendered by the iOS content filter)", security: [],
        parameters: [{ name: "u", in: "query", required: false, schema: { type: "string" },
                       description: "The blocked flow URL, substituted by NEFilterProvider. Non-http(s) values are ignored." }],
        responses: { "200": { description: "HTML page", content: { "text/html": { schema: { type: "string" } } } } } },
    },
    "/openapi.json": {
      get: { tags: ["system"], summary: "This OpenAPI document", security: [],
        responses: { "200": { description: "OpenAPI 3.1 document", content: json({ type: "object", additionalProperties: true }) } } },
    },
    "/v1/categories": {
      get: { tags: ["categories"], summary: "List categories with domain counts + dataset version", security: userAuth,
        responses: { "200": { description: "Category stats", content: json({ type: "object", properties: { version: { type: "integer" }, categories: { type: "array", items: { $ref: "#/components/schemas/CategoryStat" } } } }) }, "401": errorResponses["401"] } },
    },
    "/v1/categories/lookup": {
      get: { tags: ["categories"], summary: "Look up which categories a host belongs to (follows CNAMEs)", security: userAuth,
        parameters: [
          { name: "host", in: "query", required: true, schema: { type: "string" }, description: "Hostname to classify, e.g. m.tiktok.com" },
          { name: "resolve", in: "query", required: false, schema: { type: "string", enum: ["0", "1"] }, description: "Follow the CNAME chain (default on). `0` classifies only the literal host." },
        ],
        responses: { "200": { description: "Categories for the host and its CNAME chain", content: json({ type: "object", properties: { host: { type: "string" }, resolvedHosts: { type: "array", items: { type: "string" }, description: "Canonical names the host CNAMEs to" }, categories: { type: "array", items: { type: "string" } } } }) }, "400": errorResponses["400"], "401": errorResponses["401"] } },
    },
    "/v1/categories/dataset": {
      put: { tags: ["categories"], summary: "Replace the categorization dataset from a feed (ops)", security: userAuth,
        description: "Replaces the entire domain→category dataset. The bundled list is only a seed; import a maintained feed here without a code change.",
        parameters: [{ name: "x-admin-token", in: "header", required: true, schema: { type: "string" }, description: "Deployment ops secret (CATEGORY_ADMIN_TOKEN). The endpoint is disabled with 503 when unset." }],
        requestBody: { required: true, content: json({ $ref: "#/components/schemas/CategoryDatasetImport" }) },
        responses: { "200": { description: "New dataset version + stats", content: json({ type: "object", properties: { version: { type: "integer" }, categories: { type: "array", items: { $ref: "#/components/schemas/CategoryStat" } } } }) }, "400": errorResponses["400"], "401": errorResponses["401"], "403": errorResponses["403"], "503": { description: "Import not enabled on this deployment", content: json({ $ref: "#/components/schemas/Error" }) } } },
    },
    "/v1/categories/filters": {
      get: { tags: ["categories"], summary: "Signed per-category Bloom-filter asset (device)", security: [{ bearerAuth: [] }],
        description: "Compact category-membership filters a child device downloads once and caches — local O(k) lookup, no per-URL call, no domain list in the app. Signed with the policy key; `?since=N` returns { upToDate: true } when unchanged.",
        parameters: [{ name: "since", in: "query", required: false, schema: { type: "integer" }, description: "Dataset version the device already has." }],
        responses: { "200": { description: "Signed filter set or up-to-date", content: json({ oneOf: [{ $ref: "#/components/schemas/CategoryFilterAsset" }, { type: "object", properties: { upToDate: { const: true } } }] }) }, "401": errorResponses["401"] } },
    },
    "/v1/auth/register": {
      post: { tags: ["auth"], summary: "Ask to create an account (always 202)", security: [],
        description:
          "Emails a single-use confirmation code, valid for 60 minutes. Responds 202 with an identical body whether or not the address already has an account — a different status would make this an account-enumeration oracle — and NO account is created here: the account comes into being when the code is redeemed at POST /v1/auth/verify, which returns the token pair. An address that already has an account is emailed a notice instead, with the same subject and no code. A 400 means the request itself was unusable (malformed body, bad address, password below the minimum) and says nothing about the address. Rate-limited.",
        requestBody: { required: true, content: json({ type: "object", properties: { email: { type: "string", format: "email" }, password: { type: "string", minLength: 8 }, displayName: { type: "string" } }, required: ["email", "password", "displayName"] }) },
        responses: { "202": { description: "Accepted (whether or not the address is known)", content: json({ type: "object", properties: { status: { const: "accepted" } } }) }, "400": errorResponses["400"], "429": { description: "Rate limited", content: json({ $ref: "#/components/schemas/Error" }) } } },
    },
    "/v1/auth/verify/request": {
      post: { tags: ["auth"], summary: "Re-send a confirmation email (always 202)", security: [],
        description: "For an account that already exists and has not confirmed its address — including every account created before this flow existed. Responds 202 whether or not the address is known, and sends nothing when there is nothing to confirm. Rate-limited.",
        requestBody: { required: true, content: json({ type: "object", properties: { email: { type: "string", format: "email" } }, required: ["email"] }) },
        responses: { "202": { description: "Accepted (whether or not the address is known)", content: json({ type: "object", properties: { status: { const: "accepted" } } }) }, "400": errorResponses["400"], "429": { description: "Rate limited", content: json({ $ref: "#/components/schemas/Error" }) } } },
    },
    "/v1/auth/verify": {
      post: { tags: ["auth"], summary: "Confirm an email address with the emailed code", security: [],
        description: "Single use, 60-minute TTL, stored only as a SHA-256 hash, and superseded by any newer code. For a sign-up this CREATES the account and returns 201 with a token pair, so the parent is signed straight in. For an account that already exists it records the confirmation and returns 200 with no session.",
        requestBody: { required: true, content: json({ type: "object", properties: { token: { type: "string" } }, required: ["token"] }) },
        responses: {
          "200": { description: "An existing account confirmed its address", content: json({ type: "object", properties: { verified: { const: true }, userId: { type: "string" } }, required: ["verified"] }) },
          "201": { description: "The account was created; token pair returned", content: json({ allOf: [{ $ref: "#/components/schemas/TokenResponse" }, { type: "object", properties: { verified: { const: true } } }] }) },
          "400": errorResponses["400"],
          "401": { description: "Invalid or expired confirmation code", content: json({ $ref: "#/components/schemas/Error" }) },
          "409": { description: "That address already has an account", content: json({ $ref: "#/components/schemas/Error" }) },
        } },
    },
    "/v1/auth/login": {
      post: { tags: ["auth"], summary: "Log in with email + password", security: [],
        requestBody: { required: true, content: json({ type: "object", properties: { email: { type: "string", format: "email" }, password: { type: "string" } }, required: ["email", "password"] }) },
        description: "Step one of two. An account with a passkey enrolled gets an MfaChallenge and NO session; finish at /v1/auth/passkeys/login. An account with no passkey yet gets a token pair carrying `passkeyRequired: true`, which is the console's cue to send the parent straight to enrolment.",
        responses: { "200": { description: "Either a token pair (no passkey enrolled) or an MFA challenge", content: json({ oneOf: [{ $ref: "#/components/schemas/TokenResponse" }, { $ref: "#/components/schemas/MfaChallenge" }] }) }, "401": { description: "Invalid email or password", content: json({ $ref: "#/components/schemas/Error" }) } } },
    },
    "/v1/auth/passkeys/login/options": {
      post: { tags: ["auth"], summary: "Step two of sign-in: get a passkey challenge", security: [],
        description: "Authorized by the `mfaToken` from /v1/auth/login, sent as a bearer token. Returns PublicKeyCredentialRequestOptions to hand to navigator.credentials.get(). Single-use and bound to that account; valid for five minutes.",
        responses: { "200": { description: "WebAuthn request options", content: json({ type: "object", additionalProperties: true }) }, "400": errorResponses["400"], "401": errorResponses["401"] } },
    },
    "/v1/auth/passkeys/login": {
      post: { tags: ["auth"], summary: "Step two of sign-in: present the assertion", security: [],
        description: "Authorized by the same `mfaToken`. The only route that turns one into a session.",
        requestBody: { required: true, content: json({ type: "object", properties: { credential: { type: "object", additionalProperties: true, description: "the PublicKeyCredential from navigator.credentials.get(), JSON-serialized" } }, required: ["credential"] }) },
        responses: { "200": { description: "Token pair", content: json({ $ref: "#/components/schemas/TokenResponse" }) }, "400": errorResponses["400"], "401": errorResponses["401"] } },
    },
    "/v1/me/passkeys/options": {
      post: { tags: ["auth"], summary: "Get enrolment options for a new passkey", security: userAuth,
        description: "Returns PublicKeyCredentialCreationOptions for navigator.credentials.create(). Already-enrolled credentials are excluded, so a parent cannot silently register the same key twice.",
        responses: { "200": { description: "WebAuthn creation options", content: json({ type: "object", additionalProperties: true }) }, "401": errorResponses["401"] } },
    },
    "/v1/me/passkeys": {
      get: { tags: ["auth"], summary: "List this account's passkeys", security: userAuth,
        responses: { "200": { description: "Passkeys", content: json({ type: "array", items: { $ref: "#/components/schemas/Passkey" } }) }, "401": errorResponses["401"] } },
      post: { tags: ["auth"], summary: "Enrol a passkey", security: userAuth,
        requestBody: { required: true, content: json({ type: "object", properties: { credential: { type: "object", additionalProperties: true, description: "the PublicKeyCredential from navigator.credentials.create(), JSON-serialized" }, label: { type: "string", maxLength: 64 } }, required: ["credential"] }) },
        responses: { "201": { description: "Enrolled", content: json({ $ref: "#/components/schemas/Passkey" }) }, "400": errorResponses["400"], "401": errorResponses["401"] } },
    },
    "/v1/me/passkeys/{id}": {
      delete: { tags: ["auth"], summary: "Remove a passkey (never the last one)", security: userAuth,
        description: "409 when it is the only passkey on the account: removing it would leave no way to sign in. Enrol the replacement first.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Removed", content: json({ type: "object", properties: { ok: { const: true } } }) }, "401": errorResponses["401"], "404": errorResponses["404"], "409": { description: "This is the only passkey on the account", content: json({ $ref: "#/components/schemas/Error" }) } } },
    },
    "/v1/auth/refresh": {
      post: { tags: ["auth"], summary: "Exchange a refresh token for a fresh token pair", security: [],
        requestBody: { required: true, content: json({ type: "object", properties: { refreshToken: { type: "string" } }, required: ["refreshToken"] }) },
        responses: { "200": { description: "Token pair", content: json({ $ref: "#/components/schemas/TokenResponse" }) }, "401": errorResponses["401"] } },
    },
    "/v1/auth/forgot": {
      post: { tags: ["auth"], summary: "Start a password reset (always 202)", security: [],
        description: "Emails a single-use reset token, valid for 30 minutes, if the address belongs to an account. Responds 202 either way — a different status for an unknown address would make this an account-enumeration oracle. Rate-limited.",
        requestBody: { required: true, content: json({ type: "object", properties: { email: { type: "string", format: "email" } }, required: ["email"] }) },
        responses: { "202": { description: "Accepted (whether or not the address is known)", content: json({ type: "object", properties: { status: { const: "accepted" } } }) }, "429": { description: "Rate limited", content: json({ $ref: "#/components/schemas/Error" }) } } },
    },
    "/v1/auth/reset": {
      post: { tags: ["auth"], summary: "Complete a password reset with an emailed token", security: [],
        description: "Consumes the token (single use, 30-minute TTL, stored only as a SHA-256 hash), sets the new password, and revokes every existing session by bumping tokenVersion. Returns a fresh token pair on a new session.",
        requestBody: { required: true, content: json({ type: "object", properties: { token: { type: "string" }, newPassword: { type: "string", minLength: 8 } }, required: ["token", "newPassword"] }) },
        responses: { "200": { description: "New token pair", content: json({ $ref: "#/components/schemas/TokenResponse" }) }, "400": errorResponses["400"], "401": { description: "Invalid or expired reset token", content: json({ $ref: "#/components/schemas/Error" }) } } },
    },
    "/v1/auth/logout": {
      post: { tags: ["auth"], summary: "Sign out this device (revoke current session)", security: userAuth,
        responses: { "200": { description: "Signed out", content: json({ type: "object", properties: { ok: { const: true } } }) }, "401": errorResponses["401"] } },
    },
    "/v1/auth/logout-all": {
      post: { tags: ["auth"], summary: "Sign out everywhere (revoke all sessions)", security: userAuth,
        responses: { "200": { description: "Signed out everywhere", content: json({ type: "object", properties: { ok: { const: true } } }) }, "401": errorResponses["401"] } },
    },
    "/v1/me/sessions": {
      get: { tags: ["auth"], summary: "List active sessions (signed-in devices)", security: userAuth,
        responses: { "200": { description: "Sessions", content: json({ type: "array", items: { $ref: "#/components/schemas/SessionSummary" } }) }, "401": errorResponses["401"] } },
    },
    "/v1/me/sessions/{sessionId}": {
      delete: { tags: ["auth"], summary: "Revoke one session (remote sign-out of a device)", security: userAuth,
        parameters: [{ name: "sessionId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Revoked", content: json({ type: "object", properties: { revoked: { const: true } } }) }, "401": errorResponses["401"], "404": errorResponses["404"] } },
    },
    "/v1/auth/password": {
      post: { tags: ["auth"], summary: "Change password (revokes other sessions)", security: userAuth,
        requestBody: { required: true, content: json({ type: "object", properties: { currentPassword: { type: "string" }, newPassword: { type: "string", minLength: 8 } }, required: ["currentPassword", "newPassword"] }) },
        responses: { "200": { description: "New token pair", content: json({ $ref: "#/components/schemas/TokenResponse" }) }, "400": errorResponses["400"], "401": errorResponses["401"] } },
    },
    "/v1/me": {
      delete: { tags: ["auth"], summary: "Close this account and erase it", security: userAuth,
        description: "Re-authenticates with the current password: this is the most destructive call in the API and a live session on a shared computer is not enough. A family where somebody else is also an OWNER survives, minus this membership; a family where this account was the last OWNER is erased with it — children, devices, rules, grants, requests, decisions, enrollment codes and the audit log. Devices of an erased family stop authenticating and keep enforcing the last policy they hold, exactly as they do offline.",
        requestBody: { required: true, content: json({ type: "object", properties: { password: { type: "string" } }, required: ["password"] }) },
        responses: { "200": { description: "Deleted", content: json({ type: "object", properties: { deleted: { const: true }, familiesDeleted: { type: "integer" } }, required: ["deleted", "familiesDeleted"] }) }, "400": errorResponses["400"], "401": errorResponses["401"] } },
      get: { tags: ["auth"], summary: "Current user + family memberships", security: userAuth,
        description: "`emailVerified` is reported, never enforced: an unconfirmed account keeps every capability, because every account created before this flow existed is unconfirmed. Use it to prompt, not to gate.",
        responses: { "200": { description: "Profile", content: json({ type: "object", properties: { userId: { type: "string" }, email: { type: "string" }, displayName: { type: "string" }, emailVerified: { type: "boolean", description: "Whether the address has been proved to belong to this person." }, emailVerifiedAt: { type: "string", format: "date-time", description: "When it was proved. Absent = never." }, families: { type: "array", items: { type: "object", properties: { familyId: { type: "string" }, role: { $ref: "#/components/schemas/Role" }, family: { $ref: "#/components/schemas/Family" } } } } } }) }, "401": errorResponses["401"] } },
    },
    "/v1/families": {
      post: { tags: ["families"], summary: "Create a family (caller becomes OWNER)", security: userAuth,
        requestBody: { required: true, content: json({ type: "object", properties: { name: { type: "string" } }, required: ["name"] }) },
        responses: { "201": { description: "Created", content: json({ $ref: "#/components/schemas/Family" }) }, "401": errorResponses["401"] } },
    },
    "/v1/families/{familyId}": {
      get: { tags: ["families"], summary: "Get a family", security: userAuth, parameters: [familyIdParam],
        responses: { "200": { description: "Family", content: json({ $ref: "#/components/schemas/Family" }) }, "403": errorResponses["403"], "404": errorResponses["404"] } },
    },
    "/v1/families/{familyId}/parents": {
      post: { tags: ["families"], summary: "Add a parent/guardian to the family", security: userAuth, parameters: [familyIdParam],
        description: "Identify the co-parent by `email` (preferred) or `userId`. The person must already have an Ajar account — an unknown address is a 404, never a membership pointing at nobody. `assignedChildIds` applies only to LIMITED_GUARDIAN and every id must belong to this family.",
        requestBody: { required: true, content: json({ type: "object", properties: { email: { type: "string", format: "email" }, userId: { type: "string", description: "Legacy alternative to email." }, role: { $ref: "#/components/schemas/Role" }, assignedChildIds: { type: "array", items: { type: "string" } } }, required: ["role"] }) },
        responses: { "201": { description: "Membership", content: json({ $ref: "#/components/schemas/FamilyMembership" }) }, "400": errorResponses["400"], "401": errorResponses["401"], "403": errorResponses["403"], "404": { description: "No account with that email/id", content: json({ $ref: "#/components/schemas/Error" }) }, "409": { description: "Already a member of this family", content: json({ $ref: "#/components/schemas/Error" }) } } },
    },
    "/v1/families/{familyId}/children": {
      post: { tags: ["families"], summary: "Add a child", security: userAuth, parameters: [familyIdParam],
        requestBody: { required: true, content: json({ type: "object", properties: { displayName: { type: "string" }, timezone: { type: "string", default: "UTC", description: "IANA time zone; rejected with 400 if unknown." } }, required: ["displayName"] }) },
        responses: { "201": { description: "Child", content: json({ $ref: "#/components/schemas/Child" }) }, "400": errorResponses["400"], "401": errorResponses["401"], "403": errorResponses["403"] } },
      get: { tags: ["families"], summary: "List children", security: userAuth, parameters: [familyIdParam],
        responses: { "200": { description: "Children", content: json({ type: "array", items: { $ref: "#/components/schemas/Child" } }) }, "403": errorResponses["403"] } },
    },
    "/v1/families/{familyId}/children/{childId}": {
      put: { tags: ["families"], summary: "Update a child's time zone", security: userAuth,
        parameters: [familyIdParam, { name: "childId", in: "path", required: true, schema: { type: "string" } }],
        description: "Sets the IANA zone that UNTIL_END_OF_DAY approvals are measured in.",
        requestBody: { required: true, content: json({ type: "object", properties: { timezone: { type: "string" } }, required: ["timezone"] }) },
        responses: { "200": { description: "Updated child", content: json({ $ref: "#/components/schemas/Child" }) }, "400": errorResponses["400"], "403": errorResponses["403"], "404": errorResponses["404"] } },
      delete: { tags: ["families"], summary: "Erase a child and everything attached to them", security: userAuth,
        parameters: [familyIdParam, { name: "childId", in: "path", required: true, schema: { type: "string" } }],
        description: "Cascades: devices, standing rules, temporary grants, access requests, default policy, and any LIMITED_GUARDIAN assignment naming this child. Irreversible.",
        responses: { "200": { description: "Deleted", content: json({ type: "object", properties: { deleted: { const: true } } }) }, "401": errorResponses["401"], "403": errorResponses["403"], "404": errorResponses["404"] } },
    },
    "/v1/families/{familyId}/devices": {
      get: { tags: ["families"], summary: "List enrolled devices with last-seen status", security: userAuth, parameters: [familyIdParam],
        description: "Each device reports `lastSeenAt`, the policy version it actually pulled, and a `stale` flag (no contact for 24h) — so a parent can tell whether protection is still running rather than assuming it is.",
        responses: { "200": { description: "Devices", content: json({ type: "array", items: { $ref: "#/components/schemas/DeviceStatus" } }) }, "403": errorResponses["403"] } },
    },
    "/v1/families/{familyId}/devices/{deviceId}": {
      delete: { tags: ["families"], summary: "Remove a device (and its device-scoped policy)", security: userAuth,
        parameters: [familyIdParam, { name: "deviceId", in: "path", required: true, schema: { type: "string" } }],
        description: "Cascades device-scoped rules, temporary grants and requests. The device's token stops working immediately.",
        responses: { "200": { description: "Deleted", content: json({ type: "object", properties: { deleted: { const: true } } }) }, "401": errorResponses["401"], "403": errorResponses["403"], "404": errorResponses["404"] } },
    },
    "/v1/families/{familyId}/audit": {
      get: { tags: ["families"], summary: "List audit events", security: userAuth, parameters: [familyIdParam],
        responses: { "200": { description: "Audit events", content: json({ type: "array", items: { $ref: "#/components/schemas/AuditEvent" } }) }, "403": errorResponses["403"] } },
    },
    "/v1/families/{familyId}/children/{childId}/defaults": {
      put: { tags: ["policy"], summary: "Set a child's default policy (web + YouTube)", security: userAuth,
        parameters: [familyIdParam, { name: "childId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: json({ $ref: "#/components/schemas/DefaultPolicy" }) },
        responses: { "200": { description: "Updated", content: json({ type: "object", properties: { updated: { const: true } } }) }, "401": errorResponses["401"], "403": errorResponses["403"] } },
    },
    "/v1/families/{familyId}/rules": {
      post: { tags: ["policy"], summary: "Add a standing policy rule", security: userAuth, parameters: [familyIdParam],
        requestBody: { required: true, content: json({ type: "object", properties: { target: { $ref: "#/components/schemas/PolicyTargetType" }, value: { type: "string" }, action: { $ref: "#/components/schemas/RuleAction" }, scope: { type: "object", properties: { type: { type: "string", enum: ["FAMILY", "CHILD", "DEVICE"] }, childId: { type: "string" }, deviceId: { type: "string" } }, required: ["type"] }, priority: { type: "integer" } }, required: ["target", "value", "action", "scope"] }) },
        responses: { "201": { description: "Rule", content: json({ $ref: "#/components/schemas/PolicyRule" }) }, "401": errorResponses["401"], "403": errorResponses["403"] } },
      get: { tags: ["policy"], summary: "List policy rules", security: userAuth, parameters: [familyIdParam],
        responses: { "200": { description: "Rules", content: json({ type: "array", items: { $ref: "#/components/schemas/PolicyRule" } }) }, "403": errorResponses["403"] } },
    },
    "/v1/families/{familyId}/rules/{ruleId}": {
      delete: { tags: ["policy"], summary: "Delete a policy rule", security: userAuth,
        parameters: [familyIdParam, { name: "ruleId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Deleted", content: json({ type: "object", properties: { deleted: { const: true } } }) }, "401": errorResponses["401"], "403": errorResponses["403"] } },
    },
    "/v1/families/{familyId}/enroll": {
      post: { tags: ["enrollment"], summary: "Create a single-use device enrollment code", security: userAuth, parameters: [familyIdParam],
        requestBody: { required: true, content: json({ type: "object", properties: { childId: { type: "string" }, platform: { $ref: "#/components/schemas/Platform" } }, required: ["childId", "platform"] }) },
        responses: { "201": { description: "Enrollment code", content: json({ type: "object", properties: { code: { type: "string" }, expiresAt: { type: "string", format: "date-time" } } }) }, "401": errorResponses["401"], "403": errorResponses["403"] } },
    },
    "/v1/enroll/redeem": {
      post: { tags: ["enrollment"], summary: "Redeem a code; register a device and get a device token", security: [],
        requestBody: { required: true, content: json({ type: "object", properties: { code: { type: "string" }, devicePublicKey: { type: "string", description: "base64 raw Ed25519" }, displayName: { type: "string" } }, required: ["code", "devicePublicKey", "displayName"] }) },
        responses: { "201": { description: "Device + token", content: json({ type: "object", properties: { device: { $ref: "#/components/schemas/Device" }, deviceToken: { type: "string" }, expiresIn: { type: "integer", description: "device-token lifetime (seconds); refresh via /v1/devices/{deviceId}/token/refresh" }, signingPublicKeyB64: { type: "string" } } }) }, "400": errorResponses["400"], "410": { description: "Code expired or already used", content: json({ $ref: "#/components/schemas/Error" }) } } },
    },
    "/v1/requests": {
      post: { tags: ["requests"], summary: "File an access request (device token)", security: userAuth,
        description: "Requires a **device token**. The child device asks a parent to open one canonical target.",
        requestBody: { required: true, content: json({ type: "object", properties: { targetType: { $ref: "#/components/schemas/PolicyTargetType" }, targetValue: { type: "string" }, title: { type: "string" }, url: { type: "string" }, reason: { type: "string" } }, required: ["targetType", "targetValue"] }) },
        responses: { "201": { description: "Request", content: json({ $ref: "#/components/schemas/AccessRequest" }) }, "401": errorResponses["401"], "403": errorResponses["403"] } },
    },
    "/v1/families/{familyId}/requests": {
      get: { tags: ["requests"], summary: "List access requests", security: userAuth,
        parameters: [familyIdParam, { name: "status", in: "query", required: false, schema: { type: "string", enum: ["PENDING", "APPROVED", "DENIED", "EXPIRED"] } }],
        responses: { "200": { description: "Requests", content: json({ type: "array", items: { $ref: "#/components/schemas/AccessRequest" } }) }, "403": errorResponses["403"] } },
    },
    "/v1/families/{familyId}/requests/wait": {
      get: { tags: ["requests"], summary: "Long-poll the pending-request feed", security: userAuth,
        description: "Returns the current PENDING list the instant it changes (create or decide), or the unchanged list after `timeout`. Pass `count` = the client's current pending length so an already-changed set returns immediately.",
        parameters: [familyIdParam, { name: "count", in: "query", required: false, schema: { type: "integer", default: -1 } }, { name: "timeout", in: "query", required: false, schema: { type: "integer", default: 25000, maximum: 60000 } }],
        responses: { "200": { description: "Pending requests", content: json({ type: "object", properties: { requests: { type: "array", items: { $ref: "#/components/schemas/AccessRequest" } }, upToDate: { type: "boolean" } }, required: ["requests"] }) }, "403": errorResponses["403"] } },
    },
    "/v1/families/{familyId}/requests/{requestId}/decide": {
      post: { tags: ["requests"], summary: "Approve or deny a request", security: userAuth,
        parameters: [familyIdParam, { name: "requestId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: json({ type: "object", properties: { decision: { $ref: "#/components/schemas/RuleAction" }, scope: { $ref: "#/components/schemas/ApprovalScope" }, duration: { $ref: "#/components/schemas/ApprovalDuration" } }, required: ["decision", "scope", "duration"] }) },
        responses: { "200": { description: "Decision + updated request", content: json({ type: "object", properties: { decision: { $ref: "#/components/schemas/ApprovalDecision" }, request: { $ref: "#/components/schemas/AccessRequest" } } }) }, "401": errorResponses["401"], "403": errorResponses["403"], "404": errorResponses["404"], "409": { description: "Already decided", content: json({ $ref: "#/components/schemas/Error" }) } } },
    },
    "/v1/devices/{deviceId}/policy": {
      get: { tags: ["sync"], summary: "Get the signed policy snapshot (device token)", security: userAuth,
        description: "Requires a **device token** matching `deviceId`. With `since=vN` returns `{upToDate:true}` when unchanged, else the new snapshot; without `since` returns the full current snapshot.",
        parameters: [{ name: "deviceId", in: "path", required: true, schema: { type: "string" } }, { name: "since", in: "query", required: false, schema: { type: "integer" } }],
        responses: { "200": { description: "Snapshot or up-to-date", content: json({ oneOf: [{ $ref: "#/components/schemas/DevicePolicySnapshot" }, { type: "object", properties: { upToDate: { const: true } } }] }) }, "401": errorResponses["401"], "403": errorResponses["403"] } },
    },
    "/v1/devices/{deviceId}/policy/wait": {
      get: { tags: ["sync"], summary: "Long-poll for a new policy snapshot (device token)", security: userAuth,
        description: "Requires a **device token**. Returns a fresh snapshot the moment an approval bumps the version past `since`, or `{upToDate:true}` after `timeout`.",
        parameters: [{ name: "deviceId", in: "path", required: true, schema: { type: "string" } }, { name: "since", in: "query", required: false, schema: { type: "integer", default: 0 } }, { name: "timeout", in: "query", required: false, schema: { type: "integer", default: 25000, maximum: 60000 } }],
        responses: { "200": { description: "Snapshot or up-to-date", content: json({ oneOf: [{ $ref: "#/components/schemas/DevicePolicySnapshot" }, { type: "object", properties: { upToDate: { const: true } } }] }) }, "401": errorResponses["401"], "403": errorResponses["403"] } },
    },
    "/v1/devices/{deviceId}/token/refresh": {
      post: { tags: ["sync"], summary: "Refresh this device's token (device token)", security: userAuth,
        description: "Requires a still-valid **device token** matching `deviceId`; returns its successor. Device tokens last 30 days and previously had no renewal path, so a device silently stopped syncing on day 31 and needed a full re-enrollment. Also counts as a heartbeat. Returns 401 once the device has been removed.",
        parameters: [{ name: "deviceId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "New device token", content: json({ type: "object", properties: { deviceToken: { type: "string" }, expiresIn: { type: "integer" }, signingPublicKeyB64: { type: "string" } }, required: ["deviceToken", "expiresIn"] }) }, "401": errorResponses["401"], "403": errorResponses["403"], "404": errorResponses["404"] } },
    },
    "/v1/devices/{deviceId}/grants/{ruleId}/consume": {
      post: { tags: ["sync"], summary: "Report a single-use grant as used (device token)", security: userAuth,
        description: "Requires a **device token**. Spends a `grantKind: ONCE` temporary rule: it is marked consumed, the policy version bumps, and it is absent from every later snapshot. Consumption is client-attested — the 5-minute TTL remains the backstop (see docs/SECURITY.md).",
        parameters: [{ name: "deviceId", in: "path", required: true, schema: { type: "string" } }, { name: "ruleId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Consumed", content: json({ type: "object", properties: { consumed: { const: true }, ruleId: { type: "string" }, consumedAt: { type: "string", format: "date-time" } } }) }, "400": errorResponses["400"], "401": errorResponses["401"], "403": errorResponses["403"], "404": errorResponses["404"], "410": { description: "Grant already used", content: json({ $ref: "#/components/schemas/Error" }) } } },
    },
    "/v1/me/endpoints": {
      post: { tags: ["notifications"], summary: "Register a push notification endpoint", security: userAuth,
        requestBody: { required: true, content: json({ type: "object", properties: { kind: { type: "string", enum: ["APNS", "WEBSOCKET", "CONSOLE", "EMAIL", "WEBPUSH"] }, token: { type: "string" } }, required: ["kind", "token"] }) },
        responses: { "201": { description: "Endpoint", content: json({ $ref: "#/components/schemas/NotificationEndpoint" }) }, "401": errorResponses["401"] } },
    },
  },
} satisfies Record<string, unknown>;
