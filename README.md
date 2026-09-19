# Pi-Ship

> Snapshot a pi setup — pinned extensions, model providers, user config — into a
> portable bundle, then replay it on another machine with a self-checking,
> interactive runbook.

Moving a pi configuration to a new machine by hand is error-prone: you forget an
extension, you get `@latest` instead of the version you were actually running,
your custom provider config lives in a file you didn't copy.

`pi-ship` captures the **exact** state and turns it into a script you can read
before you run.

## Install

```bash
pi install npm:pi-ship
```

Then:

```
/ship export --providers --config
```

## What it does

**Export** writes a bundle directory:

```
pi-ship-<host>-<date>/
├── install.sh        self-checking runbook (interactive, idempotent)
├── pi-ship.json      manifest: every layer, every pinned version
├── .env.example      which secrets are needed (names only)
├── .secrets.env      values, opt-in only, mode 600, gitignored
├── config/           providers + config files + portable settings
├── extensions/       loose extension sources
├── bin/              zero-dependency merge helpers
└── README.md         human-readable summary of this bundle
```

**Apply** runs `install.sh` on the target:

```bash
./install.sh --preflight   # report what this machine has
./install.sh --dry-run     # show every action, change nothing
./install.sh               # interactive: ask once, then apply
./install.sh --update-existing   # also upgrade what is already here
```

## Layers

Exports are layered so the default is safe:

| Layer | Contents | Default |
|---|---|---|
| L1 | extension packages, pinned to exact installed versions | ✅ always |
| L1b | loose extensions in `~/.pi/agent/extensions/` | ✅ always |
| L2 | model providers from `models.json` | `--providers` |
| L3 | user config files (`web-search.json`, …) | `--config` |
| L4 | portable settings keys (theme, default model, …) | ✅ always |
| L5 | secret **values** | `--with-keys` |

## Incremental by default

`pi-ship` is built for merging into a machine that **already has pi**. Nothing
that already exists is replaced.

| What | Already on the target | Absent |
|---|---|---|
| extension package | **left completely alone** | installed |
| loose extension file | kept; bundled copy as `*.pi-ship-new` | copied |
| provider | kept | added |
| config file | kept; bundled copy as `*.pi-ship-new` | copied |
| settings key | kept | set |
| secret value | kept | filled in |

This matters most for packages. `pi install <spec>` has **no already-installed
semantics** — it rewrites the `settings.json` entry and reinstalls. Applying an
older bundle to a newer machine would therefore silently *downgrade* the
packages that machine already had. So the runbook decides for itself: it derives
the bare package name from each spec (handling `npm:`, `git:`, and `@scope/name`),
checks the target, and only installs what is missing.

```
target already has   rpiv-btw 2.10.1
bundle carries       rpiv-btw 2.10.0
result               rpiv-btw 2.10.1   (untouched, not downgraded)
```

When a file differs, you get the bundled version **beside** yours to compare:

```
~/.pi/agent/sol-pi.json              # yours, untouched
~/.pi/agent/sol-pi.json.pi-ship-new  # what the bundle carried
```

To upgrade things that already exist, opt in explicitly:

```bash
./install.sh --update-existing
```

That flips packages to install-over and config files to overwrite (keeping a
`*.bak-pi-ship` backup). It never applies to secrets — those stay additive,
because overwriting a working credential is a worse failure than leaving it.

## What the runbook handles for you

- **Preflight** — detects pi / node / npm, and crucially compares the node
  version against pi's `>= 22.19.0` requirement instead of just checking presence.
- **Node bootstrap** — if node is missing or too old, offers nvm / fnm /
  NodeSource / npm methods and a version choice (22 LTS / 24 LTS / latest).
  Includes mirror fallbacks, because `raw.githubusercontent.com` is blocked on
  some networks.
- **pi install** — uses the npm belonging to the node you selected, and falls
  back to a user-writable prefix when the system prefix needs root.
- **Shell PATH** — optionally writes a PATH entry to the right profile so `pi`
  resolves in future shells (the failure mode when node lives in nvm).
- **Secrets** — merges additively: a name already set on the target is **never**
  overwritten.
- **Idempotent** — re-running skips satisfied steps.

## Commands

```
/ship help
/ship export [--providers] [--config] [--with-keys] [--out=DIR] [--force]
/ship preflight [<bundle>]
/ship plan <bundle>        # what applying it here would change (writes nothing)
/ship verify <bundle>      # check this machine matches the bundle
/ship inspect <bundle>     # summarise a bundle's contents
```

A `ship` tool is registered too, so the model can drive exports and plans.

## Safety

- **Incremental.** Existing packages, extensions, providers, config files,
  settings keys and secrets are never replaced. See above.
- **No plaintext credentials in the bundle.** Literal secrets found at export are
  replaced with `$VAR` references; names go to `.env.example`.
  `auth.json`, `trust.json`, `models-store.json` and sessions are never shipped.
- **Nothing is overwritten.** `models.json` and `settings.json` are merged;
  existing providers and keys win. Conflicting files land as `*.pi-ship-new`.
- **Secrets are additive.** An existing value on the target always wins.
- **Version-pinned.** Installed versions are captured, not `@latest`;
  git packages are pinned to a commit.
- **Reviewable.** The runbook is generated bash with numbered steps, and supports
  `--dry-run` and `--only=<layer>`.
- **Reversible.** Every step is a plain filesystem or `pi install` operation.

## Verified on real machines

Tested end-to-end against clean hosts with no pi installed:

- **Ubuntu 24.04, node 18.19.1 only** — preflight correctly flagged node as below
  pi's minimum; the runbook installed node 24 via the npm method (GitHub raw was
  unreachable), installed pi 0.85.1 into a user prefix, installed all 11 pinned
  extensions, migrated providers/config/settings, and `pi -p` then returned a real
  completion **through the migrated provider**. Re-running was idempotent.
- **Ubuntu 22.04, no node, no npm** — the nvm path was exercised end to end.

If you find a host where it does not work, please open an issue with the output
of `./install.sh --preflight`.

## Limitations

- OAuth-backed providers (`openai-codex`) need a fresh `/login` on the target;
  their tokens live in `auth.json`, which is never shipped.
- Incremental application means the result is a **union** with what the target
  already had, not a strict snapshot of the source machine. A strict snapshot
  would need `pi uninstall`, which deletes things the user may want — the
  opposite of the intended safety property. Use `--update-existing` to at least
  move shared packages to the bundle's pinned versions.
- Only user-level `~/.pi/agent/` is collected; project-local `.pi/` is not.
- bash does not read profile files in non-interactive mode, so
  `ssh host 'pi ...'` may not find `pi`. Use `ssh host 'bash -lc "pi ..."'`.

## Development

```bash
git clone https://github.com/zhangshuoming/pi-ship
cd pi-ship
pi -e ./src/index.ts     # load without installing
./test.sh                # self-test: secret leaks, fresh-machine apply, idempotency
```

See [MIGRATION.md](./MIGRATION.md) for the full operator guide.

## License

MIT