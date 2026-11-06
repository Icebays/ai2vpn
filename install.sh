#!/usr/bin/env bash
# ai2vpn installer and manager (Linux and macOS)
#
#   curl -fsSL https://raw.githubusercontent.com/icebays/ai2vpn/HEAD/install.sh | bash
#
# Run it in a terminal and it shows a numbered menu (install, manage, settings, backup, uninstall).
# After installing, open the menu again any time with:   ai2vpn
# An existing install is found automatically, also in a custom or renamed folder: saved location,
# Docker (containers, compose projects), common folders incl. NAS volumes, and — if none of those
# know it — a quick disk search. Menu 3 → 7 searches the whole disk. Or say where it is with --dir <path>.
#
# Without a menu (scripts, automation):
#   install.sh install   [--dir <path>] [--port <n>] [--branch <name>]   install or update
#   install.sh status | start | stop | restart | logs | shell
#   install.sh port <n>                change the web UI / API port
#   install.sh password <new>          change the admin password
#   install.sh vpn                     show the VPN status and exit IP
#   install.sh backup                  back up accounts, logins and settings
#   install.sh restore <file.tar.gz>   restore a backup
#   install.sh uninstall [--purge]     remove containers (--purge also deletes all data)
#   -y / --yes                         answer yes to every question
set -euo pipefail

REPO_URL="https://github.com/icebays/ai2vpn"
REPO_API="https://api.github.com/repos/icebays/ai2vpn"
# private fork: set GH_TOKEN (a GitHub token with read access) before running
BRANCH="${BRANCH:-}"            # empty = the repository's default branch
INSTALL_DIR="${INSTALL_DIR:-}"
PORT=""
ACTION=""
ARG=""
PURGE=0
YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --purge) PURGE=1; shift ;;
    -y|--yes) YES=1; shift ;;
    --uninstall) ACTION="uninstall"; shift ;;
    -h|--help|help) ACTION="help"; shift ;;
    install|update|status|start|stop|restart|logs|shell|vpn|backup|uninstall|menu) ACTION="$1"; shift ;;
    port|restore|password) ACTION="$1"; ARG="${2:-}"; shift; [ $# -gt 0 ] && shift ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 1 ;;
  esac
done

# ---------------------------------------------------------------- output helpers
if [ -t 1 ]; then
  B=$'\033[1m'; D=$'\033[2m'; R=$'\033[0m'; C=$'\033[36m'; G=$'\033[32m'; Y=$'\033[33m'; E=$'\033[31m'; P=$'\033[35m'
else B=""; D=""; R=""; C=""; G=""; Y=""; E=""; P=""; fi
info() { printf '%s==>%s %s\n' "$C" "$R" "$*"; }
ok()   { printf '%s✓%s  %s\n' "$G" "$R" "$*"; }
warn() { printf '%s!!%s  %s\n' "$Y" "$R" "$*" >&2; }
die()  { printf '%sxx%s  %s\n' "$E" "$R" "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
tty_info() { if [ "${TTY:-0}" -eq 1 ]; then info "$*" >/dev/tty; else info "$*" >&2; fi; }

# questions are read from the terminal, so they also work under `curl … | bash`
TTY=0; if { : </dev/tty; } 2>/dev/null; then TTY=1; fi
ask() {  # ask "Question" default  -> prints answer
  local q="$1" def="${2:-}" a=""
  if [ "$TTY" -eq 0 ] || [ "$YES" -eq 1 ]; then printf '%s' "$def"; return; fi
  if [ -n "$def" ]; then printf '%s %s[%s]%s: ' "$q" "$D" "$def" "$R" >/dev/tty; else printf '%s: ' "$q" >/dev/tty; fi
  IFS= read -r a </dev/tty || true
  printf '%s' "${a:-$def}"
}
ask_secret() {  # like ask, but the typing is hidden
  local q="$1" def="${2:-}" a=""
  if [ "$TTY" -eq 0 ] || [ "$YES" -eq 1 ]; then printf '%s' "$def"; return; fi
  printf '%s: ' "$q" >/dev/tty
  IFS= read -rs a </dev/tty || true
  echo >/dev/tty
  printf '%s' "${a:-$def}"
}
confirm() {  # confirm "Question" [y|n default]
  local def="${2:-n}" a
  [ "$YES" -eq 1 ] && return 0
  [ "$TTY" -eq 0 ] && [ "$def" = "y" ] && return 0
  [ "$TTY" -eq 0 ] && return 1
  a="$(ask "$1 (y/n)" "$def")"
  case "$a" in y|Y|yes|YES|Yes) return 0 ;; *) return 1 ;; esac
}
pause() { [ "$TTY" -eq 1 ] && [ "$YES" -eq 0 ] && { printf '\n%sPress Enter to go back…%s' "$D" "$R" >/dev/tty; read -r _ </dev/tty || true; }; return 0; }

OS="$(uname -s)"
SUDO=""
if [ "$(id -u)" -ne 0 ] && have sudo; then SUDO="sudo"; fi

# ---------------------------------------------------------------- install dir
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
DEFAULT_DIR="/opt/ai2vpn"
if [ "$OS" = "Darwin" ] || { [ "$(id -u)" -ne 0 ] && [ -z "$SUDO" ]; }; then
  DEFAULT_DIR="$HOME/ai2vpn"   # Docker Desktop shares your home folder by default
fi
# where the installer remembers the install folder (so a custom folder is found next time)
if [ "$(id -u)" -eq 0 ] || [ -n "$SUDO" ]; then CONF_FILE="/etc/ai2vpn.conf"; else CONF_FILE="$HOME/.config/ai2vpn.conf"; fi
has_files() { [ -f "$INSTALL_DIR/docker-compose.yml" ]; }
# installed = this installer set it up (.env) or ai2vpn has run here (data/ — not part of the download,
# created on the first start). Only the folder itself is checked: ai2vpn runs as root and keeps data/
# private, so a normal user may not be allowed to look inside it.
is_installed_dir() {
  [ -f "$1/.env" ] || [ -d "$1/data" ] && return 0
  # or Docker says the ai2vpn containers belong to this folder
  local d; d="$(cd "$1" 2>/dev/null && pwd -P)" || return 1
  grep -qxF "$d" <<<"$(docker_dirs)"
}
DOCKER_DIRS_DONE=0; DOCKER_DIRS=""
docker_dirs() {  # folders the existing ai2vpn containers belong to (asked once per run)
  if [ "$DOCKER_DIRS_DONE" -eq 0 ]; then
    DOCKER_DIRS_DONE=1
    if quick_docker; then
      DOCKER_DIRS="$( {
        for c in $( { $DOCKER ps -aq --filter name=ai2vpn; $DOCKER ps -aq --filter ancestor=ai2vpn:latest; $DOCKER ps -aq --filter label=com.docker.compose.project=ai2vpn; } 2>/dev/null | sort -u); do
          # the compose folder it was started from …
          $DOCKER inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$c" 2>/dev/null
          # … and the folder that holds its data (the parent of what is mounted at /data)
          $DOCKER inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$c" 2>/dev/null | while IFS= read -r m; do [ -n "$m" ] && dirname "$m"; done
        done
      } | grep . | while IFS= read -r d; do (cd "$d" 2>/dev/null && pwd -P) || echo "$d"; done | sort -u || true )"
    fi
  fi
  printf '%s' "$DOCKER_DIRS"
}
installed() { has_files && is_installed_dir "$INSTALL_DIR"; }

# ---------------------------------------------------------------- docker
install_docker() {
  case "$OS" in
    Linux)
      confirm "Docker is not installed. Install it now (from get.docker.com)?" y || die "Docker is needed. Install it and run this again."
      info "Installing Docker…"
      have curl || { $SUDO apt-get update -y && $SUDO apt-get install -y curl; } || die "Please install curl first."
      curl -fsSL https://get.docker.com | $SUDO sh
      $SUDO systemctl enable --now docker 2>/dev/null || true
      ;;
    Darwin) die "Docker is not installed. Install Docker Desktop from https://www.docker.com/products/docker-desktop/ , start it, then run this again." ;;
    *) die "Unsupported system: $OS. Install Docker with Compose, then run: docker compose up -d --build" ;;
  esac
}

