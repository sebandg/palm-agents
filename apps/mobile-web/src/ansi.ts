// Minimal ANSI SGR → styled spans. Handles what CLIs like claude actually emit:
// reset, bold, dim, italic, underline, inverse, 16/256/truecolor fg+bg.
// Everything else (cursor movement, OSC) is stripped. Output is text nodes, never HTML.
import type { ComponentChild } from "preact";
import { h } from "preact";

const BASE = ["#1e293b", "#f87171", "#4ade80", "#facc15", "#60a5fa", "#c084fc", "#22d3ee", "#e2e8f0"];
const BRIGHT = ["#64748b", "#fca5a5", "#86efac", "#fde047", "#93c5fd", "#d8b4fe", "#67e8f9", "#ffffff"];

function c256(n: number): string {
  if (n < 8) return BASE[n]!;
  if (n < 16) return BRIGHT[n - 8]!;
  if (n < 232) {
    const i = n - 16;
    const r = Math.floor(i / 36), g = Math.floor((i % 36) / 6), b = i % 6;
    const v = (x: number) => (x === 0 ? 0 : 55 + x * 40);
    return `rgb(${v(r)},${v(g)},${v(b)})`;
  }
  const grey = 8 + (n - 232) * 10;
  return `rgb(${grey},${grey},${grey})`;
}

interface Style { fg?: string; bg?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean; inverse?: boolean }

function apply(st: Style, codes: number[]): Style {
  const s = { ...st };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]!;
    if (c === 0) return {};
    else if (c === 1) s.bold = true;
    else if (c === 2) s.dim = true;
    else if (c === 3) s.italic = true;
    else if (c === 4) s.underline = true;
    else if (c === 7) s.inverse = true;
    else if (c === 22) { s.bold = false; s.dim = false; }
    else if (c === 23) s.italic = false;
    else if (c === 24) s.underline = false;
    else if (c === 27) s.inverse = false;
    else if (c >= 30 && c <= 37) s.fg = BASE[c - 30];
    else if (c >= 90 && c <= 97) s.fg = BRIGHT[c - 90];
    else if (c === 39) s.fg = undefined;
    else if (c >= 40 && c <= 47) s.bg = BASE[c - 40];
    else if (c >= 100 && c <= 107) s.bg = BRIGHT[c - 100];
    else if (c === 49) s.bg = undefined;
    else if (c === 38 || c === 48) {
      const key = c === 38 ? "fg" : "bg";
      if (codes[i + 1] === 5 && codes[i + 2] !== undefined) { s[key] = c256(codes[i + 2]!); i += 2; }
      else if (codes[i + 1] === 2 && codes[i + 4] !== undefined) { s[key] = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; i += 4; }
    }
  }
  return s;
}

function css(s: Style): string {
  const parts: string[] = [];
  let fg = s.fg, bg = s.bg;
  if (s.inverse) [fg, bg] = [bg ?? "#0b1220", fg ?? "#e2e8f0"];
  if (fg) parts.push(`color:${fg}`);
  if (bg) parts.push(`background:${bg}`);
  if (s.bold) parts.push("font-weight:700");
  if (s.dim) parts.push("opacity:.6");
  if (s.italic) parts.push("font-style:italic");
  if (s.underline) parts.push("text-decoration:underline");
  return parts.join(";");
}

const ESC_RE = /\u001b\[([0-9;]*)m|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[A-Za-z]|\u001b[()][A-Z0-9]|\u001b[=>]/g;

/** Render one screen of ANSI text as an array of spans and raw strings. */
export function renderAnsi(text: string): ComponentChild[] {
  const out: ComponentChild[] = [];
  let st: Style = {};
  let last = 0;
  let key = 0;
  const push = (chunk: string) => {
    if (!chunk) return;
    const style = css(st);
    out.push(style ? h("span", { key: key++, style }, chunk) : chunk);
  };
  for (const m of text.matchAll(ESC_RE)) {
    push(text.slice(last, m.index));
    last = m.index! + m[0].length;
    if (m[1] !== undefined) st = apply(st, m[1] === "" ? [0] : m[1].split(";").map((x) => Number(x || 0)));
  }
  push(text.slice(last));
  return out;
}
