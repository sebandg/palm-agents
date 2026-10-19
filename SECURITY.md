# Security policy

Palm Agents gives a paired phone control over agents, a browser and a shell on your machine, so security reports are very welcome.

**Please do not open a public issue for a vulnerability.** Report it privately through GitHub: the repository's **Security** tab → **Report a vulnerability**. Include what you found, how to reproduce it, and what an attacker could do with it. You will get an answer as soon as possible; this is a one-person project, so allow a few days.

Only the latest version on `main` is supported.

What the project does and does not protect against is described in [docs/security.md](docs/security.md). In short: it assumes a private network (Tailscale, never Funnel or a public port), a single owner, and trusted agents. Reports that break those assumptions' protections (pairing, sessions, CSRF/Origin checks, the agent bridge token, the browser ownership gate, credential handling) are in scope.
