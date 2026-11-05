#!/usr/bin/env bash
# ai2vpn quick start — interactive installer and manager.
#
#   curl -fsSL https://raw.githubusercontent.com/icebays/ai2vpn/HEAD/install.sh | bash
#   ./install.sh                 # menu
#   ./install.sh install|update|start|stop|restart|status|logs|backup|uninstall
#
# Environment overrides: A2V_DIR (install folder), A2V_REPO, A2V_BRANCH.

set -u
A2V_REPO="${A2V_REPO:-https://github.com/icebays/ai2vpn.git}"
A2V_BRANCH="${A2V_BRANCH:-}"
TTY="${A2V_TTY:-/dev/tty}"          # where answers are read from (works with curl | bash)
NO_BUILD="${A2V_NO_BUILD:-}"        # testing: use already-built images

# ---------------- output helpers ----------------
if [ -t 1 ]; then B=$'\e[1m'; D=$'\e[2m'; R=$'\e[31m'; G=$'\e[32m'; Y=$'\e[33m'; C=$'\e[36m'; N=$'\e[0m'; else B= D= R= G= Y= C= N=; fi
say()  { printf '%s\n' "$*"; }
info() { printf '%s›%s %s\n' "$C" "$N" "$*"; }
ok()   { printf '%s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '%s!%s %s\n' "$Y" "$N" "$*"; }
err()  { printf '%s✗ %s%s\n' "$R" "$*" "$N" >&2; }
line() { printf '%s%s%s\n' "$D" "────────────────────────────────────────────────────────" "$N"; }

ask() { # ask "Question" default → $REPLY
  local q="$1" def="${2:-}"
  if [ -n "$def" ]; then printf '%s %s[%s]%s: ' "$q" "$D" "$def" "$N"; else printf '%s: ' "$q"; fi
  IFS= read -r REPLY <"$TTY" || REPLY=""
  [ -z "$REPLY" ] && REPLY="$def"
  return 0
}
ask_secret() {
  local q="$1" def="${2:-}"
  printf '%s %s[Enter = %s]%s: ' "$q" "$D" "${3:-keep}" "$N"
  if [ "$TTY" = /dev/tty ]; then IFS= read -rs REPLY <"$TTY" || REPLY=""; echo; else IFS= read -r REPLY <"$TTY" || REPLY=""; fi
  [ -z "$REPLY" ] && REPLY="$def"
  return 0
}
yesno() { # yesno "Question" y|n
  local def="${2:-y}" hint="Y/n"; [ "$def" = n ] && hint="y/N"
  while :; do
    printf '%s %s[%s]%s: ' "$1" "$D" "$hint" "$N"
    IFS= read -r REPLY <"$TTY" || REPLY=""
    REPLY="${REPLY:-$def}"
    case "$REPLY" in [yY]*) return 0 ;; [nN]*) return 1 ;; esac
  done
}
choose() { # choose "Title" "opt1" "opt2" … → $CHOICE (1-based); 0 = back/exit
  local title="$1"; shift
  local i=1
  say ""; say "${B}${title}${N}"
  for o in "$@"; do printf '  %s%d)%s %s\n' "$C" "$i" "$N" "$o"; i=$((i + 1)); done
  printf '  %s0)%s %s\n' "$C" "$N" "${BACK_LABEL:-Back / 返回}"
  while :; do
    printf '%s> %s' "$B" "$N"
    IFS= read -r CHOICE <"$TTY" || { CHOICE=0; return; }
    case "$CHOICE" in ''|*[!0-9]*) ;; *) [ "$CHOICE" -ge 0 ] && [ "$CHOICE" -le $# ] && return ;; esac
    warn "Enter a number 0-$# / 請輸入 0-$#"
  done
}
pause() { printf '%sPress Enter to continue / 按 Enter 繼續…%s' "$D" "$N"; IFS= read -r _ <"$TTY" || true; }

