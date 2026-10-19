// Shared protocol: browser ownership, stream envelopes, bridge contracts, terminal sessions.
// Everything that crosses a process boundary (phone <-> control service,
// control service <-> browser worker, control service <-> MCP bridge) is typed here.
import { z } from "zod";

// ---------------------------------------------------------------------------
// Browser ownership
// ---------------------------------------------------------------------------
export const OwnershipState = z.enum([
  "agent_control",
  "pausing",
  "human_control",
  "recovering",
  "unavailable",
]);
export type OwnershipState = z.infer<typeof OwnershipState>;

export const OwnershipRecord = z.object({
  state: OwnershipState,
  /** The agent holding the browser: its terminal session name ("agent" when unknown), or null when free. */
  holder: z.string().nullable(),
  /** Monotonic lease: bumped on every change of control, so an operation can tell control changed under it. */
  lease: z.number().int(),
  /** Why the human has the browser, when state is human_control/pausing. */
  humanRequest: z
    .object({
      /** The agent that handed over or was taken over from; null when the owner just browses. */
      holder: z.string().nullable(),
      reason: z.string(),
      kind: z.enum(["login", "otp", "captcha", "native_dialog", "other"]),
      requestedAt: z.string(),
      requestedBy: z.enum(["agent", "owner"]),
    })
    .nullable(),
  updatedAt: z.string(),
});
export type OwnershipRecord = z.infer<typeof OwnershipRecord>;

/** Global stream envelope sent over SSE. `cursor` is the global, monotonically increasing id. */
export const StreamEnvelope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ownership"), cursor: z.number().int(), ownership: OwnershipRecord }),
  z.object({ kind: z.literal("health"), cursor: z.number().int(), health: z.unknown() }),
  z.object({ kind: z.literal("session_revoked"), cursor: z.number().int() }),
]);
export type StreamEnvelope = z.infer<typeof StreamEnvelope>;

// ---------------------------------------------------------------------------
// Browser worker contracts
// ---------------------------------------------------------------------------
export const BrowserTab = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  selected: z.boolean(),
  /** The terminal session whose agent works in this tab, if any. */
  session: z.string().optional(),
});
export type BrowserTab = z.infer<typeof BrowserTab>;

export const FrameMeta = z.object({
  /** Increments whenever the browser process/context is (re)launched. Inputs for an old generation are rejected. */
  generation: z.number().int(),
  tabId: z.string(),
  url: z.string(),
  title: z.string(),
  viewport: z.object({ width: z.number().int(), height: z.number().int() }),
  seq: z.number().int(),
  capturedAt: z.string(),
  /** True while the browser emulates the owner's phone (human control). */
  mobile: z.boolean().optional(),
  /** Visible editable fields in viewport pixels, so a tap on one can open the phone keyboard at once. */
  fields: z.array(z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })).optional(),
});
export type FrameMeta = z.infer<typeof FrameMeta>;

export const BrowserInput = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("click"),
    x: z.number(),
    y: z.number(),
    /** Viewport the coordinates were computed against; must match the live viewport. */
    viewport: z.object({ width: z.number().int(), height: z.number().int() }),
  }),
  z.object({ type: z.literal("type"), text: z.string().max(4096), sensitive: z.boolean().optional() }),
  /**
   * Fill the page's own username / password / one-time-code fields, located by the
   * worker (autocomplete hints, input types, names). Lets the phone use its password
   * manager (iOS AutoFill, Bitwarden) instead of tapping fields and typing blind.
   * Values are never logged or stored. Fields that are not on the page are skipped
   * and reported back so the phone can keep them for the next step.
   */
  z.object({
    type: z.literal("fill"),
    username: z.string().max(512).optional(),
    password: z.string().max(1024).optional(),
    otp: z.string().max(64).optional(),
    submit: z.boolean().optional(),
  }),
  z.object({ type: z.literal("key"), key: z.enum(["Enter", "Tab", "Backspace", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) }),
  z.object({ type: z.literal("scroll"), dy: z.number(), dx: z.number().optional() }),
  /** Press, move and release (slider captchas, drag handles). Points in viewport pixels, at most 60. */
  z.object({
    type: z.literal("drag"),
    points: z.array(z.object({ x: z.number(), y: z.number() })).min(2).max(60),
    viewport: z.object({ width: z.number().int(), height: z.number().int() }),
  }),
  z.object({ type: z.literal("back") }),
  z.object({ type: z.literal("navigate"), url: z.string().url() }),
  z.object({ type: z.literal("select_tab"), tabId: z.string() }),
]);
export type BrowserInput = z.infer<typeof BrowserInput>;

