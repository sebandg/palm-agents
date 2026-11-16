// Make the shared browser's window recognisable: a profile name and a theme colour, so it is
// never mistaken for the owner's everyday Chrome. Written into the profile's preferences
// before Chrome starts, once: a profile that already has a theme colour (ours or one the
// owner picked later in chrome://settings/manageProfile) is left alone.
import fs from "node:fs";
import path from "node:path";

export const PROFILE_NAME = "PALM AGENTS";
/** Teal 0xFF00897B as the signed 32-bit SkColor Chrome stores. */
const THEME_COLOR = 0xff00897b - 2 ** 32;

type Json = Record<string, unknown>;
const obj = (parent: Json, key: string): Json => {
  if (typeof parent[key] !== "object" || parent[key] === null) parent[key] = {};
  return parent[key] as Json;
};
function readJson(file: string): Json | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Json;
  } catch {
    return null;
  }
}

/** Returns true when it changed the profile. Never throws: a plain-looking window is not worth a failed start. */
export function brandProfile(profileDir: string): boolean {
  try {
    const prefsFile = path.join(profileDir, "Default", "Preferences");
    const prefs = readJson(prefsFile) ?? {};
    const theme = obj(obj(prefs, "browser"), "theme");
    if (theme.user_color2 !== undefined) return false;
    Object.assign(theme, { user_color2: THEME_COLOR, color_variant2: 3, color_scheme2: 2 });
    obj(obj(prefs, "extensions"), "theme").id = "user_color_theme_id";
    obj(prefs, "profile").name = PROFILE_NAME;
    fs.mkdirSync(path.dirname(prefsFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(prefsFile, JSON.stringify(prefs), { mode: 0o600 });
    // The profile button reads its label from here once the profile has been opened before.
    const stateFile = path.join(profileDir, "Local State");
    const state = readJson(stateFile);
    if (state) {
      Object.assign(obj(obj(obj(state, "profile"), "info_cache"), "Default"), { name: PROFILE_NAME, is_using_default_name: false });
      fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
    }
    return true;
  } catch {
    return false;
  }
}
