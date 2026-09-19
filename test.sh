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
OUT=/tmp/pi-ship-selftest/bundle
TARGET=/tmp/pi-ship-selftest/target
FAIL=0

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
pass() { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=1; }

rm -rf /tmp/pi-ship-selftest
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
  bash "$OUT/install.sh" >/tmp/pi-ship-selftest/apply1.log 2>&1 \
  && pass "runbook exited 0" || { fail "runbook failed"; tail -20 /tmp/pi-ship-selftest/apply1.log; }

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
cp "$TARGET/.pi/agent/settings.json" /tmp/pi-ship-selftest/settings.before
cp "$TARGET/.pi/agent/models.json" /tmp/pi-ship-selftest/models.before
env -i HOME="$TARGET" PATH="$TARGET/bin:$(dirname "$(command -v node)"):/usr/bin:/bin" \
  bash "$OUT/install.sh" >/tmp/pi-ship-selftest/apply2.log 2>&1 \
  && pass "second run exited 0" || fail "second run failed"

cmp -s /tmp/pi-ship-selftest/settings.before "$TARGET/.pi/agent/settings.json" \
  && pass "settings.json unchanged on re-run" || fail "settings.json changed on re-run"
cmp -s /tmp/pi-ship-selftest/models.before "$TARGET/.pi/agent/models.json" \
  && pass "models.json unchanged on re-run" || fail "models.json changed on re-run"

grep -q 'settings already match' /tmp/pi-ship-selftest/apply2.log \
  && pass "re-run reports settings already match" || fail "re-run did not detect match"

say "6. node version gate (the check that matters on a real host)"
# Extract version_ge from the generated runbook and exercise it. A machine with
# node 18 (Ubuntu 24.04 default) must be recognised as TOO OLD, not silently ok.
awk '/^version_ge\(\) \{/,/^\}/' "$OUT/install.sh" > /tmp/pi-ship-selftest/vg.sh
cat >> /tmp/pi-ship-selftest/vg.sh <<'VG'
chk() { if version_ge "$1" "$2"; then r=yes; else r=no; fi
  if [ "$r" = "$3" ]; then echo "ok $1"; else echo "FAIL $1>= $2 gave $r want $3"; fi; }
chk 18.19.1 22.19.0 no
chk 24.21.0 22.19.0 yes
chk v22.19.0 22.19.0 yes
chk 22.18.9 22.19.0 no
chk v26.7.0 22.19.0 yes
VG
VG_FAIL=$(bash /tmp/pi-ship-selftest/vg.sh | grep -c '^FAIL' || true)
[ "$VG_FAIL" = 0 ] && pass "version_ge handles 18/22/24/26 correctly" \
  || { fail "version_ge comparison wrong"; bash /tmp/pi-ship-selftest/vg.sh | grep '^FAIL'; }

# A too-old node must produce a warning, never a tick.
FAKE=/tmp/pi-ship-selftest/fakenode
mkdir -p "$FAKE/bin"
printf '#!/bin/sh\n[ "$1" = "--version" ] && echo v18.19.1\nexit 0\n' > "$FAKE/bin/node"
printf '#!/bin/sh\nexit 0\n' > "$FAKE/bin/npm"
chmod +x "$FAKE/bin/node" "$FAKE/bin/npm"
PRE=$(env -i HOME="$FAKE" PATH="$FAKE/bin:/usr/bin:/bin" bash "$OUT/install.sh" --preflight 2>&1)
echo "$PRE" | grep -q 'below pi' && pass "node 18 is flagged as below the minimum" \
  || { fail "node 18 was not flagged"; echo "$PRE"; }
echo "$PRE" | grep -q '✓ node' && fail "node 18 wrongly shown as OK" \
  || pass "node 18 is not shown as a passing check"

say "7. plan reports drift without proposing destruction"
cat > "$REPO/.tmp/selftest-plan.ts" <<EOF
import { planBundle, formatPlan } from "$REPO/src/bundle.ts";
console.log(formatPlan(planBundle("$OUT")));
EOF
PLAN_OUT=$(node --experimental-strip-types "$REPO/.tmp/selftest-plan.ts")
echo "$PLAN_OUT" | tail -3

if echo "$PLAN_OUT" | grep -q 'existing packages and files are not replaced'; then
  pass "plan states the incremental guarantee"
else
  fail "plan does not mention incremental semantics"
fi

# planning must never mutate the live agent dir
BEFORE=$(cat "$TARGET/.pi/agent/models.json" | shasum | cut -d' ' -f1)
node --experimental-strip-types "$REPO/.tmp/selftest-plan.ts" >/dev/null
AFTER=$(cat "$TARGET/.pi/agent/models.json" | shasum | cut -d' ' -f1)
[ "$BEFORE" = "$AFTER" ] && pass "plan is read-only" || fail "plan mutated the agent dir"

