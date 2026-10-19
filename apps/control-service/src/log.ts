// Bounded, secret-free logging. Rotates by size; never logs tokens, cookies,
// typed input, or screenshots. Callers must pass already-sanitized text.
import fs from "node:fs";
import path from "node:path";

export type Level = "info" | "warn" | "error";
export interface Logger {
  (level: Level, msg: string, extra?: Record<string, unknown>): void;
  recent(): string[];
}

const SECRET_RE = /(token|secret|password|cookie|authorization)[^\s]*\s*[:=]\s*\S+/gi;

export function createLogger(logDir: string, opts: { maxBytes?: number; keep?: number; stdout?: boolean } = {}): Logger {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const keep = opts.keep ?? 3;
  const file = path.join(logDir, "control-service.log");
  const ring: string[] = [];
  const write = (line: string) => {
    ring.push(line);
    if (ring.length > 300) ring.shift();
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > maxBytes) {
        for (let i = keep - 1; i >= 1; i--) {
          const from = `${file}.${i}`;
          if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}`);
        }
        fs.renameSync(file, `${file}.1`);
      }
      fs.appendFileSync(file, line + "\n", { mode: 0o600 });
    } catch {
      /* logging must never crash the service */
    }
    if (opts.stdout !== false) process.stdout.write(line + "\n");
  };
  const log = ((level: Level, msg: string, extra?: Record<string, unknown>) => {
    const safeMsg = msg.replace(SECRET_RE, "$1=[redacted]");
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${safeMsg}${extra ? " " + JSON.stringify(extra).replace(SECRET_RE, "$1=[redacted]") : ""}`;
    write(line);
  }) as Logger;
  log.recent = () => [...ring];
  return log;
}