# ---------------- environment ----------------
OS="$(uname -s)"
SUDO=""; [ "$(id -u)" != 0 ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"
DOCKER="docker"; DC=""

detect_docker() {
  command -v docker >/dev/null 2>&1 || return 1
  if ! docker info >/dev/null 2>&1; then
    if [ -n "$SUDO" ] && $SUDO docker info >/dev/null 2>&1; then DOCKER="$SUDO docker"; else return 2; fi
  fi
  if $DOCKER compose version >/dev/null 2>&1; then DC="$DOCKER compose"
  elif command -v docker-compose >/dev/null 2>&1; then DC="${SUDO:+$SUDO }docker-compose"
  else return 3; fi
  return 0
}

ensure_docker() {
  detect_docker; local rc=$?
  [ $rc = 0 ] && { ok "Docker: $($DOCKER --version 2>/dev/null | head -1)"; return 0; }
  case $rc in
    1)
      warn "Docker is not installed / 未安裝 Docker"
      if [ "$OS" = Linux ] && yesno "Install Docker now with the official script (get.docker.com)? / 用官方腳本安裝 Docker？" y; then
        curl -fsSL https://get.docker.com | $SUDO sh || { err "Docker installation failed"; return 1; }
        $SUDO systemctl enable --now docker >/dev/null 2>&1 || true
        detect_docker || { err "Docker installed but not usable yet — log out/in or run with sudo"; return 1; }
        ok "Docker installed"
      else
        say "Install Docker Desktop: https://docs.docker.com/get-docker/  then run this installer again."
        return 1
      fi ;;
    2) err "Docker is installed but not running, or you lack permission. Start Docker, or run with sudo."; return 1 ;;
    3) err "Docker Compose v2 is missing. Install the 'docker-compose-plugin' package (or Docker Desktop)."; return 1 ;;
  esac
}

# ---------------- install folder ----------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"
find_dir() {
  if [ -n "${A2V_DIR:-}" ]; then DIR="$A2V_DIR"
  elif [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/docker-compose.yml" ] && [ -f "$SCRIPT_DIR/Dockerfile" ]; then DIR="$SCRIPT_DIR"
  elif [ -f "./docker-compose.yml" ] && [ -f "./Dockerfile" ] && [ -d ./src ]; then DIR="$(pwd)"
  else DIR="$HOME/ai2vpn"; fi
}
installed() { [ -f "$DIR/docker-compose.yml" ] && [ -f "$DIR/.env" ]; }
dc() { (cd "$DIR" && $DC "$@"); }

# ---------------- .env ----------------
env_get() { # env_get KEY → value or empty
  [ -f "$DIR/.env" ] || return 0
  sed -n "s/^$1=//p" "$DIR/.env" | tail -1 | sed -e "s/^'\(.*\)'$/\1/" -e 's/^"\(.*\)"$/\1/'
}
env_set() { # env_set KEY VALUE  (single-quoted so special characters are kept literally)
  local k="$1" v="$2" f="$DIR/.env"
  touch "$f"; chmod 600 "$f" 2>/dev/null || true
  local tmp; tmp="$(mktemp)"
  grep -v "^$k=" "$f" >"$tmp" || true
  printf "%s='%s'\n" "$k" "$v" >>"$tmp"
  cat "$tmp" >"$f"; rm -f "$tmp"
}
env_unset() { [ -f "$DIR/.env" ] || return 0; local tmp; tmp="$(mktemp)"; grep -v "^$1=" "$DIR/.env" >"$tmp" || true; cat "$tmp" >"$DIR/.env"; rm -f "$tmp"; }

rand_pw() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c 16; }

port_in_use() {
  local p="$1"
  if command -v ss >/dev/null 2>&1; then ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$p\$" && return 0; return 1; fi
  if command -v lsof >/dev/null 2>&1; then lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 && return 0; return 1; fi
  if command -v nc >/dev/null 2>&1; then nc -z 127.0.0.1 "$p" >/dev/null 2>&1 && return 0; fi
  return 1
}
free_port() { local p="${1:-8080}"; while port_in_use "$p"; do p=$((p + 1)); done; echo "$p"; }

