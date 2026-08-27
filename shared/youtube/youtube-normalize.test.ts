import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeYouTube, youTubePolicyKey } from "./youtube-normalize.js";

test("all common YouTube URL forms reduce to the same canonical video key", () => {
  const forms = [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s&pp=abc",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    "https://www.youtube.com/live/dQw4w9WgXcQ",
  ];
  for (const f of forms) {
    assert.equal(youTubePolicyKey(normalizeYouTube(f)), "YOUTUBE_VIDEO:dQw4w9WgXcQ", f);
  }
});

test("channel, playlist, handle, and non-YouTube", () => {
  assert.equal(youTubePolicyKey(normalizeYouTube("https://www.youtube.com/playlist?list=PLabc1234567")), "YOUTUBE_PLAYLIST:PLabc1234567");
  assert.equal(youTubePolicyKey(normalizeYouTube("https://www.youtube.com/channel/UC1234567890123456789012")), "YOUTUBE_CHANNEL:UC1234567890123456789012");
  assert.equal(youTubePolicyKey(normalizeYouTube("https://www.youtube.com/@SomeHandle")), "YOUTUBE_CHANNEL_HANDLE:@SomeHandle");
  const other = normalizeYouTube("https://example.com/watch?v=abc");
  assert.equal(other.isYouTube, false);
  assert.equal(youTubePolicyKey(other), null);
});

test("garbage input never throws", () => {
  assert.equal(normalizeYouTube("not a url").isYouTube, false);
  assert.equal(normalizeYouTube("").isYouTube, false);
});
