# Working on Palm Agents

- **Everything must be transferable.** A fix or a behavior belongs in this repo: the service code, `scripts/`, or `docs/`. Someone who clones the repo on another Mac must get it without extra steps. Do not solve a problem only in files on one machine (`~/.tmux.conf`, `~/.claude/` settings or memory, `~/.palm-agents`). Local files are for secrets and personal values only, and `scripts/setup.sh` or `docs/setup.md` must say how to create them.
- When behavior changes, update `docs/features.md` (what each part does and its known limits) and `docs/setup.md` if setup changes.
- Check with `npm run typecheck` and `npm test` before calling a change done.