lan_ip() {
  local ip=""
  if command -v ip >/dev/null 2>&1; then ip="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)"; fi
  [ -z "$ip" ] && command -v hostname >/dev/null 2>&1 && ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -z "$ip" ] && [ "$OS" = Darwin ] && ip="$(ipconfig getifaddr en0 2>/dev/null)"
  echo "${ip:-localhost}"
}

vpn_mode()      { [ "$(env_get COMPOSE_FILE)" = "docker-compose.gluetun.yml" ] && echo gluetun || echo builtin; }
sandbox_on()    { [ "$(env_get A2V_SANDBOX)" != 0 ]; }
ai_container()  { echo ai2vpn; }

# ---------------- actions ----------------
compose_up() {
  local services=""
  sandbox_on || services="$( [ "$(vpn_mode)" = gluetun ] && echo "gluetun ai2vpn" || echo "ai2vpn" )"
  if [ -n "$NO_BUILD" ]; then
    # shellcheck disable=SC2086
    dc up -d --no-build $services
  else
    info "Building and starting containers (first time can take 5-15 minutes) / 建立並啟動容器（第一次可能要 5-15 分鐘）…"
    # shellcheck disable=SC2086
    dc up -d --build $services
  fi
  local rc=$?
  if ! sandbox_on; then dc rm -sf sandbox >/dev/null 2>&1 || true; fi
  return $rc
}

wait_healthy() {
  info "Waiting for ai2vpn to start / 等待 ai2vpn 啟動…"
  local i s
  for i in $(seq 1 90); do
    s="$($DOCKER inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' ai2vpn 2>/dev/null || echo missing)"
    [ "$s" = healthy ] && { ok "ai2vpn is running / 已啟動"; return 0; }
    [ "$s" = exited ] || [ "$s" = dead ] && break
    sleep 2
  done
  err "ai2vpn did not become healthy. Last log lines:"
  $DOCKER logs --tail 30 ai2vpn 2>&1 | sed 's/^/    /'
  return 1
}

show_access() {
  local port pw url
  port="$(env_get AI2VPN_PORT)"; port="${port:-8080}"
  pw="$(env_get ADMIN_PASSWORD)"
  url="$(env_get PUBLIC_URL)"; [ -z "$url" ] && url="http://$(lan_ip):$port"
  line
  say "${B}ai2vpn is ready / ai2vpn 已就緒${N}"
  say "  Web UI   : ${G}${url}${N}"
  say "  API base : ${url}/v1"
  say "  Password : ${B}${pw:-<see docker logs ai2vpn>}${N}"
  sandbox_on && say "  Sandbox  : Web UI → Sandbox tab (Claude Code / Codex / Gemini CLI)"
  say ""
  say "Next / 下一步:"
  if [ "$(vpn_mode)" = builtin ]; then say "  1. VPN tab → paste your WireGuard/OpenVPN config → Save & connect (if not done yet)"; fi
  say "  2. Accounts → + Add account → Sign in"
  say "  3. Copy the account's Base URL + API key into your app"
  line
}

