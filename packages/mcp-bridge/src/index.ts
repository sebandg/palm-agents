// Stdio MCP server that gives agents (Claude Code / Codex in terminal sessions, started
// from their MCP config) the shared browser. It holds no browser state: every call is
// forwarded to the control service's /bridge endpoint with the agent token, and the
// control service enforces ownership immediately before execution. The token is read
// from the service's token file on every call, so a service restart (which rotates it)
// needs no config change.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BridgeResult, BridgeToolArgs, BridgeToolName } from "@palm-agents/protocol";
import { z } from "zod";

export const TOOL_DESCRIPTIONS: Record<BridgeToolName, string> = {
  browser_observe:
    "Capture the current page of the shared browser: URL, title, interactive elements with refs (e1, e2, ...) and a screenshot. Call this before clicking or typing, and again after navigation.",
  browser_navigate: "Navigate the selected tab to a URL.",
  browser_click: "Click an element by ref from the last observation (preferred) or by screenshot x,y coordinates.",
  browser_type: "Type text into an element ref (focuses it first) or into the focused element. Set submit=true to press Enter afterwards.",
  browser_key: "Press a single key: Enter, Tab, Backspace, Escape or an arrow key.",
  browser_scroll: "Scroll the page vertically by dy pixels (positive = down).",
  browser_tabs: "List open tabs (including popups). Pass select=<id> to switch tabs.",
  request_human:
    "Hand the shared browser to the owner when you hit a login, OTP, CAPTCHA, or a native dialog you cannot complete; their phone shows that you need them. This call waits until they hand the browser back (if it returns 'still waiting', call it again with the same reason). Never ask the owner to send you passwords or codes in chat.",
};

export interface BridgeClientOptions {
  baseUrl: string;
  /** A fixed token, or a function that reads the current one. */
  token: string | (() => string);
  /** The tmux session the agent runs in, so the phone can point back to it. */
  session?: string;
  fetchImpl?: typeof fetch;
}

export async function callBridge(opts: BridgeClientOptions, tool: BridgeToolName, args: unknown): Promise<BridgeResult> {
  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${opts.baseUrl}/bridge/call`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${typeof opts.token === "function" ? opts.token() : opts.token}`,
        ...(opts.session ? { "x-palm-agents-session": opts.session } : {}),
      },
      body: JSON.stringify({ tool, args }),
    });
  } catch {
    return { ok: false, text: "The shared browser is not reachable: the Palm Agents service on this machine is not running." };
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const b = body as { error?: unknown; text?: unknown } | null;
    const msg = typeof b?.error === "string" ? b.error : typeof b?.text === "string" ? b.text : `bridge HTTP ${res.status}`;
    return { ok: false, text: msg, blocked: res.status === 409 };
  }
  return BridgeResult.parse(body);
}

export function createBridgeServer(opts: BridgeClientOptions): McpServer {
  const server = new McpServer({ name: "palm-browser", version: "0.1.0" });
  for (const tool of BridgeToolName.options) {
    const schema = BridgeToolArgs[tool] as z.ZodObject<z.ZodRawShape>;
    server.registerTool(
      tool,
      { description: TOOL_DESCRIPTIONS[tool], inputSchema: schema.shape },
      async (args: Record<string, unknown>) => {
        const r = await callBridge(opts, tool, args);
        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
          { type: "text", text: r.text },
        ];
        if (r.imageBase64) content.push({ type: "image", data: r.imageBase64, mimeType: "image/jpeg" });
        return { content, isError: !r.ok };
      },
    );
  }
  return server;
}

/** Where the control service writes the token for terminal agents. */
export function agentTokenPath(env = process.env): string {
  return path.join(env.PALM_AGENTS_DATA_DIR ?? path.join(os.homedir(), ".palm-agents"), "agent-bridge-token");
}

/** The tmux session this process runs in (inherited TMUX_PANE), if any. */
function tmuxSession(): string | undefined {
  const pane = process.env.TMUX_PANE;
  if (!pane) return undefined;
  for (const bin of ["tmux", "/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", path.join(os.homedir(), ".local/bin/tmux")]) {
    try {
      return execFileSync(bin, ["display-message", "-p", "-t", pane, "#S"], { encoding: "utf8", timeout: 2000 }).trim() || undefined;
    } catch { /* try the next location */ }
  }
  return undefined;
}

export async function runStdioBridge(): Promise<void> {
  const baseUrl = process.env.PALM_AGENTS_BRIDGE_URL ?? `http://127.0.0.1:${process.env.PALM_AGENTS_PORT ?? 8787}`;
  const file = agentTokenPath();
  const token = () => {
    try { return fs.readFileSync(file, "utf8").trim(); } catch { return ""; }
  };
  const server = createBridgeServer({ baseUrl, token, session: tmuxSession() });
  await server.connect(new StdioServerTransport());
}