DOCKER=""; COMPOSE=""
need_docker() {
  [ -n "$COMPOSE" ] && return 0
  have docker || install_docker
  DOCKER="docker"
  if ! docker info >/dev/null 2>&1; then
    if [ -n "$SUDO" ] && $SUDO docker info >/dev/null 2>&1; then DOCKER="$SUDO docker"
    elif [ "$OS" = "Darwin" ]; then die "Docker is installed but not running. Start Docker Desktop and try again."
    else
      $SUDO systemctl start docker 2>/dev/null || true; sleep 2
      if docker info >/dev/null 2>&1; then DOCKER="docker"
      elif [ -n "$SUDO" ] && $SUDO docker info >/dev/null 2>&1; then DOCKER="$SUDO docker"
      else die "Docker is installed but not reachable. Start the Docker service and try again."; fi
    fi
  fi
  if $DOCKER compose version >/dev/null 2>&1; then COMPOSE="$DOCKER compose"
  elif have docker-compose; then COMPOSE="${SUDO:+$SUDO }docker-compose"
  else
    if [ "$OS" = "Linux" ]; then
      info "Installing the Docker Compose plugin…"
      ($SUDO apt-get install -y docker-compose-plugin || $SUDO dnf install -y docker-compose-plugin || $SUDO yum install -y docker-compose-plugin) >/dev/null 2>&1 || true
    fi
    $DOCKER compose version >/dev/null 2>&1 || die "Docker Compose is missing. Install the docker-compose-plugin package and try again."
    COMPOSE="$DOCKER compose"
  fi
}
need_install() { installed || die "ai2vpn is not installed in $INSTALL_DIR yet. Choose Install first (or use --dir)."; cd "$INSTALL_DIR"; need_docker; }

# find docker without installing, starting or asking for a password (for the menu header)
quick_docker() {
  [ -n "$COMPOSE" ] && return 0
  local d=""
  if have docker && docker info >/dev/null 2>&1; then d="docker"
  elif have docker && [ -n "$SUDO" ] && sudo -n docker info >/dev/null 2>&1; then d="sudo docker"
  else return 1; fi
  if $d compose version >/dev/null 2>&1; then DOCKER="$d"; COMPOSE="$d compose"
  elif have docker-compose; then DOCKER="$d"; if [ "$d" = "docker" ]; then COMPOSE="docker-compose"; else COMPOSE="sudo docker-compose"; fi
  else return 1; fi
}

# ---------------------------------------------------------------- .env
env_get() {  # env_get KEY -> value ('' if missing); quotes are removed
  [ -f "$INSTALL_DIR/.env" ] || return 0
  $SUDO sed -n "s/^$1=//p" "$INSTALL_DIR/.env" 2>/dev/null | tail -1 | sed -e "s/^'\(.*\)'\$/\1/" -e 's/^"\(.*\)"$/\1/'
}
env_set() {  # env_set KEY VALUE   (single-quoted, so special characters stay as typed)
  local f="$INSTALL_DIR/.env" tmp; tmp="$(mktemp)"
  if [ -f "$f" ]; then $SUDO cat "$f" | grep -v "^$1=" >"$tmp" || true; fi
  printf "%s='%s'\n" "$1" "$2" >>"$tmp"
  $SUDO cp "$tmp" "$f"; $SUDO chmod 600 "$f" 2>/dev/null || true; rm -f "$tmp"
}
env_unset() {
  local f="$INSTALL_DIR/.env" tmp; [ -f "$f" ] || return 0; tmp="$(mktemp)"
  $SUDO cat "$f" | grep -v "^$1=" >"$tmp" || true
  $SUDO cp "$tmp" "$f"; rm -f "$tmp"
}

# ---------------------------------------------------------------- small helpers
port_busy() {
  local out=""
  if have ss; then out="$(ss -ltn 2>/dev/null || true)"
  elif have lsof; then out="$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null || true)"
  elif have netstat; then out="$(netstat -an 2>/dev/null | grep LISTEN || true)"
  fi
  grep -Eq "[:.]$1([[:space:]]|\$)" <<<"$out"
}
free_port() { local p="${1:-8080}"; while port_busy "$p"; do p=$((p + 1)); done; echo "$p"; }
valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }
compose_file() { local f; f="$(env_get COMPOSE_FILE)"; echo "$INSTALL_DIR/${f:-docker-compose.yml}"; }
fixed_port() {  # a port typed straight into docker-compose.yml (instead of ${AI2VPN_PORT})
  sed -n 's/^[[:space:]]*-[[:space:]]*"\{0,1\}\([0-9][0-9]*\):8080"\{0,1\}[[:space:]]*\(#.*\)\{0,1\}$/\1/p' "$(compose_file)" 2>/dev/null | head -1 || true
}
published_port() {  # the host port the running ai2vpn container is published on
  [ -n "$DOCKER" ] || quick_docker 2>/dev/null || return 0
  $DOCKER port ai2vpn 8080/tcp 2>/dev/null | head -1 | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p' || true
}
current_port() {
  local p; p="$(fixed_port)"; [ -z "$p" ] && p="$(env_get AI2VPN_PORT)"
  [ -z "$p" ] && [ ! -f "$INSTALL_DIR/.env" ] && p="$(published_port)"
  echo "${p:-8080}"
}
server_ip() {
  local ip=""
  [ "$OS" = "Linux" ] && ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -z "$ip" ] && have ipconfig && ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
  echo "${ip:-localhost}"
}
address() { local u; u="$(env_get PUBLIC_URL)"; echo "${u:-http://$(server_ip):$(current_port)}"; }
rand_pw() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c 16 || true; }
vpn_mode() { [ "$(env_get COMPOSE_FILE)" = "docker-compose.gluetun.yml" ] && echo gluetun || echo built-in; }
sandbox_on() { [ "$(env_get A2V_SANDBOX)" != "0" ]; }
running_count() { local n; n="$(cd "$INSTALL_DIR" && $COMPOSE ps --services --filter status=running 2>/dev/null | grep -c . || true)"; echo "${n:-0}"; }
expected_count() { local n=1; sandbox_on && n=$((n + 1)); [ "$(vpn_mode)" = gluetun ] && n=$((n + 1)); echo "$n"; }

# call ai2vpn's own admin API from inside the container (signs in with ADMIN_PASSWORD from .env)
a2v_api() {  # a2v_api METHOD PATH [JSON-BODY]   -> prints the JSON answer
  # shellcheck disable=SC2016
  $DOCKER exec -i ai2vpn node -e '
    const [m, p, body] = process.argv.slice(1);
    const base = "http://127.0.0.1:" + (process.env.PORT || 8080), J = { "content-type": "application/json" };
    (async () => {
      const r = await fetch(base + "/api/login", { method: "POST", headers: J, body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }) });
      if (!r.ok) throw new Error("could not sign in to ai2vpn (HTTP " + r.status + ")");
      const H = { ...J, cookie: r.headers.get("set-cookie").split(";")[0] };
      const x = await fetch(base + p, { method: m, headers: H, body: m === "GET" ? undefined : (body || "{}") });
      process.stdout.write(await x.text());
    })().catch((e) => { console.log(JSON.stringify({ error: e.message })); process.exit(1); });
  ' "$1" "$2" "${3:-}"
}
json_field() {  # json_field <json> <js expression on d>
  $DOCKER exec -i ai2vpn node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const d=JSON.parse(s);const v=('"$2"');console.log(v==null?"":v)}catch(e){console.log("")}})' <<<"$1"
}