configure_vpn_now() { # load a WireGuard/OpenVPN file into the built-in VPN through the API
  choose "Load a VPN config now? / 而家載入 VPN 設定？" \
    "WireGuard .conf file / WireGuard 檔案" \
    "OpenVPN .ovpn file + username/password / OpenVPN 檔案 + 帳號密碼" \
    "Later, in the web UI / 稍後喺網頁設定"
  local mode
  case "$CHOICE" in 1) mode=wireguard ;; 2) mode=openvpn ;; *) return 0 ;; esac
  ask "Path to the file / 檔案路徑" ""
  local file="${REPLY/#\~/$HOME}"
  [ -f "$file" ] || { err "File not found: $file"; return 1; }
  local user="" pass="" ks=false
  if [ "$mode" = openvpn ]; then
    ask "VPN service username / 服務帳號" ""; user="$REPLY"
    ask_secret "VPN service password / 服務密碼" "" "none"; pass="$REPLY"
  fi
  yesno "Enable the kill switch (block traffic if the VPN drops)? / 開啟 kill switch？" y && ks=true
  info "Connecting the VPN / 連接 VPN…"
  # shellcheck disable=SC2016
  $DOCKER exec -i -e MODE="$mode" -e VUSER="$user" -e VPASS="$pass" -e KS="$ks" ai2vpn node -e '
    const conf = require("fs").readFileSync(0, "utf8");
    const base = "http://127.0.0.1:" + (process.env.PORT || 8080);
    const J = { "content-type": "application/json" };
    (async () => {
      const r = await fetch(base + "/api/login", { method: "POST", headers: J, body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }) });
      if (!r.ok) throw new Error("login failed (" + r.status + ")");
      const cookie = r.headers.get("set-cookie").split(";")[0];
      const H = { ...J, cookie };
      const body = { mode: process.env.MODE, killSwitch: process.env.KS === "true", autoConnect: true };
      if (process.env.MODE === "wireguard") body.wireguardConfig = conf;
      else Object.assign(body, { openvpnConfig: conf, openvpnUser: process.env.VUSER, openvpnPass: process.env.VPASS });
      await fetch(base + "/api/vpn", { method: "PUT", headers: H, body: JSON.stringify(body) });
      const c = await (await fetch(base + "/api/vpn/connect", { method: "POST", headers: H, body: "{}" })).json();
      const s = c.status || {};
      console.log(s.status === "connected" ? "connected " + ((s.ip && s.ip.ip) || "") + " " + ((s.ip && s.ip.country) || "") : "not connected: " + (c.error || s.error || s.status));
    })().catch((e) => { console.log("error: " + e.message); process.exit(1); });
  ' <"$file"
}

ask_gluetun() {
  say ""
  say "${B}gluetun${N} handles the VPN by provider name. See https://github.com/qdm12/gluetun-wiki for your provider's settings."
  ask "VPN provider (surfshark, nordvpn, mullvad, protonvpn, private internet access, expressvpn, …)" "$(env_get VPN_SERVICE_PROVIDER || true)"
  env_set VPN_SERVICE_PROVIDER "${REPLY:-surfshark}"
  choose "VPN type" "WireGuard" "OpenVPN"
  if [ "$CHOICE" = 2 ]; then
    env_set VPN_TYPE openvpn
    ask "OpenVPN service username / 服務帳號" "$(env_get OPENVPN_USER)"; env_set OPENVPN_USER "$REPLY"
    ask_secret "OpenVPN service password / 服務密碼" "$(env_get OPENVPN_PASSWORD)"; env_set OPENVPN_PASSWORD "$REPLY"
  else
    env_set VPN_TYPE wireguard
    ask_secret "WireGuard private key (PrivateKey in your .conf)" "$(env_get WIREGUARD_PRIVATE_KEY)"; env_set WIREGUARD_PRIVATE_KEY "$REPLY"
    ask "WireGuard address (Address in your .conf, e.g. 10.14.0.2/16)" "$(env_get WIREGUARD_ADDRESSES)"; env_set WIREGUARD_ADDRESSES "$REPLY"
  fi
  ask "Server countries, comma separated (optional) / 伺服器國家（可留空）" "$(env_get SERVER_COUNTRIES)"; env_set SERVER_COUNTRIES "$REPLY"
}

