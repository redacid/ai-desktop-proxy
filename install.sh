#!/usr/bin/env bash
# Install the latest stable AI Desktop Proxy release and its runtime prerequisites.
# Run as your desktop user: curl -fsSL <official URL>/install.sh | bash
set -euo pipefail

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
log() { printf '\n%s\n' "$*"; }
fetch() { curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 600 --proto '=https' --proto-redir '=https' "$1" -o "$2"; }

main() {
  [[ $(uname -s) == Linux ]] || fail 'Only Linux is supported.'
  [[ $(uname -m) == x86_64 ]] || fail 'Release packages currently support x86_64/amd64 only.'
  [[ $(id -u) != 0 ]] || fail 'Run this script as your desktop user, without sudo. It requests sudo only for system installation.'
  command -v sudo >/dev/null || fail 'sudo is required for installing system packages.'
  command -v systemctl >/dev/null || fail 'A systemd-based Linux distribution is required.'

  local manager extension
  if command -v apt-get >/dev/null; then manager=apt; extension=deb
  elif command -v dnf >/dev/null; then manager=dnf; extension=rpm
  elif command -v zypper >/dev/null; then manager=zypper; extension=rpm
  else fail 'Supported package managers: apt-get (Debian/Ubuntu), dnf (Fedora/RHEL), zypper (openSUSE).'
  fi

  log 'Installing prerequisites (administrator authentication may be requested)…'
  sudo -v
  local curl_packages=()
  command -v curl >/dev/null || curl_packages=(curl)
  case "$manager" in
    apt)
      sudo apt-get update
      sudo apt-get install -y "${curl_packages[@]}" ca-certificates python3 git iproute2 xz-utils tar
      ;;
    dnf) sudo dnf install -y "${curl_packages[@]}" ca-certificates python3 git iproute xz tar ;;
    zypper) sudo zypper --non-interactive install "${curl_packages[@]}" ca-certificates python3 git iproute2 xz tar ;;
  esac

  install_work=$(mktemp -d)
  local work=$install_work
  # EXIT, not RETURN: clean up also when a download or command fails under set -e.
  trap 'rm -rf -- "${install_work:?}"' EXIT
  local repo='redacid/ai-desktop-proxy'
  log 'Finding the latest stable release…'
  fetch "https://api.github.com/repos/$repo/releases/latest" "$work/release.json"
  python3 - "$work/release.json" "$extension" > "$work/plan" <<'PY'
import json, re, sys
r = json.load(open(sys.argv[1]))
tag = r.get('tag_name', '')
if r.get('draft') or r.get('prerelease') or not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', tag):
    sys.exit('The latest release is not a stable MAJOR.MINOR.PATCH version.')
assets = r.get('assets', [])
pattern = r'ai-desktop-proxy_[A-Za-z0-9.+-]+_amd64\.deb' if sys.argv[2] == 'deb' else r'ai-desktop-proxy-[A-Za-z0-9.+_-]+\.x86_64\.rpm'
matches = [a for a in assets if re.fullmatch(pattern, a.get('name', ''))]
checksums = [a for a in assets if a.get('name') == 'SHA256SUMS']
if len(matches) != 1 or len(checksums) > 1:
    sys.exit('Release must contain exactly one matching package.')
digest = matches[0].get('digest') or ''
if not checksums and not re.fullmatch(r'sha256:[a-fA-F0-9]{64}', digest):
    sys.exit('Release has neither SHA256SUMS nor a SHA-256 asset digest.')
for asset in [matches[0], *checksums]:
    expected = f"https://github.com/redacid/ai-desktop-proxy/releases/download/{tag}/{asset['name']}"
    if asset.get('browser_download_url') != expected:
        sys.exit('Unexpected release asset URL.')
print(tag)
print(matches[0]['name'])
print(matches[0]['browser_download_url'])
print(checksums[0]['browser_download_url'] if checksums else '')
print(digest[7:] if digest.startswith('sha256:') else '')
PY
  local release
  mapfile -t release < "$work/plan"
  local version=${release[0]} package=${release[1]}
  log "Downloading AI Desktop Proxy $version…"
  fetch "${release[2]}" "$work/$package"
  if [[ -n ${release[3]} ]]; then
    fetch "${release[3]}" "$work/SHA256SUMS"
  else
    printf '%s  %s\n' "${release[4]}" "$package" > "$work/SHA256SUMS"
  fi
  python3 - "$work/$package" "$work/SHA256SUMS" <<'PY'
import hashlib, pathlib, re, sys
p = pathlib.Path(sys.argv[1])
entries = [m.groups() for line in pathlib.Path(sys.argv[2]).read_text().splitlines()
           if (m := re.fullmatch(r'([a-fA-F0-9]{64}) [ *](.+)', line))]