# ---------------------------------------------------------------- finding an existing install
is_a2v_dir() { [ -f "$1/docker-compose.yml" ] && [ -f "$1/src/server.js" ] && { grep -qs '^name: ai2vpn' "$1/docker-compose.yml" || grep -qs 'container_name: ai2vpn' "$1/docker-compose.yml"; }; }
find_installs() {  # prints every ai2vpn folder found, best guess first
  local c=() d f
  for f in /etc/ai2vpn.conf "$HOME/.config/ai2vpn.conf"; do
    [ -r "$f" ] && d="$(sed -n 's/^INSTALL_DIR=//p' "$f" | tail -1)" && [ -n "$d" ] && c+=("$d")
  done
  # ask Docker: works for any custom or renamed folder, even manual installs and stopped stacks
  if quick_docker; then
    while IFS= read -r d; do [ -n "$d" ] && c+=("$d"); done < <( {
        # folders the ai2vpn containers were started from, and where their data is
        docker_dirs; echo
        # every compose project Docker knows about (also stopped ones) → the folder of its compose file
        $COMPOSE ls --all --format json 2>/dev/null | grep -o '"ConfigFiles":"[^"]*"' | sed 's/^"ConfigFiles":"//; s/"$//' \
          | tr ',' '\n' | while IFS= read -r f; do [ -n "$f" ] && dirname "$f"; done
      } 2>/dev/null | sort -u)
  fi
  for d in /opt/ai2vpn "$HOME/ai2vpn" /root/ai2vpn /srv/ai2vpn /data/ai2vpn /usr/local/ai2vpn \
           /home/*/ai2vpn /opt/*/ai2vpn /srv/*/ai2vpn /data/*/ai2vpn /mnt/*/ai2vpn /mnt/*/*/ai2vpn /media/*/ai2vpn \
           /volume*/docker/ai2vpn /volume*/*/ai2vpn /vol*/*/ai2vpn /vol*/*/[Dd]ocker/ai2vpn /share/*/ai2vpn /share/[Dd]ocker/ai2vpn \
           /home/*/docker/ai2vpn /root/docker/ai2vpn /opt/docker/ai2vpn "$PWD" "$PWD/ai2vpn"; do
    [ -d "$d" ] && c+=("$d")
  done
  local seen="" out="" rest=""
  for d in ${c[@]+"${c[@]}"}; do
    d="$(cd "$d" 2>/dev/null && pwd -P)" || continue
    case " $seen " in *" $d "*) continue ;; esac
    seen="$seen $d"
    is_a2v_dir "$d" || continue
    # real installs (they have a .env) first; plain downloads of the code after them
    if is_installed_dir "$d"; then out="$out$d"$'\n'; else rest="$rest$d"$'\n'; fi
  done
  if [ "${1:-}" = "--all" ]; then printf '%s%s' "$out" "$rest"; else printf '%s' "$out"; fi
}
quick_search() {  # fast, automatic: locate database, else the usual data folders (time-limited)
  local roots=() r t="" f hits=""
  if have plocate || have locate; then
    local loc; loc="$(command -v plocate || command -v locate)"
    hits="$($loc -b '\docker-compose.yml' 2>/dev/null | while IFS= read -r f; do d="$(dirname "$f")"; if is_a2v_dir "$d"; then echo "$d"; fi; done || true)"
    # the locate database can be older than the install: only trust it if it found something
    [ -n "$hits" ] && { printf '%s\n' "$hits"; return 0; }
  fi
  for r in /home /root /opt /srv /data /DATA /mnt /media /share /usr/local /var/services /Users /volume* /vol* /docker /apps /app /storage; do
    [ -d "$r" ] && roots+=("$r")
  done
  [ ${#roots[@]} -eq 0 ] && return 0
  have timeout && t="timeout 45"
  tty_info "Looking for an existing ai2vpn install (up to 45 s)…"
  $SUDO $t find "${roots[@]}" -maxdepth 7 \( -path '*/node_modules' -o -path '*/.git' -o -path '*/profiles' -o -path '*/proc' -o -path '*/@*' -o -path '*/#recycle' -o -path '*/.Trash*' \) -prune \
    -o -name docker-compose.yml -print 2>/dev/null | while IFS= read -r f; do d="$(dirname "$f")"; if is_a2v_dir "$d"; then echo "$d"; fi; done || true
}
search_disk() {  # slow: look everywhere for an ai2vpn docker-compose.yml
  local t=""; have timeout && t="timeout 180"
  tty_info "Searching the disk (up to 3 minutes)…"
  $SUDO $t find / -maxdepth 9 \( -path /proc -o -path /sys -o -path /dev -o -path /run -o -path /var/lib/docker -o -path /snap -o -path '*/node_modules' -o -path '*/.git' -o -path '*/profiles' \) -prune \
    -o -name docker-compose.yml -print 2>/dev/null | while IFS= read -r f; do d="$(dirname "$f")"; if is_a2v_dir "$d"; then echo "$d"; fi; done \
    | awk '{ if (system("[ -f \"" $0 "/.env\" ]") == 0) print; else rest = rest $0 "\n" } END { printf "%s", rest }' || true
}
remember_dir() {
  { [ -n "$SUDO" ] || [ "$(id -u)" -eq 0 ]; } || mkdir -p "$(dirname "$CONF_FILE")"
  printf '# written by the ai2vpn installer\nINSTALL_DIR=%s\n' "$INSTALL_DIR" | $SUDO tee "$CONF_FILE" >/dev/null 2>&1 || true
}
pick_dir() {  # pick_dir "<newline list>"  → sets INSTALL_DIR; returns 1 if cancelled
  local list="$1" n=0 d a
  echo >/dev/tty; printf '  %sai2vpn found in:%s\n' "$B" "$R" >/dev/tty
  while IFS= read -r d; do [ -z "$d" ] && continue; n=$((n + 1)); printf '  %s%d)%s %s%s\n' "$C$B" "$n" "$R" "$d" "$(is_installed_dir "$d" || printf ' %s(downloaded, not installed)%s' "$D" "$R")" >/dev/tty; done <<<"$list"
  [ "$n" -eq 0 ] && printf '  %s(none in the usual places)%s\n' "$D" "$R" >/dev/tty
  printf '  %sS)%s Search the whole disk\n  %sT)%s Type a folder\n  %s0)%s Cancel\n' "$C$B" "$R" "$C$B" "$R" "$C$B" "$R" >/dev/tty
  a="$(ask "  Choose" "$( [ "$n" -gt 0 ] && echo 1 || echo S)")"
  case "$a" in
    [sS]) local more; more="$(search_disk)"
          [ -z "$more" ] && { warn "No ai2vpn folder found on this disk."; return 1; }
          pick_dir "$more"; return $? ;;
    [tT]) a="$(ask "  Folder" "")"; [ -z "$a" ] && return 1
          is_a2v_dir "$a" || { warn "No ai2vpn in $a (no docker-compose.yml)."; confirm "Use it anyway (e.g. to install there)?" n || return 1; }
          INSTALL_DIR="$(cd "$a" 2>/dev/null && pwd -P || echo "$a")"; return 0 ;;
    *) [[ "$a" =~ ^[0-9]+$ ]] && [ "$a" -ge 1 ] && [ "$a" -le "$n" ] || return 1
       INSTALL_DIR="$(grep . <<<"$list" | sed -n "${a}p")"; return 0 ;;
  esac
}
resolve_dir() {
  [ -n "$INSTALL_DIR" ] && return 0                                   # --dir or INSTALL_DIR=…
  if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/docker-compose.yml" ] && [ -f "$SCRIPT_DIR/src/server.js" ]; then INSTALL_DIR="$SCRIPT_DIR"; return 0; fi
  local found n; found="$(find_installs)"; n="$(grep -c . <<<"$found" || true)"
  if [ "${n:-0}" -eq 0 ] && [ "${A2V_NO_SEARCH:-0}" != 1 ]; then
    # nothing in the usual places: search the disk for a custom folder (only real installs count)
    found="$(quick_search | while IFS= read -r d; do if is_installed_dir "$d"; then (cd "$d" && pwd -P); fi; done | awk '!seen[$0]++' || true)"
    n="$(grep -c . <<<"$found" || true)"
  fi
  if [ "${n:-0}" -eq 0 ]; then
    INSTALL_DIR="$DEFAULT_DIR"
    local dd; dd="$(docker_dirs)"
    [ -n "$dd" ] && warn "ai2vpn containers exist (data in: $(tr '\n' ' ' <<<"$dd")) but that folder has no ai2vpn files (docker-compose.yml). Use menu 6 → T to choose the folder with the files, or install there."
    return 0
  fi
  if [ "$n" -ge 1 ] && [ -z "$(find_installs)" ]; then tty_info "Found ai2vpn in $(head -1 <<<"$found")"; fi
  if [ "$n" -eq 1 ] || [ "$TTY" -eq 0 ] || [ "$YES" -eq 1 ]; then
    INSTALL_DIR="$(head -1 <<<"$found")"; [ "$n" -gt 1 ] && warn "Several installs found; using $INSTALL_DIR (choose another with --dir)."
    return 0
  fi
  pick_dir "$found" || INSTALL_DIR="$(head -1 <<<"$found")"
}
remember_found() { installed && [ ! -r "$CONF_FILE" ] && remember_dir; return 0; }
page_folder() {
  header; title "3 · Settings › Install folder"
  printf '  Now using: %s%s%s\n' "$B" "$INSTALL_DIR" "$R"
  local found; found="$(find_installs --all)"
  if pick_dir "$found"; then
    COMPOSE=""; quick_docker || true
    remember_dir
    [ -f "$INSTALL_DIR/install.sh" ] && install_shortcut >/dev/null
    ok "Now using $INSTALL_DIR"
  else info "Unchanged."; fi
  pause
}

