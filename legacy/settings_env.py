#!/usr/bin/env python3
"""Add or remove the proxy variables in a Claude Code settings.json `env` block.

usage: settings_env.py add|remove SETTINGS_FILE PROXY_URL CA_FILE
"""
import json
import os
import shutil
import sys


def proxy_env(proxy_url, ca_file):
    # NO_PROXY keeps the console claude (base URL = local headroom) off the proxy.
    return {
        "HTTPS_PROXY": proxy_url,
        "NODE_EXTRA_CA_CERTS": ca_file,
        "NO_PROXY": "127.0.0.1,localhost",
    }


def apply(settings, action, wanted):
    env = settings.setdefault("env", {})
    if action == "add":
        conflicts = [k for k, v in wanted.items() if k in env and env[k] != v]
        if conflicts:
            sys.exit(f"settings env already sets {', '.join(conflicts)} to other values; merge by hand")
        env.update(wanted)
    else:
        # Only drop values we set, so a user's own NO_PROXY etc. survives.
        for key, value in wanted.items():
            if env.get(key) == value:
                del env[key]
    return settings


def main(action, path, proxy_url, ca_file):
    if action not in ("add", "remove"):
        sys.exit(f"unknown action: {action}")
    settings = {}
    if os.path.exists(path):
        with open(path) as f:
            settings = json.load(f)  # a broken file aborts here, before any write
        backup = path + ".bak-claude-desktop-proxy"
        if not os.path.exists(backup):
            shutil.copy2(path, backup)
    apply(settings, action, proxy_env(proxy_url, ca_file))
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(settings, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)


if __name__ == "__main__":
    if len(sys.argv) != 5:
        sys.exit(__doc__)
    main(*sys.argv[1:])
