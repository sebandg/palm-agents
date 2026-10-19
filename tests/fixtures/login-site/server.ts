// Deterministic login fixture for tests and manual handoff rehearsal.
// Flow: /  -> /login (username+password) -> /otp (6-digit code) -> /success
// /popup-login opens a popup window that completes the login (popup tab test).
// Credentials: owner / fixture-pass, OTP 246810.
import http from "node:http";
import { randomUUID } from "node:crypto";

export const FIXTURE_USER = "owner";
export const FIXTURE_PASS = "fixture-pass";
export const FIXTURE_OTP = "246810";

const sessions = new Map<string, { stage: "password" | "otp" | "done" }>();

function page(title: string, body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:-apple-system,Helvetica,Arial;margin:40px;max-width:480px}input,button{font-size:18px;padding:8px;margin:6px 0;display:block;width:100%}</style>
</head><body><h1>${title}</h1>${body}</body></html>`;
}

function parseCookies(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k) out[k] = decodeURIComponent(v.join("="));
  }
  return out;
}
function readBody(req: http.IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(new URLSearchParams(data)));
  });
}

export function createFixtureServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture");
    const cookies = parseCookies(req);
    let sid = cookies.fsid;
    if (!sid || !sessions.has(sid)) {
      sid = randomUUID();
      sessions.set(sid, { stage: "password" });
      res.setHeader("set-cookie", `fsid=${sid}; Path=/; HttpOnly`);
    }
    const s = sessions.get(sid)!;
    const send = (status: number, html: string) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
    };
    const redirect = (to: string) => {
      res.writeHead(303, { location: to });
      res.end();
    };

    if (req.method === "GET" && url.pathname === "/") {
      return send(200, page("Fixture Portal", `<p>Public landing page.</p><a id="go-login" href="/login">Sign in</a><br><a id="go-popup" href="/popup-start">Sign in with popup</a>`));
    }
    if (url.pathname === "/login") {
      if (req.method === "GET") {
        if (s.stage === "done") return redirect("/success");
        // ?overlay=1: as on some sites' phone layouts, a transparent layer sits over the form and swallows clicks.
        const cover = url.searchParams.get("overlay") ? `<div style="position:fixed;inset:0;z-index:10"></div>` : "";
        return send(200, page("Sign in", `${cover}<form method="post" action="/login"><label for="u">Username</label><input id="u" name="username" autocomplete="username"><label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password"><button type="submit">Continue</button></form>`));
      }
      const form = await readBody(req);
      if (form.get("username") === FIXTURE_USER && form.get("password") === FIXTURE_PASS) {
        s.stage = "otp";
        return redirect("/otp");
      }
      return send(401, page("Sign in", `<p id="err">Wrong username or password.</p><a href="/login">Try again</a>`));
    }
    if (url.pathname === "/otp") {
      if (s.stage !== "otp" && s.stage !== "done") return redirect("/login");
      if (req.method === "GET") {
        if (s.stage === "done") return redirect("/success");
        if (url.searchParams.get("split")) {
          // One box per character with focus auto-advance, like many real verification pages.
          const boxes = [1, 2, 3, 4, 5, 6].map((i) => `<input class="d" name="c${i}" maxlength="1" inputmode="text" autocomplete="off">`).join("");
          return send(200, page("One-time code", `<form method="post" action="/otp"><label>Enter the 6-character code</label><div>${boxes}</div><button type="submit">Verify</button></form><script>document.querySelectorAll('.d').forEach((el,i,all)=>el.addEventListener('input',()=>{if(el.value&&all[i+1])all[i+1].focus();}));</script>`));
        }
        return send(200, page("One-time code", `<form method="post" action="/otp"><label for="c">Enter the one-time code (OTP)</label><input id="c" name="code" inputmode="numeric" autocomplete="one-time-code"><button type="submit">Verify</button></form>`));
      }
      const form = await readBody(req);
      const code = form.get("code") ?? [1, 2, 3, 4, 5, 6].map((i) => form.get(`c${i}`) ?? "").join("");
      if (code === FIXTURE_OTP) {
        s.stage = "done";
        return redirect("/success");
      }
      return send(401, page("One-time code", `<p id="err">Wrong code.</p><a href="/otp">Try again</a>`));
    }
    if (url.pathname === "/popup-start") {
      return send(200, page("Popup sign in", `<p>Click to open the login popup.</p><button id="open" onclick="window.open('/login','login','width=420,height=520')">Open popup</button><p id="status">${s.stage === "done" ? "Signed in" : "Not signed in"}</p>`));
    }
    if (url.pathname === "/success") {
      if (s.stage !== "done") return redirect("/login");
      return send(200, page("Success", `<p id="ok">Login successful. Welcome, ${FIXTURE_USER}.</p><p>Secret dashboard value: <b id="value">42</b></p><a href="/logout">Log out</a>`));
    }
    if (url.pathname === "/logout") {
      s.stage = "password";
      return redirect("/");
    }
    send(404, page("Not found", ""));
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ""))) {
  const port = Number(process.env.FIXTURE_PORT ?? 8899);
  createFixtureServer().listen(port, "127.0.0.1", () => console.log(`fixture login site on http://127.0.0.1:${port}/`));
}
