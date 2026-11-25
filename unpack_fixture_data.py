#!/usr/bin/env python3
"""Unpack synthetic test fixtures on an offline dev machine. Safe extraction."""
from pathlib import Path
from zipfile import ZipFile
import sys
root = Path(__file__).resolve().parents[1]
archive = root / 'tests' / 'fixture-data.zip'
with ZipFile(archive) as z:
    for info in z.infolist():
        dest = (root / info.filename).resolve()
        if not dest.is_relative_to(root) or info.is_dir() or not info.filename.startswith(('tests/fixtures/', 'tests/e2e/fixtures/')):
            raise SystemExit('Refusing unsafe fixture path: ' + info.filename)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(z.read(info))
print('Restored', len(z.namelist()), 'synthetic fixture files for LOCAL testing only')
