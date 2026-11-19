#!/usr/bin/env python3
"""Build bundled development-signed APK using installed SDK, no Gradle required."""
from pathlib import Path
import os, subprocess, shutil, zipfile
root=Path(__file__).resolve().parents[1]
sdk=Path(os.environ['ANDROID_HOME'])
java=Path(os.environ.get('JAVA_HOME','/usr/lib/jvm/java-17-openjdk-amd64'))/'bin'
tools=sdk/'build-tools/35.0.0'
jar=sdk/'platforms/android-35/android.jar'
out=root/'android/build'
out.mkdir(parents=True,exist_ok=True)
assets=out/'assets/web'
shutil.copytree(root/'dist',assets,dirs_exist_ok=True)
classes=out/'classes'; classes.mkdir(exist_ok=True)
def run(*args): subprocess.run([str(x) for x in args],check=True,cwd=root)
run(java/'javac','-source','8','-target','8','-classpath',jar,'-d',classes,*sorted((root/'android/src').rglob('*.java')))
run(tools/'aapt','package','-f','-M',root/'android/AndroidManifest.xml','-I',jar,'-A',out/'assets','-F',out/'unsigned.apk')
run(tools/'d8','--lib',jar,'--min-api','26','--output',out,*sorted(classes.rglob('*.class')))
with zipfile.ZipFile(out/'unsigned.apk','a',zipfile.ZIP_DEFLATED) as apk: apk.write(out/'classes.dex','classes.dex')
run(tools/'zipalign','-f','-p','4',out/'unsigned.apk',out/'aligned.apk')
# Stable development-only identity, never distributed in the source archive.
key=Path.home()/'.local/share/repertoire-forge/development.keystore'
key.parent.mkdir(parents=True,exist_ok=True);os.chmod(key.parent,0o700)
if not key.exists():
    run(java/'keytool','-genkeypair','-keystore',key,'-storepass','android','-keypass','android','-alias','androiddebugkey','-dname','CN=Repertoire Forge Development,O=Development,C=FR','-keyalg','RSA','-keysize','2048','-validity','10000')
    os.chmod(key,0o600)
target=root/'release/Repertoire-Forge-0.1.0-android-UNVERIFIED-RUNTIME.apk'
target.parent.mkdir(exist_ok=True)
run(tools/'apksigner','sign','--ks',key,'--ks-pass','pass:android','--ks-key-alias','androiddebugkey','--out',target,out/'aligned.apk')
run(tools/'apksigner','verify','--verbose','--print-certs',target)
with zipfile.ZipFile(target) as apk:
    assert apk.testzip() is None
    files=list((root/'dist').rglob('*'))
    for p in files:
        if p.is_file(): assert apk.read('assets/web/'+str(p.relative_to(root/'dist')))==p.read_bytes(),p
    print('Verified bundled assets:',sum(p.is_file() for p in files))
print(target)
