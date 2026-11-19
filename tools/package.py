#!/usr/bin/env python3
"""Bundle ready web, source and APK together, excluding private/generated state."""
from pathlib import Path
import zipfile,hashlib,json
root=Path(__file__).resolve().parents[1]
release=root/'release';release.mkdir(exist_ok=True)
target=release/'Repertoire-Forge-0.1.0.zip'
exclude={'node_modules','dist','release','.git','build','browser-artifacts','__pycache__'}
manifest={}
with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    def put(p,name):
        data=p.read_bytes();z.writestr(name,data);manifest[name]=hashlib.sha256(data).hexdigest()
    for p in sorted(root.rglob('*')):
        rel=p.relative_to(root)
        if not p.is_file() or any(x in exclude for x in rel.parts) or p.suffix in {'.keystore','.jks','.pyc'} or p.name in {'local.properties'}:continue
        put(p,'source/'+str(rel))
    for p in sorted((root/'dist').rglob('*')):
        if p.is_file():put(p,'web/'+str(p.relative_to(root/'dist')))
    for p in sorted(release.glob('*.apk')):put(p,p.name)
    for name in ['README.md','SOURCES.md','LICENSE','VERIFICATION.md']:
        put(root/name,name)
    z.writestr('SHA256SUMS',''.join(h+'  '+n+'\n' for n,h in sorted(manifest.items())))
with zipfile.ZipFile(target) as z:
    assert z.testzip() is None
    for name,digest in manifest.items():assert hashlib.sha256(z.read(name)).hexdigest()==digest,name
receipt={'archive':target.name,'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'bytes':target.stat().st_size,'verifiedEntries':len(manifest)}
(release/'archive-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt,indent=2))