do_install() {
  say ""; say "${B}ai2vpn setup / 安裝${N}"; line
  ensure_docker || return 1
  command -v git >/dev/null 2>&1 || { err "git is required / 需要 git（例如 apt install git）"; return 1; }
  [ "$OS" = Linux ] && [ ! -e /dev/net/tun ] && warn "/dev/net/tun not found — the built-in OpenVPN needs it (try: sudo modprobe tun)"

  # 1. Folder + code
  if [ -f "$DIR/docker-compose.yml" ]; then
    ok "Using $DIR"
  else
    ask "Install folder / 安裝資料夾" "$DIR"; DIR="${REPLY/#\~/$HOME}"
    if [ -d "$DIR/.git" ]; then ok "Existing checkout in $DIR"
    else
      info "Downloading ai2vpn / 下載 ai2vpn…"
      git clone ${A2V_BRANCH:+--branch "$A2V_BRANCH"} "$A2V_REPO" "$DIR" || { err "git clone failed"; return 1; }
    fi
  fi
  [ -f "$DIR/.env" ] && cp "$DIR/.env" "$DIR/.env.bak.$(date +%Y%m%d%H%M%S)" && info "Backed up existing .env"

  # 2. Password
  local cur_pw; cur_pw="$(env_get ADMIN_PASSWORD)"
  local def_pw="${cur_pw:-$(rand_pw)}"
  while :; do
    ask_secret "Web UI admin password / 管理員密碼" "$def_pw" "$( [ -n "$cur_pw" ] && echo keep || echo "generate $def_pw" )"
    case "$REPLY" in *"'"*) warn "Please don't use the ' character" ;; ?????*) break ;; *) warn "At least 6 characters / 至少 6 個字元" ;; esac
  done
  env_set ADMIN_PASSWORD "$REPLY"

  # 3. Port
  local cur_port; cur_port="$(env_get AI2VPN_PORT)"
  local sug; sug="${cur_port:-$(free_port 8080)}"
  [ -z "$cur_port" ] && [ "$sug" != 8080 ] && warn "Port 8080 is in use — suggesting $sug / 8080 已被佔用，建議用 $sug"
  while :; do
    ask "Port for the web UI and API / 網頁及 API 端口" "$sug"
    case "$REPLY" in ''|*[!0-9]*) warn "Number please"; continue ;; esac
    if [ "$REPLY" != "$cur_port" ] && port_in_use "$REPLY"; then warn "Port $REPLY is in use / 已被佔用"; continue; fi
    break
  done
  env_set AI2VPN_PORT "$REPLY"

  # 4. Public URL + timezone
  ask "Public URL if behind a domain/reverse proxy (optional) / 公開網址（可留空）" "$(env_get PUBLIC_URL)"; env_set PUBLIC_URL "$REPLY"
  local tz="${TZ:-}"; [ -z "$tz" ] && [ -f /etc/timezone ] && tz="$(cat /etc/timezone)"
  [ -z "$tz" ] && command -v timedatectl >/dev/null 2>&1 && tz="$(timedatectl show -p Timezone --value 2>/dev/null)"
  ask "Time zone / 時區" "$(env_get TZ | grep . || echo "${tz:-UTC}")"; env_set TZ "$REPLY"

  # 5. VPN mode
  choose "How should ai2vpn connect to the VPN? / VPN 連線方式" \
    "Built-in: paste a WireGuard/OpenVPN config (Surfshark, NordVPN, Mullvad, …) — recommended / 內置（建議）" \
    "gluetun: pick the provider by name, settings stored in .env / 用 gluetun" \
    "No VPN for now (can be added later in the web UI) / 暫時唔用 VPN"
  case "$CHOICE" in
    2) env_set COMPOSE_FILE docker-compose.gluetun.yml; ask_gluetun ;;
    *) env_unset COMPOSE_FILE; local want_vpn=$CHOICE ;;
  esac

  # 6. Sandbox
  if yesno "Also run the sandbox with Claude Code / Codex / Gemini CLI? / 一齊安裝 Sandbox（Claude Code / Codex）？" y; then env_set A2V_SANDBOX 1; else env_set A2V_SANDBOX 0; fi
  mkdir -p "$DIR/data" "$DIR/workspace" "$DIR/sandbox-home"

  # 7. Start
  line
  compose_up || { err "Starting the containers failed — see the messages above."; return 1; }
  wait_healthy || return 1
  if [ "$(vpn_mode)" = builtin ] && [ "${want_vpn:-3}" = 1 ]; then configure_vpn_now || warn "You can set up the VPN in the web UI → VPN tab"; fi
  show_access
}

