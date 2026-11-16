// The shared browser's window is named and coloured so it is not mistaken for the owner's own.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { brandProfile, PROFILE_NAME } from "../packages/browser-worker/src/brand.ts";

const dirs: string[] = [];
const fresh = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "pa-brand-")); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const prefs = (d: string) => JSON.parse(fs.readFileSync(path.join(d, "Default", "Preferences"), "utf8"));

describe("naming and colouring the shared browser's profile", () => {
  it("sets a name and theme on a profile that does not exist yet", () => {
    const d = fresh();
    expect(brandProfile(d)).toBe(true);
    expect(prefs(d).profile.name).toBe(PROFILE_NAME);
    expect(prefs(d).browser.theme.user_color2).toBeLessThan(0);
    expect(prefs(d).extensions.theme.id).toBe("user_color_theme_id");
  });

  it("adds them to an existing profile without losing what is there", () => {
    const d = fresh();
    fs.mkdirSync(path.join(d, "Default"));
    fs.writeFileSync(path.join(d, "Default", "Preferences"), JSON.stringify({ profile: { name: "Your Chromium", exit_type: "Normal" }, browser: { window_placement: { top: 1 } } }));
    fs.writeFileSync(path.join(d, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Your Chromium", avatar_icon: "x" } } } }));
    expect(brandProfile(d)).toBe(true);
    expect(prefs(d).profile).toMatchObject({ name: PROFILE_NAME, exit_type: "Normal" });
    expect(prefs(d).browser.window_placement).toEqual({ top: 1 });
    expect(JSON.parse(fs.readFileSync(path.join(d, "Local State"), "utf8")).profile.info_cache.Default).toMatchObject({ name: PROFILE_NAME, avatar_icon: "x" });
  });

  it("leaves a profile alone once it has a theme colour, ours or the owner's", () => {
    const d = fresh();
    brandProfile(d);
    const p = prefs(d); p.profile.name = "Mine"; p.browser.theme.user_color2 = -1;
    fs.writeFileSync(path.join(d, "Default", "Preferences"), JSON.stringify(p));
    expect(brandProfile(d)).toBe(false);
    expect(prefs(d).profile.name).toBe("Mine");
  });
});