expected = [digest for digest, name in entries if name == p.name]
with p.open('rb') as f:
    digest = hashlib.sha256()
    for chunk in iter(lambda: f.read(1024 * 1024), b''):
        digest.update(chunk)
if len(expected) != 1 or digest.hexdigest() != expected[0].lower():
    sys.exit('Package checksum verification failed. Nothing will be installed.')
PY

  # Keep a working Node installation. Otherwise use the official Node 22 binary distribution.
  if ! command -v node >/dev/null || ! command -v npm >/dev/null || ! command -v npx >/dev/null ||
     ! node -e 'const [a,b,c]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&(b>18||(b===18&&c>=1)))?0:1)'; then
    log 'Installing Node.js 22 LTS and npm from nodejs.org…'
    fetch 'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt' "$work/node-checksums"
    local node_archive node_hash node_dir
    read -r node_hash node_archive < <(awk '$2 ~ /^node-v22\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$/ { print $1, $2 }' "$work/node-checksums")
    [[ $node_hash =~ ^[a-f0-9]{64}$ && $node_archive =~ ^node-v22\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$ ]] || fail 'Cannot find a Node.js 22 binary.'
    fetch "https://nodejs.org/dist/latest-v22.x/$node_archive" "$work/$node_archive"
    (cd "$work" && printf '%s  %s\n' "$node_hash" "$node_archive" | sha256sum --check --status)
    node_dir=${node_archive%.tar.xz}
    tar -xJf "$work/$node_archive" -C "$work" --no-same-owner
    local command target
    for command in node npm npx; do
      target="/usr/local/bin/$command"
      if [[ -e $target || -L $target ]]; then
        [[ -L $target && $(readlink "$target") == /opt/ai-desktop-proxy-node/* ]] || fail "Will not overwrite $target. Install Node.js 20.18+ with npm/npx yourself and retry."
      fi
    done
    sudo mkdir -p /opt/ai-desktop-proxy-node /usr/local/bin
    sudo cp -R "$work/$node_dir" /opt/ai-desktop-proxy-node/
    for command in node npm npx; do sudo ln -sfn "/opt/ai-desktop-proxy-node/$node_dir/bin/$command" "/usr/local/bin/$command"; done
    export PATH="/usr/local/bin:$PATH"
  fi

  # uv belongs to the desktop user; its official installer leaves shell profiles alone.
  export PATH="$HOME/.local/bin:$PATH"
  if ! command -v uv >/dev/null || ! command -v uvx >/dev/null; then
    log 'Installing uv and uvx from astral.sh…'
    fetch 'https://astral.sh/uv/install.sh' "$work/uv-install.sh"
    UV_INSTALL_DIR="$HOME/.local/bin" UV_NO_MODIFY_PATH=1 sh "$work/uv-install.sh"
  fi
  command -v uv >/dev/null && command -v uvx >/dev/null || fail 'uv installation did not provide uv and uvx.'

  # The proxy and compressor are required for routing; keep existing installations as they are.
  if ! command -v mitmdump >/dev/null; then
    log 'Installing mitmproxy (uv tool install --python 3.13 mitmproxy)…'
    uv tool install --python 3.13 mitmproxy
  fi
  if ! command -v headroom >/dev/null; then
    log 'Installing headroom (uv tool install --python 3.13 headroom-ai[all])…'
    uv tool install --python 3.13 'headroom-ai[all]'
  fi

  # Validate package identity before handing it to the package manager, which resolves GUI dependencies.
  if [[ $extension == deb ]]; then
    [[ $(dpkg-deb -f "$work/$package" Package) == ai-desktop-proxy ]] || fail 'Unexpected deb package name.'
    [[ $(dpkg-deb -f "$work/$package" Version) == "$version" ]] || fail 'Unexpected deb version.'
  else
    [[ $(rpm -qp --queryformat '%{NAME}' "$work/$package") == ai-desktop-proxy ]] || fail 'Unexpected rpm package name.'
    [[ $(rpm -qp --queryformat '%{VERSION}' "$work/$package") == "$version" ]] || fail 'Unexpected rpm version.'
  fi
  log "Installing AI Desktop Proxy $version and its system dependencies…"
  case "$manager" in
    apt) sudo apt-get install -y "$work/$package" ;;
    dnf) sudo dnf install -y "$work/$package" ;;
    zypper) sudo zypper --non-interactive install "$work/$package" ;;
  esac
  log 'Installed. Open AI Desktop Proxy from your applications menu.'
  printf 'Use the app to set up the proxy/headroom services and connect clients or optional tools. Restart an already running copy.\n'
}

main "$@"
