/**
 * pi-ship — runbook generation.
 *
 * Produces `install.sh`: an ordered, self-checking, idempotent replay script.
 *
 * Structure (each stage is a numbered step):
 *
 *   preflight   — report what this machine has and what would be fixed
 *   configure   — INTERACTIVE ONLY: ask which optional layers to apply
 *   bootstrap   — install node/npm/pi if missing (opt-in)
 *   apply       — pinned package installs, providers, configs, settings
 *   secrets     — merge .env, never overwriting an existing value
 *   path        — optionally expose pi to future shells
 *   verify      — re-check the result and print a summary
 *
 * The script has two modes:
 *   interactive  a terminal is attached (or --interactive) -> asks questions
 *   unattended   no terminal (CI, ssh with a command) -> reads .pi-ship.conf
 *
 * Answers are persisted to `.pi-ship.conf` so a re-run never asks twice and a
 * non-interactive re-run behaves identically.
 */

import type { ShipManifest } from "./types.ts";

function sh(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function generateRunbook(m: ShipManifest): string {
	const L: string[] = [];
	const step = (n: number, title: string) =>
		L.push("", `# ── step ${n}: ${title} ${"─".repeat(Math.max(0, 56 - title.length))}`);

	L.push(
		"#!/usr/bin/env bash",
		"#",
		`# pi-ship runbook — generated ${m.createdAt}`,
		`# source machine: ${m.source.hostname} (${m.source.platform}/${m.source.arch})`,
		`# pi version:     ${m.source.piVersion ?? "unknown"}`,
		"#",
		"# Replays a pi configuration on a new machine. Every step checks first and",
		"# is safe to re-run. Nothing is overwritten that already exists.",
		"#",
		"# Usage:",
		"#   ./install.sh                 # interactive (asked once, then remembered)",
		"#   ./install.sh --dry-run       # show every action, change nothing",
		"#   ./install.sh --yes           # unattended, accept the defaults/config",
		"#   ./install.sh --only=extensions,providers",
		"#   ./install.sh --update-existing  # upgrade packages this machine already has",
		"#   ./install.sh --kinds=npm,git  # accept only these source kinds (npm,git,url)",
		"#   ./install.sh --preflight     # only run the self-check, then stop",
		"#   ./install.sh --help",
		"# --- end of help ---",
		"#",
		"set -euo pipefail",
		"",
		'DRY_RUN=0; ASSUME_YES=0; ONLY=""; PREFLIGHT_ONLY=0; FORCE_INTERACTIVE=0; UPDATE_EXISTING=0',
		'SHIP_KINDS=""   # empty = accept every kind; else a comma list of npm,git,url',
		'for arg in "$@"; do',
		'  case "$arg" in',
		'    --dry-run) DRY_RUN=1 ;;',
		'    --yes|-y) ASSUME_YES=1 ;;',
		'    --interactive) FORCE_INTERACTIVE=1 ;;',
		'    --only=*) ONLY="${arg#--only=}" ;;',
		'    --update-existing) UPDATE_EXISTING=1 ;;',
		'    --kinds=*) SHIP_KINDS="${arg#--kinds=}" ;;',
		'    --preflight) PREFLIGHT_ONLY=1 ;;',
		'    -h|--help)',
		'      sed -n \'/^# Usage:/,/^# --- end of help ---$/p\' "$0" | sed \'s/^# \\{0,1\\}//\'',
		'      exit 0 ;;',
		'    *) echo "unknown flag: $arg" >&2; exit 2 ;;',
		'  esac',
		'done',
		"",
		'BUNDLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
		'AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"',
		'CONF="$BUNDLE_DIR/.pi-ship.conf"',
		'ENV_FILE="$BUNDLE_DIR/.env"',
		'',
		'# ── output helpers ──────────────────────────────────────────────────────',
		'# Colours only when attached to a terminal.',
		'if [ -t 1 ]; then',
		'  C_OK=$(printf "\\033[32m"); C_WARN=$(printf "\\033[33m")',
		'  C_ERR=$(printf "\\033[31m"); C_DIM=$(printf "\\033[2m"); C_OFF=$(printf "\\033[0m")',
		'else',
		'  C_OK=; C_WARN=; C_ERR=; C_DIM=; C_OFF=',
		'fi',
		'info()  { printf "  %s\\n" "$*"; }',
		'ok()    { printf "  = %s\\n" "$*"; }',
		'doit()  { if [ "$DRY_RUN" = 1 ]; then printf "  %s[dry-run]%s %s\\n" "$C_DIM" "$C_OFF" "$*"; else printf "  + %s\\n" "$*"; "$@"; fi; }',
		'warn()  { printf "  %s!%s %s\\n" "$C_WARN" "$C_OFF" "$*"; }',
		'err()   { printf "  %sx%s %s\\n" "$C_ERR" "$C_OFF" "$*"; }',
		'title() { printf "\\n%s\\n" "$*"; }',
		'have()  { command -v "$1" >/dev/null 2>&1; }',
		'# want <layer>: true when --only was not given, or names this layer.',
		'want() {',
		'  [ -z "$ONLY" ] && return 0',
		'  case ",$ONLY," in *",$1,"*) return 0 ;; esac',
		'  return 1',
		'}',
		'',
		'# ── incremental install support ────────────────────────────────────────',
		'# `pi install <spec>` has NO "already installed" semantics: it rewrites the',
		'# settings.json entry and reinstalls, so applying an older bundle onto a',
		'# newer machine would silently DOWNGRADE packages. So we decide ourselves',
		'# and install only what is missing.',
		'',
		'# kind_wanted <kind> -> 0 if this kind should be installed.',
		'#   An empty SHIP_KINDS means "accept every kind". A kind is matched only',
		'#   as a whole comma-separated field, so "git" never matches "gitlab".',
		'kind_wanted() {',
		'  [ -z "$SHIP_KINDS" ] && return 0',
		'  case ",$SHIP_KINDS," in *",$1,"*) return 0 ;; esac',
		'  return 1',
		'}',
		'',
		'# pkg_name <spec> -> bare package name, version/ref stripped.',
		'#   npm:pi-memory@0.4.2     -> pi-memory',
		'#   npm:@scope/pkg@1.2.3    -> @scope/pkg',
		'#   git:github.com/o/r@v1   -> github.com/o/r',
		'pkg_name() {',
		'  local s="$1" n=""',
		'  case "$s" in',
		'    npm:*) n="${s#npm:}" ;;',
		'    git:*) n="${s#git:}" ;;',
		'    *)     n="$s" ;;',
		'  esac',
		'  case "$n" in',
		'    @*) local scope="${n%%/*}" rest="${n#*/}"',
		'        printf "%s/%s" "$scope" "${rest%%@*}" ;;',
		'    *)  printf "%s" "${n%%@*}" ;;',
		'  esac',
		'}',
		'',
		'# pkg_installed <name> -> 0 when this machine already has the package.',
		'# Checks both the recorded spec list and the install directories, because a',
		'# package can be present on disk while absent from settings.json, or vice',
		'# versa when settings were edited by hand.',
		'pkg_installed() {',
		'  local name="$1"',
		'  [ -z "$name" ] && return 1',
		'  if [ -f "$AGENT_DIR/settings.json" ] && have node; then',
		'    if node "$BUNDLE_DIR/bin/has-package.mjs" "$AGENT_DIR/settings.json" "$name" 2>/dev/null; then',
		'      return 0',
		'    fi',
		'  fi',
		'  [ -d "$HOME/.pi/agent/npm/node_modules/$name" ] && return 0',
		'  [ -d "$HOME/.pi/agent/git/github.com/$name" ] && return 0',
		'  return 1',
		'}',
		'',
		'# ── interactive detection ───────────────────────────────────────────────',
		'INTERACTIVE=0',
		'if [ "$FORCE_INTERACTIVE" = 1 ]; then INTERACTIVE=1; fi',
		'if [ "$ASSUME_YES" = 0 ] && [ "$DRY_RUN" = 0 ] && [ -t 1 ] && [ -r /dev/tty ]; then INTERACTIVE=1; fi',
		'',
		'ask_yn() {',
		'  # ask_yn <question> <default: y|n> -> echoes y or n',
		'  local q="$1" d="${2:-y}" a=',
		'  if [ "$INTERACTIVE" != 1 ]; then echo "$d"; return; fi',
		'  while :; do',
		'    printf "  %s [%s/%s] " "$q" "$([ "$d" = y ] && echo Y || echo y)" "$([ "$d" = y ] && echo n || echo N)" > /dev/tty',
		'    read -r a < /dev/tty || a=""',
		'    a="${a:-$d}"',
		'    case "$a" in',
		'      y|Y|yes|YES) echo y; return ;;',
		'      n|N|no|NO)   echo n; return ;;',
		'      *) printf "  please answer y or n\\n" > /dev/tty ;;',
		'    esac',
		'  done',
		'}',
		'',
		'# ── configuration ───────────────────────────────────────────────────────',
		'# Defaults come from the bundle flags; the user is asked once and the',
		'# answers persist in .pi-ship.conf so re-runs stay unattended.',
		'CFG_INSTALL_PI=yes',
		'CFG_NODE_METHOD=skip',
		'CFG_NODE_VERSION=',
		'CFG_NODE_BIN_DIR=',
		'CFG_PI_BIN_DIR=',
		'CFG_PATH=ask',
		'CFG_SECRETS=ask',
		'if [ -f "$CONF" ]; then',
		'  # shellcheck disable=SC1090',
		'  . "$CONF"',
		'  info "loaded previous answers from .pi-ship.conf"',
		'fi',
		'save_conf() {',
		'  if [ "$DRY_RUN" = 1 ]; then return; fi',
		'  cat > "$CONF" <<CONF_EOF',
		'# pi-ship: answers from the interactive configuration step.',
		'# Delete this file to be asked again.',
		'CFG_INSTALL_PI=$CFG_INSTALL_PI',
		'CFG_NODE_METHOD=$CFG_NODE_METHOD',
		'CFG_NODE_VERSION=$CFG_NODE_VERSION',
		'CFG_NODE_BIN_DIR=$CFG_NODE_BIN_DIR',
		'CFG_PI_BIN_DIR=$CFG_PI_BIN_DIR',
		'CFG_PATH=$CFG_PATH',
		'CFG_SECRETS=$CFG_SECRETS',
		'CONF_EOF',
		'}',
		"",
	);

	// ── step 1: preflight ───────────────────────────────────────────────────
	step(1 + 0, "self-check");
	L.push(
		"# Reports what this machine has before anything is modified.",
		'PI_OK=no; NODE_OK=no; NPM_OK=no; NODE_BIN=""; NODE_VERSION=""; NODE_GOOD=no',
		'command -v pi  >/dev/null 2>&1 && PI_OK=yes',
		'command -v node >/dev/null 2>&1 && NODE_OK=yes && NODE_BIN="$(command -v node)"',
		'command -v npm  >/dev/null 2>&1 && NPM_OK=yes',
		'if [ "$NODE_OK" = yes ]; then NODE_VERSION="$("$NODE_BIN" --version 2>/dev/null)"; fi',
		'',
		'# pi requires node >= this. Semantic compare, not string compare.',
		'PI_NODE_MIN="22.19.0"',
		'version_ge() {',
		'  # version_ge <actual> <required>; treats "v22.19.0" and "22.19.0" alike.',
		'  # awk keeps this portable across bash 3.2 (macOS) and 5.x (Linux).',
		'  awk -v a="\${1#v}" -v b="\${2#v}" \'BEGIN {',
		'    n = split(a, x, "."); m = split(b, y, ".");',
		'    if (n < m) n = m;',
		'    for (i = 1; i <= n; i++) {',
		'      xi = (i in x) ? x[i] + 0 : 0;',
		'      yi = (i in y) ? y[i] + 0 : 0;',
		'      if (xi > yi) exit 0;',
		'      if (xi < yi) exit 1;',
		'    }',
		'    exit 0',
		'  }\'',
		'}',
		'',
		'# node is frequently installed but not on PATH (nvm, fnm, volta), and the',
		'# one on PATH is often too old. Look for a usable one.',
		'if [ "$NODE_OK" = no ] || ! version_ge "$NODE_VERSION" "$PI_NODE_MIN"; then',
		'  for cand in "$HOME"/.nvm/versions/node/*/bin "$HOME"/.volta/bin "$HOME"/.fnm/aliases/default/bin /usr/local/bin /opt/homebrew/bin; do',
		'    [ -x "$cand/node" ] || continue',
		'    cv="$("$cand/node" --version 2>/dev/null)" || continue',
		'    if version_ge "$cv" "$PI_NODE_MIN"; then',
		'      NODE_BIN="$cand/node"; NODE_VERSION="$cv"; NODE_OK=yes',
		'      PATH="$cand:$PATH"; export PATH',
		'      command -v npm >/dev/null 2>&1 && NPM_OK=yes',
		'      info "using node $cv from $cand (PATH one was insufficient)"',
		'      break',
		'    fi',
		'  done',
		'fi',
		'',
		'# Is the node we settled on actually usable by pi?',
		'if [ "$NODE_OK" = yes ] && version_ge "$NODE_VERSION" "$PI_NODE_MIN"; then NODE_GOOD=yes; fi',
		'check() { printf "  %s %-14s %s\\n" "$2" "$1" "$3"; }',
		'[ "$PI_OK"   = yes ] && check pi      "${C_OK}✓${C_OFF}" "$(pi --version 2>/dev/null | head -1)" || check pi "${C_WARN}→${C_OFF}" "not installed (will install if you agree)"',
		'if [ "$NODE_OK" = yes ] && version_ge "$NODE_VERSION" "$PI_NODE_MIN"; then',
		'  check node "${C_OK}✓${C_OFF}" "$NODE_VERSION"',
		'elif [ "$NODE_OK" = yes ]; then',
		'  check node "${C_WARN}→${C_OFF}" "$NODE_VERSION is below pi\'s minimum $PI_NODE_MIN"',
		'else',
		'  check node "${C_WARN}→${C_OFF}" "not found (pi needs >= $PI_NODE_MIN)"',
		'fi',
		'[ "$NPM_OK"  = yes ] && check npm     "${C_OK}✓${C_OFF}" "available" || check npm "${C_WARN}→${C_OFF}" "not on PATH"',
		'check platform "${C_OK}✓${C_OFF}" "$(uname -s)/$(uname -m)"',
		'check agentdir "${C_OK}✓${C_OFF}" "$AGENT_DIR"',
		'if [ "$PREFLIGHT_ONLY" = 1 ]; then title "preflight only — stopping"; exit 0; fi',
		"",
	);

	let n = 1;
	const bump = () => ++n;

	// ── step 2: interactive configuration ───────────────────────────────────
	step(bump(), "configuration");
	L.push(
		"# The only interactive part. Answers are remembered in .pi-ship.conf.",
		'if [ "$INTERACTIVE" = 1 ]; then',
		'  title "Configure this migration"',
		'  info "Re-run with --yes to skip these questions."',
		"",
		'  # ── node: needed before pi can be installed ──────────────────────────',
		'  NODE_GOOD=no',
		'  if [ "$NODE_OK" = yes ] && version_ge "$NODE_VERSION" "$PI_NODE_MIN"; then NODE_GOOD=yes; fi',
		'  if [ "$PI_OK" = no ] && [ "$NODE_GOOD" = no ]; then',
		'    if [ "$NODE_OK" = yes ]; then',
		"      warn \"node $NODE_VERSION is below pi's minimum $PI_NODE_MIN.\"",
		'    else',
		'      warn "no usable node found (pi needs >= $PI_NODE_MIN)."',
		'    fi',
		'    title "How should node be installed?"',
		'    info "  1) nvm   — user-local, recommended, no sudo, multiple versions"',
		'    info "  2) fnm   — fast user-local alternative"',
		'    info "  3) nodesource — system-wide via apt (needs sudo)"',
		'    info "  4) npm     — npm install -g node (works when GitHub is blocked)"',
		'    info "  5) skip    — I will install node myself, then re-run"',
		'    printf "  choose [1-5] (default 1): " > /dev/tty',
		'    read -r choice < /dev/tty || choice=""',
		'    case "${choice:-1}" in',
		'      1) CFG_NODE_METHOD=nvm ;;',
		'      2) CFG_NODE_METHOD=fnm ;;',
		'      3) CFG_NODE_METHOD=nodesource ;;',
		'      4) CFG_NODE_METHOD=npmnode ;;',
		'      5) CFG_NODE_METHOD=skip ;;',
		'      *) CFG_NODE_METHOD=nvm ;;',
		'    esac',
		'    if [ "$CFG_NODE_METHOD" != skip ]; then',
		'      title "Which node version?"',
		'      info "  1) 22 LTS   — the minimum pi supports, most conservative"',
		"      info \"  2) 24 LTS   — current LTS (matches this bundle's source machine)\"",
		'      info "  3) latest   — newest release"',
		'      printf "  choose [1-3] (default 2): " > /dev/tty',
		'      read -r vchoice < /dev/tty || vchoice=""',
		'      case "${vchoice:-2}" in',
		'        1) CFG_NODE_VERSION=22 ;;',
		'        2) CFG_NODE_VERSION=24 ;;',
		'        3) CFG_NODE_VERSION=latest ;;',
		'        *) CFG_NODE_VERSION=24 ;;',
		'      esac',
		'    fi',
		'  else',
		'    CFG_NODE_METHOD=skip',
		'    CFG_NODE_VERSION=',
		'  fi',
		"",
		'  # ── pi itself ────────────────────────────────────────────────────────',
		'  if [ "$PI_OK" = no ]; then',
		'    a="$(ask_yn "Install pi now (npm install -g @earendil-works/pi-coding-agent)?" y)"',
		'    [ "$a" = y ] && CFG_INSTALL_PI=yes || CFG_INSTALL_PI=no',
		'  else',
		'    CFG_INSTALL_PI=no',
		'  fi',
		"",
		'  # ── shell PATH ───────────────────────────────────────────────────────',
		'  a="$(ask_yn "Expose node/pi to your future shells (write a PATH entry)?" y)"',
		'  [ "$a" = y ] && CFG_PATH=yes || CFG_PATH=no',
		"",
	);

	if (m.requiredEnv.length > 0) {
		L.push(
			"  # ── secrets ──────────────────────────────────────────────────────────",
			"  IN_BUNDLE=no",
			'  [ -s "$BUNDLE_DIR/.secrets.env" ] && IN_BUNDLE=yes',
			'  if [ "$IN_BUNDLE" = yes ]; then',
			'    a="$(ask_yn "This bundle carries secret values. Apply the ones missing here?" y)"',
			'    [ "$a" = y ] && CFG_SECRETS=yes || CFG_SECRETS=no',
			'  else',
			'    CFG_SECRETS=no',
			'    info "no secret values in this bundle; see .env.example for what to provide."',
			'  fi',
			"",
		);
	} else {
		L.push("  CFG_SECRETS=no", "");
	}

	L.push(
		'  save_conf',
		'else',
		'  info "unattended mode: using defaults from .pi-ship.conf (or none)"',
		'fi',
		"",
	);

	// ── step 3: bootstrap node (if the user chose a method) ─────────────────
	step(bump(), "bootstrap node if needed");
	L.push(
		"# Node is the one hard prerequisite pi has. This step is skipped when the",
		"# machine already has a usable version, or when the user opted out.",
		'if [ "$CFG_NODE_METHOD" != skip ] && [ "$DRY_RUN" = 0 ]; then',
		'  case "$CFG_NODE_METHOD" in',
		'    nvm)',
		'      export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
		'      if [ ! -s "$NVM_DIR/nvm.sh" ]; then',
		'        info "installing nvm..."',
		'        NVM_OK=no',
		'        # raw.githubusercontent.com is blocked on some networks, so try',
		'        # several equivalent sources before giving up.',
		'        for src in \\',
		'          "https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh" \\',
		'          "https://github.com/nvm-sh/nvm/raw/v0.40.1/install.sh" \\',
		'          "https://cdn.jsdelivr.net/gh/nvm-sh/nvm@v0.40.1/install.sh" \\',
		'          "https://gitee.com/mirrors/nvm/raw/v0.40.1/install.sh"; do',
		'          info "trying $src"',
		'          if have curl; then',
		'            curl -fsSL "$src" -o /tmp/pi-ship-nvm.sh 2>/dev/null || continue',
		'            bash /tmp/pi-ship-nvm.sh >/dev/null 2>&1 && NVM_OK=yes && break',
		'          elif have wget; then',
		'            wget -qO /tmp/pi-ship-nvm.sh "$src" 2>/dev/null || continue',
		'            bash /tmp/pi-ship-nvm.sh >/dev/null 2>&1 && NVM_OK=yes && break',
		'          fi',
		'        done',
		'        if [ "$NVM_OK" = no ] && have git; then',
		'          info "installer unreachable; cloning nvm instead"',
		'          git clone --depth 1 --branch v0.40.1 https://github.com/nvm-sh/nvm.git "$NVM_DIR" >/dev/null 2>&1 \\',
		'            && NVM_OK=yes',
		'        fi',
		'        [ "$NVM_OK" = no ] && warn "could not install nvm (network restricted?) - try the npm method"',
		'      fi',
		'      if [ -s "$NVM_DIR/nvm.sh" ]; then',
		'        # shellcheck disable=SC1090',
		'        . "$NVM_DIR/nvm.sh"',
		'        case "$CFG_NODE_VERSION" in',
		'          22) nvm install 22 >/dev/null 2>&1 || warn "nvm install 22 failed" ;;',
		'          24) nvm install 24 >/dev/null 2>&1 || warn "nvm install 24 failed" ;;',
		'          *)  nvm install --lts >/dev/null 2>&1 || warn "nvm install failed" ;;',
		'        esac',
		'        NV="$(nvm current)"',
		'        if [ -n "$NV" ] && [ -d "$NVM_DIR/versions/node/$NV/bin" ]; then',
		'          PATH="$NVM_DIR/versions/node/$NV/bin:$PATH"; export PATH',
		'          info "node $NV active via nvm"',
		'        fi',
		'      fi',
		'      ;;',
		'    npmnode)',
		'      # Last resort: the npm registry is reachable on networks that block',
		'      # GitHub raw. The node package ships prebuilt binaries, but it must be',
		'      # installed into a USER-WRITABLE prefix: the node already on PATH is',
		'      # often a root-owned system package we cannot upgrade.',
		'      info "installing node via npm into a user-local prefix..."',
		'      USER_PREFIX="$HOME/.pi-node"',
		'      case "$CFG_NODE_VERSION" in',
		'        22) NODE_MAJOR="22" ;;',
		'        24) NODE_MAJOR="24" ;;',
		'        *)  NODE_MAJOR="" ;;',
		'      esac',
		'      if have npm; then',
		'        if [ -n "$NODE_MAJOR" ]; then',
		'          # `npm view` prints "node@<ver> \'<ver>\'" per line, and may include',
		'          # warnings, so extract the highest quoted semver from the output.',
		'          NPM_NODE_SPEC="node@$(npm view "node@${NODE_MAJOR}" version 2>/dev/null \\',
		'            | grep -Eo "[0-9]+\\.[0-9]+\\.[0-9]+" \\',
		'            | sort -t. -k1,1n -k2,2n -k3,3n \\',
		'            | tail -1)"',
		'          if [ "$NPM_NODE_SPEC" = "node@" ]; then NPM_NODE_SPEC="node@$NODE_MAJOR"; fi',
		'        else',
		'          NPM_NODE_SPEC="node"',
		'        fi',
		'        info "installing $NPM_NODE_SPEC (may take a minute)..."',
		'        if npm install -g --prefix "$USER_PREFIX" "$NPM_NODE_SPEC" >/dev/null 2>&1 \\',
		'           && [ -x "$USER_PREFIX/bin/node" ]; then',
		'          PATH="$USER_PREFIX/bin:$PATH"; export PATH',
		'          NODE_BIN="$USER_PREFIX/bin/node"',
		'          NODE_VERSION="$("$NODE_BIN" --version 2>/dev/null)"',
		'          CFG_NODE_BIN_DIR="$USER_PREFIX/bin"',
		'          info "node $NODE_VERSION installed at $NODE_BIN"',
		'        else',
		'          warn "npm install -g --prefix $USER_PREFIX failed"',
		'        fi',
		'      else',
		'        warn "npm is unavailable; cannot use this method"',
		'      fi',
		'      ;;',
		'    fnm)',
		'      if ! have fnm; then',
		'        info "installing fnm..."',
		'        if have curl; then curl -fsSL https://fnm.vercel.app/install | bash; fi',
		'        export PATH="$HOME/.local/share/fnm:$HOME/.fnm:$PATH"',
		'      fi',
		'      if have fnm; then',
		'        eval "$(fnm env)" 2>/dev/null || true',
		'        case "$CFG_NODE_VERSION" in',
		'          22) fnm install 22 >/dev/null 2>&1 && fnm use 22 >/dev/null 2>&1 ;;',
		'          24) fnm install 24 >/dev/null 2>&1 && fnm use 24 >/dev/null 2>&1 ;;',
		'          *)  fnm install --lts >/dev/null 2>&1 && fnm use lts-latest >/dev/null 2>&1 ;;',
		'        esac',
		'      fi',
		'      ;;',
		'    nodesource)',
		'      info "installing node via NodeSource (requires sudo)..."',
		'      case "$CFG_NODE_VERSION" in',
		'        22) NS=22 ;; 24) NS=24 ;; *) NS=24 ;;',
		'      esac',
		'      if have curl && have sudo; then',
		'        curl -fsSL "https://deb.nodesource.com/setup_${NS}.x" -o /tmp/pi-ship-ns.sh \\',
		'          && sudo -n bash /tmp/pi-ship-ns.sh >/dev/null 2>&1 \\',
		'          && sudo -n apt-get install -y nodejs >/dev/null 2>&1 \\',
		'          && info "node installed system-wide" \\',
		'          || warn "NodeSource install failed (sudo may need a password) — use nvm instead"',
		'      else',
		'        warn "need curl and passwordless sudo for this method"',
		'      fi',
		'      ;;',
		'  esac',
		'  # Re-detect after any install attempt.',
		'  if have node; then',
		'    NODE_BIN="$(command -v node)"; NODE_VERSION="$(node --version 2>/dev/null)"; NODE_OK=yes',
		'    have npm && NPM_OK=yes',
		'    version_ge "$NODE_VERSION" "$PI_NODE_MIN" && NODE_GOOD=yes || NODE_GOOD=no',
		'  fi',
		'fi',
		"",
	);

	// ── step 4: install pi ──────────────────────────────────────────────────
	step(bump(), "install pi if needed");
	L.push(
		'if [ "$PI_OK" = no ] && [ "$CFG_INSTALL_PI" = yes ]; then',
		'  if [ "$NPM_OK" = no ] || [ "$NODE_GOOD" != yes ]; then',
		'    err "cannot install pi: node $PI_NODE_MIN+ and npm are required."',
		'    info "this machine has: node ${NODE_VERSION:-none}"',
		'    info "install a suitable node, then re-run this script."',
		'  else',
		'    # Use the npm that belongs to the node we just selected. On a machine',
		'    # with a root-owned system node, the old npm points its global prefix at',
		'    # /usr/local and fails with EACCES — so fall back to a user-local prefix',
		'    # whenever the default prefix is not writable.',
		'    PI_NPM="npm"',
		'    if [ -n "$NODE_BIN" ] && [ -x "$(dirname "$NODE_BIN")/npm" ]; then',
		'      PI_NPM="$(dirname "$NODE_BIN")/npm"',
		'    fi',
		'    PREFIX="$("$PI_NPM" config get prefix 2>/dev/null || echo /usr/local)"',
		'    PI_PREFIX=""',
		'    if [ ! -w "$PREFIX/lib/node_modules" ] 2>/dev/null; then',
		'      PI_PREFIX="$HOME/.pi-node"',
		'      info "$PREFIX is not writable; installing pi into $PI_PREFIX"',
		'      mkdir -p "$PI_PREFIX" 2>/dev/null || true',
		'    fi',
		'    if [ -n "$PI_PREFIX" ]; then',
		'      doit "$PI_NPM" install -g --prefix "$PI_PREFIX" @earendil-works/pi-coding-agent',
		'    else',
		'      doit "$PI_NPM" install -g @earendil-works/pi-coding-agent',
		'    fi',
		'    # pi lands in the prefix we just installed into; make it visible now.',
		'    if [ -n "$PI_PREFIX" ] && [ -x "$PI_PREFIX/bin/pi" ]; then',
		'      PATH="$PI_PREFIX/bin:$PATH"; export PATH',
		'      CFG_PI_BIN_DIR="$PI_PREFIX/bin"',
		'    fi',
		'    have pi && PI_OK=yes',
		'  fi',
		'fi',
		'if [ "$PI_OK" = no ]; then',
		'  err "pi is not available — the rest of the migration cannot run."',
		'  info "install it, then re-run:"',
		'  info "  npm install -g @earendil-works/pi-coding-agent"',
		'  exit 1',
		'fi',
		"",
	);

	// ── step: extensions ────────────────────────────────────────────────────
	if (m.layers.extensions.length > 0) {
		step(bump(), `install ${m.layers.extensions.length} pinned extension package(s)`);
		L.push(
			"# Versions are pinned to the exact builds on the source machine.",
			"# `pi install` takes ONE source per call; failures are collected, not fatal.",
			"#",
			"# INCREMENTAL: a package this machine already has is left completely",
			"# untouched - not upgraded, not downgraded. `pi install` has no",
			"# already-installed semantics: it rewrites the settings.json entry and",
			"# reinstalls, so applying an older bundle to a newer machine could",
			"# silently downgrade it. Pass --update-existing to upgrade instead.",
			"#",
			"# SOURCE KINDS: pass --kinds=npm,git,url to accept only some of them.",
			"# A declined kind is reported and skipped; nothing is installed for it.",
			'if want extensions; then',
			'  PI_FAILED=(); PI_SKIPPED=(); PI_DECLINED=()',
		);
		for (const e of m.layers.extensions) {
			L.push(
				`  # ${e.source}${e.version ? `  (pinned ${e.version})` : ""}  [kind: ${e.kind}]`,
				`  if ! kind_wanted ${sh(e.kind)}; then`,
				`    info "${e.name} skipped - kind '${e.kind}' declined (--kinds)"; PI_DECLINED+=(${sh(e.name)})`,
				`  elif pkg_installed ${sh(e.name)}; then`,
				'    if [ "$UPDATE_EXISTING" = 1 ]; then',
				`      if doit pi install ${sh(e.spec)}; then :; else PI_FAILED+=(${sh(e.name)}); fi`,
				"    else",
				`      ok "${e.name} (already installed - left as-is)"; PI_SKIPPED+=(${sh(e.name)})`,
				"    fi",
				`  elif doit pi install ${sh(e.spec)}; then :; else PI_FAILED+=(${sh(e.name)}); fi`,
			);
		}
		L.push(
			'  if [[ ${#PI_DECLINED[@]} -gt 0 ]]; then',
			'    info "${#PI_DECLINED[@]} skipped by --kinds (run without it to include them)"',
			"  fi",
			'  if [[ ${#PI_SKIPPED[@]} -gt 0 ]]; then',
			'    info "${#PI_SKIPPED[@]} already present, left untouched (--update-existing upgrades)"',
			"  fi",
			'  if [[ ${#PI_FAILED[@]} -gt 0 ]]; then',
			'    warn "these failed: ${PI_FAILED[*]}"',
			'    info "the rest of the migration continues; re-run to retry."',
			"  fi",
			"fi",
			"",
		);
	}

	// ── step: local extensions ──────────────────────────────────────────────
	if (m.layers.localExtensions.length > 0) {
		step(bump(), `copy ${m.layers.localExtensions.length} local extension file(s)`);
		L.push(
			"# INCREMENTAL: an extension this machine already has is never overwritten.",
			"# A file only this bundle provides is added. When both exist and differ, the",
			"# bundled copy lands as <name>.pi-ship-new for you to diff.",
			'if want extensions; then',
			'  doit mkdir -p "$AGENT_DIR/extensions"',
		);
		for (const le of m.layers.localExtensions) {
			const dest = `"$AGENT_DIR/extensions/${le.bundlePath}"`;
			const incoming = `"$BUNDLE_DIR/extensions/${le.bundlePath}"`;
			L.push(
				`  # ${le.bundlePath}`,
				`  if [ ! -f ${dest} ]; then`,
				`    doit mkdir -p "$(dirname ${dest})"`,
				`    doit cp ${incoming} ${dest}`,
				`  elif cmp -s ${incoming} ${dest}; then`,
				`    ok "extensions/${le.bundlePath} (identical)"`,
				'  elif [ "$UPDATE_EXISTING" = 1 ]; then',
				`    doit cp ${dest} ${dest}.bak-pi-ship`,
				`    doit cp ${incoming} ${dest}`,
				"  else",
				`    doit cp ${incoming} ${dest}.pi-ship-new`,
				`    info "extensions/${le.bundlePath} kept - bundled copy at extensions/${le.bundlePath}.pi-ship-new"`,
				"  fi",
			);
		}
		L.push("fi", "");
	}

	// ── step: providers ─────────────────────────────────────────────────────
	if (m.layers.providers.length > 0) {
		step(bump(), `merge ${m.layers.providers.length} provider definition(s)`);
		L.push(
			"# models.json is MERGED: providers already present are left untouched,",
			"# and a backup is written before any change.",
			'if want providers; then',
			'  if [ ! -f "$AGENT_DIR/models.json" ]; then',
			'    doit cp "$BUNDLE_DIR/config/models.json" "$AGENT_DIR/models.json"',
			"  else",
			'    doit node "$BUNDLE_DIR/bin/merge-models.mjs" "$AGENT_DIR/models.json" "$BUNDLE_DIR/config/models.json"',
			"  fi",
			"fi",
			"",
		);
	}

	// ── step: config files ──────────────────────────────────────────────────
	if (m.layers.configFiles.length > 0) {
		step(bump(), `copy ${m.layers.configFiles.length} config file(s)`);
		L.push(
			"# INCREMENTAL: an existing file is never overwritten. What this machine",
			"# already has wins; the bundled copy is written alongside as",
			"# <name>.pi-ship-new so you can diff it and adopt it by hand.",
			"# Pass --update-existing to overwrite instead (keeping a .bak-pi-ship).",
			'if want config; then',
		);
		for (const c of m.layers.configFiles) {
			const dest = `"$AGENT_DIR/${c.targetRel}"`;
			const incoming = `"$BUNDLE_DIR/config/${c.bundlePath}"`;
			L.push(
				`  # ${c.bundlePath}${c.redacted ? " (secrets redacted to $VARS)" : ""}`,
				`  if [ ! -f ${dest} ]; then`,
				`    doit mkdir -p "$(dirname ${dest})"`,
				`    doit cp ${incoming} ${dest}`,
				`  elif cmp -s ${incoming} ${dest}; then`,
				`    ok "${c.bundlePath} (identical)"`,
				'  elif [ "$UPDATE_EXISTING" = 1 ]; then',
				`    doit cp ${dest} ${dest}.bak-pi-ship`,
				`    doit cp ${incoming} ${dest}`,
				"  else",
				`    doit cp ${incoming} ${dest}.pi-ship-new`,
				`    info "${c.bundlePath} kept - bundled copy at ${c.targetRel}.pi-ship-new (diff it)"`,
				"  fi",
			);
		}
		L.push("fi", "");
	}

	// ── step: settings ──────────────────────────────────────────────────────
	if (Object.keys(m.settings).length > 0) {
		step(bump(), "merge portable settings");
		L.push(
			"# Only portable keys; machine state like lastChangelogVersion is dropped.",
			'doit node "$BUNDLE_DIR/bin/merge-settings.mjs" "$AGENT_DIR/settings.json" "$BUNDLE_DIR/config/settings.json"',
			"",
		);
	}

	// ── step: secrets ───────────────────────────────────────────────────────
	if (m.requiredEnv.length > 0) {
		step(bump(), "secrets");
		L.push(
			"# Values already present in this machine's environment ALWAYS win; the",
			"# bundle only fills in what is missing. Nothing is ever overwritten.",
			'if want secrets && [ "$CFG_SECRETS" = yes ] && [ -s "$BUNDLE_DIR/.secrets.env" ]; then',
			'  if [ ! -f "$ENV_FILE" ]; then doit cp "$BUNDLE_DIR/.secrets.env" "$ENV_FILE"; fi',
			'  doit chmod 600 "$ENV_FILE"',
			'  ok "secrets written to .env (only names absent from this machine)"',
			"fi",
			"",
			"# Report what is still missing, without failing.",
			'ALREADY=(); MISSING=()',
		);
		for (const e of m.requiredEnv) {
			L.push(`if [ -n "\${${e}:-}" ]; then ALREADY+=(${sh(e)}); else MISSING+=(${sh(e)}); fi`);
		}
		L.push(
			'if [ -f "$ENV_FILE" ]; then',
			'  info "a .env exists; load it with:  set -a; . ./.env; set +a"',
			"fi",
			'if [[ ${#ALREADY[@]} -gt 0 ]]; then ok "already set in this shell: ${ALREADY[*]}"; fi',
			'if [[ ${#MISSING[@]} -gt 0 ]]; then',
			'  if [ -f "$ENV_FILE" ] && grep -q "^${MISSING[0]}=" "$ENV_FILE" 2>/dev/null; then',
			'    info "provided by .env but not loaded here: ${MISSING[*]}"',
			'    info "load them with:  set -a; . $ENV_FILE; set +a"',
			'  else',
			'    warn "no value found for: ${MISSING[*]}"',
			'    info "add them to $ENV_FILE; providers using them will fail until then."',
			'  fi',
			'fi',
			"",
		);
	}

	// ── step: PATH ──────────────────────────────────────────────────────────
	step(bump(), "shell PATH (optional)");
	L.push(
		"# The failure this prevents: node installed via nvm is invisible to",
		"# non-interactive shells, so `pi` appears to be missing later.",
		'if [ "$CFG_PATH" = yes ]; then',
		'  NODE_DIR="${CFG_NODE_BIN_DIR:-$(dirname "$NODE_BIN")}"',
		'  # Include the directory pi actually lives in, which may differ from node\'s.',
		'  # Collect the directories that matter, without duplicates: pi and node',
		'  # often share one prefix.',
		'  PATH_DIRS=""',
		'  add_dir() {',
		'    [ -n "$1" ] || return 0',
		'    case ":$PATH_DIRS:" in *":$1:"*) return 0 ;; esac',
		'    if [ -z "$PATH_DIRS" ]; then PATH_DIRS="$1"; else PATH_DIRS="$1:$PATH_DIRS"; fi',
		'  }',
		'  add_dir "${CFG_PI_BIN_DIR:-}"',
		'  add_dir "$NODE_DIR"',
		'  # Write to every profile a future shell might read, so pi is found from',
		'  # login shells, interactive shells, and non-interactive scripts alike.',
		'  MARK="# pi-ship: node/pi on PATH"',
		'  LINE="export PATH=\\\"$PATH_DIRS:\\$PATH\\\""',
		'  PROFILES="$HOME/.profile"',
		'  case "$SHELL" in',
		'    */zsh)  PROFILES="$HOME/.zshenv $HOME/.zshrc" ;;',
		'    */bash) PROFILES="$HOME/.profile $HOME/.bashrc" ;;',
		'  esac',
		'  for PROFILE in $PROFILES; do',
		'    [ -e "$PROFILE" ] || continue',
		'    if grep -qF "$MARK" "$PROFILE" 2>/dev/null; then',
		'      ok "PATH entry already present in $PROFILE"',
		'    elif [ "$DRY_RUN" = 1 ]; then',
		'      printf "  %s[dry-run]%s would add PATH to %s\\n" "$C_DIM" "$C_OFF" "$PROFILE"',
		'    else',
		'      printf "\\n%s\\n%s\\n" "$MARK" "$LINE" >> "$PROFILE"',
		'      ok "added $PATH_DIRS to $PROFILE"',
		'    fi',
		'  done',
		'  case ":$PATH:" in',
		'    *":$PATH_DIRS:"*) : ;;',
		'    *) PATH="$PATH_DIRS:$PATH"; export PATH ;;',
		'  esac',
		'fi',
		"",
	);

	// ── step: verify ────────────────────────────────────────────────────────
	step(bump(), "verify");
	L.push(
		'if [ "$DRY_RUN" = 1 ]; then title "dry run complete — nothing was changed"; exit 0; fi',
		'FAILED=0',
		'checkver() { if [ "$1" = ok ]; then printf "  %s✓%s %s\\n" "$C_OK" "$C_OFF" "$2"; else printf "  %s✗%s %s\\n" "$C_ERR" "$C_OFF" "$2"; FAILED=$((FAILED+1)); fi; }',
		"",
		'have pi && checkver ok "pi: $(pi --version 2>/dev/null | head -1)" || checkver bad "pi not runnable"',
	);

	if (m.layers.extensions.length > 0) {
		L.push(
			"PKG_WANT=0",
			// Only count packages this run actually intends to install: a kind
			// declined via --kinds must not be reported as a missing package.
			...m.layers.extensions.map((e) => `kind_wanted ${sh(e.kind)} && PKG_WANT=$((PKG_WANT+1))`),
			"PKG_GOT=0",
			'if [ -f "$AGENT_DIR/settings.json" ]; then',
			'  PKG_GOT="$(node -e \'try{const s=require(process.argv[1]);console.log((s.packages||[]).length)}catch{console.log(0)}\' "$AGENT_DIR/settings.json" 2>/dev/null || echo 0)"',
			"fi",
			'[ "${PKG_GOT:-0}" -ge "$PKG_WANT" ] && checkver ok "packages: $PKG_GOT configured (wanted $PKG_WANT)" \\',
			'  || checkver bad "packages: $PKG_GOT configured, wanted $PKG_WANT"',
		);
	}

	if (m.layers.localExtensions.length > 0) {
		for (const le of m.layers.localExtensions) {
			L.push(`[ -f "$AGENT_DIR/extensions/${le.bundlePath}" ] && checkver ok "extension ${le.bundlePath}" || checkver bad "extension ${le.bundlePath} missing"`);
		}
	}

	if (m.layers.providers.length > 0) {
		L.push(
			'if [ -f "$AGENT_DIR/models.json" ]; then',
			'  PROV="$(node -e \'try{const m=require(process.argv[1]);console.log(Object.keys(m.providers||{}).join(","))}catch{console.log("")}\' "$AGENT_DIR/models.json" 2>/dev/null || echo "")"',
		);
		for (const p of m.layers.providers) {
			L.push(`  case ",$PROV," in *",${p.name},"*) checkver ok "provider ${p.name}" ;; *) checkver bad "provider ${p.name} missing" ;; esac`);
		}
		L.push("else", '  checkver bad "models.json absent"', "fi");
	}

	L.push(
		"",
		"title \"pi-ship: migration complete\"",
		'if [ "$FAILED" -gt 0 ]; then',
		'  warn "$FAILED check(s) did not pass — see above."',
		"else",
		'  info "all checks passed."',
		"fi",
		'echo',
	);
	if (m.requiredEnv.length > 0) {
		L.push(
			'info "To use the migrated providers, export your secrets, then start pi:"',
			'info "  set -a; . $ENV_FILE; set +a   # or put them in your shell profile"',
		);
	}
	L.push('info "  pi"', 'info "If pi was already running, use /reload instead."', "");

	return L.join("\n");
}

/** Deep-merge shipped providers into an existing models.json. */
export const MERGE_MODELS_MJS = `#!/usr/bin/env node
// pi-ship — merge shipped providers into models.json.
// Existing providers always win: this machine's configuration is preserved.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";

const [target, incoming] = process.argv.slice(2);
if (!target || !incoming) {
  console.error("usage: merge-models.mjs <target-models.json> <incoming-models.json>");
  process.exit(2);
}

const read = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return {}; } };

const t = read(target);
const i = read(incoming);
t.providers ??= {};

const added = [], kept = [];
for (const [name, cfg] of Object.entries(i.providers ?? {})) {
  if (t.providers[name]) { kept.push(name); continue; }
  t.providers[name] = cfg;
  added.push(name);
}

if (added.length === 0) {
  console.log("  = all providers already present; nothing changed");
  process.exit(0);
}

if (existsSync(target)) copyFileSync(target, \`\${target}.bak-pi-ship\`);
writeFileSync(target, JSON.stringify(t, null, 2) + "\\n");
if (added.length) console.log(\`  ~ added providers: \${added.join(", ")}\`);
if (kept.length)  console.log(\`  = left untouched:   \${kept.join(", ")}\`);
console.log(\`  backup: \${target}.bak-pi-ship\`);
`;

/** Merge portable settings keys into an existing settings.json. */
export const MERGE_SETTINGS_MJS = `#!/usr/bin/env node
// pi-ship — merge portable settings keys. Only keys the bundle carries change.
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";

const [target, incoming] = process.argv.slice(2);
if (!target || !incoming) {
  console.error("usage: merge-settings.mjs <target-settings.json> <incoming-settings.json>");
  process.exit(2);
}

const read = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return {}; } };

const t = existsSync(target) ? read(target) : {};
const i = read(incoming);
const changed = [];

for (const [k, v] of Object.entries(i)) {
  if (JSON.stringify(t[k]) === JSON.stringify(v)) continue;
  changed.push(\`\${k}: \${JSON.stringify(t[k])} -> \${JSON.stringify(v)}\`);
  t[k] = v;
}

if (changed.length === 0) { console.log("  = settings already match"); process.exit(0); }

if (existsSync(target)) copyFileSync(target, \`\${target}.bak-pi-ship\`);
writeFileSync(target, JSON.stringify(t, null, 2) + "\\n");
for (const c of changed) console.log(\`  ~ \${c}\`);
`;

export function generateReadme(m: ShipManifest): string {
	const pkgs = m.layers.extensions.map((e) => `- \`${e.spec}\``).join("\n") || "- (none)";
	const provs =
		m.layers.providers
			.map(
				(p) =>
					`- **${p.name}** — ${p.modelCount} models${p.secretKeys.length ? `, needs ${p.secretKeys.map((s) => `\`${s}\``).join(", ")}` : ""}`,
			)
			.join("\n") || "- (providers not included in this bundle)";
	const cfgs =
		m.layers.configFiles.map((c) => `- \`${c.bundlePath}\`${c.redacted ? " (secrets redacted)" : ""}`).join("\n") ||
		"- (none)";
	const locals = m.layers.localExtensions.map((l) => `- \`${l.bundlePath}\``).join("\n") || "- (none)";

	return `# pi-ship bundle

Generated ${m.createdAt} from **${m.source.hostname}** (${m.source.platform}/${m.source.arch}).

| | |
|---|---|
| pi at export | ${m.source.piVersion ?? "unknown"} |
| node at export | ${m.source.nodeVersion} |
| schema | ${m.schemaVersion} |

## Contents

**Extension packages (pinned)**
${pkgs}

**Local extension files**
${locals}

**Providers** ${m.layers.providers.length ? "" : "_(not included)_"}
${provs}

**Config files** ${m.layers.configFiles.length ? "" : "_(not included)_"}
${cfgs}

## Apply

\`\`\`bash
./install.sh --preflight    # see what this machine has
./install.sh --dry-run      # see what would change
./install.sh                # interactive: ask once, then apply
\`\`\`

## Safety

- **Existing values are never overwritten.** Providers, settings and secrets
  already present on the target are left untouched; changed files are backed up
  to \`*.bak-pi-ship\`.
- **No plaintext credentials in the bundle.** Literal secrets found at export
  were replaced with \`$VAR\` references.
- **Idempotent.** Re-running skips satisfied steps.
- **Interactive answers persist** in \`.pi-ship.conf\`; delete it to be asked again.
${
	m.requiredEnv.length
		? `\n## Secrets\n\n${m.requiredEnv.map((e) => `- \`${e}\``).join("\n")}\n\nProvided values are only applied when the name is not already set on the target.\n`
		: ""
}${
		m.warnings.length
			? `\n## Export warnings\n\n${m.warnings.map((w) => `- ${w}`).join("\n")}\n`
			: ""
	}`;
}
/**
 * Emitted as bin/has-package.mjs.
 *
 * Answers "does this machine already have package X?" for the package layer.
 * `pi install <spec>` has no already-installed semantics, so the runbook has to
 * decide for itself; this keeps the settings.json parsing out of bash.
 */
export const HAS_PACKAGE_MJS = `#!/usr/bin/env node
// pi-ship - exit 0 when <settings.json> already lists package <name>.
// Match is by bare package name, ignoring any version or git ref, so an
// installed package counts as present regardless of which version it is.
import { readFileSync } from "node:fs";

const [settingsPath, want] = process.argv.slice(2);
if (!settingsPath || !want) {
  console.error("usage: has-package.mjs <settings.json> <package-name>");
  process.exit(2);
}

// "npm:@scope/pkg@1.2.3" -> "@scope/pkg"; "npm:pkg@1.2.3" -> "pkg";
// "git:github.com/o/r@v1" -> "github.com/o/r"
function bareName(spec) {
  let s = String(spec).replace(/^(npm|git):/, "");
  if (s.startsWith("@")) {
    const slash = s.indexOf("/");
    if (slash < 0) return s;
    return s.slice(0, slash + 1) + s.slice(slash + 1).split("@")[0];
  }
  return s.split("@")[0];
}

let settings;
try {
  settings = JSON.parse(readFileSync(settingsPath, "utf8"));
} catch {
  process.exit(1);
}

const packages = Array.isArray(settings?.packages) ? settings.packages : [];
process.exit(packages.some((p) => bareName(p) === want) ? 0 : 1);
`;
