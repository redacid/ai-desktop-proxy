import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('version.py').resolve()


class VersionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = {**os.environ, 'HOME': self.temp.name, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull}
        self.env.pop('VERSION', None)
        self.env.pop('BUMP', None)
        self.git('init', '-q')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('config', 'user.name', 'Test')
        self.write('0.1.0')
        self.commit('Initial')
        self.git('tag', '0.1.0')
        (self.root / 'feature').write_text('new')
        self.commit('Add feature')

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.root, env=self.env, text=True).strip()

    def commit(self, message):
        self.git('add', '.')
        self.git('commit', '-qm', message)

    def write(self, version):
        (self.root / 'package.json').write_text(json.dumps({'name': 'test', 'version': version}))
        (self.root / 'package-lock.json').write_text(json.dumps({'version': version, 'packages': {'': {'version': version}, 'node_modules/example': {'version': '8.0.0'}}}))

    def run_script(self, mode, **env):
        return subprocess.run([sys.executable, str(SCRIPT), mode], cwd=self.root, env={**self.env, **env}, text=True, capture_output=True)

    def test_patch_bumps_all_app_versions_only(self):
        self.assertEqual(self.run_script('bump').returncode, 0)
        lock = json.loads((self.root / 'package-lock.json').read_text())
        self.assertEqual(json.loads((self.root / 'package.json').read_text())['version'], '0.1.1')
        self.assertEqual(lock['version'], '0.1.1')
        self.assertEqual(lock['packages']['']['version'], '0.1.1')
        self.assertEqual(lock['packages']['node_modules/example']['version'], '8.0.0')

    def test_version_and_release_use_same_notes(self):
        self.assertEqual(self.run_script('version', VERSION='0.2.0').returncode, 0)
        changelog = (self.root / 'CHANGELOG.md').read_text()
        self.assertIn('Changes since 0.1.0.', changelog)
        self.assertIn('- Add feature (', changelog)
        self.assertNotIn('- Initial (', changelog)
        self.commit('Prepare release')
        notes = self.run_script('notes', VERSION='0.2.0')
        self.assertIn('- Add feature (', notes.stdout)
        self.assertNotIn('Prepare release', notes.stdout)

    def test_minor_major_and_invalid_versions(self):
        self.assertEqual(self.run_script('bump', BUMP='minor').returncode, 0)
        self.assertEqual(json.loads((self.root / 'package.json').read_text())['version'], '0.2.0')
        self.assertEqual(self.run_script('bump', BUMP='major').returncode, 0)
        self.assertEqual(json.loads((self.root / 'package.json').read_text())['version'], '1.0.0')
        before = (self.root / 'package.json').read_text()
        for value in ['v2.0.0', '2.0.0-beta', '0.1.0', '01.2.3']:
            self.assertNotEqual(self.run_script('version', VERSION=value).returncode, 0)
            self.assertEqual((self.root / 'package.json').read_text(), before)

    def test_first_release_fallback_and_ignore_unreachable_tags(self):
        self.git('tag', '-d', '0.1.0')
        result = self.run_script('notes', VERSION='0.1.0')
        self.assertEqual(result.returncode, 0)
        self.assertIn('Initial release.', result.stdout)
        self.assertIn('- Initial (', result.stdout)

    def test_preserves_old_changelog_entries(self):
        (self.root / 'CHANGELOG.md').write_text('# Changelog\n\n## 0.1.0 — 2026-01-01\n\nOld release.\n')
        self.assertEqual(self.run_script('version').returncode, 0)
        text = (self.root / 'CHANGELOG.md').read_text()
        self.assertLess(text.index('## 0.1.1'), text.index('## 0.1.0'))
        self.assertIn('Old release.', text)


if __name__ == '__main__':
    unittest.main()
