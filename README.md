# ai2vpn

A self-hosted Docker container that:

1. **Signs in to your own AI chat accounts**: ChatGPT, Claude, Gemini, Kimi, DeepSeek, Grok, Qwen, Le Chat (Mistral), or any other chat site you configure. Each account gets its own real Chromium profile inside the container.
2. **Sends all of that traffic through a VPN** (Surfshark, NordVPN, Mullvad, Proton VPN, PIA, ExpressVPN, Windscribe, IVPN, CyberGhost, or any WireGuard/OpenVPN server). It has a kill switch and blocks IPv6 leaks.
3. **Turns each account into an OpenAI-compatible API** served by the container host (`http://<host>:8080/v1`). Each account has its own API key and its own OpenAPI spec.

You manage everything from the web interface: adding accounts, signing in, the VPN, API keys, and site selectors.

```
 your apps (OpenAI SDK, curl, …)            ┌──────────────── ai2vpn container ─────────────────┐
 ───────────────────────────────▶ :8080 ──▶ │  /v1/chat/completions  → account (by API key)      │
   Authorization: Bearer sk-a2v-…           │        │                                           │
                                            │        ▼                                           │
 web UI (browser) ───────────────▶ :8080 ──▶│  Chromium profile per account (chatgpt.com, …)     │
                                            │        │                                           │
                                            │        ▼  wg0 / tun0 (kill switch)                 │
                                            └────────┼───────────────────────────────────────────┘
                                                     ▼
                                                VPN provider ──▶ chatgpt.com / claude.ai / …
```

## Quick start

Linux / macOS (on a NAS, run it over SSH):

```bash
curl -fsSL https://raw.githubusercontent.com/icebays/ai2vpn/HEAD/install.sh | bash
```

Windows (Docker Desktop), in PowerShell:

```powershell
irm https://raw.githubusercontent.com/icebays/ai2vpn/HEAD/install.ps1 | iex
```

In a terminal, the installer shows a numbered menu:

```
  Status: ● running   Address: http://192.168.1.20:8080
  Folder: /opt/ai2vpn · VPN: built-in · Sandbox: on

  Main menu
  ────────────────────────────
  1) Update ai2vpn (keeps your accounts and settings)
  2) Manage service      › status, start, stop, restart, logs, sandbox terminal
  3) Settings            › port, password, VPN, sandbox, install folder
  4) Backup & restore
  5) Uninstall
  0) Exit
```

- **Install** asks for the folder (default `/opt/ai2vpn`, or `~/ai2vpn` on macOS) and the port (8080, or the next free one). It generates an admin password, then asks how to connect to the VPN (built-in, gluetun or none for now) and whether to run the sandbox. It installs Docker if missing (Linux), builds and starts everything, can load your WireGuard/OpenVPN file and connect, and finally prints the address and password.
- **Shortcut:** afterwards, type **`ai2vpn`** to open the menu again.
- **Finding an existing install:** the installer finds it by itself, also in a custom or renamed folder (anywhere, not only `/opt`). In order:
  1. the folder it remembered (`/etc/ai2vpn.conf`)
  2. Docker: where the ai2vpn containers were started, and every compose project Docker knows about (also stopped ones)
  3. common folders, including NAS volumes such as `/volume1/docker/ai2vpn` or `/vol1/1000/Docker/ai2vpn`
  4. if none of those know it, a quick disk search (the `locate` database, or the usual data folders, up to 45 s). ai2vpn is recognised by the folder's contents, so the folder can have any name.

  A folder found this way is remembered, so the next run is instant. If there are several, you pick one. **3 → 7**, or **6** while nothing is found, searches the whole disk or takes a folder you type. `--dir <path>` always wins.
- **Port written into `docker-compose.yml`:** if you typed the port there by hand, the installer detects it, and **3 → 1** moves it to `.env`.

**Without the menu (for scripts):** `install.sh install [--dir <path>] [--port <n>]`, `status`, `start`, `stop`, `restart`, `logs`, `shell`, `port <n>`, `password <new>`, `vpn`, `backup`, `restore <file>`, `uninstall [--purge]`, plus `-y` to answer yes to everything. Backups go to `backups/` in the install folder.

<details><summary>Manual setup without the installer</summary>

```bash
git clone https://github.com/icebays/ai2vpn && cd ai2vpn
```

