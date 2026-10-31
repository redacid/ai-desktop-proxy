#!/usr/bin/env python3
import json
import os
import tempfile

import settings_env as s

with tempfile.TemporaryDirectory() as d:
    path = os.path.join(d, "settings.json")
    original = {"model": "haiku", "env": {"KEEP": "1"}}
    with open(path, "w") as f:
        json.dump(original, f)

    s.main("add", path, "http://127.0.0.1:8877", "/ca.pem")
    added = json.load(open(path))
    assert added["env"]["HTTPS_PROXY"] == "http://127.0.0.1:8877"
    assert added["env"]["NODE_EXTRA_CA_CERTS"] == "/ca.pem"
    assert added["env"]["KEEP"] == "1" and added["model"] == "haiku"
    assert json.load(open(path + ".bak-claude-desktop-proxy")) == original

    s.main("add", path, "http://127.0.0.1:8877", "/ca.pem")  # idempotent
    assert json.load(open(path)) == added

    s.main("remove", path, "http://127.0.0.1:8877", "/ca.pem")
    assert json.load(open(path)) == {"model": "haiku", "env": {"KEEP": "1"}}

    # a user's own value is neither overwritten nor removed
    with open(path, "w") as f:
        json.dump({"env": {"NO_PROXY": "corp.example"}}, f)
    try:
        s.main("add", path, "http://127.0.0.1:8877", "/ca.pem")
        raise AssertionError("expected a conflict")
    except SystemExit:
        pass
    s.main("remove", path, "http://127.0.0.1:8877", "/ca.pem")
    assert json.load(open(path)) == {"env": {"NO_PROXY": "corp.example"}}

    # broken JSON is never overwritten
    with open(path, "w") as f:
        f.write("{broken")
    try:
        s.main("add", path, "http://127.0.0.1:8877", "/ca.pem")
        raise AssertionError("expected a JSON error")
    except json.JSONDecodeError:
        pass
    assert open(path).read() == "{broken"

print("ok")
