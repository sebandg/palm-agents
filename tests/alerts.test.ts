// Push alerts name the agent's session and link to the right place, and nothing more.
import { describe, expect, it } from "vitest";
import { alertPayload } from "../packages/notifications/src/index.ts";

describe("push alert payloads", () => {
  it("names the session and links to the browser or the session", () => {
    expect(alertPayload({ kind: "browser", session: "claude-proj" })).toEqual({ title: "Palm Agents", body: "claude-proj needs you in the browser", tag: "browser", url: "/?open=browser" });
    expect(alertPayload({ kind: "terminal", session: "codex-web" })).toEqual({ title: "Palm Agents", body: "codex-web is waiting for you", tag: "term:codex-web", url: "/?open=term%3Acodex-web" });
  });
  it("falls back to a generic name, and service alerts open Settings", () => {
    expect(alertPayload({ kind: "browser", session: null }).body).toBe("An agent needs you in the browser");
    expect(alertPayload({ kind: "service" })).toMatchObject({ body: "Palm Agents reported a problem", url: "/system" });
  });
});
