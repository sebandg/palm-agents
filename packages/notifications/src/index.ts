// Optional Web Push. A payload names at most the agent's terminal session (which the owner
// chose), never what the agent is doing or what is on screen.
import webPush from "web-push";

export interface PushKeys { publicKey: string; privateKey: string }
export interface PushSubscriptionRecord { id: string; endpoint: string; keys: { p256dh: string; auth: string } }

export function generateVapidKeys(): PushKeys {
  const k = webPush.generateVAPIDKeys();
  return { publicKey: k.publicKey, privateKey: k.privateKey };
}

/** browser: an agent handed the browser over; terminal: a session waits for an answer. */
export type Alert = { kind: "browser" | "terminal"; session: string | null } | { kind: "service" };

/** Notification text, the tag that collapses repeats, and the app link that opens the right place. */
export function alertPayload(a: Alert): { title: string; body: string; tag: string; url: string } {
  const who = a.kind !== "service" && a.session ? a.session : "An agent";
  switch (a.kind) {
    case "browser": return { title: "Palm Agents", body: `${who} needs you in the browser`, tag: "browser", url: "/?open=browser" };
    case "terminal": return { title: "Palm Agents", body: `${who} is waiting for you`, tag: `term:${a.session ?? ""}`, url: a.session ? `/?open=${encodeURIComponent(`term:${a.session}`)}` : "/" };
    case "service": return { title: "Palm Agents", body: "Palm Agents reported a problem", tag: "service", url: "/system" };
  }
}

export interface PushSender {
  send(sub: PushSubscriptionRecord, alert: Alert): Promise<{ ok: true } | { ok: false; gone: boolean; error: string }>;
}

export function createPushSender(keys: PushKeys, contact: string): PushSender {
  webPush.setVapidDetails(contact, keys.publicKey, keys.privateKey);
  return {
    async send(sub, alert) {
      const payload = JSON.stringify(alertPayload(alert));
      try {
        await webPush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload, { TTL: 600, urgency: "high" });
        return { ok: true };
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        return { ok: false, gone: status === 404 || status === 410, error: `push failed (${status ?? "network"})` };
      }
    },
  };
}
