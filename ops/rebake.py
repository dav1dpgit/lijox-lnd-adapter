#!/usr/bin/env python3
# rebake.py — bake the adapter's key again from a permission file and put it in the adapter's .env.
#   python3 rebake.py <permission file> <the adapter's .env> [the lncli command, in quotes]
# e.g. python3 rebake.py bake-permissions.json ~/lijox-adapter-live/.env
#      python3 rebake.py bake-permissions-nodelegate.json ~/lij-adapter/.env "docker exec lightning_lnd_1 lncli"
# What it does, in order, stopping at the first thing that is not right:
#   1. reads the permission file (LND's own form: root_key_id + a list of uri permissions);
#   2. asks LND to bake a key with exactly those permissions (lncli bakemacaroon, the file's root key id) — LND
#      refuses a permission name it does not know, and nothing is changed then;
#   3. tries the new key on one of the block reads (chain getbestblock) — a "permission denied" stops here;
#   4. copies .env to .env.bak-rebake-<date>-<time> (never over an existing copy);
#   5. replaces the ONE line LIJ_ADAPTER_MACAROON_HEX=… and nothing else.
# It prints counts and lengths, never the key. The old key keeps working (same root key id) until that id is deleted.
import json, os, re, shlex, subprocess, sys, tempfile, time

def die(m): print('STOPPED: ' + m); sys.exit(1)
if len(sys.argv) < 3: die('usage: rebake.py <permission file> <.env> ["lncli command"]')
perm_file, env_file = os.path.expanduser(sys.argv[1]), os.path.expanduser(sys.argv[2])
lncli = shlex.split(sys.argv[3]) if len(sys.argv) > 3 else ['lncli']
try: d = json.load(open(perm_file))
except Exception as e: die('cannot read the permission file: %s' % e)
uris = [p.get('action', '') for p in d.get('permissions', []) if p.get('entity') == 'uri']
if len(uris) != len(d.get('permissions', [])) or not uris or not all(re.fullmatch(r'/[A-Za-z0-9_.]+/[A-Za-z0-9]+', u) for u in uris):
    die('the permission file is not a list of uri permissions')
root = str(d.get('root_key_id', ''))
if not re.fullmatch(r'[0-9]{1,18}', root): die('the permission file has no root_key_id')
try: env = open(env_file).read()
except Exception as e: die('cannot read %s: %s' % (env_file, e))
lines = re.findall(r'(?m)^LIJ_ADAPTER_MACAROON_HEX=(.*)$', env)
if len(lines) != 1: die('%s has %d LIJ_ADAPTER_MACAROON_HEX lines (want exactly 1)' % (env_file, len(lines)))
old = lines[0].strip()

r = subprocess.run(lncli + ['bakemacaroon', '--root_key_id', root] + ['uri:' + u for u in uris], capture_output=True, text=True)
if r.returncode != 0: die('LND did not bake the key: ' + (r.stderr or r.stdout).strip()[:300])
new = r.stdout.strip()
if not re.fullmatch(r'[0-9a-f]{200,}', new) or len(new) % 2: die('the bake did not answer with a key in hex')
print('baked: %d permissions, root key id %s, %d bytes (the key in use is %d bytes)' % (len(uris), root, len(new) // 2, len(old) // 2))

# 3. try it — never fatal unless LND itself says the key may not do it
note = 'not tried'
try:
    raw = bytes.fromhex(new)
    if lncli[0] == 'docker' and 'exec' in lncli:
        i = lncli.index('exec'); box = lncli[i + 1]; inner = ' '.join(shlex.quote(x) for x in lncli[i + 2:])
        t = subprocess.run(['docker', 'exec', '-i', box, 'sh', '-c', 'umask 077; f=$(mktemp); cat > "$f"; ' + inner + ' --macaroonpath "$f" chain getbestblock; s=$?; rm -f "$f"; exit $s'], input=raw, capture_output=True)
        out = (t.stdout + t.stderr).decode('utf-8', 'replace'); rc = t.returncode
    else:
        fd, fn = tempfile.mkstemp(); os.write(fd, raw); os.close(fd)
        try: t = subprocess.run(lncli + ['--macaroonpath', fn, 'chain', 'getbestblock'], capture_output=True, text=True)
        finally: os.unlink(fn)
        out = t.stdout + t.stderr; rc = t.returncode
    if rc == 0 and 'block_height' in out:
        m = re.search(r'"block_height":\s*(\d+)', out); note = 'the new key read the best block (height %s)' % (m.group(1) if m else '?')
    elif 'permission denied' in out.lower(): die('the new key was refused on a block read: ' + out.strip()[:200])
    else: note = 'could not be tried here (%s)' % out.strip().replace('\n', ' ')[:120]
except SystemExit: raise
except Exception as e: note = 'could not be tried here (%s)' % str(e)[:120]
print('try-out: ' + note)

if new == old: print('the .env already holds this key — nothing written'); sys.exit(0)
bak = env_file + '.bak-rebake-' + time.strftime('%Y%m%d-%H%M%S')
if os.path.exists(bak): die('a copy named %s exists' % bak)
with open(bak, 'x') as f: f.write(env)
os.chmod(bak, 0o600)
out = re.sub(r'(?m)^LIJ_ADAPTER_MACAROON_HEX=.*$', lambda m: 'LIJ_ADAPTER_MACAROON_HEX=' + new, env)
changed = [i for i, (a, b) in enumerate(zip(env.split('\n'), out.split('\n')), 1) if a != b]
if len(env.split('\n')) != len(out.split('\n')) or len(changed) != 1: die('the replacement would touch more than one line — nothing written')
tmp = env_file + '.tmp-rebake'
with open(tmp, 'w') as f: f.write(out)
os.chmod(tmp, os.stat(env_file).st_mode & 0o777); os.replace(tmp, env_file)
print('written: line %d of %s (LIJ_ADAPTER_MACAROON_HEX); the copy before it: %s' % (changed[0], env_file, bak))
print('DONE — restart the adapter to use the new key.')
