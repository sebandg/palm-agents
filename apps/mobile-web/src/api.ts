// Thin fetch wrapper. Every mutation sends the CSRF header; cookies carry the session.
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "x-pa-request": "1", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, typeof data.error === "string" ? data.error : `HTTP ${res.status}`);
  return data as T;
}
export const api = {
  get: <T>(p: string) => req<T>("GET", p),
  post: <T>(p: string, b?: unknown) => req<T>("POST", p, b ?? {}),
  del: <T>(p: string) => req<T>("DELETE", p),
};
export function rid(): string {
  return crypto.randomUUID();
}