```bash
cp .env.example .env    # set ADMIN_PASSWORD
```

```bash
docker compose up -d --build
```

</details>

Then open the web UI, sign in, and:

1. **VPN tab**: pick WireGuard or OpenVPN and your provider. Follow the instructions shown for that provider, paste or load the config, then click **Save & connect**. The pill at the top shows the container's exit IP.
2. **Accounts tab**: click **+ Add account**, pick the service, then sign in:
   - **Direct login**: enter your email and password, plus a 2FA secret if you use one. The container opens the real sign-in page and fills it in step by step (email → password → code). If you save the credentials, it signs in again automatically when the session expires.
   - **Remote browser**: the account's Chromium appears live in your browser. Sign in by hand, which works for Google sign-in, passkeys and captchas. Popups such as "Sign in with Google" open as tabs.
   - **Import cookies**: paste cookies exported from your own browser (Cookie-Editor JSON, cookies.txt, or a `Cookie:` header).
3. Copy the account's **Base URL**, **Model** and **API key**, or use the **Test** button.

```python
from openai import OpenAI

client = OpenAI(base_url="http://<host>:8080/v1", api_key="sk-a2v-…")   # the account's key
r = client.chat.completions.create(model="chatgpt", messages=[{"role": "user", "content": "Hello"}])
print(r.choices[0].message.content)
```

## API

