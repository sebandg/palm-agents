// Resumable event stream. Every envelope is persisted (stream_log) before it is
// published, so a reconnecting phone replays from its last cursor.
import type { StreamEnvelope } from "@palm-agents/protocol";
import type { Store } from "./store.ts";

type Subscriber = (env: StreamEnvelope) => void;
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type Body = DistributiveOmit<StreamEnvelope, "cursor">;

export class StreamHub {
  private subs = new Set<Subscriber>();
  constructor(private readonly store: Store) {}

  /** Persist + fan out. Returns the cursor. */
  publish(body: Body): number {
    const cursor = this.store.appendStream(body.kind, body);
    this.fanout({ ...body, cursor } as StreamEnvelope);
    return cursor;
  }
  /** Deliver to live subscribers. */
  fanout(env: StreamEnvelope) {
    for (const s of this.subs) {
      try {
        s(env);
      } catch {
        /* subscriber errors never affect others */
      }
    }
  }
  subscribe(fn: Subscriber): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
  replay(afterCursor: number): StreamEnvelope[] {
    return this.store.streamAfter(afterCursor).map((r) => ({ ...(r.body as Body), cursor: r.cursor }) as StreamEnvelope);
  }
  get subscriberCount() {
    return this.subs.size;
  }
}
