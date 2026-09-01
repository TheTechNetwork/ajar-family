/**
 * A one-endpoint Worker that runs PasskeyService against vectors POSTed to it.
 *
 * It exists so the passkey ceremonies can be executed by workerd rather than by
 * Node. The test alongside it (../passkey-workerd.test.mjs) owns the vectors and
 * the assertions; this file owns nothing but the wiring, so that whatever it
 * reports is the real service's behaviour in the real runtime.
 */
import { PasskeyService } from "../../dist/domain/passkeys.js";
import { MemoryStore } from "../../dist/store/memory.js";

const iso = (ms) => new Date(Date.now() + ms).toISOString();

export default {
  async fetch(request) {
    const v = await request.json();
    const repo = new MemoryStore();

    if (v.credential) await repo.createWebAuthnCredential(v.credential);
    await repo.createWebAuthnChallenge({
      challenge: v.challenge,
      kind: v.mode === "register" ? "REGISTER" : "AUTHENTICATE",
      userId: v.mode === "register" ? v.userId : undefined,
      expiresAt: iso(5 * 60_000),
      createdAt: iso(0),
    });

    const svc = new PasskeyService(repo, v.cfg);
    try {
      if (v.mode === "register") {
        const cred = await svc.register(v.userId, v.response, "workerd");
        return Response.json({ ok: true, id: cred.id, signCount: cred.signCount, backedUp: cred.backedUp });
      }
      const out = await svc.login(v.response);
      const after = await repo.getWebAuthnCredential(v.credential.id);
      return Response.json({ ok: true, userId: out.userId, signCount: after.signCount });
    } catch (e) {
      return Response.json({ ok: false, code: e?.code ?? null, message: String(e?.message ?? e) });
    }
  },
};
