#!/bin/sh
set -e
mkdir -p "${DATA_DIR:-/data}"

# TUN device for OpenVPN (normally passed with --device /dev/net/tun)
if [ ! -c /dev/net/tun ]; then
  mkdir -p /dev/net && mknod /dev/net/tun c 10 200 2>/dev/null && chmod 600 /dev/net/tun || true
fi

# Some hosts (older kernels, Synology, …) have no nf_tables: fall back to legacy iptables.
if ! iptables -t mangle -S >/dev/null 2>&1; then
  if iptables-legacy -t mangle -S >/dev/null 2>&1; then
    update-alternatives --set iptables /usr/sbin/iptables-legacy >/dev/null 2>&1 || true
  fi
fi

# A virtual display so Chromium can run "headed" (harder for sites to flag as a bot).
if [ "$HEADLESS" != "true" ]; then
  rm -f /tmp/.X99-lock
  Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp >/dev/null 2>&1 &
  export DISPLAY=:99
  sleep 0.5
fi

exec /app/scripts/run-app.sh