/** Human input from the phone carries frame identity so stale taps can be rejected. */
export const HumanInputRequest = z.object({
  requestId: z.string(),
  generation: z.number().int(),
  tabId: z.string(),
  frameSeq: z.number().int(),
  input: BrowserInput,
});
export type HumanInputRequest = z.infer<typeof HumanInputRequest>;

export const BrowserHealth = z.object({
  state: z.enum(["starting", "ready", "unavailable", "stopped"]),
  generation: z.number().int(),
  lastContactAt: z.string().nullable(),
  error: z.string().nullable(),
  profileDir: z.string().nullable(),
});
export type BrowserHealth = z.infer<typeof BrowserHealth>;

// ---------------------------------------------------------------------------
// Agent bridge (MCP bridge -> control service). Every call carries the agent token
// and, when known, the terminal session the agent runs in.
// ---------------------------------------------------------------------------
export const BridgeToolName = z.enum([
  "browser_observe",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_key",
  "browser_scroll",
  "browser_tabs",
  "request_human",
]);
export type BridgeToolName = z.infer<typeof BridgeToolName>;

export const BridgeToolArgs: Record<BridgeToolName, z.ZodTypeAny> = {
  browser_observe: z.object({}),
  browser_navigate: z.object({ url: z.string().url() }),
  browser_click: z.object({
    ref: z.string().optional().describe("Element reference from the last observation, e.g. e12"),
    x: z.number().optional(),
    y: z.number().optional(),
  }),
  browser_type: z.object({
    text: z.string().max(4096),
    ref: z.string().optional(),
    submit: z.boolean().optional().describe("Press Enter after typing"),
  }),
  browser_key: z.object({ key: z.enum(["Enter", "Tab", "Backspace", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) }),
  browser_scroll: z.object({ dy: z.number().describe("Positive scrolls down") }),
  browser_tabs: z.object({ select: z.string().optional().describe("Tab id to select") }),
  request_human: z.object({
    reason: z.string().max(500),
    kind: z.enum(["login", "otp", "captcha", "native_dialog", "other"]),
  }),
};

export const BridgeCall = z.object({
  tool: BridgeToolName,
  args: z.record(z.string(), z.unknown()),
});
export type BridgeCall = z.infer<typeof BridgeCall>;

export const BridgeResult = z.object({
  ok: z.boolean(),
  /** Text block returned to the model. Never contains credentials typed by the human. */
  text: z.string(),
  /** Base64 JPEG screenshot for observe calls (sent to the model as an image block). */
  imageBase64: z.string().optional(),
  /** true when the call was rejected by the ownership gate; the agent must stop and wait. */
  blocked: z.boolean().optional(),
});
export type BridgeResult = z.infer<typeof BridgeResult>;

/** Observation returned to the model: compact accessibility-ish tree with refs. */
export const Observation = z.object({
  generation: z.number().int(),
  tabId: z.string(),
  url: z.string(),
  title: z.string(),
  elements: z.array(
    z.object({
      ref: z.string(),
      role: z.string(),
      name: z.string(),
      value: z.string().optional(),
      box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
    }),
  ),
  textSnippet: z.string(),
});
export type Observation = z.infer<typeof Observation>;

// ---------------------------------------------------------------------------
// Phone API request schemas
// ---------------------------------------------------------------------------
/** Phone-sized viewport the browser emulates while the owner has control. */
/** Phone mode at the given size, or `{ desktop: true }` for the desktop site ("request desktop website"). */
export const DeviceRequest = z.union([
  z.object({ width: z.number().int().min(280).max(1200), height: z.number().int().min(300).max(2000) }),
  z.object({ desktop: z.literal(true) }),
]);
export type DeviceRequest = z.infer<typeof DeviceRequest>;
export const TakeControlRequest = z.object({ reason: z.string().max(500).optional() });

export const HealthReport = z.object({
  service: z.object({ ok: z.boolean(), startedAt: z.string(), now: z.string(), version: z.string() }),
  browser: BrowserHealth,
  /** When an agent last used the shared browser. */
  agent: z.object({ lastContactAt: z.string().nullable() }),
  ownership: OwnershipRecord,
  push: z.object({ configured: z.boolean(), subscriptions: z.number().int() }),
});
export type HealthReport = z.infer<typeof HealthReport>;

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Terminal sessions (tmux on the Mac). The phone is a remote for real interactive
// CLI sessions (e.g. `claude` with whatever tools the owner gives it); the
// control service only lists, screenshots (text) and types into them.
// ---------------------------------------------------------------------------
export const TERM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
/** tmux key names the phone may send; anything else is rejected. */
export const TermKey = z.enum([
  "Enter", "Escape", "Tab", "BTab", "Space", "BSpace", "Up", "Down", "Left", "Right",
  "Home", "End", "PageUp", "PageDown", "C-c", "C-d", "C-u", "C-l", "C-z", "C-r", "C-o",
]);
export type TermKey = z.infer<typeof TermKey>;
export const TermKeysRequest = z.object({
  /** Literal text typed as-is (no key-name interpretation). */
  text: z.string().max(8_000).optional(),
  /** Special keys sent after the text, in order. */
  keys: z.array(TermKey).max(16).optional(),
});
export type TermKeysRequest = z.infer<typeof TermKeysRequest>;
export const TermCreateRequest = z.object({
  name: z.string().regex(TERM_NAME_RE),
  cwd: z.string().max(1024).optional(),
  /** Shell command to run in the new session (default: the login shell). */
  command: z.string().max(1024).optional(),
});
export type TermCreateRequest = z.infer<typeof TermCreateRequest>;
/** Fit the pane to the phone so lines wrap at the phone's width instead of scrolling sideways. */
export const TermResizeRequest = z.object({ cols: z.number().int().min(20).max(300), rows: z.number().int().min(5).max(200) });
export type TermResizeRequest = z.infer<typeof TermResizeRequest>;
export const TermSession = z.object({
  name: z.string(),
  createdAt: z.string(),
  attached: z.boolean(),
  windows: z.number().int(),
  /** Active pane of the active window. */
  pane: z.object({ id: z.string(), command: z.string(), path: z.string(), title: z.string(), cols: z.number().int(), rows: z.number().int() }),
  /** Heuristic: the last screen lines look like a prompt waiting for the owner. */
  attention: z.boolean(),
  /** waiting = attention; working = the screen changed in the last few seconds; idle otherwise. */
  activity: z.enum(["working", "waiting", "idle"]),
  /** Dev servers started from this session; url is set while shared to the owner's tailnet. */
  previews: z.array(z.object({ port: z.number().int(), url: z.string().nullable() })).optional(),
});
export type TermSession = z.infer<typeof TermSession>;
/** A photo or screenshot from the phone, pasted into the session as a file path. */
export const TermImageRequest = z.object({
  /** Base64 image bytes; JPEG, PNG, GIF, WebP or HEIC. ~9 MB at most. */
  dataBase64: z.string().min(16).max(12_000_000),
});
export type TermImageRequest = z.infer<typeof TermImageRequest>;
export const TermScreen = z.object({
  name: z.string(),
  /** Foreground program in the pane (tmux pane_current_command), e.g. "zsh" or claude's process title. */
  command: z.string(),
  text: z.string(),
  cursor: z.object({ x: z.number().int(), y: z.number().int() }),
  size: z.object({ cols: z.number().int(), rows: z.number().int() }),
  attention: z.boolean(),
  capturedAt: z.string(),
});
export type TermScreen = z.infer<typeof TermScreen>;
