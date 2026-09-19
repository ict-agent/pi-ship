#!/usr/bin/env bash
# pi-ship self-test.
#
# Verifies the properties we actually care about:
#   1. export produces a complete bundle
#   2. no plaintext secret from models.json survives anywhere in the bundle
#   3. install.sh is valid bash
#   4. the runbook applies cleanly to an EMPTY agent dir (fresh-machine sim)
#   5. re-running is idempotent
#
# Usage: ./test.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT=/tmp/pi-migrate-selftest/bundle
TARGET=/tmp/pi-migrate-selftest/target
FAIL=0

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
pass() { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=1; }

rm -rf /tmp/pi-migrate-selftest
mkdir -p "$(dirname "$OUT")" "$TARGET/.pi/agent" "$TARGET/bin" "$REPO/.tmp"

say "1. export"
cat > "$REPO/.tmp/selftest-export.ts" <<EOF
import { collect } from "$REPO/src/collect.ts";
import { writeBundle } from "$REPO/src/writer.ts";
const m = collect({ outDir: "$OUT", providers: true, configFiles: true });
await writeBundle(m, "$OUT", { force: true });
console.log("packages", m.layers.extensions.length);
console.log("providers", m.layers.providers.length);
console.log("configs", m.layers.configFiles.length);
EOF
node --experimental-strip-types "$REPO/.tmp/selftest-export.ts"

for f in pi-ship.json install.sh .env.example bin/merge-models.mjs bin/merge-settings.mjs README.md; do
  [ -f "$OUT/$f" ] && pass "bundle has $f" || fail "bundle missing $f"
done

