import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]


class PackageTests(unittest.TestCase):
    def project(self, parent):
        root = Path(parent) / 'project'
        shutil.copytree(ROOT / 'extension', root / 'extension')
        shutil.copytree(ROOT / 'scripts', root / 'scripts', ignore=shutil.ignore_patterns('__pycache__'))
        for name in ('README.md', 'QUICKSTART.txt', 'SECURITY.md'):
            shutil.copyfile(ROOT / name, root / name)
        return root

    def test_unlisted_local_files_are_not_packaged(self):
        with tempfile.TemporaryDirectory() as temp:
            root = self.project(temp)
            (root / 'extension/local-credentials.txt').write_text('synthetic secret fixture')
            (root / 'extension/contacts.csv').write_text('synthetic private fixture')
            subprocess.run([sys.executable, str(root / 'scripts/package.py')], check=True, capture_output=True)
            with ZipFile(Path(temp) / 'inevitable-linkedin.zip') as z:
                self.assertIsNone(z.testzip())
                self.assertNotIn('inevitable-linkedin/local-credentials.txt', z.namelist())
                self.assertNotIn('inevitable-linkedin/contacts.csv', z.namelist())
                self.assertIn('inevitable-linkedin/manifest.json', z.namelist())

    def test_symlinked_release_input_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = self.project(temp)
            outside = Path(temp) / 'outside.txt'
            outside.write_text('synthetic private fixture')
            entry = root / 'extension/app.js'
            entry.unlink()
            entry.symlink_to(outside)
            result = subprocess.run([sys.executable, str(root / 'scripts/package.py')], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((Path(temp) / 'inevitable-linkedin.zip').exists())


if __name__ == '__main__':
    unittest.main()
