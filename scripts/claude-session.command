#!/bin/zsh
# Double-click this (or the copy on the Desktop): pick a project, get a tmux session
# running claude, attached in this Terminal window. The session keeps running when the
# window closes (Ctrl-B then D to detach), and the phone sees it in the Terminal tab.
#
# Why tmux and not plain claude: only sessions on the tmux server are visible to Palm
# Agents - the phone's Terminal tab, "needs you" push alerts, photos into the prompt,
# dev-server previews, and owner_context's per-session signals.
set -eu

DEV_DIR="${PALM_AGENTS_DEV_DIR:-$HOME/dev}"
# Extra arguments for claude, e.g. (--continue) to resume that project's last conversation.
CLAUDE_ARGS=()

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

TMUX_BIN="${PALM_AGENTS_TMUX:-}"
if [[ -z "$TMUX_BIN" ]]; then
  for c in "$(command -v tmux 2>/dev/null || true)" "$HOME/.local/bin/tmux" /opt/homebrew/bin/tmux /usr/local/bin/tmux; do
    [[ -n "$c" && -x "$c" ]] && { TMUX_BIN="$c"; break; }
  done
fi
[[ -n "$TMUX_BIN" ]] || { print -u2 "tmux not found (brew install tmux; see docs/setup.md)"; read -r -k 1 "?press a key " 2>/dev/null || true; exit 1; }
command -v claude >/dev/null 2>&1 || print -u2 "note: claude is not on PATH; the session will open but claude may not start"

# Newest first, so the project worked on last is the default.
dirs=(${DEV_DIR}/*(/Nom))
[[ ${#dirs} -gt 0 ]] || { print -u2 "no project directories in $DEV_DIR"; read -r -k 1 "?press a key " 2>/dev/null || true; exit 1; }

print -r -- "Projects in $DEV_DIR"
for i in {1..${#dirs}}; do printf "  %2d  %s\n" $i "${dirs[$i]:t}"; done
printf "\nnumber, name or path (Enter = %s, q quits): " "${dirs[1]:t}"
read -r choice || choice=""

case "$choice" in
  "") DIR="${dirs[1]}" ;;
  q|Q) exit 0 ;;
  <->) DIR="${dirs[$choice]:-}" ;;
  /*|~*) DIR="${~choice}" ;;
  *) DIR="$DEV_DIR/$choice" ;;
esac
[[ -n "${DIR:-}" && -d "$DIR" ]] || { print -u2 "no such project: ${choice:-?}"; read -r -k 1 "?press a key " 2>/dev/null || true; exit 1; }
DIR="${DIR:A}"
NAME="$(printf '%s' "${DIR:t}" | tr -c 'A-Za-z0-9._-' '-')"

# A claude started from inside another claude refuses to run, and the tmux server keeps the
# environment it was first started with, so scrub those variables (same as ~/.local/bin/cs).
clean=()
for v in ${(f)"$(env | grep -oE '^(CLAUDE|ANTHROPIC)[A-Z_]*' || true)"}; do clean+=(-u "$v"); done

# -A attaches to the session if it already exists, instead of making a second one.
if [[ -n "${PA_DRY_RUN:-}" ]]; then
  print -r -- "would run: env ${clean[*]} $TMUX_BIN new-session -A -s $NAME -c $DIR claude ${CLAUDE_ARGS[*]}"
  exit 0
fi
print -r -- "\n→ session ${NAME} in ${DIR}"
# Links opened inside the session go to the Palm Agents shared Chrome (visible on the phone).
# The options in front turn on wheel/trackpad scrolling and a long history (same as scripts/cs).
exec env "${clean[@]}" "$TMUX_BIN" start-server \; set-option -g mouse on \; set-option -g history-limit 50000 \; new-session -A -s "$NAME" -c "$DIR" -e "BROWSER=${0:A:h}/open-in-shared-browser" claude "${CLAUDE_ARGS[@]}"