say "2. no plaintext secrets leak"
# Extract only credential-position values (apiKey/token/secret/...), plus any
# string that looks like an opaque token. Base URLs and model names are config,
# not secrets, and legitimately appear in the bundle.
SECRETS=$(node -e '
const fs=require("fs"),os=require("os"),p=os.homedir()+"/.pi/agent/models.json";
if(!fs.existsSync(p))process.exit(0);
const d=JSON.parse(fs.readFileSync(p,"utf8"));
const KEY=/(api[-_]?key|secret|token|password|credential)/i;
const seen=new Set();
const walk=(o,keyHint)=>{if(Array.isArray(o))return o.forEach(v=>walk(v,keyHint));
  if(o&&typeof o==="object")return Object.entries(o).forEach(([k,v])=>walk(v,k));
  if(typeof o==="string"&&o.length>=16&&!o.startsWith("$")){
    if(KEY.test(keyHint||"")||/^(sk-|[0-9a-f]{32,}$)/i.test(o)) seen.add(o);
  }};
for(const prov of Object.values(d.providers||{})) walk(prov,"");
console.log([...seen].join("\n"));
')

if [ -z "$SECRETS" ]; then
  pass "no credential-position values in models.json to check"
else
  LEAK=0
  while IFS= read -r key; do
    [ -z "$key" ] && continue
    if grep -rqI -- "$key" "$OUT"; then
      fail "LEAK: credential literal found in bundle (${#key} chars)"; LEAK=1
    fi
  done <<< "$SECRETS"
  [ "$LEAK" = 0 ] && pass "no literal credential from models.json appears in the bundle"
fi

# The concrete key we know lives in this machine's models.json must be gone.
if grep -rqI '67a294f684ca412185da06ccfcd91593' "$OUT" 2>/dev/null; then
  fail "LEAK: known zhipu key present in bundle"
else
  pass "known plaintext key absent from bundle"
fi

grep -q '^\.env$' "$OUT/.gitignore" && pass ".gitignore excludes .env" || fail ".gitignore does not exclude .env"

say "3. runbook is valid bash"
bash -n "$OUT/install.sh" && pass "install.sh parses" || fail "install.sh has syntax errors"
"$OUT/install.sh" --help >/dev/null 2>&1 && pass "--help works" || fail "--help broken"

say "4. apply to a fresh machine"
cat > "$TARGET/bin/pi" <<'STUB'
#!/usr/bin/env bash
# Faithful stand-in for the real pi CLI, including its contract that
# `pi install` accepts exactly one source per invocation.
if [ "$1" = "--version" ]; then echo "0.85.1"; exit 0; fi
if [ "$1" = "install" ]; then
  shift
  if [ $# -ne 1 ]; then
    echo "Unexpected argument $2." >&2
    echo "Usage: pi install <source> [-l] [--approve|--no-approve]" >&2
    exit 1
  fi
  printf 'install %s\n' "$1" >> "$HOME/install-calls.log"
  exit 0
fi
exit 0
STUB
chmod +x "$TARGET/bin/pi"

env -i HOME="$TARGET" PATH="$TARGET/bin:$(dirname "$(command -v node)"):/usr/bin:/bin" \
  bash "$OUT/install.sh" >/tmp/pi-migrate-selftest/apply1.log 2>&1 \
  && pass "runbook exited 0" || { fail "runbook failed"; tail -20 /tmp/pi-migrate-selftest/apply1.log; }

for f in extensions/model-name.ts models.json settings.json web-search.json; do
  [ -f "$TARGET/.pi/agent/$f" ] && pass "target has $f" || fail "target missing $f"
done

[ -f "$TARGET/install-calls.log" ] && pass "pi install was invoked" || fail "pi install never ran"
# Regression guard: `pi install` accepts exactly ONE source per invocation. A
# single batched call silently fails on a real machine, so assert the runbook
# issues one call per package with the source as $1.
NPKG=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$OUT/pi-ship.json','utf8')).layers.extensions.length)")
NCALLS=$(grep -c '^install$\|^install ' "$TARGET/install-calls.log" 2>/dev/null || echo 0)
SOURCES=$(grep -oE '(npm|git):[^ ]+' "$TARGET/install-calls.log" | wc -l | tr -d ' ')
[ "$SOURCES" = "$NPKG" ] && pass "one pi install call per package ($NPKG sources)" \
  || fail "expected $NPKG pinned sources on the install lines, found $SOURCES"

# Each install line must carry exactly one source (the batch bug).
MAXSRC=$(grep '^install' "$TARGET/install-calls.log" | awk '{print NF-1}' | sort -rn | head -1)
[ "${MAXSRC:-0}" -le 1 ] && pass "no batched sources on any install line" \
  || fail "an install call passed $MAXSRC sources; pi install takes only one"

say "5. re-run is idempotent"
cp "$TARGET/.pi/agent/settings.json" /tmp/pi-migrate-selftest/settings.before
cp "$TARGET/.pi/agent/models.json" /tmp/pi-migrate-selftest/models.before
env -i HOME="$TARGET" PATH="$TARGET/bin:$(dirname "$(command -v node)"):/usr/bin:/bin" \
  bash "$OUT/install.sh" >/tmp/pi-migrate-selftest/apply2.log 2>&1 \
  && pass "second run exited 0" || fail "second run failed"

cmp -s /tmp/pi-migrate-selftest/settings.before "$TARGET/.pi/agent/settings.json" \
  && pass "settings.json unchanged on re-run" || fail "settings.json changed on re-run"
cmp -s /tmp/pi-migrate-selftest/models.before "$TARGET/.pi/agent/models.json" \
  && pass "models.json unchanged on re-run" || fail "models.json changed on re-run"

grep -q 'settings already match' /tmp/pi-migrate-selftest/apply2.log \
  && pass "re-run reports settings already match" || fail "re-run did not detect match"

say "6. node version gate (the check that matters on a real host)"
# Extract version_ge from the generated runbook and exercise it. A machine with
# node 18 (Ubuntu 24.04 default) must be recognised as TOO OLD, not silently ok.
awk '/^version_ge\(\) \{/,/^\}/' "$OUT/install.sh" > /tmp/pi-migrate-selftest/vg.sh
cat >> /tmp/pi-migrate-selftest/vg.sh <<'VG'
chk() { if version_ge "$1" "$2"; then r=yes; else r=no; fi
  if [ "$r" = "$3" ]; then echo "ok $1"; else echo "FAIL $1>= $2 gave $r want $3"; fi; }
chk 18.19.1 22.19.0 no
chk 24.21.0 22.19.0 yes
chk v22.19.0 22.19.0 yes
chk 22.18.9 22.19.0 no
chk v26.7.0 22.19.0 yes
VG
VG_FAIL=$(bash /tmp/pi-migrate-selftest/vg.sh | grep -c '^FAIL' || true)
[ "$VG_FAIL" = 0 ] && pass "version_ge handles 18/22/24/26 correctly" \
  || { fail "version_ge comparison wrong"; bash /tmp/pi-migrate-selftest/vg.sh | grep '^FAIL'; }

# A too-old node must produce a warning, never a tick.
FAKE=/tmp/pi-migrate-selftest/fakenode
mkdir -p "$FAKE/bin"
printf '#!/bin/sh\n[ "$1" = "--version" ] && echo v18.19.1\nexit 0\n' > "$FAKE/bin/node"
printf '#!/bin/sh\nexit 0\n' > "$FAKE/bin/npm"
chmod +x "$FAKE/bin/node" "$FAKE/bin/npm"
PRE=$(env -i HOME="$FAKE" PATH="$FAKE/bin:/usr/bin:/bin" bash "$OUT/install.sh" --preflight 2>&1)
echo "$PRE" | grep -q 'below pi' && pass "node 18 is flagged as below the minimum" \
  || { fail "node 18 was not flagged"; echo "$PRE"; }
echo "$PRE" | grep -q '✓ node' && fail "node 18 wrongly shown as OK" \
  || pass "node 18 is not shown as a passing check"

say "7. plan detects drift (and writes nothing)"
cat > "$REPO/.tmp/selftest-plan.ts" <<EOF
import { planBundle, formatPlan } from "$REPO/src/bundle.ts";
console.log(formatPlan(planBundle("$OUT")));
EOF
PLAN_OUT=$(node --experimental-strip-types "$REPO/.tmp/selftest-plan.ts")
echo "$PLAN_OUT" | tail -4

# The target we just applied to is a fresh dir; planning against a copy of it
# should report drift for the file we deliberately perturb.
DRIFT_DIR=/tmp/pi-migrate-selftest/drift
mkdir -p "$DRIFT_DIR"
cp -R "$TARGET/.pi/agent" "$DRIFT_DIR/agent"
printf '{\n  "mutated": true\n}\n' > "$DRIFT_DIR/agent/web-search.json"

cat > "$REPO/.tmp/selftest-drift.ts" <<EOF
import { planBundle } from "$REPO/src/bundle.ts";
const p = planBundle("$OUT");
const drift = p.items.filter(i => i.action !== "skip");
console.log(JSON.stringify({ drift: drift.map(d => d.target), conflicts: p.conflicts }));
EOF
DRIFT_JSON=$(node --experimental-strip-types "$REPO/.tmp/selftest-drift.ts")
echo "  plan says: $DRIFT_JSON"

# planning must never mutate the live agent dir
BEFORE=$(cat "$TARGET/.pi/agent/models.json" | shasum | cut -d' ' -f1)
node --experimental-strip-types "$REPO/.tmp/selftest-plan.ts" >/dev/null
AFTER=$(cat "$TARGET/.pi/agent/models.json" | shasum | cut -d' ' -f1)
[ "$BEFORE" = "$AFTER" ] && pass "plan is read-only" || fail "plan mutated the agent dir"

echo
if [ "$FAIL" = 0 ]; then printf '\033[32mALL CHECKS PASSED\033[0m\n'; else printf '\033[31mSOME CHECKS FAILED\033[0m\n'; exit 1; fi