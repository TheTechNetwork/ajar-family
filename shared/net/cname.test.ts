import { test } from "node:test";
import assert from "node:assert/strict";
import { followCnameChain, normalizeDnsName } from "./cname.js";

const mapResolver = (m: Record<string, string>) => async (n: string) => m[n] ?? null;

test("follows a multi-hop chain, normalized", async () => {
  const chain = await followCnameChain("VIDEOS.Site.com.", mapResolver({
    "videos.site.com": "edge.site.com.cdn.example",
    "edge.site.com.cdn.example": "tiktok.com",
  }));
  assert.deepEqual(chain, ["edge.site.com.cdn.example", "tiktok.com"]);
});

test("stops at a name with no CNAME", async () => {
  assert.deepEqual(await followCnameChain("a.test", mapResolver({})), []);
});

test("breaks a CNAME loop instead of spinning", async () => {
  const chain = await followCnameChain("a.test", mapResolver({ "a.test": "b.test", "b.test": "a.test" }));
  assert.deepEqual(chain, ["b.test"]); // b then a (already seen) → stop
});

test("honors the depth cap", async () => {
  // A chain longer than maxDepth is truncated.
  const long: Record<string, string> = {};
  for (let i = 0; i < 20; i++) long[`h${i}.test`] = `h${i + 1}.test`;
  const chain = await followCnameChain("h0.test", mapResolver(long), { maxDepth: 3 });
  assert.equal(chain.length, 3);
});

test("resolveOne errors end the chain gracefully", async () => {
  const chain = await followCnameChain("a.test", async () => { throw new Error("SERVFAIL"); });
  assert.deepEqual(chain, []);
});

test("normalizeDnsName drops trailing dot + www and lowercases", () => {
  assert.equal(normalizeDnsName("WWW.Example.COM."), "example.com");
});
