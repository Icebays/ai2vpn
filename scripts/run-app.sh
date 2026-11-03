#!/bin/sh
# Supervisor for the ai2vpn Node process.
# - Runs the updated code from $DATA_DIR/app/current if present, else the image's code.
# - Exit code 75 = "restart me" (after an in-app update or rollback).
# - If an updated version crashes right after starting twice, roll back to the image's code.
APP_IMAGE_DIR="${APP_IMAGE_DIR:-/app}"
DATA_DIR="${DATA_DIR:-/data}"
CUR="$DATA_DIR/app/current"
export A2V_SUPERVISED=1
fails=0
while :; do
  dir="$APP_IMAGE_DIR"
  [ -f "$CUR/src/server.js" ] && dir="$CUR"
  start=$(date +%s)
  node "$dir/src/server.js"
  code=$?
  if [ "$code" = 75 ]; then
    echo "[run-app] restarting ai2vpn"
    fails=0
    continue
  fi
  if [ "$dir" != "$APP_IMAGE_DIR" ] && [ $(( $(date +%s) - start )) -lt 60 ]; then
    fails=$((fails + 1))
    echo "[run-app] updated version exited with code $code shortly after starting ($fails)"
    if [ "$fails" -ge 2 ]; then
      echo "[run-app] rolling back to the version built into the image"
      rm -f "$CUR"
      fails=0
    fi
    sleep 2
    continue
  fi
  exit "$code"
done
