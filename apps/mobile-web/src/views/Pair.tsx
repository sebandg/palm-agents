import { useState } from "preact/hooks";
import { api } from "../api.ts";

export function PairView({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.post("/api/pair", { code: code.replace(/\D/g, ""), label: navigator.userAgent.includes("iPhone") ? "iPhone" : "Browser" });
      onPaired();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="pair">
      <h1>Pair this phone</h1>
      <p class="muted">On the Mac run <code>npm run pair</code> and enter the 8-digit code. Codes are one-use and expire after 5 minutes.</p>
      <form onSubmit={submit}>
        <input inputMode="numeric" autoComplete="one-time-code" placeholder="0000 0000" value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value)} />
        <p />
        <button disabled={busy || code.replace(/\D/g, "").length !== 8}>Pair</button>
      </form>
      {err && <p style="color:#fca5a5">{err}</p>}
    </div>
  );
}
