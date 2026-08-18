#!/usr/bin/env bash
# =============================================================================
# Gives the studio a permanent address.
#
# `cloudflared tunnel --url …` is a *quick* tunnel: it lives in the terminal you
# started it in, dies when the SSH session closes, and hands out a new random
# hostname every time. Fine for a first look, useless as somewhere to work —
# every bookmark, every browser session and every publish target breaks on
# reconnect.
#
# This sets up the other kind: a named tunnel on a hostname you own, running as
# a user service, so it comes back after a reboot at the same address.
#
#   bash deploy/linux/tunnel.sh studio.example.ir     set up, or update
#   bash deploy/linux/tunnel.sh --status              is it connected?
#   bash deploy/linux/tunnel.sh --logs                what did it say?
#   bash deploy/linux/tunnel.sh --url                 the address it serves
#
# The hostname must be on a zone in the same Cloudflare account you log into
# below. The DNS record is created for you.
#
# Safe to run twice.
# =============================================================================
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/walk-on-3d"
ENV_FILE="$CONF_DIR/env"
CF_DIR="$HOME/.cloudflared"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/walk-tunnel.service"
TUNNEL="${WALK_TUNNEL_NAME:-walk-studio}"
PORT="${WALK_PORT:-5173}"

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; D='\033[2m'; N='\033[0m'
say()  { printf "  %s\n" "$1"; }
ok()   { printf "  ${G}✓${N} %s\n" "$1"; }
warn() { printf "  ${Y}!${N} %s\n" "$1"; }
die()  { printf "\n  ${R}✗${N} %s\n\n" "$1"; exit 1; }

case "${1:-}" in
  --status)
    systemctl --user status walk-tunnel --no-pager 2>/dev/null || say "no tunnel service yet"
    exit 0 ;;
  --logs)
    journalctl --user -u walk-tunnel -n 60 --no-pager 2>/dev/null || say "no logs yet"
    exit 0 ;;
  --url)
    grep -m1 'hostname:' "$CF_DIR/config.yml" 2>/dev/null | awk '{print "https://" $2}' \
      || die "no tunnel configured yet"
    exit 0 ;;
esac

HOSTNAME_ARG="${1:-}"
[[ -n "$HOSTNAME_ARG" ]] || die "which hostname? e.g.  bash deploy/linux/tunnel.sh studio.example.ir"
[[ "$HOSTNAME_ARG" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] \
  || die "\"$HOSTNAME_ARG\" does not look like a hostname."

printf "\n  ${D}Studio tunnel — %s${N}\n\n" "$HOSTNAME_ARG"

# ── cloudflared ──────────────────────────────────────────────────────────────
if ! command -v cloudflared >/dev/null 2>&1; then
  cat <<'EOF'
  cloudflared is not installed. On Debian or Ubuntu:

    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
      | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] \
https://pkg.cloudflare.com/cloudflared any main" \
      | sudo tee /etc/apt/sources.list.d/cloudflared.list
    sudo apt update && sudo apt install cloudflared

  Then run this again.

EOF
  exit 1
fi
ok "cloudflared $(cloudflared --version 2>/dev/null | awk '{print $3}')"

# ── the account ──────────────────────────────────────────────────────────────
# One browser login, once, ever. It writes a certificate that authorises this
# machine to create tunnels and DNS records in that account.
if [[ ! -f "$CF_DIR/cert.pem" ]]; then
  say "you need to authorise this machine with Cloudflare once."
  say "a URL will be printed — open it in any browser and pick the zone."
  say ""
  cloudflared tunnel login
  [[ -f "$CF_DIR/cert.pem" ]] || die "login did not complete."
fi
ok "authorised with Cloudflare"

# ── the tunnel ───────────────────────────────────────────────────────────────
if cloudflared tunnel list 2>/dev/null | awk '{print $2}' | grep -qx "$TUNNEL"; then
  ok "tunnel \"$TUNNEL\" already exists"
else
  cloudflared tunnel create "$TUNNEL" >/dev/null
  ok "created tunnel \"$TUNNEL\""
fi

UUID="$(cloudflared tunnel list 2>/dev/null | awk -v n="$TUNNEL" '$2 == n {print $1}' | head -1)"
[[ -n "$UUID" ]] || die "could not find the tunnel's id after creating it."
CREDS="$CF_DIR/$UUID.json"
[[ -f "$CREDS" ]] || die "the tunnel's credentials are missing — expected $CREDS"

# ── what it points at ────────────────────────────────────────────────────────
cat > "$CF_DIR/config.yml" <<EOF
# Written by deploy/linux/tunnel.sh — edit here, then restart walk-tunnel.
tunnel: $UUID
credentials-file: $CREDS

ingress:
  - hostname: $HOSTNAME_ARG
    service: http://127.0.0.1:$PORT
  # Anything arriving on another hostname is not for us.
  - service: http_status:404