# ---------------------------------------------------------------- actions
# git with the GitHub token (if any) passed as a header, so it is never saved in .git/config.
# core.fileMode=false: some NAS / shared volumes can't keep the "executable" flag, which made every
# script look changed; the Docker images set those flags themselves, so they are ignored here.
g() {
  if [ -n "${GH_TOKEN:-}" ]; then
    $SUDO git -c core.fileMode=false -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')" "$@"
  else $SUDO git -c core.fileMode=false "$@"; fi
}
gl() { $SUDO git -c core.fileMode=false -C "$INSTALL_DIR" "$@"; }   # local git commands

keep_port_in_env() {  # a port typed into docker-compose.yml must survive the update
  local fp sp i
  fp="$(fixed_port)"
  if [ -z "$fp" ]; then
    # an earlier update may have set the edited docker-compose.yml aside in a stash: look there
    for i in $(gl stash list 2>/dev/null | grep -n 'ai2vpn installer' | cut -d: -f1); do
      sp="$(gl diff "stash@{$((i - 1))}^1" "stash@{$((i - 1))}" -- docker-compose.yml 2>/dev/null \
        | sed -n 's/^+[[:space:]]*-[[:space:]]*"\{0,1\}\([0-9][0-9]*\):8080.*/\1/p' | head -1)"
      [ -n "$sp" ] && { fp="$sp"; break; }
    done
  fi
  if [ -n "$fp" ] && [ "$(env_get AI2VPN_PORT)" != "$fp" ]; then
    env_set AI2VPN_PORT "$fp"
    info "Keeping your port $fp (saved in .env, so it no longer depends on docker-compose.yml)."
  fi
  return 0
}

git_update() {  # pull the latest code, keeping local edits where possible
  local dir="$1" stashed=0 dirty ts bak f
  gl config core.fileMode false 2>/dev/null || true   # also for later manual `git pull`
  keep_port_in_env
  dirty="$(gl status --porcelain --untracked-files=no 2>/dev/null || true)"
  if [ -n "$dirty" ]; then
    if gl stash push -q -m "ai2vpn installer $(date +%F)"; then stashed=1; info "Your own changes to the files were set aside and will be put back."; fi
    dirty="$(gl status --porcelain --untracked-files=no 2>/dev/null || true)"
    if [ -n "$dirty" ]; then
      # still "changed" after setting them aside: the disk can't undo them. Back up, then reset.
      ts="$(date +%Y%m%d-%H%M%S)"; bak="$dir/backups/local-changes-$ts"
      $SUDO mkdir -p "$bak"
      while IFS= read -r f; do f="${f:3}"; [ -f "$dir/$f" ] && $SUDO mkdir -p "$bak/$(dirname "$f")" && $SUDO cp -p "$dir/$f" "$bak/$f"; done <<<"$dirty"
      warn "Some files still look changed (copied to $bak); resetting them to the official version."
      gl reset -q --hard HEAD
    fi
  fi
  if ! g -C "$dir" pull -q --ff-only ${BRANCH:+origin "$BRANCH"}; then
    if [ "$stashed" -eq 1 ]; then gl stash pop -q 2>/dev/null || true; fi
    die "Could not download the update (no internet / GitHub not reachable?). If the repository is private, set GH_TOKEN first."
  fi
  if [ "$stashed" -eq 1 ] && ! gl stash pop -q 2>/dev/null; then
    gl reset -q --hard HEAD 2>/dev/null || true
    warn "Your own file changes clash with the update, so the update was kept. Your changes are saved (git stash list); your port and settings are in .env."
  fi
  ok "Code updated to $(gl log -1 --format='%h %s' 2>/dev/null | cut -c1-70)"
}
fetch_code() {
  if [ -n "$SCRIPT_DIR" ] && [ "$INSTALL_DIR" = "$SCRIPT_DIR" ] && has_files; then
    if [ -d "$INSTALL_DIR/.git" ] && confirm "Download the latest version from GitHub into this folder?" y; then
      git_update "$INSTALL_DIR"
    else info "Using the files in $INSTALL_DIR"; fi
    return
  fi
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Downloading the latest version…"
    git_update "$INSTALL_DIR"
    return
  fi
  if has_files; then info "Using the files in $INSTALL_DIR (not a git folder, so not updated)"; return; fi
  $SUDO mkdir -p "$INSTALL_DIR"
  if have git; then
    info "Downloading ai2vpn to $INSTALL_DIR…"
    local tmp; tmp="$(mktemp -d)"
    SUDO="" g clone -q ${BRANCH:+--branch "$BRANCH"} "$REPO_URL.git" "$tmp/src" \
      || { rm -rf "$tmp"; die "Could not download ai2vpn. If the repository is private, set GH_TOKEN first."; }
    $SUDO cp -a "$tmp/src/." "$INSTALL_DIR/"
    rm -rf "$tmp"
  else
    info "Downloading ai2vpn to $INSTALL_DIR…"
    curl -fsSL ${GH_TOKEN:+-H "Authorization: Bearer $GH_TOKEN"} "$REPO_API/tarball/$BRANCH" | $SUDO tar -xz -C "$INSTALL_DIR" --strip-components=1 \
      || die "Could not download ai2vpn. If the repository is private, set GH_TOKEN first."
  fi
}

install_shortcut() {
  local bin=/usr/local/bin/ai2vpn
  [ -d /usr/local/bin ] || $SUDO mkdir -p /usr/local/bin 2>/dev/null || return 0
  printf '#!/bin/sh\n# opens the ai2vpn menu\nexec bash "%s/install.sh" --dir "%s" "$@"\n' "$INSTALL_DIR" "$INSTALL_DIR" | $SUDO tee "$bin" >/dev/null 2>&1 \
    && $SUDO chmod +x "$bin" 2>/dev/null && ok "Shortcut added: type ${B}ai2vpn${R} to open this menu again." || true
}

