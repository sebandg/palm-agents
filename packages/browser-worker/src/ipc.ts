// IPC message shapes between the control service (parent) and the browser worker (child).
import type { BrowserHealth, BrowserInput, BrowserTab, FrameMeta, Observation } from "@palm-agents/protocol";

/** Which credential fields a `fill` input actually wrote. */
export type FillField = "username" | "password" | "otp";

export interface WorkerMethods {
  launch: { params: Record<string, never>; result: { generation: number } };
  health: { params: Record<string, never>; result: BrowserHealth };
  tabs: { params: Record<string, never>; result: BrowserTab[] };
  selectTab: { params: { tabId: string }; result: BrowserTab[] };
  /** Open a blank tab and select it. */
  newTab: { params: Record<string, never>; result: { id: string } };
  /** Close a tab; the last tab is replaced by a blank one so the browser stays usable. */
  closeTab: { params: { tabId: string }; result: BrowserTab[] };
  frame: { params: { quality?: number }; result: { meta: FrameMeta; jpegBase64: string } };
  observe: { params: Record<string, never>; result: { observation: Observation; jpegBase64: string; meta: FrameMeta } };
  input: { params: { input: BrowserInput; expect?: { generation: number; tabId: string } }; result: { meta: FrameMeta; filled?: FillField[] } };
  clickRef: { params: { ref: string }; result: { meta: FrameMeta } };
  typeRef: { params: { ref?: string; text: string; submit?: boolean }; result: { meta: FrameMeta } };
  /** Emulate a phone of this size (mobile identity, touch, reload), or return to the desktop viewport with null. */
  device: { params: { mobile: { width: number; height: number } | null; reload?: boolean }; result: { meta: FrameMeta } };
  /** Live screencast of the selected tab: frames arrive as `frame` events while on. */
  screencast: { params: { on: boolean }; result: { on: boolean } };
  /** Resolves once no operation is in flight. Used as the takeover barrier. */
  barrier: { params: Record<string, never>; result: { drained: true } };
  shutdown: { params: Record<string, never>; result: { ok: true } };
}
export type WorkerMethodName = keyof WorkerMethods;

export interface IpcRequest { id: number; method: WorkerMethodName; params: unknown }
export type IpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string; code?: string };
export type IpcEvent =
  | { event: "health"; health: BrowserHealth }
  /** A screencast frame of the selected tab (only while the screencast is on). */
  | { event: "frame"; meta: FrameMeta; jpegBase64: string }
  /** Sent about once a second while the screencast is on, so a still page is known to be live. */
  | { event: "castTick"; generation: number; tabId: string };
export type IpcFromWorker = IpcResponse | IpcEvent;

export class WorkerError extends Error {
  constructor(message: string, public code: string = "worker_error") {
    super(message);
  }
}