EOF
ok "config written — $CF_DIR/config.yml"

# ── the DNS record ───────────────────────────────────────────────────────────
if cloudflared tunnel route dns "$TUNNEL" "$HOSTNAME_ARG" >/dev/null 2>&1; then
  ok "DNS record created — $HOSTNAME_ARG"
else
  # Already pointing at this tunnel is the common case and not a problem;
  # pointing at something else is, and the operator has to decide.
  warn "could not create the DNS record — it may already exist."
  say  "  Check that $HOSTNAME_ARG is a CNAME to $UUID.cfargotunnel.com"
fi

# ── Vite has to accept the hostname ──────────────────────────────────────────
# Without this the tunnel connects, the request arrives, and Vite answers
# "Blocked request. This host is not allowed" — which looks like a broken
# tunnel and is not one.
mkdir -p "$CONF_DIR"; chmod 700 "$CONF_DIR"
touch "$ENV_FILE"; chmod 600 "$ENV_FILE"

if grep -q "^WALK_HOSTS=" "$ENV_FILE"; then
  CURRENT="$(grep '^WALK_HOSTS=' "$ENV_FILE" | cut -d= -f2-)"
  if [[ ",$CURRENT," == *",$HOSTNAME_ARG,"* ]]; then
    ok "the studio already accepts $HOSTNAME_ARG"
  else
    sed -i "s|^WALK_HOSTS=.*|WALK_HOSTS=$CURRENT,$HOSTNAME_ARG|" "$ENV_FILE"
    ok "added $HOSTNAME_ARG to the studio's accepted hostnames"
  fi
else
  printf '\n# Hostnames the studio answers to. Loopback always works.\nWALK_HOSTS=%s\n' \
    "$HOSTNAME_ARG" >> "$ENV_FILE"
  ok "the studio will now accept $HOSTNAME_ARG"
fi
systemctl --user restart walk-studio 2>/dev/null && ok "studio restarted to pick it up" || true

# ── the service ──────────────────────────────────────────────────────────────
if [[ ! -d /run/systemd/system ]]; then
  warn "no systemd here — run it by hand instead:"
  say  "    cloudflared tunnel run $TUNNEL"
  exit 0
fi

mkdir -p "$UNIT_DIR"
cat > "$UNIT" <<EOF
[Unit]
Description=Walk on 3D — studio tunnel ($HOSTNAME_ARG)
Documentation=https://github.com/rcclothing2026-pixel/Walk-on-3d
After=network-online.target walk-studio.service
Wants=network-online.target
# cloudflared rides out a network outage on its own and only exits for real
# problems, so rapid restarts mean a broken config, not a flapping line. The
# window is wide enough to survive a bad night and still give up on a typo.
StartLimitIntervalSec=600
StartLimitBurst=20

[Service]
Type=simple
ExecStart=$(command -v cloudflared) --no-autoupdate --config $CF_DIR/config.yml tunnel run $TUNNEL
# Always, not on-failure: a tunnel that exits cleanly because the far end went
# away is the case that matters, and it exits 0 doing it.
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
ok "service written — $UNIT"

systemctl --user daemon-reload
systemctl --user enable --now walk-tunnel >/dev/null 2>&1 || true
systemctl --user restart walk-tunnel >/dev/null 2>&1 || true

if loginctl show-user "$(id -un)" 2>/dev/null | grep -q 'Linger=yes'; then
  ok "lingering is on — both services survive logout and reboot"
else
  warn "run this once, or nothing survives your logout:"
  say  "    sudo loginctl enable-linger $(id -un)"
fi

sleep 4
if systemctl --user is-active --quiet walk-tunnel; then
  ok "tunnel is up"
else
  warn "tunnel did not come up — bash deploy/linux/tunnel.sh --logs"
fi

TOKEN="$(grep '^WALK_TOKEN=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)"
cat <<EOF

  The studio now lives at a permanent address:

    https://$HOSTNAME_ARG/tour/tools/studio.html${TOKEN:+?key=$TOKEN}

  DNS can take a minute the first time. After that it survives reboots,
  disconnects and IP changes — the tunnel dials out, so nothing is open
  on this machine and nothing depends on your home address.

  One thing worth knowing: that key is now the only door. Anyone who
  learns it can edit every venue and run the pipeline on this box. If
  more than you ever needs in, put Cloudflare Access in front of the
  hostname — it is free at this size and takes about two minutes:

    Zero Trust → Access → Applications → Add → Self-hosted
    Domain: $HOSTNAME_ARG      Policy: emails you name

  Useful afterwards:

    bash deploy/linux/tunnel.sh --status
    bash deploy/linux/tunnel.sh --logs
    bash deploy/linux/tunnel.sh --url

EOF
