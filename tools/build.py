"""Package only public runtime files; no dependencies required."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FILES = ['index.html', 'about.html', 'app.js', 'style.css', 'sw.js',
         'manifest.webmanifest', 'icon-192.png', 'icon-512.png']


def build():
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    # Use committed bytes so Windows line endings and local-only files cannot
    # change the release or make its provenance/checksums inaccurate.
    snapshot = subprocess.check_output(['git', 'archive', '--format=zip', revision], cwd=ROOT)
    source = zipfile.ZipFile(io.BytesIO(snapshot))
    paths = FILES + sorted(name for name in source.namelist()
                          if name.startswith(('data/', 'vendor/')) and not name.endswith('/')
                          and not any(part.startswith('.') for part in name.split('/')))
    manifest = {'repository': 'bezlemma/WoodsHole', 'commit': revision, 'files': {}}
    output = ROOT / 'dist' / 'woodshole-site.zip'
    output.parent.mkdir(exist_ok=True)
    with source, zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name in paths:
            body = source.read(name)
            manifest['files'][name] = hashlib.sha256(body).hexdigest()
            archive.writestr(name, body)
        archive.writestr('build.json', json.dumps(manifest, indent=2) + '\n')
    print(f'Built {len(paths)} files from {revision}: {output}')


if __name__ == '__main__':
    build()
