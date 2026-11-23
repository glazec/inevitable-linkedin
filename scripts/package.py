from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parent.parent
target = root.parent / 'inevitable-linkedin.zip'
# Only reviewed release files may enter the archive.
extension_files = ['app.css', 'app.html', 'app.js', 'background.js', 'collector.js',
                   'core.js', 'crm.js', 'export.js', 'manifest.json']
files = [(root / 'extension' / name, name) for name in extension_files]
files += [(root / name, name) for name in
          ['scripts/enrich_connections.py', 'QUICKSTART.txt', 'README.md', 'SECURITY.md']]
for source, _ in files:
    if source.is_symlink() or not source.is_file():
        raise ValueError('Release input must be a regular file: ' + str(source))
with ZipFile(target, 'w', ZIP_DEFLATED) as archive:
    for source, name in files:
        archive.write(source, 'inevitable-linkedin/' + name)
print(target)