echo
say "8. incremental: existing packages are never touched"
# `pi install` rewrites the settings entry and reinstalls, so an older bundle
# applied to a newer machine can silently DOWNGRADE a package. The runbook must
# therefore detect what is already installed and skip it by default.
if grep -q 'pkg_installed' "$OUT/install.sh"; then
  pass "runbook detects already-installed packages"
else
  fail "runbook has no already-installed detection"
fi

if grep -q 'already installed - left as-is' "$OUT/install.sh"; then
  pass "default behaviour is to leave existing packages alone"
else
  fail "no leave-as-is branch"
fi

if grep -q -- '--update-existing' "$OUT/install.sh"; then
  pass "opt-in upgrade flag exists"
else
  fail "--update-existing flag missing"
fi

# An existing package must not reach a `pi install` call on the default path.
# The install invocation for a package only appears inside the
# --update-existing branch and the "elif" (absent) branch.
INSTALL_LINES=$(grep -c 'doit pi install' "$OUT/install.sh")
GUARDED=$(grep -c 'elif doit pi install' "$OUT/install.sh")
[ "$INSTALL_LINES" -gt 0 ] && pass "packages still get installed when absent ($INSTALL_LINES call sites)" \
  || fail "no install call sites at all"
[ "$GUARDED" -gt 0 ] && pass "the absent-branch install is guarded by pkg_installed" \
  || fail "install not guarded"

echo
say "9. incremental: existing files are not overwritten"
if grep -q 'pi-ship-new' "$OUT/install.sh"; then
  pass "conflicting config/extensions are written alongside, not over"
else
  fail "no side-by-side fallback for conflicting files"
fi

# Prove it for real: point the runbook at a target that already has a
# different web-search.json and confirm the original survives.
INC_DIR=/tmp/pi-ship-selftest/incr
rm -rf "$INC_DIR"; mkdir -p "$INC_DIR/.pi/agent"
printf '{\n  "userOwned": true\n}\n' > "$INC_DIR/.pi/agent/web-search.json"
ORIG_MD5=$(shasum "$INC_DIR/.pi/agent/web-search.json" | cut -d' ' -f1)

# Apply only the config layer against a HOME whose web-search.json differs.
HOME="$INC_DIR" "$OUT/install.sh" --yes --only=config >/dev/null 2>&1 || true

NEW_MD5=$(shasum "$INC_DIR/.pi/agent/web-search.json" | cut -d' ' -f1)
[ "$ORIG_MD5" = "$NEW_MD5" ] && pass "pre-existing config file was preserved" \
  || fail "pre-existing config file was overwritten"

if [ -f "$INC_DIR/.pi/agent/web-search.json.pi-ship-new" ]; then
  pass "bundled copy landed beside it as .pi-ship-new"
else
  fail "no .pi-ship-new copy produced"
fi

echo
say "10. source kinds: every form pi accepts is classified, and selection works both ways"

# Export side: a settings.json containing all eight spec shapes. Two of them
# (github: and git://) are forms pi itself cannot install, so the correct
# behaviour is to refuse them loudly rather than carry a broken entry.
KIND_HOME=/tmp/pi-ship-selftest/kindhome
rm -rf "$KIND_HOME"; mkdir -p "$KIND_HOME/.pi/agent/npm/node_modules/pi-memory"
printf '{"name":"pi-memory","version":"1.0.0"}\n' > "$KIND_HOME/.pi/agent/npm/node_modules/pi-memory/package.json"
cat > "$KIND_HOME/.pi/agent/settings.json" <<'KJSON'
{
  "packages": [
    "npm:pi-memory@^1.0.0",
    "git:github.com/NVlabs/SoL-Pi@bd005888b9b8",
    "https://github.com/ict-agent/pi-ship",
    "ssh://git@example.com/team/tool",
    "github:someone/broken",
    "git://example.com/bad/spec",
    "/tmp/pi-ship-selftest/localpkg"
  ]
}
KJSON

KIND_OUT=/tmp/pi-ship-selftest/kindout
rm -rf "$KIND_OUT"
HOME="$KIND_HOME" node --experimental-strip-types -e '
import { collect } from "./src/collect.ts";
import { writeBundle } from "./src/writer.ts";
const m = collect({ outDir: process.argv[1] });
await writeBundle(m, process.argv[1], { force: true, secrets: {} });
console.log(JSON.stringify({ kinds: m.layers.extensions.map((e) => e.kind), warn: m.warnings }));
' "$KIND_OUT" > /tmp/pi-ship-selftest/kind.json 2>/tmp/pi-ship-selftest/kind.err