do_update() {
  installed || { err "Not installed yet — choose Install first / 未安裝"; return 1; }
  ensure_docker || return 1
  info "Updating code / 更新程式碼…"
  local stashed=0
  if [ -n "$(cd "$DIR" && git status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    (cd "$DIR" && git stash push -q -m "ai2vpn installer $(date +%F)") && stashed=1 && info "Saved your local changes (git stash)"
  fi
  (cd "$DIR" && git pull --ff-only) || { err "git pull failed"; [ $stashed = 1 ] && (cd "$DIR" && git stash pop -q); return 1; }
  if [ $stashed = 1 ]; then (cd "$DIR" && git stash pop -q) || warn "Your local changes conflict with the update — they are kept in 'git stash list'"; fi
  compose_up && wait_healthy && ok "Updated / 已更新"
  if yesno "Remove old, unused Docker images to free disk space? / 刪除舊映像釋放空間？" n; then $DOCKER image prune -f >/dev/null && ok "Cleaned up"; fi
}

do_backup() {
  installed || { err "Not installed"; return 1; }
  local out="$HOME/ai2vpn-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
  info "Backing up .env, data/ and sandbox-home/ (accounts, logins, VPN settings) → $out"
  (cd "$DIR" && tar -czf "$out" .env data sandbox-home 2>/dev/null) && chmod 600 "$out" && ok "Backup saved: $out" && warn "It contains your logins and passwords — keep it private / 包含登入資料，請妥善保管"
}

do_manage() {
  installed || { err "Not installed yet / 未安裝"; return 1; }
  ensure_docker >/dev/null || return 1
  while :; do
    choose "Manage / 管理  (${DIR})" \
      "Start / 啟動" "Stop / 停止" "Restart / 重啟" "Status / 狀態" \
      "Logs (Ctrl-C to exit) / 日誌" "Open a shell in the sandbox / 進入 Sandbox" \
      "Back up data / 備份" "Show web UI address & password / 顯示網址同密碼"
    case "$CHOICE" in
      1) compose_up && wait_healthy && show_access ;;
      2) dc stop && ok "Stopped / 已停止" ;;
      3) dc restart && wait_healthy ;;
      4) dc ps; say ""; $DOCKER exec ai2vpn node -e 'fetch("http://127.0.0.1:"+(process.env.PORT||8080)+"/healthz").then(r=>console.log("health:",r.status))' 2>/dev/null || warn "ai2vpn not reachable" ;;
      5) dc logs -f --tail 100 ai2vpn ;;
      6) $DOCKER exec -it -u coder ai2vpn-sandbox tmux new-session -A -s main -c /workspace 2>/dev/null || $DOCKER exec -it -u coder ai2vpn-sandbox bash || err "The sandbox isn't running" ;;
      7) do_backup ;;
      8) show_access ;;
      0) return 0 ;;
    esac
  done
}

apply_settings() { info "Applying / 套用設定…"; compose_up && wait_healthy && ok "Done / 完成"; }

do_settings() {
  installed || { err "Not installed yet / 未安裝"; return 1; }
  ensure_docker >/dev/null || return 1
  while :; do
    local sb; sandbox_on && sb="on / 開" || sb="off / 關"
    choose "Settings / 設定" \
      "Admin password / 管理員密碼" \
      "Port (now $(env_get AI2VPN_PORT | grep . || echo 8080)) / 端口" \
      "Public URL (now $(env_get PUBLIC_URL | grep . || echo auto)) / 公開網址" \
      "VPN mode (now $(vpn_mode)) / VPN 模式" \
      "Sandbox (now $sb)" \
      "Load a WireGuard/OpenVPN file into the built-in VPN / 載入 VPN 檔案"
    case "$CHOICE" in
      1) while :; do ask_secret "New admin password / 新密碼" "" "cancel"; [ -z "$REPLY" ] && break
           case "$REPLY" in *"'"*) warn "No ' please" ;; ?????*) env_set ADMIN_PASSWORD "$REPLY"; apply_settings; break ;; *) warn "At least 6 characters" ;; esac; done ;;
      2) ask "New port / 新端口" "$(free_port "$(env_get AI2VPN_PORT | grep . || echo 8080)")"
         case "$REPLY" in ''|*[!0-9]*) warn "Number please" ;; *) env_set AI2VPN_PORT "$REPLY"; apply_settings ;; esac ;;
      3) ask "Public URL (empty = auto) / 公開網址（留空 = 自動）" "$(env_get PUBLIC_URL)"; env_set PUBLIC_URL "$REPLY"; apply_settings ;;
      4) choose "VPN mode / VPN 模式" "Built-in (configure in the web UI) / 內置" "gluetun"
         case "$CHOICE" in
           1) [ "$(vpn_mode)" = gluetun ] && dc down; env_unset COMPOSE_FILE; apply_settings ;;
           2) ask_gluetun; [ "$(vpn_mode)" = builtin ] && dc down; env_set COMPOSE_FILE docker-compose.gluetun.yml; apply_settings ;;
         esac ;;
      5) if sandbox_on; then env_set A2V_SANDBOX 0; else env_set A2V_SANDBOX 1; fi; apply_settings ;;
      6) [ "$(vpn_mode)" = builtin ] && configure_vpn_now || warn "Only for the built-in VPN mode" ;;
      0) return 0 ;;
    esac
  done
}

