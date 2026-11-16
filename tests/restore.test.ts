// What the shared browser may reopen after a restart. A sign-in page must not come back:
// claude.ai and friends answer a cold hit on their login with a verification loop, in a
// window nobody asked for.
import { describe, expect, it } from "vitest";
import { isAuthPage, mayRestore } from "../packages/browser-worker/src/restore.ts";

describe("reopening the last page", () => {
  it("does not reopen a sign-in, consent or verification page", () => {
    for (const url of [
      "https://claude.ai/login",
      "https://claude.ai/login?returnTo=%2F",
      "https://accounts.google.com/o/oauth2/auth?client_id=1",
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      "https://github.com/login/device",
      "https://example.com/users/sign_in",
      "https://example.com/verify-email/abc",
      "https://example.com/?challenge=1",
    ]) {
      expect(isAuthPage(url), url).toBe(true);
      expect(mayRestore(url), url).toBe(false);
    }
  });

  it("still reopens ordinary pages", () => {
    for (const url of [
      "https://claude.ai/chat/abc",
      "https://example.com/authors/ada",
      "https://news.example.com/2026/11/16/story",
      "http://127.0.0.1:5173/",
      "https://docs.example.com/guide/authoring",
    ]) {
      expect(isAuthPage(url), url).toBe(false);
      expect(mayRestore(url), url).toBe(true);
    }
  });

  it("refuses anything that is not an http address", () => {
    for (const url of ["", "about:blank", "file:///etc/passwd", "not a url", "javascript:alert(1)"]) expect(mayRestore(url), url).toBe(false);
  });
});
