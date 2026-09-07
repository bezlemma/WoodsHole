"""Package only public runtime files; no dependencies required."""
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FILES = ['index.html', 'about.html', 'app.js', 'style.css', 'sw.js',
         'manifest.webmanifest', 'icon-192.png', 'icon-512.png']


def build():
    paths = [ROOT / name for name in FILES]
    for folder in ['data', 'vendor']:
        paths.extend(sorted(p for p in (ROOT / folder).rglob('*')
                            if p.is_file() and not any(part.startswith('.') for part in p.relative_to(ROOT).parts)))
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    manifest = {'repository': 'bezlemma/WoodsHole', 'commit': revision, 'files': {}}
    output = ROOT / 'dist' / 'woodshole-site.zip'
    output.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for path in paths:
            name = path.relative_to(ROOT).as_posix()
            body = path.read_bytes()
            manifest['files'][name] = hashlib.sha256(body).hexdigest()
            archive.writestr(name, body)
        archive.writestr('build.json', json.dumps(manifest, indent=2) + '\n')
    print(f'Built {len(paths)} files from {revision}: {output}')


if __name__ == '__main__':
    build()
