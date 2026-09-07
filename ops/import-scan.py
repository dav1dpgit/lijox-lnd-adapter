#!/usr/bin/env python3
# lijox-adapter import scan — run against EVERY file imported from an
# operator box BEFORE it is committed. Exit 1 on any finding.
# Generic patterns only. Operator-specific identifiers (usernames,
# hostnames, domains) belong in a PRIVATE patterns file passed as
#   --extra-patterns FILE   (one regex per line, '#' comments) —
# never commit that file to this repository.
import re, sys, pathlib
PATTERNS = [
  (r'[0-9a-fA-F]{64,}',              'long hex (macaroon/key/secret?)'),
  (r'github_pat_[A-Za-z0-9_]+',      'GitHub PAT'),
  (r'gh[pousr]_[A-Za-z0-9]{20,}',    'GitHub token'),
  (r'-----BEGIN [A-Z ]*PRIVATE KEY', 'private key block'),
  (r'AKIA[0-9A-Z]{16}',              'AWS key'),
  (r'xox[baprs]-',                   'Slack token'),
  (r'\b100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.\d+\.\d+\b', 'Tailscale CGNAT IP'),
  (r'\b192\.168\.\d+\.\d+\b',        'LAN IP'),
  (r'\b10\.\d+\.\d+\.\d+\b',         'private-range IP'),
]
ALLOW_HEX_FILES = {
  'package-lock.json',              # npm integrity hashes
  'cooperative-chain-msg.test.js',  # synthetic wire fixtures + secp256k1 generator point — verified benign S35
}
args = sys.argv[1:]
if '--extra-patterns' in args:
    i = args.index('--extra-patterns'); pf = args[i+1]; del args[i:i+2]
    for ln in pathlib.Path(pf).read_text().splitlines():
        ln = ln.strip()
        if ln and not ln.startswith('#'): PATTERNS.append((ln, 'operator identifier'))
fail = 0
for arg in args:
    p = pathlib.Path(arg)
    try: text = p.read_text(errors='replace')
    except Exception as e: print(f'?? {p}: unreadable ({e})'); fail = 1; continue
    for rx, label in PATTERNS:
        if label.startswith('long hex') and p.name in ALLOW_HEX_FILES: continue
        for m in re.finditer(rx, text):
            line = text.count('\n', 0, m.start()) + 1
            print(f'!! {p}:{line}: {label} :: {m.group(0)[:24]}...')
            fail = 1
print('CLEAN' if not fail else 'FINDINGS ABOVE — do not commit')
sys.exit(fail)
