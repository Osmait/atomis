#!/usr/bin/env bash
# Installs the built AppImage into the user's session: the binary under
# ~/.local/bin, the icon in the hicolor theme (every size Tauri generated)
# and a desktop entry, so Atomis shows up in the launcher like any other
# app. No root, no package manager — undo with --uninstall.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_id="dev.osmait.atomis"
bin_dir="$HOME/.local/bin"
apps_dir="$HOME/.local/share/applications"
icons_dir="$HOME/.local/share/icons/hicolor"
target="$bin_dir/atomis"
entry="$apps_dir/$app_id.desktop"

if [[ "${1:-}" == "--uninstall" ]]; then
	rm -f "$target" "$entry"
	find "$icons_dir" -name "$app_id.png" -delete 2>/dev/null || true
	update-desktop-database "$apps_dir" 2>/dev/null || true
	gtk-update-icon-cache -f -t "$icons_dir" 2>/dev/null || true
	echo "Atomis uninstalled."
	exit 0
fi

appimage="$(ls -t "$root"/apps/desktop/src-tauri/target/release/bundle/appimage/*.AppImage 2>/dev/null | head -1 || true)"
if [[ -z "$appimage" ]]; then
	echo "No AppImage found. Build one first:" >&2
	echo "  pnpm desktop:build && pnpm --filter @atomis/desktop bundle:linux" >&2
	exit 1
fi

mkdir -p "$bin_dir" "$apps_dir"
install -m 755 "$appimage" "$target"

# Icons: hicolor is what launchers and window managers read.
for size in 32 128 256; do
	case "$size" in
		32) source_icon="$root/apps/desktop/src-tauri/icons/32x32.png" ;;
		128) source_icon="$root/apps/desktop/src-tauri/icons/128x128.png" ;;
		256) source_icon="$root/apps/desktop/src-tauri/icons/128x128@2x.png" ;;
	esac
	[[ -f "$source_icon" ]] || continue
	mkdir -p "$icons_dir/${size}x${size}/apps"
	install -m 644 "$source_icon" "$icons_dir/${size}x${size}/apps/$app_id.png"
done

cat > "$entry" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Atomis
GenericName=Code playground
Comment=Run Zig, Rust, Go, TypeScript, Python, C and C++ with inline values
Exec=$target
Icon=$app_id
Terminal=false
Categories=Development;IDE;
StartupWMClass=Atomis
DESKTOP

update-desktop-database "$apps_dir" 2>/dev/null || true
gtk-update-icon-cache -f -t "$icons_dir" 2>/dev/null || true

echo "Atomis installed:"
echo "  binary: $target"
echo "  entry:  $entry"
echo "Launch it from your launcher, or run: atomis"
