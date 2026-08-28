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
      { type: "object", properties: { kind: { const: "ONCE" } }, required: ["kind"] },
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
      displayName: { type: "string" }, createdAt: { type: "string", format: "date-time" },
    },
    required: ["id", "familyId", "displayName", "createdAt"],
  },
  Device: {
    type: "object",
    properties: {
      id: { type: "string" }, familyId: { type: "string" }, childId: { type: "string" },
      platform: { $ref: "#/components/schemas/Platform" }, displayName: { type: "string" },
      devicePublicKey: { type: "string", description: "base64 raw Ed25519 public key" },
      enrolledAt: { type: "string", format: "date-time" }, lastSyncedVersion: { type: "integer" },
    },
    required: ["id", "familyId", "childId", "platform", "displayName", "devicePublicKey", "enrolledAt", "lastSyncedVersion"],
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
      issuedAt: { type: "string", format: "date-time" },
      signature: { type: "string", description: "base64 Ed25519 over canonical JSON" },
    },
    required: ["version", "familyId", "childId", "deviceId", "defaults", "rules", "temporaryRules", "issuedAt", "signature"],
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
      kind: { type: "string", enum: ["APNS", "WEBSOCKET", "CONSOLE"] },
      token: { type: "string" }, createdAt: { type: "string", format: "date-time" },
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
    "/v1/signing-key": {
      get: { tags: ["system"], summary: "Policy-signing public key", security: [],
        responses: { "200": { description: "Public key", content: json({ type: "object", properties: { publicKeyB64: { type: "string" }, alg: { const: "Ed25519" } } }) } } },
    },
    "/openapi.json": {
      get: { tags: ["system"], summary: "This OpenAPI document", security: [],
        responses: { "200": { description: "OpenAPI 3.1 document", content: json({ type: "object", additionalProperties: true }) } } },
    },
    "/v1/auth/register": {
      post: { tags: ["auth"], summary: "Register a parent with a password", security: [],
        requestBody: { required: true, content: json({ type: "object", properties: { email: { type: "string", format: "email" }, password: { type: "string", minLength: 8 }, displayName: { type: "string" } }, required: ["email", "password", "displayName"] }) },
        responses: { "201": { description: "Token pair", content: json({ $ref: "#/components/schemas/TokenResponse" }) }, "400": errorResponses["400"], "409": { description: "Email already registered", content: json({ $ref: "#/components/schemas/Error" }) } } },
    },
    "/v1/auth/login": {
      post: { tags: ["auth"], summary: "Log in with email + password", security: [],
        requestBody: { required: true, content: json({ type: "object", properties: { email: { type: "string", format: "email" }, password: { type: "string" } }, required: ["email", "password"] }) },
        responses: { "200": { description: "Token pair", content: json({ $ref: "#/components/schemas/TokenResponse" }) }, "401": { description: "Invalid email or password", content: json({ $ref: "#/components/schemas/Error" }) } } },
    },
    "/v1/auth/refresh": {
      post: { tags: ["auth"], summary: "Exchange a refresh token for a fresh token pair", security: [],
        requestBody: { required: true, content: json({ type: "object", properties: { refreshToken: { type: "string" } }, required: ["refreshToken"] }) },
        responses: { "200": { description: "Token pair", content: json({ $ref: "#/components/schemas/TokenResponse" }) }, "401": errorResponses["401"] } },
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
      get: { tags: ["auth"], summary: "Current user + family memberships", security: userAuth,
        responses: { "200": { description: "Profile", content: json({ type: "object", properties: { userId: { type: "string" }, email: { type: "string" }, displayName: { type: "string" }, families: { type: "array", items: { type: "object", properties: { familyId: { type: "string" }, role: { $ref: "#/components/schemas/Role" }, family: { $ref: "#/components/schemas/Family" } } } } } }) }, "401": errorResponses["401"] } },
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
        requestBody: { required: true, content: json({ type: "object", properties: { userId: { type: "string" }, role: { $ref: "#/components/schemas/Role" }, assignedChildIds: { type: "array", items: { type: "string" } } }, required: ["userId", "role"] }) },
        responses: { "201": { description: "Membership", content: json({ $ref: "#/components/schemas/FamilyMembership" }) }, "401": errorResponses["401"], "403": errorResponses["403"] } },
    },
    "/v1/families/{familyId}/children": {
      post: { tags: ["families"], summary: "Add a child", security: userAuth, parameters: [familyIdParam],
        requestBody: { required: true, content: json({ type: "object", properties: { displayName: { type: "string" } }, required: ["displayName"] }) },
        responses: { "201": { description: "Child", content: json({ $ref: "#/components/schemas/Child" }) }, "401": errorResponses["401"], "403": errorResponses["403"] } },
      get: { tags: ["families"], summary: "List children", security: userAuth, parameters: [familyIdParam],
        responses: { "200": { description: "Children", content: json({ type: "array", items: { $ref: "#/components/schemas/Child" } }) }, "403": errorResponses["403"] } },
    },
    "/v1/families/{familyId}/devices": {
      get: { tags: ["families"], summary: "List enrolled devices", security: userAuth, parameters: [familyIdParam],
        responses: { "200": { description: "Devices", content: json({ type: "array", items: { $ref: "#/components/schemas/Device" } }) }, "403": errorResponses["403"] } },
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
        responses: { "201": { description: "Device + token", content: json({ type: "object", properties: { device: { $ref: "#/components/schemas/Device" }, deviceToken: { type: "string" }, signingPublicKeyB64: { type: "string" } } }) }, "400": errorResponses["400"], "410": { description: "Code expired or already used", content: json({ $ref: "#/components/schemas/Error" }) } } },
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
    "/v1/me/endpoints": {
      post: { tags: ["notifications"], summary: "Register a push notification endpoint", security: userAuth,
        requestBody: { required: true, content: json({ type: "object", properties: { kind: { type: "string", enum: ["APNS", "WEBSOCKET", "CONSOLE"] }, token: { type: "string" } }, required: ["kind", "token"] }) },
        responses: { "201": { description: "Endpoint", content: json({ $ref: "#/components/schemas/NotificationEndpoint" }) }, "401": errorResponses["401"] } },
    },
  },
} satisfies Record<string, unknown>;
