#!/usr/bin/env bash
# Runs Atomis as a systemd user service so it is up whenever the machine is,
# reachable from your own tailnet and from nowhere else. Two independent
# pieces, in this order:
#
#   1. the service — binds 127.0.0.1 only, needs no privileges;
#   2. `tailscale serve` — terminates the remote TLS and proxies to that
#      loopback port. Its config lives in tailscaled and survives reboots,
#      so this is a one-time step and the service never touches it.
#
# No root for step 1. Undo everything with --uninstall.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
port="${ATOMIS_PORT:-4317}"
unit="$HOME/.config/systemd/user/atomis.service"

if [[ "${1:-}" == "--uninstall" ]]; then
	systemctl --user disable --now atomis.service 2>/dev/null || true
	rm -f "$unit"
	systemctl --user daemon-reload
	# -n so an uninstall never blocks on a password prompt.
	tailscale serve --https=443 off 2>/dev/null || sudo -n tailscale serve --https=443 off 2>/dev/null || true
	echo "Atomis service removed. Linger left as it was: loginctl disable-linger $USER"
	exit 0
fi

binary="$root/apps/server-rs/target/release/atomis-server"
if [[ ! -x "$binary" ]]; then
	echo "No release binary at $binary — run 'pnpm build' first." >&2
	exit 1
fi
if [[ ! -d "$root/apps/web/dist" ]]; then
	echo "No web build at $root/apps/web/dist — run 'pnpm build' first." >&2
	exit 1
fi

# `|| true` so the friendly message below survives `set -euo pipefail`:
# without it a stopped tailscaled aborts the pipeline before the hint prints.
host="$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"
if [[ -z "$host" ]]; then
	echo "This machine has no MagicDNS name — is tailscale up?" >&2
	exit 1
fi
origin="https://$host"

# A systemd unit starts from an empty environment, and the login shell's PATH
# is no help: fnm points `node` at /run/user/<uid>/fnm_multishells/<pid>-<ts>,
# a directory that belongs to one shell and is gone after a reboot. So resolve
# each toolchain now and keep the directory that will still be there — the
# symlink target whenever the visible path is one of those ephemeral ones.
declare -a dirs=()
for tool in zig zls cargo rustc rust-analyzer go gopls node python3 uv clang clang++ clangd; do
	found="$(command -v "$tool" 2>/dev/null)" || continue
	case "$found" in
		/run/user/*) found="$(readlink -f "$found")" ;;
	esac
	dirs+=("$(dirname "$found")")
done
dirs+=(/usr/local/bin /usr/bin /bin)
path="$(printf '%s\n' "${dirs[@]}" | awk '!seen[$0]++' | paste -sd:)"

missing=""
for tool in zig zls cargo go node python3 clang; do
	command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done
[[ -n "$missing" ]] && echo "Note: not on PATH, those languages stay disabled:$missing"

# Optional second lock. Tailscale already limits who can reach the port to
# your own devices; this limits it to whoever holds the secret, which is the
# only thing that tells a browser apart from a curl on the same tailnet — the
# Origin of a request is the machine's own name, not a secret.
#   ATOMIS_TOKEN=$(openssl rand -hex 24) scripts/install-service.sh
token_line=""
if [[ -n "${ATOMIS_TOKEN:-}" ]]; then
	token_line="Environment=ATOMIS_TOKEN=$ATOMIS_TOKEN"
fi

mkdir -p "$(dirname "$unit")"
# The unit may carry ATOMIS_TOKEN in clear text, so it is born 0600 (rm +
# umask covers creation, chmod covers a pre-existing file) — user services
# default to 0644, which would hand the secret to every local account.
rm -f "$unit"
(
umask 077
cat > "$unit" <<UNIT
[Unit]
Description=Atomis — code playground, served to this machine's tailnet
Documentation=https://github.com/Osmait/atomis

[Service]
Type=simple
ExecStart=$binary
WorkingDirectory=$root
Restart=on-failure
RestartSec=3
# The Origin guard is the server's whole access control, so this variable is
# what lets the tailnet page in — see apps/server-rs/src/util.rs.
Environment=NODE_ENV=production
Environment=ATOMIS_PORT=$port
Environment=ATOMIS_ALLOWED_ORIGINS=$origin
Environment=ATOMIS_ROOT=$root
Environment=PATH=$path
$token_line

[Install]
WantedBy=default.target
UNIT
)
chmod 600 "$unit"

# Without linger a user service waits for a login session; with it, the
# manager starts at boot and so does Atomis.
loginctl enable-linger "$USER" 2>/dev/null || true
systemctl --user daemon-reload
systemctl --user enable --now atomis.service
echo "Service installed and started: 127.0.0.1:$port"

# Step 2. Serve config is stored by tailscaled and restored on boot, so this
# runs once and the service stays out of it.
if tailscale serve status 2>/dev/null | grep -q "127.0.0.1:$port"; then
	echo "tailscale serve already points at 127.0.0.1:$port"
elif tailscale serve --bg --https=443 "http://127.0.0.1:$port" 2>/dev/null; then
	echo "Serving $origin"
else
	echo
	echo "The service is up, but 'tailscale serve' still has to be pointed at it."
	echo "It fails for one of two reasons — check both, then run this script again:"
	echo
	echo "  1. HTTPS certificates are off for your tailnet. Turn them on at"
	echo "     https://login.tailscale.com/admin/dns — without them the page is"
	echo "     plain HTTP, which is not a secure context, and the editor's"
	echo "     copy/paste stops working."
	echo "  2. 'tailscale serve' needs root here. Grant it once with:"
	echo "     sudo tailscale set --operator=$USER"
	exit 1
fi

echo
if [[ -n "${ATOMIS_TOKEN:-}" ]]; then
	echo "Open this once on each device — the token is remembered and then"
	echo "drops out of the address bar:"
	echo "  $origin/?t=$ATOMIS_TOKEN"
else
	echo "Open $origin from any device on your tailnet."
fi
echo "Logs: journalctl --user -u atomis -f"
