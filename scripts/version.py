#!/usr/bin/env python3
"""Keep npm versions together and prepare a changelog/release body from Git."""
import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import sys

VERSION_RE = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z')


def semver(value):
    if not VERSION_RE.fullmatch(value):
        raise ValueError(f'Expected MAJOR.MINOR.PATCH, got {value!r}')
    return tuple(map(int, value.split('.')))


def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()


def previous_tag(version):
    target = semver(version)
    tags = git('tag', '--merged', 'HEAD').splitlines()
    candidates = [tag for tag in tags if VERSION_RE.fullmatch(tag) and semver(tag) < target]
    return max(candidates, key=semver) if candidates else None


def changes(version):
    previous = previous_tag(version)
    commits = git('log', '--format=- %s (%h)', f'{previous}..HEAD' if previous else 'HEAD')
    return (f'Changes since {previous}.' if previous else 'Initial release.') + '\n\n' + (commits or '- No new commits.') + '\n'


def notes(version, changelog):
    semver(version)
    match = re.search(r'^## ' + re.escape(version) + r'(?: — [^\n]+)?\n(.*?)(?=^## |\Z)', changelog, re.M | re.S)
    return match.group(1).strip() + '\n' if match else changes(version)


def run(mode):
    package_file, lock_file, changelog_file = map(Path, ['package.json', 'package-lock.json', 'CHANGELOG.md'])
    package = json.loads(package_file.read_text())
    current = package['version']
    semver(current)
    requested = os.environ.get('VERSION', '')
    changelog = changelog_file.read_text() if changelog_file.exists() else '# Changelog\n'
    if mode == 'notes':
        print(notes(requested or current, changelog), end='')
        return
    if mode not in ('bump', 'version'):
        raise ValueError('Usage: version.py bump|version|notes')
    major, minor, patch = semver(current)
    if requested:
        target = requested
    else:
        part = os.environ.get('BUMP', 'patch')
        if part not in ('major', 'minor', 'patch'):
            raise ValueError('BUMP must be major, minor or patch')
        target = {'major': f'{major + 1}.0.0', 'minor': f'{major}.{minor + 1}.0', 'patch': f'{major}.{minor}.{patch + 1}'}[part]
    if semver(target) <= semver(current):
        raise ValueError(f'New version {target} must be greater than {current}')
    lock = json.loads(lock_file.read_text())
    if lock['version'] != current or lock['packages']['']['version'] != current:
        raise ValueError('package.json and package-lock.json versions disagree')
    # Finish validation and Git reads before changing any file.
    if mode == 'version':
        if re.search(r'^## ' + re.escape(target) + r'(?: — |\n)', changelog, re.M):
            raise ValueError(f'CHANGELOG.md already contains {target}')
        body = changes(target)
        day = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
        entry = f'## {target} — {day}\n\n{body}\n'
        first = re.search(r'^## ', changelog, re.M)
        at = first.start() if first else len(changelog)
        changelog = changelog[:at].rstrip() + '\n\n' + entry + changelog[at:]
    package['version'] = lock['version'] = lock['packages']['']['version'] = target
    for path, data in ((package_file, package), (lock_file, lock)):
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')
    if mode == 'version':
        changelog_file.write_text(changelog)
    print(f'{current} → {target}')


if __name__ == '__main__':
    try:
        run(sys.argv[1] if len(sys.argv) == 2 else '')
    except (ValueError, KeyError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