do_uninstall() {
  installed || [ -f "$DIR/docker-compose.yml" ] || { err "Nothing installed in $DIR"; return 1; }
  ensure_docker >/dev/null || return 1
  warn "This stops and removes the ai2vpn containers and images. / 會停止並刪除容器同映像。"
  yesno "Continue? / 繼續？" n || return 0
  dc down --rmi all --volumes --remove-orphans || true
  ok "Containers removed / 已刪除容器"
  say "Your data (accounts, browser logins, VPN settings, sandbox files) is still in $DIR."
  printf 'Type %sDELETE%s to also delete that folder, or press Enter to keep it: ' "$B" "$N"
  IFS= read -r REPLY <"$TTY" || REPLY=""
  if [ "$REPLY" = DELETE ]; then
    $SUDO rm -rf "$DIR" && ok "Deleted $DIR"
  else ok "Kept $DIR"; fi
}

banner() {
  say ""
  say "${B}${C}  ▲ ai2vpn${N}  ${D}AI accounts → VPN → OpenAI-compatible API${N}"
  if installed; then
    local st; st="$($DOCKER inspect -f '{{.State.Status}}' ai2vpn 2>/dev/null || echo "not running")"
    say "  ${D}folder: $DIR · status: $st · port: $(env_get AI2VPN_PORT | grep . || echo 8080)${N}"
  else
    say "  ${D}not installed yet / 未安裝${N}"
  fi
}

main_menu() {
  while :; do
    banner
    BACK_LABEL="Exit / 離開" choose "Main menu / 主選單" \
      "Install / set up again / 安裝或重新設定" \
      "Update to the latest version / 更新" \
      "Manage: start, stop, logs, backup, sandbox shell / 管理" \
      "Settings: password, port, VPN, sandbox / 設定" \
      "Uninstall / 解除安裝"
    case "$CHOICE" in
      1) do_install; pause ;;
      2) do_update; pause ;;
      3) do_manage ;;
      4) do_settings ;;
      5) do_uninstall; pause ;;
      0) say "Bye / 再見"; exit 0 ;;
    esac
  done
}

# ---------------- entry ----------------
needs_tty=1
case "${1:-menu}" in start|stop|restart|status|logs|backup|-h|--help|help) needs_tty=0 ;; esac
if [ "$needs_tty" = 1 ] && ! { : <"$TTY"; } 2>/dev/null; then
  err "No terminal available for the questions. Download the script and run it in a terminal: bash install.sh"
  exit 1
fi
find_dir
detect_docker >/dev/null 2>&1 || true
case "${1:-menu}" in
  menu) main_menu ;;
  install) do_install ;;
  update) do_update ;;
  start) ensure_docker && compose_up && wait_healthy && show_access ;;
  stop) ensure_docker && dc stop ;;
  restart) ensure_docker && dc restart && wait_healthy ;;
  status) ensure_docker && dc ps ;;
  logs) ensure_docker && dc logs -f --tail 100 ai2vpn ;;
  backup) do_backup ;;
  uninstall) do_uninstall ;;
  -h|--help|help) sed -n '2,9p' "$0" ;;
  *) err "Unknown command: $1"; sed -n '2,9p' "$0"; exit 1 ;;
esac
