"""Rebuild the checked-in single-file WASM from verified upstream sources."""
import argparse
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import urllib.request

COMMIT = 'e035c75be1916ed8c0d1a38e823981366da3971e'
SOURCES = {
    'bindings/javascript/emscripten.cpp': '3b366a7b728b28c3a1e8925b27795c445f2b274118a656a470140fd1a1dc4e4a',
    'include/ggwave/ggwave.h': 'eda81563b86b24098da6c061329cde80f32b3a5c2a710e1fbd19d2d603c03322',
    'src/fft.h': '1ec89c52f15a9bb25badbb6dde4612d5aedb445d946a7f571c4363523903de55',
    'src/ggwave.cpp': 'cac241ee2403c2373aad6fbdf12e8fc9f583b77de44fa1ee5fb30f8eb8412ea5',
    'src/reed-solomon/gf.hpp': 'ce0a12e1cfb0ed31bdf4580668e7629cad043b2f252e0404750c21cb7ec477e0',
    'src/reed-solomon/poly.hpp': '9c8fa3b3099144009002a8543a11d756e26d633ac005f1e07ce0e5eff900f020',
    'src/reed-solomon/rs.hpp': 'b1e42030ed26981c2074152a839d2fa3006af97925f687052e8497e02497c2b7',
}

def apply_receiver_patch(original, patch):
    """Apply the checked-in unified diff only when every context line matches."""
    source = original.splitlines(keepends=True)
    lines = patch.splitlines(keepends=True)
    result = []
    position = 0
    index = 0
    while index < len(lines):
        match = re.match(r'@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@', lines[index])
        if not match:
            index += 1
            continue
        start = int(match.group(1)) - 1
        result.extend(source[position:start])
        position = start
        index += 1
        while index < len(lines) and not lines[index].startswith('@@'):
            line = lines[index]
            if line.startswith((' ', '-')):
                if source[position] != line[1:]:
                    raise RuntimeError(f'Receiver patch context mismatch at line {position + 1}')
                position += 1
            if line.startswith((' ', '+')):
                result.append(line[1:])
            index += 1
    result.extend(source[position:])
    return ''.join(result)

def main():
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--emscripten-root', type=Path, required=True,
                        help='Emscripten 3.1.6 directory containing em++.py')
    parser.add_argument('--work-dir', type=Path, required=True,
                        help='Directory for downloaded sources, cache and temporary files')
    parser.add_argument('--node', default=shutil.which('node'), help='Existing Node.js executable')
    args = parser.parse_args()
    if not args.node:
        parser.error('Node.js is required; provide --node')
    vendor = Path(__file__).resolve().parent
    work = args.work_dir.resolve()
    work.mkdir(parents=True, exist_ok=True)
    emscripten = args.emscripten_root.resolve()
    sdk = emscripten.parent
    source = work / 'source'
    for relative, expected in SOURCES.items():
        destination = source / relative
        if not destination.exists():
            destination.parent.mkdir(parents=True, exist_ok=True)
            url = f'https://raw.githubusercontent.com/ggerganov/ggwave/{COMMIT}/{relative}'
            with urllib.request.urlopen(url, timeout=60) as response:
                destination.write_bytes(response.read())
        actual = hashlib.sha256(destination.read_bytes()).hexdigest()
        if actual != expected:
            raise RuntimeError(f'Source SHA-256 mismatch: {relative}: {actual}')
    config = work / 'emscripten-config.py'
    config.write_text('\n'.join([
        f'LLVM_ROOT = {str(sdk / "bin")!r}',
        f'BINARYEN_ROOT = {str(sdk)!r}',
        f'NODE_JS = [{str(Path(args.node).resolve())!r}]',
        f'EMSCRIPTEN_ROOT = {str(emscripten)!r}',
    ]), encoding='utf-8')
    env = dict(os.environ, EM_CONFIG=str(config), EM_CACHE=str(work / 'em-cache'),
               TEMP=str(work), TMP=str(work))
    compiler = [sys.executable, str(emscripten / 'em++.py')]
    version = subprocess.check_output(compiler + ['--version'], env=env, text=True)
    if '3.1.6 ' not in version:
        raise RuntimeError(f'This artifact is pinned to Emscripten 3.1.6: {version}')
    output = work / 'ggwave-balanced.js'
    patched_core = work / 'ggwave-receiver.cpp'
    patched_core.write_text(apply_receiver_patch(
        (source / 'src/ggwave.cpp').read_text(encoding='utf-8'),
        (vendor / 'receiver-candidates.patch').read_text(encoding='utf-8'),
    ), encoding='utf-8')
    command = compiler + [
        str(patched_core), str(source / 'bindings/javascript/emscripten.cpp'),
        str(vendor / 'balanced.cpp'), '-I' + str(source / 'include'), '-I' + str(source / 'src'),
        '-std=c++11', '-O3', '--bind', '-s', 'MODULARIZE=1',
        '-s', 'ALLOW_MEMORY_GROWTH=1', '-s', 'SINGLE_FILE=1',
        '-s', 'EXPORT_NAME=ggwave_factory', '-o', str(output),
    ]
    subprocess.run(command, env=env, check=True)
    header = b'/*! ggwave 0.4.0 + SonaWeave 5/4-frame protocols. MIT; see LICENSE and README.md. */\n'
    artifact = vendor / 'ggwave.cjs'
    artifact.write_bytes(header + output.read_bytes())
    print(f'{artifact}\nSHA-256: {hashlib.sha256(artifact.read_bytes()).hexdigest()}')

if __name__ == '__main__':
    main()
