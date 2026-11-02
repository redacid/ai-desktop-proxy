# Install and update

## Requirements

- Linux x86_64 desktop with systemd. ARM packages are not built yet.
- apt-get (Debian, Ubuntu), dnf (Fedora, RHEL) or zypper (openSUSE).
- Internet access, sudo rights and `curl`. If curl is missing, install it with your package manager first.
- On GNOME, the AppIndicator extension, so the tray icon is visible.

## Installing

Run this as your normal desktop user (not root, and do not pipe it into `sudo bash`):

```bash
curl -fsSL https://raw.githubusercontent.com/redacid/ai-desktop-proxy/main/install.sh | bash
```

To read the script before running it:

```bash
curl -fsSL https://raw.githubusercontent.com/redacid/ai-desktop-proxy/main/install.sh -o install.sh
less install.sh
bash install.sh
```

The installer:

- installs system prerequisites (CA certificates, Python 3, Git, iproute and archive tools);
- downloads the latest stable release package (deb or rpm) and checks its SHA-256 checksum. A missing checksum or
  a mismatch stops the installation. Packages are not code-signed;
- keeps an existing Node.js 20.18.1+ with npm/npx, otherwise installs the official Node.js 22 into
  `/opt/ai-desktop-proxy-node/` with links in `/usr/local/bin`. It never overwrites unrelated files there;
- installs uv/uvx into `~/.local/bin` if missing, without changing your shell profile;
- installs mitmproxy and headroom (`headroom-ai[all]`) with uv if missing. headroom and its models are a large
  download;
- installs the app with your package manager, which pulls in its desktop dependencies.

Installing does not start any service and does not change Claude Code or Codex settings. Your existing settings,
indexes and tools are kept.

You can also download the `.deb` or `.rpm` yourself from
[GitHub Releases](https://github.com/redacid/ai-desktop-proxy/releases) and install it with your package manager.
The installer is still the easiest way to get mitmproxy, headroom and uv.

## First run

1. Open **AI Desktop Proxy** from the applications menu. If an older copy is running, quit it from the tray first.
2. On **Overview**, use **Set up & start** on the Proxy and Compressor cards.
3. Turn on **Claude Code** or **Codex** in the Clients card, then start a new client session.
4. Open **Savings** to see what headroom compresses, and **Tools** to add optional tools.

The [interface tour](interface.md) explains every tab.

## App updates

Installed packages check GitHub Releases for a new stable version when the app starts, then every **2 hours**.
Restarting the app does not reset that timer.

**Settings → App updates** shows the current version, the last check and two switches: check automatically and
download automatically (both on by default). **Check for updates** and **Download update** do the same by hand.
When an update is ready, a notice shows the new version and its release notes; **Later** hides it until the next
start.

Nothing is installed until you press **Update and restart**. Quitting the app does not install a downloaded update.
The app refuses to update while a service or tool action is running; retry when it finishes. Your system may ask for
your password to install the package. The proxy and headroom services keep running while the app restarts.

## Uninstalling

1. Turn off Claude Code and Codex on the Clients card. This removes exactly the settings the app wrote.
2. **Remove** the Proxy and the Compressor services on their cards.
3. Optionally, on the **Tools** tab, use **Remove from system** for the tools you no longer need.
4. Uninstall the package: `sudo apt remove ai-desktop-proxy`, `sudo dnf remove ai-desktop-proxy` or
   `sudo zypper remove ai-desktop-proxy`.
5. Optionally remove mitmproxy and headroom: `uv tool uninstall mitmproxy` and `uv tool uninstall headroom-ai`.

Settings stay in `~/.config/ai-desktop-proxy/`; delete that directory to remove them too.
