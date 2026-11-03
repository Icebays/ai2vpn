#!/bin/sh
# Runs as root only to fix ownership, then serves a web terminal as "coder".
set -e
SOCK="${SANDBOX_SOCKET:-/run/sandbox/ttyd.sock}"
mkdir -p "$(dirname "$SOCK")" /workspace /home/coder
rm -f "$SOCK"

# Bind-mounted folders are created by Docker as root: hand them to coder.
[ "$(stat -c %u /home/coder)" = "1000" ] || chown -R 1000:1000 /home/coder
[ "$(stat -c %u /workspace)" = "1000" ] || chown 1000:1000 /workspace
chown 1000:1000 "$(dirname "$SOCK")"
[ -f /home/coder/.bashrc ] || cp /etc/skel-coder/.bashrc /home/coder/.bashrc && chown 1000:1000 /home/coder/.bashrc

if [ "${SANDBOX_SUDO:-true}" != "true" ]; then rm -f /etc/sudoers.d/coder; fi

echo "[sandbox] web terminal on $SOCK"
# -W: writable terminal; -b: served under ai2vpn's /sandbox/term/; tmux keeps sessions alive.
exec runuser -u coder -- env HOME=/home/coder USER=coder SHELL=/bin/bash \
  ttyd -W -i "$SOCK" -b /sandbox/term \
    -t fontSize=14 -t disableLeaveAlert=true -t titleFixed="ai2vpn sandbox" \
    -t 'theme={"background":"#0d0f13"}' \
    tmux new-session -A -s main -c /workspace
