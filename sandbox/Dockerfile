# ai2vpn sandbox: Claude Code, Codex CLI and Gemini CLI in their own container.
# It shares ai2vpn's network (network_mode: service:ai2vpn), so all traffic goes through
# ai2vpn's VPN / kill switch, and it has no capability to change that network.
FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tmux sudo git curl wget ca-certificates openssh-client \
      python3 python3-pip python3-venv build-essential \
      ripgrep fd-find jq less nano vim-tiny unzip zip procps htop locales \
 && sed -i 's/# en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen \
 && rm -rf /var/lib/apt/lists/*

# ttyd (web terminal) — static release binary, checked against the published SHA256SUMS.
ARG TTYD_VERSION=1.7.7
RUN set -e; \
    case "$(dpkg --print-architecture)" in \
      amd64) a=x86_64 ;; arm64) a=aarch64 ;; armhf) a=armhf ;; *) echo "unsupported arch"; exit 1 ;; \
    esac; \
    cd /tmp; \
    curl -fsSLO "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.$a"; \
    curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/SHA256SUMS" | grep " ttyd.$a\$" | sha256sum -c -; \
    install -m 755 "ttyd.$a" /usr/local/bin/ttyd; rm -f "ttyd.$a"; \
    ttyd --version

# The coding agents (system-wide). `update-clis` installs newer versions into the user's home.
RUN npm install -g --prefix /usr/local @anthropic-ai/claude-code @openai/codex @google/gemini-cli \
 && npm cache clean --force

# Rename the image's "node" user (uid 1000) to "coder".
RUN usermod -l coder -d /home/coder -m node && groupmod -n coder node \
 && echo 'coder ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/coder && chmod 440 /etc/sudoers.d/coder \
 && mkdir -p /workspace /run/sandbox /etc/skel-coder

COPY tmux.conf /etc/tmux.conf
COPY bashrc /etc/skel-coder/.bashrc
COPY update-clis /usr/local/bin/update-clis
COPY entrypoint.sh /usr/local/bin/sandbox-entrypoint
# Set permissions explicitly: COPY keeps the host's file modes, and on some NAS / shared volumes the
# checked-out files are readable by their owner only, which locked "coder" out (e.g. /etc/tmux.conf).
RUN chmod 644 /etc/tmux.conf /etc/skel-coder/.bashrc \
 && chmod 755 /etc/skel-coder /usr/local/bin/update-clis /usr/local/bin/sandbox-entrypoint

ENV LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    TERM=xterm-256color \
    DISABLE_AUTOUPDATER=1

WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/sandbox-entrypoint"]
