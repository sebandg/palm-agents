// Photos and screenshots from the phone, saved owner-only so a terminal agent can read them.
// Kept for a week, then removed.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const KEEP_MS = 7 * 24 * 3600_000;

/** File type from the first bytes; anything that is not a common image is refused. */
export function imageType(buf: Buffer): "jpg" | "png" | "gif" | "webp" | "heic" | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.subarray(0, 4).toString("latin1") === "GIF8") return "gif";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (buf.subarray(4, 8).toString("latin1") === "ftyp" && /^(heic|heix|mif1|msf1|hevc)$/.test(buf.subarray(8, 12).toString("latin1"))) return "heic";
  return null;
}

export function saveImage(dir: string, buf: Buffer): string {
  const ext = imageType(buf);
  if (!ext) throw new Error("not a JPEG, PNG, GIF, WebP or HEIC image");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const file = path.join(dir, `photo-${stamp}-${randomBytes(3).toString("hex")}.${ext}`);
  fs.writeFileSync(file, buf, { mode: 0o600 });
  return file;
}

export function pruneUploads(dir: string) {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    const f = path.join(dir, n);
    try { if (Date.now() - fs.statSync(f).mtimeMs > KEEP_MS) fs.unlinkSync(f); } catch { /* gone */ }
  }
}
