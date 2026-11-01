"""Exercise the curl-pipe installer using fake commands, never real system packages/network."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'install.sh'


class InstallTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.home = self.root / 'home'
        self.home.mkdir()
        self.env = {**os.environ, 'HOME': str(self.home), 'PATH': str(self.bin), 'TEST_ROOT': str(self.root)}
        for command in ['bash', 'sh', 'python3', 'mktemp', 'rm', 'cat', 'mkdir', 'chmod', 'awk', 'sha256sum', 'cp']:
            (self.bin / command).symlink_to(shutil.which(command))
        self.mock('uname', 'if [[ $1 == -s ]]; then echo Linux; else echo x86_64; fi')
        self.mock('id', 'echo 1000')
        self.mock('sudo', 'printf "%s\\n" "$*" >> "$TEST_ROOT/calls"')
        self.mock('apt-get', ':')
        self.mock('systemctl', ':')
        self.mock('node', 'exit 0')
        for command in ['npm', 'npx', 'uv', 'uvx', 'mitmdump', 'headroom']:
            self.mock(command, ':')
        self.mock('dpkg-deb', 'if [[ $3 == Package ]]; then echo ai-desktop-proxy; else echo 0.2.0; fi')
        self.package = 'ai-desktop-proxy_0.2.0_amd64.deb'
        self.payload = b'fake package'
        self.release()
        self.mock('curl', '''url=''; out=''
while (($#)); do
  case "$1" in https://*) url=$1;; -o) shift; out=$1;; esac
  shift
done
case "$url" in
  */releases/latest) cat "$TEST_ROOT/release.json" > "$out";;
  */uv/install.sh) cat "$TEST_ROOT/uv-install.sh" > "$out";;
  */SHASUMS256.txt) cat "$TEST_ROOT/node-checksums" > "$out";;
  */SHA256SUMS) cat "$TEST_ROOT/checksums" > "$out";;
  *) cat "$TEST_ROOT/package" > "$out";;
esac''')

    def mock(self, name, body):
        path = self.bin / name
        path.write_text('#!' + shutil.which('bash') + '\nset -eu\n' + body + '\n')
        path.chmod(0o755)

    def release(self, rpm=False, checksums=True):
        self.package = 'ai-desktop-proxy-0.2.0.x86_64.rpm' if rpm else 'ai-desktop-proxy_0.2.0_amd64.deb'
        names = [self.package] + (['SHA256SUMS'] if checksums else [])
        data = {'tag_name': '0.2.0', 'draft': False, 'prerelease': False, 'assets': [
            {'name': name, 'browser_download_url': f'https://github.com/redacid/ai-desktop-proxy/releases/download/0.2.0/{name}'} for name in names]}
        (self.root / 'release.json').write_text(json.dumps(data))
        (self.root / 'package').write_bytes(self.payload)
        (self.root / 'checksums').write_text(hashlib.sha256(self.payload).hexdigest() + '  ' + self.package + '\n')

    def run_installer(self):
        # Pipe via stdin just like curl | bash, so no script filename can be assumed.
        return subprocess.run([str(self.bin / 'bash')], input=SCRIPT.read_text(), env=self.env, text=True, capture_output=True)

    def calls(self):
        path = self.root / 'calls'
        return path.read_text() if path.exists() else ''

    def test_deb_install_and_cleanup(self):
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('apt-get install -y', self.calls())
        self.assertIn(self.package, self.calls())
        package_line = self.calls().splitlines()[-1].split()[-1]
        self.assertFalse(Path(package_line).parent.exists())

    def test_rpm_uses_dnf(self):
        (self.bin / 'apt-get').unlink()
        self.mock('dnf', ':')
        self.mock('rpm', 'if [[ $3 == "%{NAME}" ]]; then echo ai-desktop-proxy; else echo 0.2.0; fi')
        self.release(rpm=True)
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('dnf install -y', self.calls())
        self.assertIn(self.package, self.calls())

    def test_older_release_with_github_asset_digest(self):
        self.release(checksums=False)
        path = self.root / 'release.json'
        release = json.loads(path.read_text())
        release['assets'][0]['digest'] = 'sha256:' + hashlib.sha256(self.payload).hexdigest()
        path.write_text(json.dumps(release))
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(self.package, self.calls())

    def test_bad_checksum_never_installs_package(self):
        (self.root / 'package').write_bytes(b'changed')
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('checksum', result.stderr)
        self.assertNotIn(self.package, self.calls())

    def test_missing_checksums_and_unsupported_arch(self):
        self.release(checksums=False)
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(self.package, self.calls())
        self.mock('uname', 'if [[ $1 == -s ]]; then echo Linux; else echo aarch64; fi')
        self.assertIn('x86_64', self.run_installer().stderr)

    def test_missing_uv_and_routing_tools_are_installed_as_desktop_user(self):
        for command in ['uv', 'uvx', 'mitmdump', 'headroom']:
            (self.bin / command).unlink()
        (self.root / 'uv-tool').write_text('#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$HOME/uv-calls"\n')
        (self.root / 'uv-install.sh').write_text(
            '#!/bin/sh\nset -eu\nmkdir -p "$UV_INSTALL_DIR"\n'
            'cp "$TEST_ROOT/uv-tool" "$UV_INSTALL_DIR/uv"\n'
            'cp "$TEST_ROOT/uv-tool" "$UV_INSTALL_DIR/uvx"\n'
            'chmod +x "$UV_INSTALL_DIR/uv" "$UV_INSTALL_DIR/uvx"\n')
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = (self.home / 'uv-calls').read_text()
        self.assertIn('tool install --python 3.13 mitmproxy', calls)
        self.assertIn('tool install --python 3.13 headroom-ai[all]', calls)
        self.assertNotIn('uv tool', self.calls())

    def test_node_bad_checksum_prevents_installation(self):
        self.mock('node', 'exit 1')
        (self.root / 'node-checksums').write_text('0' * 64 + '  node-v22.0.0-linux-x64.tar.xz\n')
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('/opt/ai-desktop-proxy-node', self.calls())
        self.assertNotIn(self.package, self.calls())

    def test_unexpected_asset_url_is_rejected(self):
        path = self.root / 'release.json'
        release = json.loads(path.read_text())
        release['assets'][0]['browser_download_url'] = 'https://example.invalid/package.deb'
        path.write_text(json.dumps(release))
        self.assertNotEqual(self.run_installer().returncode, 0)
        self.assertNotIn(self.package, self.calls())

    def test_existing_tools_are_kept(self):
        self.mock('uv', 'echo unexpected >&2; exit 8')
        self.assertEqual(self.run_installer().returncode, 0)


if __name__ == '__main__':
    unittest.main()
