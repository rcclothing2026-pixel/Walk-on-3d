#!/usr/bin/env bash
# =============================================================================
# Puts the tour studio on a Linux box and keeps it running.
#
# The studio is the engine: Node, sharp, the image pipeline, and every editor.
# It belongs on a machine with real cores and real disk, not on a laptop that
# closes. This sets it up as a user service so it starts at boot, restarts if it
# dies, and needs no root at any point.
#
# It binds to 127.0.0.1 only. Reaching it from outside is the tunnel's job, and
# a tunnel you can point at a loopback port is a tunnel that cannot be bypassed
# by anyone who finds the machine's real address.
#
#   bash deploy/linux/install.sh              set up, or update in place
#   bash deploy/linux/install.sh --status     what is it doing right now
#   bash deploy/linux/install.sh --token      print the key for this studio
#
# Safe to run twice. It never overwrites a token that already exists.
# =============================================================================
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/walk-on-3d"
ENV_FILE="$CONF_DIR/env"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/walk-studio.service"
PORT="${WALK_PORT:-5173}"

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; D='\033[2m'; N='\033[0m'
say()  { printf "  %s\n" "$1"; }
ok()   { printf "  ${G}✓${N} %s\n" "$1"; }
warn() { printf "  ${Y}!${N} %s\n" "$1"; }
die()  { printf "\n  ${R}✗${N} %s\n\n" "$1"; exit 1; }

# ── what the caller asked for ────────────────────────────────────────────────
case "${1:-install}" in
  --status)
    systemctl --user status walk-studio --no-pager 2>/dev/null || say "not installed as a service yet"
    exit 0 ;;
  --token)
    [[ -f "$ENV_FILE" ]] || die "no studio configured yet — run without arguments first"
    grep '^WALK_TOKEN=' "$ENV_FILE" | cut -d= -f2-
    exit 0 ;;
  --logs)
    journalctl --user -u walk-studio -n 60 --no-pager 2>/dev/null || say "no logs yet"
    exit 0 ;;
esac

printf "\n  ${D}Tour studio — %s${N}\n\n" "$REPO"

# ── the machine has to be able to do the job ─────────────────────────────────
command -v node >/dev/null 2>&1 || die "node is not installed. The studio is Node; there is nothing to run without it."
NODE_MAJOR="$(node -v | tr -d 'v' | cut -d. -f1)"
[[ "$NODE_MAJOR" -ge 20 ]] || die "node $NODE_MAJOR is too old — sharp needs 20 or newer."
ok "node $(node -v)"

command -v npm >/dev/null 2>&1 || die "npm is missing."
ok "npm $(npm -v)"

if command -v pdftoppm >/dev/null 2>&1; then
  ok "pdftoppm — architects' PDFs can be cropped to floor plans"
else
  warn "pdftoppm missing — PDF floor plans will not convert (sudo apt install poppler-utils)"
fi

# ── dependencies ─────────────────────────────────────────────────────────────
cd "$REPO"
if [[ -d node_modules ]] && [[ package-lock.json -ot node_modules ]]; then
  ok "dependencies already installed"
else
  say "installing dependencies…"
  npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null 2>&1
  ok "dependencies installed"
fi

# sharp is the one dependency that can fail for a reason apt cannot fix: its
# prebuilt libvips is compiled for x86-64-v2, and a pre-2010 CPU does not
# implement those instructions. That stops image processing; it does not stop
# the studio, so it is reported rather than fatal.
if node -e "require('sharp')" >/dev/null 2>&1; then
  ok "sharp loads — the image pipeline will run here"
else
  warn "sharp will not load on this CPU."
  say  "  Placing, linking and anchoring all work without it. Only building"
  say  "  renditions from raw photographs needs it."
  say  ""
  say  "  This machine reports:"
  say  "    $(lscpu 2>/dev/null | grep -m1 '^Model name' | sed 's/Model name: *//')"
  say  ""
  say  "  The portable build costs about 3× the time and no compiling:"
  say  "    npm install --cpu=wasm32 sharp"
  say  ""
fi

# ── the key ──────────────────────────────────────────────────────────────────
mkdir -p "$CONF_DIR"
chmod 700 "$CONF_DIR"

if [[ -f "$ENV_FILE" ]] && grep -q '^WALK_TOKEN=' "$ENV_FILE"; then
  ok "keeping the existing studio key"
else
  TOKEN="$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))')"
  cat > "$ENV_FILE" <<EOF
# The studio's key. Anyone with this can edit every venue and run the image
# pipeline on this machine, so treat it like a password.
WALK_TOKEN=$TOKEN

# Where the source photographs live. Absolute paths are fine.
# WALK_PHOTOS=/home/$(id -un)/photos
EOF
  chmod 600 "$ENV_FILE"
  ok "generated a studio key — $ENV_FILE"
fi

# ── the service ──────────────────────────────────────────────────────────────
if [[ ! -d /run/systemd/system ]]; then
  warn "no systemd here — start it by hand instead:"
  say  "    cd $REPO && set -a && . $ENV_FILE && set +a && npx vite --port $PORT"
  exit 0
fi

mkdir -p "$UNIT_DIR"
cat > "$UNIT" <<EOF
[Unit]
Description=Walk on 3D — tour studio
Documentation=https://github.com/rcclothing2026-pixel/Walk-on-3d
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO
EnvironmentFile=$ENV_FILE
# Loopback only. Anything reaching this from outside comes through the tunnel,
# which is the one place access can be controlled.
ExecStart=$(command -v npx) vite --host 127.0.0.1 --port $PORT --strictPort
Restart=on-failure
RestartSec=5
# The pipeline decodes 8192×4096 frames; this is generous but not unbounded.
MemoryMax=4G

[Install]
WantedBy=default.target
EOF
ok "service written — $UNIT"

systemctl --user daemon-reload
systemctl --user enable --now walk-studio >/dev/null 2>&1 || true

# Without lingering the service dies when the last session closes, which is
# exactly what happens when you disconnect the SSH you installed it over.
if loginctl show-user "$(id -un)" 2>/dev/null | grep -q 'Linger=yes'; then
  ok "lingering is on — it survives logout"
else
  warn "run this once so it survives logout:  sudo loginctl enable-linger $(id -un)"
fi

sleep 2
if systemctl --user is-active --quiet walk-studio; then
  ok "studio is running on 127.0.0.1:$PORT"
else
  warn "service did not come up — bash deploy/linux/install.sh --logs"
fi

node -e "require('sharp')" >/dev/null 2>&1 || warn "image processing is off until sharp loads (see above)"

TOKEN="$(grep '^WALK_TOKEN=' "$ENV_FILE" | cut -d= -f2-)"
cat <<EOF

  Open it once with the key, and this browser stays signed in:

    http://127.0.0.1:$PORT/tour/tools/studio.html?key=$TOKEN

  From another machine, tunnel to it rather than opening the port:

    cloudflared tunnel --url http://127.0.0.1:$PORT

  Useful afterwards:

    bash deploy/linux/install.sh --status
    bash deploy/linux/install.sh --logs
    bash deploy/linux/install.sh --token

EOF