| Endpoint | Description |
|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions. Supports `stream: true` (SSE) and `stream_options.include_usage`. |
| `GET /v1/models` | One model per account (the account's slug). |
| `POST /v1/files` | Upload a file (multipart `file` + `purpose`). Returns a `file-…` id to use in chats. Also `GET /v1/files`, `GET /v1/files/<id>`, `GET /v1/files/<id>/content`, `DELETE /v1/files/<id>`. Files expire after 24 hours. |
| `/acc/<slug>/v1/...` | The same endpoints pinned to one account. |
| `GET /acc/<slug>/openapi.json` | OpenAPI 3.1 spec for that account. Swagger UI is at `/acc/<slug>/docs`. |
| `GET /v1/openapi.json`, `/docs` | Spec covering all accounts. |

**Keys.** Each account has its own key (`sk-a2v-…`), and the key decides which account answers. The **master key** (API tab) works for every account: set `model` to the account slug or to a provider id such as `claude`.

**How a request runs.** A new conversation opens a fresh chat in the web UI and types the prompt. Follow-ups go into the same chat (see [Conversations](#conversations)). When a history can't be matched to an existing chat, the earlier messages are replayed in the prompt as a transcript. Requests to the same account are queued (one at a time per account); different accounts run in parallel. Token usage is estimated at 4 characters per token.

For ChatGPT, a `model` value that isn't an alias (for example `gpt-5`) is passed to `chatgpt.com/?model=…`.

## Conversations

Follow-up messages stay in the same web chat. Chat apps resend the whole history every time; ai2vpn recognises it and sends only the newest message into the chat where the conversation is already happening. On claude.ai you see one chat per conversation, not one per message.

- **How it matches:** the history before your new message must be exactly what ai2vpn last saw, including its own reply. System prompts are ignored when matching.
- **When it starts a new chat instead:** if you edit an earlier message, regenerate, or switch apps, ai2vpn opens a new web chat and pastes the full history, as before.
- **Explicit IDs:** API users can pass `conversation_id` in the body, or the `X-Conversation-Id` header, and send only the new message each time. `new_chat: true` (or `X-New-Chat: 1`) forces a fresh chat.
- **If the old chat is gone** (deleted on the website, logged out…), ai2vpn starts a new chat with the full history automatically.
- **Turn it off** in Settings → General if you want a new chat for every request.

## Choosing the model

Put the model in the API's `model` field. ai2vpn opens the site's own model menu and clicks the matching entry before sending, including entries under "More models" / "Legacy models" submenus.

- **Loose names work:** `claude-opus-4-1`, `opus 4.1` and `Opus-4.1` all pick "Opus 4.1"; `gpt-5-thinking` picks "GPT-5 Thinking"; `2.5 pro` picks Gemini 2.5 Pro.
- **Default:** use the account's slug (e.g. `claude`) to keep whatever model the site currently has selected.
- **DeepSeek** has no model menu: `deepseek-reasoner` (or anything with `r1` / `think`) turns on DeepThink, and `deepseek-chat` turns it off.
- **Unknown names** return `400 model_not_found` listing what the site offers.
- **Master key:** use `<account>/<model>`, e.g. `claude/opus-4-1`.

**Models** on an account card reads the site's menu and lists the names. They also appear in `GET /v1/models` as `<account>/<model>`.

## Sandbox: Claude Code, Codex, Gemini CLI

`docker compose up -d` also starts **ai2vpn-sandbox**, a separate container with Claude Code, Codex CLI and Gemini CLI, plus git, Python, Node and build tools. Open it from the web UI's **Sandbox** tab, which is a terminal running tmux, so sessions keep running after you close the page.

- **Network:** it shares ai2vpn's network, so all its traffic goes through the VPN and kill switch. It has no network-admin rights, so it can't change them, even with `sudo`.
- **Logins:** use your subscriptions, no API keys needed. `claude` signs in with your Claude Pro/Max account, `codex` with "Sign in with ChatGPT", and `gemini` with Google. For CLIs whose sign-in link sends you back to `localhost`, open the link in the tab's **login browser**: it shares the sandbox's network, so the callback reaches the CLI.
- **Storage:** projects live in `./workspace` and CLI logins in `./sandbox-home`.
- **Updates:** run `update-clis` in the terminal to update all three CLIs.
- **Security:** the terminal is only reachable through ai2vpn's admin login. It listens on a private socket, not a network port.

## Updates

**Settings → Updates** checks GitHub for a newer version of ai2vpn: `icebays/ai2vpn`, default branch, every 6 hours. It shows what changed, and **Update now** installs it inside the running container.

- **How:** the new code goes to `/data/app/releases/<commit>`, and only the ai2vpn process restarts. The VPN reconnects, and the sandbox keeps running.
- **If the new version crashes on start,** ai2vpn rolls back to the version built into the image automatically. There is also a **Roll back** button.
- **Rebuild needed:** if an update changes the Dockerfile, the startup scripts or the sandbox, the page says so. For those parts run `git pull && docker compose up -d --build` on the host.
- **Options:** automatic installation when idle, another repository or branch (e.g. your fork), and a GitHub token for private repositories.

## Files and images

You can attach any file the chat site accepts: images, PDF, Word/Excel/PowerPoint, text, code, CSV, zip and so on. Use the standard OpenAI content parts:

```python
import base64
from openai import OpenAI

client = OpenAI(base_url="http://<host>:8080/v1", api_key="sk-a2v-…")

# 1) inline (base64)
pdf = base64.b64encode(open("report.pdf", "rb").read()).decode()
r = client.chat.completions.create(model="claude", messages=[{"role": "user", "content": [
    {"type": "text", "text": "Summarize this report"},
    {"type": "file", "file": {"filename": "report.pdf", "file_data": f"data:application/pdf;base64,{pdf}"}},
    {"type": "image_url", "image_url": {"url": "https://example.com/chart.png"}},
]}])

# 2) upload once, reuse by id
f = client.files.create(file=open("data.xlsx", "rb"), purpose="user_data")
r = client.chat.completions.create(model="claude", messages=[{"role": "user", "content": [
    {"type": "text", "text": "What trends do you see?"},
    {"type": "file", "file": {"file_id": f.id}},
]}])
```

Inside the container, ai2vpn attaches the files to the chat before sending. It uses the page's file input if there is one, otherwise it clicks the attach button and answers the file picker, otherwise it drops the files onto the prompt box. It then waits for the upload to finish. Remote URLs are downloaded through the VPN.

Limits: 10 files per request and 50 MB per file (`MAX_FILES_PER_REQUEST`, `MAX_UPLOAD_MB`). The chat site's own limits also apply, for example file types or daily upload caps on free plans. If a site changes its attach button, fix the `fileInput` / `attach` / `attachMenu` / `uploading` selectors in **Settings → Provider overrides**.

## VPN

Two ways to run the VPN:

| | How | When |
|---|---|---|
| **Built-in** (default `docker-compose.yml`) | Paste a WireGuard `.conf` or OpenVPN `.ovpn` in the web UI. The container brings up `wg0`/`tun0` itself. Needs `NET_ADMIN` and `/dev/net/tun`. | You want to switch servers and providers from the UI. |
| **gluetun** (`docker-compose.gluetun.yml`) | [gluetun](https://github.com/qdm12/gluetun) owns the VPN, and ai2vpn shares its network (`VPN_MODE=external`). | You already use gluetun, or want its provider catalogue and server picking. |

Details of the built-in mode:

- **Inbound access stays up.** New connections arriving on `eth0` are marked (connmark), and their replies go back out `eth0` through a separate routing table. The web UI and API stay reachable from your LAN or reverse proxy while all outbound traffic uses the tunnel.
- **Kill switch** (optional). An iptables chain rejects any outbound traffic that is not going through the tunnel, to the local subnet, or to `LAN bypass` CIDRs. This holds while the VPN is down too.
- **IPv6.** The tunnels carry IPv4 only, so new outbound IPv6 is rejected whenever a tunnel mode is selected.
- **DNS.** Uses the VPN's DNS servers (from the WireGuard config or pushed by OpenVPN), or the servers you enter.
- **Auto-reconnect** when the tunnel process dies.
- **NordVPN WireGuard (NordLynx).** Nord does not hand out `.conf` files. Paste your access token in the generator and ai2vpn builds the config through Nord's API.
- **WireGuard needs the `wireguard` kernel module on the host.** It is built into Linux 5.6+ and Docker Desktop. If yours lacks it, use OpenVPN or gluetun.

## When a site changes its HTML

Chat sites change their markup often. Every provider is described by CSS selectors: prompt box, send button, the "generating" indicator, assistant messages, and the logged-out marker. You can override any of them under **Settings → Provider overrides** without rebuilding, or for a single account under **More → advanced settings**. The **Custom site** provider lets you add any other chat site the same way. The fields are documented at the top of `src/providers.js`.

## Configuration

| Env var | Default | |
|---|---|---|
| `ADMIN_PASSWORD` | generated, printed in the logs | Web UI password |
| `PUBLIC_URL` | taken from the request | Base URL shown for the API, e.g. `https://ai.example.com` |
| `PORT` | `8080` | |
| `HEADLESS` | `false` | `false` runs Chromium headed on a virtual display (Xvfb), which sites flag as a bot less often |
| `VPN_MODE` | (set in the UI) | Set to `external` when gluetun or the host handles the VPN |
| `TZ`, `BROWSER_LOCALE` | `UTC`, `en-US` | Browser timezone and locale |
| `MAX_QUEUE` | `20` | Maximum queued requests per account |
| `MAX_UPLOAD_MB`, `MAX_FILES_PER_REQUEST` | `50`, `10` | Attachment limits |
| `FILE_TTL_HOURS` | `24` | How long `/v1/files` uploads are kept |
| `UPDATE_REPO`, `UPDATE_BRANCH`, `UPDATE_GITHUB_TOKEN` | `icebays/ai2vpn`, default branch, — | Where updates come from (also settable in the UI) |
| `SANDBOX_SUDO` | `true` | Allow `sudo` inside the sandbox |

Everything is stored in `/data` (`./data` on the host): `config.json` (accounts, keys, VPN settings, saved sign-ins), `profiles/<id>` (browser profiles, i.e. your logged-in sessions), and `vpn/`. **Treat this folder as a secret.**

## Development

```bash
npm install
```

```bash
npm test           # end-to-end test against a local mock chat site (headless Chromium)
```

```bash
ADMIN_PASSWORD=dev HEADLESS=true npm start
```

## Notes and limits

- **Use your own accounts.** Driving a consumer chat UI through automation can be against a provider's terms of service, and providers may rate-limit, challenge or suspend accounts. The official APIs are the supported route for production workloads. You are responsible for how you use this.
- **No tool or function calling**, and sampling parameters (`temperature`, …) are ignored. That also means coding agents such as Claude Code or Codex can't run on top of this API. Use the **sandbox** instead, where they sign in with your subscription.
- **Captchas, email codes and passkeys** can't be completed automatically. Direct login stops and asks you to finish in the remote browser, or to type the code into the dialog.
- **Google often blocks sign-in from automated browsers.** If Gemini's sign-in is rejected, use **Import cookies**.
- **Do not expose port 8080 to the internet without TLS.** Put it behind a reverse proxy (Caddy, Traefik, nginx) with HTTPS. Anyone with the admin password controls your accounts.