data_dir() {  # where this install keeps its accounts, logins and settings
  local d; d="$(env_get A2V_DATA_DIR)"
  case "$d" in "") echo "$INSTALL_DIR/data" ;; /*) echo "$d" ;; *) echo "$INSTALL_DIR/${d#./}" ;; esac
}
container_data_dir() {  # the folder an existing "ai2vpn" container has mounted at /data
  [ -n "$DOCKER" ] || quick_docker 2>/dev/null || return 0
  $DOCKER inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' ai2vpn 2>/dev/null || true
}
replace_foreign_containers() {  # old ai2vpn containers started another way would block the names
  local n wd want; want="$(cd "$INSTALL_DIR" && pwd -P)"
  for n in ai2vpn ai2vpn-sandbox; do
    $DOCKER inspect "$n" >/dev/null 2>&1 || continue
    wd="$($DOCKER inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$n" 2>/dev/null || true)"
    [ -n "$wd" ] && [ "$(cd "$wd" 2>/dev/null && pwd -P || echo "$wd")" = "$want" ] && continue
    if [ "$n" = ai2vpn ] && [ "$(container_data_dir)" != "$(data_dir)" ]; then
      die "An older ai2vpn container uses other data ($(container_data_dir)). Use menu 1 (Update) to switch to it, or stop that container first."
    fi
    info "Replacing the old $n container (started from ${wd:-outside this folder}); your data is kept."
    $DOCKER rm -f "$n" >/dev/null
  done
}

compose_up() {  # start what's enabled (the sandbox can be switched off)
  replace_foreign_containers
  local svc=() build=(--build)
  [ -n "${A2V_NO_BUILD:-}" ] && build=(--no-build)
  if ! sandbox_on; then svc=(ai2vpn); [ "$(vpn_mode)" = gluetun ] && svc=(gluetun ai2vpn); fi
  $COMPOSE up -d "${build[@]}" --remove-orphans ${svc[@]+"${svc[@]}"}
  if ! sandbox_on; then $COMPOSE rm -sf sandbox >/dev/null 2>&1 || true; fi
}

wait_for_app() {
  info "Waiting for ai2vpn to start…"
  local i s
  for i in $(seq 1 90); do
    s="$($DOCKER inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' ai2vpn 2>/dev/null || echo missing)"
    case "$s" in healthy) APP_OK=1; return 0 ;; exited|dead) break ;; esac
    sleep 2
  done
  APP_OK=0
  warn "ai2vpn did not report healthy yet. Last log lines:"
  $DOCKER logs --tail 20 ai2vpn 2>&1 | sed 's/^/     /' >&2 || true
}

summary() {
  local pw; pw="$(env_get ADMIN_PASSWORD)"
  echo
  printf '%s┌──────────────────────────────────────────────────────────%s\n' "$G" "$R"
  printf '%s│%s  %sai2vpn is ready%s\n' "$G" "$R" "$B" "$R"
  printf '%s│%s  Open:        %s%s%s\n' "$G" "$R" "$B" "$(address)" "$R"
  printf '%s│%s  Password:    %s%s%s\n' "$G" "$R" "$B$Y" "${pw:-unchanged (the one you already use; change it in menu 3 → 2)}" "$R"
  printf '%s│%s  API base:    %s/v1\n' "$G" "$R" "$(address)"
  if sandbox_on; then printf '%s│%s  Sandbox:     web UI → Sandbox (Claude Code, Codex, Gemini CLI)\n' "$G" "$R"; fi
  printf '%s│%s  VPN:         %s\n' "$G" "$R" "$( [ "$(vpn_mode)" = gluetun ] && echo "gluetun ($(env_get VPN_SERVICE_PROVIDER))" || echo "web UI → VPN tab, or menu 3 → 4")"
  printf '%s│%s  Folder:      %s\n' "$G" "$R" "$INSTALL_DIR"
  printf '%s└──────────────────────────────────────────────────────────%s\n' "$G" "$R"
}

adopt_existing() {  # an install made by hand (no .env): write down what is running now, change nothing
  local p; p="$(fixed_port)"; [ -z "$p" ] && p="$(env_get AI2VPN_PORT)"; [ -z "$p" ] && p="$(published_port)"; p="${p:-8080}"
  info "Existing ai2vpn found (set up without this installer). Keeping it as it is:"
  # settings the old container was started with (docker run -e … / compose environment)
  local k v cenv; cenv="$($DOCKER inspect -f '{{range .Config.Env}}{{println .}}{{end}}' ai2vpn 2>/dev/null || true)"
  for k in ADMIN_PASSWORD PUBLIC_URL TZ; do
    v="$(sed -n "s/^$k=//p" <<<"$cenv" | head -1)"
    if [ -n "$v" ] && [ -z "$(env_get "$k")" ]; then env_set "$k" "$v"; fi
  done
  [ -z "$(env_get AI2VPN_PORT)" ] && env_set AI2VPN_PORT "$p"
  [ -z "$(env_get A2V_SANDBOX)" ] && env_set A2V_SANDBOX 1
  [ -z "$(env_get TZ)" ] && env_set TZ "$( (cat /etc/timezone 2>/dev/null || timedatectl show -p Timezone --value 2>/dev/null || echo UTC) | head -1)"
  ok "Port $(env_get AI2VPN_PORT) and your accounts are kept; the admin password is unchanged (change it in menu 3 → 2)."
}

first_setup() {  # questions asked only on the very first install (later: Settings menu)
  local p="$PORT" pw v
  if [ -z "$p" ]; then
    p="$(free_port 8080)"
    [ "$p" != 8080 ] && info "Port 8080 is in use; suggesting $p."
    p="$(ask "Port for the web UI and API" "$p")"
  fi
  valid_port "$p" || die "Not a valid port: $p"
  port_busy "$p" && die "Port $p is already in use. Pick another one."
  pw="$(rand_pw)"
  v="$(ask_secret "Admin password for the web UI (Enter = generate one)" "$pw")"
  [ ${#v} -ge 6 ] || die "The password needs at least 6 characters."
  case "$v" in *"'"*) die "Please don't use the ' character in the password." ;; esac
  env_set AI2VPN_PORT "$p"; env_set ADMIN_PASSWORD "$v"
  env_set TZ "$( (cat /etc/timezone 2>/dev/null || timedatectl show -p Timezone --value 2>/dev/null || echo UTC) | head -1)"
  ok "Port $p and admin password saved in .env"
  if [ "$TTY" -eq 1 ] && [ "$YES" -eq 0 ]; then
    echo
    printf '  %sVPN%s — how should ai2vpn reach the internet?\n' "$B" "$R"
    item 1 "Built-in VPN: paste a WireGuard / OpenVPN config (Surfshark, NordVPN, Mullvad, …)  ${D}recommended${R}"
    item 2 "gluetun: choose the VPN provider by name"
    item 3 "No VPN for now (add it later)"
    case "$(ask "  Choose" 1)" in
      2) env_set COMPOSE_FILE docker-compose.gluetun.yml; ask_gluetun ;;
      3) ;;
      *) FIRST_VPN_FILE=1 ;;
    esac
    if confirm "Also run the sandbox with Claude Code, Codex and Gemini CLI?" y; then env_set A2V_SANDBOX 1; else env_set A2V_SANDBOX 0; fi
  else
    env_set A2V_SANDBOX 1
  fi
}

do_install() {
  if [ "${DIR_ASKED:-0}" -eq 0 ] && ! installed && [ "$TTY" -eq 1 ] && [ "$YES" -eq 0 ] && [ -z "$SCRIPT_DIR$PORT" ]; then
    INSTALL_DIR="$(ask "Install folder" "$INSTALL_DIR")"
  fi
  need_docker
  # resources
  if [ "$OS" = "Linux" ] && [ -r /proc/meminfo ]; then
    local mem_mb=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 ))
    [ "$mem_mb" -lt 1900 ] && warn "This machine has ${mem_mb} MB RAM; about 2 GB (4 GB with several accounts) is recommended."
  fi
  local parent="$INSTALL_DIR"; while [ ! -d "$parent" ]; do parent="$(dirname "$parent")"; done
  local free_gb=$(( $(df -Pk "$parent" | awk 'NR==2 {print $4}') / 1024 / 1024 ))
  [ "$free_gb" -lt 10 ] && warn "Only ${free_gb} GB free disk at $parent; about 10 GB is recommended (images + browser profiles)."
  if [ "$OS" = "Linux" ] && [ ! -e /dev/net/tun ]; then warn "/dev/net/tun is missing; the built-in OpenVPN needs it (try: sudo modprobe tun)."; fi

  fetch_code
  cd "$INSTALL_DIR"
  local fresh=0 old
  old="$(container_data_dir)"
  # the running ai2vpn container keeps its data somewhere else: offer to keep using that data
  if [ -n "$old" ] && [ "$old" != "$(data_dir)" ]; then
    if [ ! -f "$(data_dir)/config.json" ]; then
      if confirm "Found your existing ai2vpn data in $old (accounts, browser logins, VPN). Keep using it?" y; then env_set A2V_DATA_DIR "$old"; fi
    else
      echo
      printf '  %sTwo sets of ai2vpn data were found:%s\n' "$B" "$R"
      item 1 "$old   ${D}(used by the running ai2vpn — recommended)${R}"
      item 2 "$(data_dir)   ${D}(in this folder)${R}"
      if [ "$(ask "  Which one should ai2vpn use?" 1)" != 2 ]; then env_set A2V_DATA_DIR "$old"; fi
    fi
  fi
  if [ ! -f .env ] && [ ! -d data ] && [ -z "$(env_get A2V_DATA_DIR)" ]; then
    first_setup; fresh=1
  elif [ ! -f .env ] || [ -z "$(env_get AI2VPN_PORT)" ] || [ -z "$(env_get A2V_SANDBOX)" ]; then
    adopt_existing
  fi
  if [ -n "$PORT" ]; then
    valid_port "$PORT" || die "Not a valid port: $PORT"
    env_set AI2VPN_PORT "$PORT"; ok "Port changed to $PORT"
  elif [ "$fresh" -eq 0 ]; then
    info "Keeping your settings (port $(current_port), VPN: $(vpn_mode), sandbox: $(sandbox_on && echo on || echo off))"
  fi
  $SUDO mkdir -p "$(data_dir)" workspace sandbox-home
  info "Building and starting (the first time downloads ~2 GB and takes 5–15 minutes)…"
  compose_up
  wait_for_app
  remember_dir
  install_shortcut
  if [ "${FIRST_VPN_FILE:-0}" -eq 1 ] && [ "${APP_OK:-0}" -eq 1 ] && confirm "Load your WireGuard / OpenVPN file now?" y; then
    do_vpn_file || warn "You can do it later: web UI → VPN, or menu 3 → 4."
  fi
  summary
}

do_status() {
  need_install
  echo; printf '%sContainers%s\n' "$B" "$R"
  $COMPOSE ps 2>/dev/null || true
  echo
  printf 'Address:  %s\n' "$(address)"
  printf 'Folder:   %s\n' "$INSTALL_DIR"
  printf 'Data:     %s (%s)\n' "$(data_dir)" "$($SUDO du -sh "$(data_dir)" 2>/dev/null | awk '{print $1}' || echo '?')"
  printf 'Sandbox:  %s\n' "$(sandbox_on && echo on || echo off)"
  if [ -d "$INSTALL_DIR/.git" ]; then printf 'Version:  %s\n' "$($SUDO git -C "$INSTALL_DIR" log -1 --format='%h %cd' --date=short 2>/dev/null || echo '?')"; fi
  if [ -n "$(fixed_port)" ]; then warn "The port is written directly in docker-compose.yml. Menu 3 → 1 can move it to .env."; fi
  do_vpn_status || true
  return 0
}
do_vpn_status() {
  need_install
  if [ -z "$(env_get ADMIN_PASSWORD)" ]; then printf 'VPN:      %s(see the web UI → VPN; set a password in menu 3 → 2 to show it here)%s\n' "$D" "$R"; return 0; fi
  local j; j="$(a2v_api GET /api/vpn 2>/dev/null)" || { printf 'VPN:      %s(ai2vpn is not running)%s\n' "$D" "$R"; return 0; }
  printf 'VPN:      %s · %s\n' "$(json_field "$j" 'd.status.mode+" · "+d.status.status+(d.status.error?" ("+d.status.error+")":"")')" \
    "exit IP $(json_field "$j" '(d.status.ip&&d.status.ip.ip?d.status.ip.ip+" "+(d.status.ip.country||"")+" "+(d.status.ip.org||""):"unknown")')"
}
do_start()   { need_install; info "Starting…"; compose_up; ok "Started. Open $(address)"; }
do_stop()    { need_install; info "Stopping…"; $COMPOSE stop; ok "Stopped. Your data is kept."; }
do_restart() { need_install; info "Restarting…"; $COMPOSE restart; ok "Restarted."; }
do_logs() {
  need_install
  local svc="ai2vpn"
  if [ "$TTY" -eq 1 ] && [ "$YES" -eq 0 ]; then
    echo "  1) ai2vpn   2) Sandbox   3) gluetun   4) All"
    case "$(ask "Which logs" 1)" in 2) svc=sandbox ;; 3) svc=gluetun ;; 4) svc="" ;; *) svc=ai2vpn ;; esac
  fi
  info "Showing logs. Press Ctrl+C to stop."
  $COMPOSE logs -f --tail 100 $svc || true
}
do_shell() {
  need_install
  sandbox_on || die "The sandbox is switched off (menu 3 → 5)."
  info "Opening the sandbox terminal (tmux). Leave with Ctrl+B then D — it keeps running."
  $DOCKER exec -it -u coder ai2vpn-sandbox tmux new-session -A -s main -c /workspace || die "The sandbox isn't running. Start it from the menu (2 → 2)."
}
do_port() {
  need_install
  local p="${1:-}"
  [ -z "$p" ] && p="$(ask "New port (now $(current_port))" "$(free_port "$(current_port)")")"
  valid_port "$p" || die "Not a valid port: $p"
  [ "$p" = "$(current_port)" ] && { info "The port is already $p."; return 0; }
  port_busy "$p" && die "Port $p is already in use. Pick another one."
  if [ -n "$(fixed_port)" ]; then
    info "The port was written directly in docker-compose.yml; moving it to .env so this menu can manage it."
    $SUDO sed -i.bak -E 's/^([[:space:]]*-[[:space:]]*)"?[0-9]+:8080"?/\1"${AI2VPN_PORT:-8080}:8080"/' "$(compose_file)" && $SUDO rm -f "$(compose_file).bak"
  fi
  env_set AI2VPN_PORT "$p"
  compose_up
  ok "Port changed. Open $(address)"
  if [ -n "$(env_get PUBLIC_URL)" ]; then warn "You use a public URL / reverse proxy: point it to port $p too."; fi
  return 0
}
do_password() {
  need_install
  local v="${1:-}"
  [ -z "$v" ] && v="$(ask_secret "New admin password (at least 6 characters)" "")"
  [ -z "$v" ] && { info "Cancelled."; return 0; }
  [ ${#v} -ge 6 ] || die "At least 6 characters, please."
  case "$v" in *"'"*) die "Please don't use the ' character." ;; esac
  env_set ADMIN_PASSWORD "$v"
  compose_up >/dev/null 2>&1
  wait_for_app
  ok "Password changed. Everyone is signed out of the web UI."
}
do_public_url() {
  need_install
  local u; u="$(ask "Public URL, e.g. https://ai.example.com (empty = automatic)" "$(env_get PUBLIC_URL)")"
  env_set PUBLIC_URL "${u%/}"
  compose_up >/dev/null 2>&1
  ok "Saved. API base: $(address)/v1"
}
ask_gluetun() {
  echo
  info "gluetun picks the server by provider name. Settings per provider: https://github.com/qdm12/gluetun-wiki"
  env_set VPN_SERVICE_PROVIDER "$(ask "VPN provider (surfshark, nordvpn, mullvad, protonvpn, expressvpn, private internet access, …)" "$(env_get VPN_SERVICE_PROVIDER | grep . || echo surfshark)")"
  printf '  1) WireGuard   2) OpenVPN\n'
  if [ "$(ask "  VPN type" 1)" = 2 ]; then
    env_set VPN_TYPE openvpn
    env_set OPENVPN_USER "$(ask "OpenVPN service username (not your login)" "$(env_get OPENVPN_USER)")"
    env_set OPENVPN_PASSWORD "$(ask_secret "OpenVPN service password" "$(env_get OPENVPN_PASSWORD)")"
  else
    env_set VPN_TYPE wireguard
    env_set WIREGUARD_PRIVATE_KEY "$(ask_secret "WireGuard private key (PrivateKey in your .conf)" "$(env_get WIREGUARD_PRIVATE_KEY)")"
    env_set WIREGUARD_ADDRESSES "$(ask "WireGuard address (Address in your .conf, e.g. 10.14.0.2/16)" "$(env_get WIREGUARD_ADDRESSES)")"
  fi
  env_set SERVER_COUNTRIES "$(ask "Server countries, comma separated (optional)" "$(env_get SERVER_COUNTRIES)")"
}
do_vpn_file() {  # load a WireGuard .conf / OpenVPN .ovpn into the built-in VPN and connect
  need_install
  [ "$(vpn_mode)" = built-in ] || die "This is for the built-in VPN; you use gluetun (switch in menu 3 → 4 → 4)."
  [ -n "$(env_get ADMIN_PASSWORD)" ] || die "The installer needs the admin password to do this. Set one in menu 3 → 2, or load the file in the web UI → VPN."
  local f mode body u="" pw="" ks j
  f="$(ask "Path to your WireGuard .conf or OpenVPN .ovpn file" "")"; f="${f/#\~/$HOME}"
  [ -z "$f" ] && { info "Cancelled."; return 0; }
  [ -f "$f" ] || die "File not found: $f"
  if grep -qiE '^[[:space:]]*\[Interface\]' "$f"; then mode=wireguard; else mode=openvpn; fi
  ks=false; if confirm "Turn on the kill switch (block all traffic if the VPN drops)?" y; then ks=true; fi
  if [ "$mode" = openvpn ]; then
    u="$(ask "VPN service username (not your login)" "")"; pw="$(ask_secret "VPN service password" "")"
  fi
  body="$($DOCKER exec -i -e MODE="$mode" -e U="$u" -e PW="$pw" -e KS="$ks" ai2vpn node -e '
    let s=""; process.stdin.on("data",c=>s+=c).on("end",()=>{ const e=process.env;
      const b={ mode:e.MODE, killSwitch:e.KS==="true", autoConnect:true };
      if (e.MODE==="wireguard") b.wireguardConfig=s; else Object.assign(b,{ openvpnConfig:s, openvpnUser:e.U, openvpnPass:e.PW });
      process.stdout.write(JSON.stringify(b)); });' <"$f")"
  a2v_api PUT /api/vpn "$body" >/dev/null
  info "Connecting ($mode)…"
  j="$(a2v_api POST /api/vpn/connect || true)"
  if [ "$(json_field "$j" 'd.status&&d.status.status')" = connected ]; then
    ok "VPN connected — exit IP $(json_field "$j" 'd.status.ip?(d.status.ip.ip+" "+(d.status.ip.country||"")):"?"')"
  else
    warn "Not connected: $(json_field "$j" 'd.error||(d.status&&d.status.error)||"unknown"')"
    return 1
  fi
}
do_vpn_mode() {
  need_install
  if [ "$(vpn_mode)" = gluetun ]; then
    confirm "Switch back to the built-in VPN (configured in the web UI)?" y || return 0
    $COMPOSE down --remove-orphans; env_unset COMPOSE_FILE
  else
    confirm "Switch to gluetun (VPN chosen by provider name)?" y || return 0
    ask_gluetun; $COMPOSE down --remove-orphans; env_set COMPOSE_FILE docker-compose.gluetun.yml
  fi
  COMPOSE=""; need_docker; compose_up; wait_for_app; ok "VPN mode: $(vpn_mode)"
}
do_sandbox_toggle() {
  need_install
  if sandbox_on; then
    confirm "Switch the sandbox off? (your projects and CLI logins are kept)" y || return 0
    env_set A2V_SANDBOX 0
  else env_set A2V_SANDBOX 1; fi
  compose_up; ok "Sandbox: $(sandbox_on && echo on || echo off)"
}
do_backup() {
  need_install
  local dir="$INSTALL_DIR/backups" ts file items=(.env) dd; dd="$(data_dir)"
  ts="$(date +%Y%m%d-%H%M%S)"; file="$dir/ai2vpn-$ts.tar.gz"
  [ -d "$INSTALL_DIR/sandbox-home" ] && items+=(sandbox-home)
  if [ -d "$INSTALL_DIR/workspace" ] && [ -n "$(ls -A "$INSTALL_DIR/workspace" 2>/dev/null)" ] && confirm "Include your sandbox projects (workspace/)?" n; then items+=(workspace); fi
  $SUDO mkdir -p "$dir"
  info "Stopping ai2vpn for a consistent copy (browser profiles are in use while it runs)…"
  $COMPOSE stop >/dev/null 2>&1 || true
  # data may live outside the install folder: store it as data/ in the archive
  if $SUDO tar -czf "$file" -C "$(dirname "$dd")" --transform "s|^$(basename "$dd")|data|" "$(basename "$dd")" -C "$INSTALL_DIR" "${items[@]}"; then
    compose_up >/dev/null 2>&1 || true
    $SUDO chmod 600 "$file"
    ok "Backup saved: $file ($($SUDO du -h "$file" | awk '{print $1}'))"
    echo "   It contains your account logins and VPN keys — keep it somewhere safe and private."
  else
    compose_up >/dev/null 2>&1 || true
    die "Backup failed."
  fi
}
list_backups() { ls -1t "$INSTALL_DIR"/backups/ai2vpn-*.tar.gz 2>/dev/null || true; }
do_list_backups() {
  need_install
  local files; files="$(list_backups)"
  [ -z "$files" ] && { info "No backups yet in $INSTALL_DIR/backups"; return 0; }
  echo; printf '%sBackups (newest first)%s\n' "$B" "$R"
  local f; while IFS= read -r f; do printf '  %s  %s\n' "$($SUDO du -h "$f" | awk '{print $1}')" "$f"; done <<<"$files"
}
do_restore() {
  need_install
  local file="${1:-}"
  if [ -z "$file" ]; then
    local files n=0 f pick; files="$(list_backups)"
    [ -z "$files" ] && die "No backups found in $INSTALL_DIR/backups. Give a file: install.sh restore <file.tar.gz>"
    echo; printf '%sChoose a backup%s\n' "$B" "$R"
    while IFS= read -r f; do n=$((n + 1)); printf '  %s%d)%s %s\n' "$C" "$n" "$R" "$(basename "$f")"; done <<<"$files"
    echo "  0) Cancel"
    pick="$(ask "Number" 1)"
    [[ "$pick" =~ ^[0-9]+$ ]] && [ "$pick" -ge 1 ] && [ "$pick" -le "$n" ] || { info "Cancelled."; return 0; }
    file="$(sed -n "${pick}p" <<<"$files")"
  fi
  [ -f "$file" ] || die "File not found: $file"
  warn "Restoring replaces the current accounts, logins and settings with the ones in the backup."
  confirm "Restore $(basename "$file")?" n || { info "Cancelled."; return 0; }
  local ts tmp dd keep; ts="$(date +%Y%m%d-%H%M%S)"; dd="$(data_dir)"; keep="$(env_get A2V_DATA_DIR)"
  tmp="$INSTALL_DIR/.restore-$ts"; $SUDO mkdir -p "$tmp"
  $SUDO tar -xzf "$file" -C "$tmp" || { $SUDO rm -rf "$tmp"; die "Could not read $file"; }
  $COMPOSE stop >/dev/null 2>&1 || true
  if [ -d "$tmp/data" ]; then
    [ -d "$dd" ] && $SUDO mv "$dd" "$dd.before-restore-$ts"
    $SUDO mv "$tmp/data" "$dd"
  fi
  if [ -d "$tmp/sandbox-home" ]; then
    [ -d "$INSTALL_DIR/sandbox-home" ] && $SUDO mv "$INSTALL_DIR/sandbox-home" "$INSTALL_DIR/sandbox-home.before-restore-$ts"
    $SUDO mv "$tmp/sandbox-home" "$INSTALL_DIR/sandbox-home"
  fi
  if [ -f "$tmp/.env" ]; then
    [ -f "$INSTALL_DIR/.env" ] && $SUDO cp "$INSTALL_DIR/.env" "$INSTALL_DIR/.env.before-restore-$ts"
    $SUDO cp "$tmp/.env" "$INSTALL_DIR/.env"
    [ -n "$keep" ] && env_set A2V_DATA_DIR "$keep"   # the data stays where it is on this machine
  fi
  $SUDO rm -rf "$tmp"
  compose_up
  ok "Restored. The previous data was kept as *.before-restore-$ts (delete it when you're happy)."
}
do_uninstall() {
  need_install
  if [ "$PURGE" -eq 1 ]; then
    local dd; dd="$(data_dir)"
    case "$dd" in /|/bin*|/etc*|/usr|/usr/*|/var|/home|/root|"$HOME") die "Refusing to delete $dd" ;; esac
    warn "This deletes ALL accounts, browser logins, VPN settings ($dd) and sandbox logins ($INSTALL_DIR/sandbox-home)."
    confirm "Really delete everything?" n || { info "Cancelled."; return 0; }
    $COMPOSE down -v --remove-orphans --rmi local
    $SUDO rm -rf "$dd" "$INSTALL_DIR/sandbox-home"
    $SUDO rm -f /usr/local/bin/ai2vpn "$CONF_FILE" 2>/dev/null || true
    ok "ai2vpn and its data were removed. (Backups in $INSTALL_DIR/backups and projects in $INSTALL_DIR/workspace were kept.)"
  else
    confirm "Remove the ai2vpn containers? Your accounts and settings stay in $INSTALL_DIR." y || { info "Cancelled."; return 0; }
    $COMPOSE down --remove-orphans
    ok "Containers removed. Your data is kept; choose Install again to bring it back."
  fi
}

# ---------------------------------------------------------------- menu
header() {
  if [ "$TTY" -eq 1 ] && [ -t 1 ]; then clear; fi
  printf '%s' "$P$B"
  cat <<'EOF'
        _ ____
   __ _(_)___ \__   ___ __  _ __
  / _` | | __) \ \ / / '_ \| '_ \
 | (_| | |/ __/ \ V /| |_) | | | |
  \__,_|_|_____| \_/ | .__/|_| |_|
                     |_|   AI accounts → VPN → OpenAI-compatible API
EOF
  printf '%s' "$R"
  if installed; then
    local st="${D}unknown (Docker not reachable)${R}"
    if quick_docker; then
      local n e; n="$(running_count)"; e="$(expected_count)"
      if [ "$n" -ge "$e" ]; then st="${G}● running${R}"; elif [ "$n" -gt 0 ]; then st="${Y}● partly running ($n of $e)${R}"; else st="${E}● stopped${R}"; fi
    fi
    printf '  Status: %s   Address: %s%s%s\n' "$st" "$B" "$(address)" "$R"
    printf '  %sFolder: %s · VPN: %s · Sandbox: %s%s\n' "$D" "$INSTALL_DIR" "$(vpn_mode)" "$(sandbox_on && echo on || echo off)" "$R"
  else
    printf '  Status: %snot installed%s   %s(will install to %s)%s\n' "$Y" "$R" "$D" "$INSTALL_DIR" "$R"
  fi
  echo
}
item() { printf '  %s%s)%s %s\n' "$C$B" "$1" "$R" "$2"; }
title() { printf '  %s%s%s\n  %s\n' "$B" "$1" "$R" "────────────────────────────"; }
choose() { echo >/dev/tty; ask "  Choose a number" ""; }
run() {  # run an action in a subshell so an error returns to the menu instead of closing it
  local rc; set +e; ( set -e; "$@" ); rc=$?; set -e
  [ "$rc" -eq 0 ] || warn "That did not finish (see the message above)."
  return 0
}

page_manage() {
  while :; do
    header; title "2 · Manage service"
    item 1 "Status (containers, VPN, exit IP)"; item 2 "Start"; item 3 "Stop"; item 4 "Restart"; item 5 "View logs"
    item 6 "Open the sandbox terminal (Claude Code / Codex)"; item 0 "Back"
    case "$(choose)" in
      1) run do_status; pause ;; 2) run do_start; pause ;; 3) run do_stop; pause ;;
      4) run do_restart; pause ;; 5) run do_logs; pause ;; 6) run do_shell; pause ;;
      0|b|q|"") return ;; *) warn "Choose 0–6."; sleep 1 ;;
    esac
  done
}
page_vpn() {
  while :; do
    header; title "3 · Settings › VPN (now: $(vpn_mode))"
    item 1 "Show VPN status and exit IP"
    item 2 "Load a WireGuard .conf / OpenVPN .ovpn file and connect"
    item 3 "Open the VPN page in the web UI: $(address)/#vpn"
    item 4 "Switch between built-in VPN and gluetun"
    item 0 "Back"
    case "$(choose)" in
      1) run do_vpn_status; pause ;; 2) run do_vpn_file; pause ;; 3) info "Open $(address)/#vpn in your browser."; pause ;;
      4) run do_vpn_mode; pause ;; 0|b|q|"") return ;; *) warn "Choose 0–4."; sleep 1 ;;
    esac
  done
}
page_settings() {
  while :; do
    header; title "3 · Settings"
    item 1 "Change port (now $(current_port))"; item 2 "Change admin password"
    item 3 "Public URL (now $(env_get PUBLIC_URL | grep . || echo automatic))"
    item 4 "VPN                 › status, load config, built-in / gluetun"
    item 5 "Sandbox: switch $(sandbox_on && echo off || echo on)"
    item 6 "Show address, password and folder"
    item 7 "Use another install folder (find / switch)"; item 0 "Back"
    echo; printf '  %sAccounts, models, provider fixes and updates are managed in the web UI.%s\n' "$D" "$R"
    case "$(choose)" in
      1) run do_port; pause ;; 2) run do_password; pause ;; 3) run do_public_url; pause ;; 4) page_vpn ;;
      5) run do_sandbox_toggle; pause ;; 6) summary; pause ;; 7) page_folder ;;
      0|b|q|"") return ;; *) warn "Choose 0–7."; sleep 1 ;;
    esac
  done
}
page_backup() {
  while :; do
    header; title "4 · Backup & restore"
    item 1 "Back up now"; item 2 "Restore a backup"; item 3 "List backups"; item 0 "Back"
    case "$(choose)" in
      1) run do_backup; pause ;; 2) run do_restore; pause ;; 3) run do_list_backups; pause ;;
      0|b|q|"") return ;; *) warn "Choose 0–3."; sleep 1 ;;
    esac
  done
}
page_uninstall() {
  header; title "5 · Uninstall"
  item 1 "Remove containers, keep my accounts and settings"; item 2 "Remove everything (delete all data)"; item 0 "Back"
  case "$(choose)" in
    1) PURGE=0 run do_uninstall; pause ;;
    2) PURGE=1 run do_uninstall; pause ;;
    *) return ;;
  esac
}
menu() {
  trap 'echo' INT   # Ctrl+C stops logs etc. but keeps the menu open
  while :; do
    header; title "Main menu"
    if installed; then item 1 "Update ai2vpn (keeps your accounts and settings)"; else item 1 "Install ai2vpn"; fi
    item 2 "Manage service      › status, start, stop, restart, logs, sandbox terminal"
    item 3 "Settings            › port, password, VPN, sandbox, install folder"
    item 4 "Backup & restore"
    item 5 "Uninstall"
    installed || item 6 "Find an existing install (custom folder / search the whole disk)"
    item 0 "Exit"
    case "$(choose)" in
      6) page_folder ;;
      1) if ! installed && [ -z "$SCRIPT_DIR" ]; then INSTALL_DIR="$(ask "  Install folder" "$INSTALL_DIR")"; DIR_ASKED=1; fi
         run do_install; pause ;;
      2) page_manage ;; 3) page_settings ;; 4) page_backup ;; 5) page_uninstall ;;
      0|q|exit) echo; exit 0 ;;
      "") ;;
      *) warn "Choose a number from the menu."; sleep 1 ;;
    esac
  done
}

# ---------------------------------------------------------------- main
if [ "$ACTION" != "help" ]; then resolve_dir; remember_found 2>/dev/null || true; fi
if [ -z "$ACTION" ]; then
  # a terminal with no options → menu; otherwise (automation, or --port/--dir given) → install
  if [ "$TTY" -eq 1 ] && [ "$YES" -eq 0 ] && [ -z "$PORT" ]; then ACTION="menu"; else ACTION="install"; fi
fi
case "$ACTION" in
  help) sed -n '2,22p' "${BASH_SOURCE[0]:-$0}" 2>/dev/null | sed 's/^# \{0,1\}//' || echo "See $REPO_URL"; exit 0 ;;
  menu) menu ;;
  install|update) do_install ;;
  status) do_status ;; start) do_start ;; stop) do_stop ;; restart) do_restart ;;
  logs) do_logs ;; shell) do_shell ;; vpn) do_vpn_status ;;
  port) do_port "$ARG" ;; password) do_password "$ARG" ;;
  backup) do_backup ;; restore) do_restore "$ARG" ;; uninstall) do_uninstall ;;
esac