if [ -s "$KIND_OUT/install.sh" ]; then
  pass "bundle exports a settings.json containing all source forms"
else
  fail "export failed for the all-kinds settings.json"
  sed -n '1,5p' /tmp/pi-ship-selftest/kind.err
fi

grep -q '"url"' /tmp/pi-ship-selftest/kind.json \
  && pass "https:// and ssh:// are carried as kind url" \
  || fail "URL specs were dropped"
grep -q 'github:' /tmp/pi-ship-selftest/kind.json \
  && pass "github: is refused with an explanation (pi cannot resolve it)" \
  || fail "github: spec was not reported"
grep -q 'git://' /tmp/pi-ship-selftest/kind.json \
  && pass "git:// is refused with an explanation (collides with git:)" \
  || fail "git:// spec was not reported"
grep -q 'local-path package' /tmp/pi-ship-selftest/kind.json \
  && pass "local-path package is reported as not shippable" \
  || fail "local path was not reported"

# The ref-carrying forms must be pinned so the target gets the same build.
grep -q 'git:https://github.com/ict-agent/pi-ship' "$KIND_OUT/install.sh" \
  && pass "URL spec is replayed through the git install path" \
  || fail "URL spec missing from the runbook"

bash -n "$KIND_OUT/install.sh" 2>/dev/null && pass "all-kinds runbook is valid shell" \
  || fail "all-kinds runbook has a syntax error"

# Install side: the target can decline kinds, and declining must actually skip.
KIND_TARGET=/tmp/pi-ship-selftest/kindtarget
rm -rf "$KIND_TARGET"; mkdir -p "$KIND_TARGET"

NPM_ONLY=$( { HOME="$KIND_TARGET" bash "$KIND_OUT/install.sh" --dry-run --yes --kinds=npm 2>&1 | grep -c "skipped - kind"; } || true )
# This bundle holds 4 packages: 1 npm, 1 git, 2 url. Declining npm skips 3.
[ "$NPM_ONLY" -eq 3 ] && pass "--kinds=npm declines exactly the 3 git/url packages" \
  || fail "--kinds=npm declined $NPM_ONLY packages, expected 3"

GITURL_ONLY=$( { HOME="$KIND_TARGET" bash "$KIND_OUT/install.sh" --dry-run --yes --kinds=git,url 2>&1 | grep -c "skipped - kind"; } || true )
[ "$GITURL_ONLY" -eq 1 ] && pass "--kinds=git,url declines exactly the 1 npm package" \
  || fail "--kinds=git,url declined $GITURL_ONLY packages, expected 1"

NONE=$( { HOME="$KIND_TARGET" bash "$KIND_OUT/install.sh" --dry-run --yes 2>&1 | grep -c "skipped - kind"; } || true )
[ "$NONE" -eq 0 ] && pass "omitting --kinds declines nothing" \
  || fail "default declined $NONE packages, expected 0"

# A declined kind must not be counted as a missing package by the verifier.
grep -q "kind_wanted 'url' && PKG_WANT" "$KIND_OUT/install.sh" \
  && pass "verify counts only the packages this run intends to install" \
  || fail "verify would report declined kinds as missing"

# An empty or unknown value must not silently mean "decline everything" for
# the empty case, and must be honest for a genuinely unknown kind.
EMPTY=$( { HOME="$KIND_TARGET" bash "$KIND_OUT/install.sh" --dry-run --yes --kinds= 2>&1 | grep -c "skipped - kind"; } || true )
[ "$EMPTY" -eq 0 ] && pass "--kinds= (empty) means accept every kind" \
  || fail "empty --kinds declined $EMPTY packages"

BOGUS=$( { HOME="$KIND_TARGET" bash "$KIND_OUT/install.sh" --dry-run --yes --kinds=bogus 2>&1 | grep -c "skipped - kind"; } || true )
# `bogus` matches no kind, so all 4 packages are declined. Silently installing
# them would be worse than declining: the flag means what it says.
[ "$BOGUS" -eq 4 ] && pass "an unknown kind declines everything rather than installing silently" \
  || fail "--kinds=bogus declined $BOGUS, expected 4"

# The parser must read the loop variable, not $1. Using ${1#--kinds=} silently
# set SHIP_KINDS to the script path, which made every kind look declined.
grep -q 'SHIP_KINDS="${arg#--kinds=}"' "$KIND_OUT/install.sh" \
  && pass "--kinds parses the loop variable" \
  || fail "--kinds parses the wrong variable"

echo
if [ "$FAIL" = 0 ]; then printf '\033[32mALL CHECKS PASSED\033[0m\n'; else printf '\033[31mSOME CHECKS FAILED\033[0m\n'; exit 1; fi