// Web addresses in the phone's terminal view become tappable links, including long ones
// that a CLI broke over several lines itself.
import { describe, expect, it } from "vitest";
import { findLinks } from "../apps/mobile-web/src/ansi.ts";

const COLS = 44;
const pad = (s: string) => s.padEnd(COLS);

describe("links in the terminal view", () => {
  it("joins an address that claude broke over several indented lines", () => {
    const lines = [
      "  Here's the link directly; tap it:",
      "  https://accounts.google.com/o/oauth2/auth?",
      "  client_id=94391946273-hhokgl3ndcr0srnqjgtg",
      "  t8f2qllc87t5.apps.googleusercontent.com&re",
      "  ysXvtZjJ7fD2H-zw",
      "  Sign in, and after the error page, copy",
    ];
    const text = lines.join("\n");
    const links = findLinks(text, COLS);
    const href = "https://accounts.google.com/o/oauth2/auth?client_id=94391946273-hhokgl3ndcr0srnqjgtgt8f2qllc87t5.apps.googleusercontent.com&reysXvtZjJ7fD2H-zw";
    expect(links.map((l) => l.href)).toEqual([href, href, href, href]);
    // Each piece covers its own line's text, not the indent.
    expect(links.map((l) => text.slice(l.start, l.end))).toEqual([lines[1]!.trim(), lines[2]!.trim(), lines[3]!.trim(), lines[4]!.trim()]);
  });

  it("does not run an address into the next sentence or keep trailing punctuation", () => {
    const text = [pad("See https://example.com/a?b=1."), "Next line", `${"x".repeat(10)} https://ex.com/${"y".repeat(19)}`, "  Sign in now"].join("\n");
    expect(findLinks(text, COLS).map((l) => l.href)).toEqual(["https://example.com/a?b=1", `https://ex.com/${"y".repeat(19)}`]);
  });

  it("ignores text without an address", () => {
    expect(findLinks("nothing to see here\nhttp:// alone", COLS)).toEqual([]);
  });
});
