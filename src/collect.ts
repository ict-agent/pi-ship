/**
 * pi-ship — collection.
 *
 * Reads the *live* pi install and turns it into a manifest. Everything here is
 * read-only: collection must never mutate the user's config.
 *
 * Version resolution strategy for npm packages:
 *   1. look up node_modules/<name>/package.json  -> exact installed version
 *   2. fall back to a lockfile entry
 *   3. fall back to whatever the user's spec said (may be a range like @latest)
 *
 * Step 3 is why we warn: a spec of `npm:foo@latest` is *not* a pinned version,
 * and shipping it means the target machine gets a different build than this one.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir, hostname, platform, arch } from "node:os";
import { basename, join, relative } from "node:path";
import {
	DEFAULT_CONFIG_FILES,
	NEVER_SHIP,
	SHIPPABLE_SETTINGS,
	type ConfigFileEntry,
	type ExportOptions,
	type LocalExtension,
	type PackageSpec,
	type ProviderEntry,
	type ShipManifest,
} from "./types.ts";
import { redactConfig, redactText } from "./secrets.ts";

export const AGENT_DIR = join(homedir(), ".pi", "agent");

function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

export function readSettings(): Record<string, unknown> {
	return readJson<Record<string, unknown>>(join(AGENT_DIR, "settings.json")) ?? {};
}

/** Detect the installed pi version from the global npm tree. */
export function detectPiVersion(): string | undefined {
	const candidates = [
		join(homedir(), ".local/lib/node_modules/@earendil-works/pi-coding-agent/package.json"),
		"/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/package.json",
		"/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/package.json",
	];
	for (const c of candidates) {
		const p = readJson<{ version?: string }>(c);
		if (p?.version) return p.version;
	}
	return undefined;
}

/** Where pi keeps packages installed via `pi install`. */
function npmRoot(): string {
	return join(AGENT_DIR, "npm", "node_modules");
}

function gitRoot(): string {
	return join(AGENT_DIR, "git");
}

/** Read the version of an installed npm package by name. */
function installedNpmVersion(name: string): string | undefined {
	const pkgJson = join(npmRoot(), name, "package.json");
	const p = readJson<{ version?: string }>(pkgJson);
	return p?.version;
}

/** Split `npm:@scope/name@1.2.3` into its pieces. */
export function parseNpmSpec(spec: string): { name: string; range?: string } {
	const body = spec.slice(4);
	// Scoped: @scope/name[@range]
	if (body.startsWith("@")) {
		const at = body.indexOf("@", 1);
		if (at === -1) return { name: body };
		return { name: body.slice(0, at), range: body.slice(at + 1) };
	}
	const at = body.indexOf("@");
	if (at === -1) return { name: body };
	return { name: body.slice(0, at), range: body.slice(at + 1) };
}

/** Split `git:github.com/user/repo@ref` into its pieces. */
export function parseGitSpec(spec: string): { repo: string; ref?: string } {
	const body = spec.slice(4);
	const at = body.lastIndexOf("@");
	if (at === -1) return { repo: body };
	return { repo: body.slice(0, at), ref: body.slice(at + 1) };
}

/** Try to resolve the checked-out commit of a git-installed package. */
function gitHead(repo: string): string | undefined {
	const dir = join(gitRoot(), repo);
	if (!existsSync(dir)) return undefined;
	const head = readJson<never>(join(dir, ".git")) as never;
	void head;
	try {
		// .git can be a file (worktree) or dir; shelling out is the robust path
		// but collection should stay dependency-free, so read packed-refs.
		const gitDir = existsSync(join(dir, ".git", "HEAD"))
			? join(dir, ".git")
			: undefined;
		if (!gitDir) return undefined;
		const h = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
		if (h.startsWith("ref: ")) {
			const ref = h.slice(5);
			const loose = join(gitDir, ref);
			if (existsSync(loose)) return readFileSync(loose, "utf8").trim();
			const packed = join(gitDir, "packed-refs");
			if (existsSync(packed)) {
				for (const line of readFileSync(packed, "utf8").split("\n")) {
					const [sha, name] = line.trim().split(" ");
					if (name === ref) return sha;
				}
			}
			return undefined;
		}
		return h;
	} catch {
		return undefined;
	}
}

/**
 * Collect the package list from settings.json, resolving each to a pinned spec.
 * The returned spec is what the runbook will run — already pinned where we
 * could pin it.
 */
export function collectPackages(warnings: string[]): PackageSpec[] {
	const settings = readSettings();
	const specs = Array.isArray(settings.packages) ? (settings.packages as string[]) : [];
	const out: PackageSpec[] = [];

	for (const raw of specs) {
		if (typeof raw !== "string") continue;

		if (raw.startsWith("npm:")) {
			const { name, range } = parseNpmSpec(raw);
			const installed = installedNpmVersion(name);
			if (!installed) {
				warnings.push(`npm package not found in ${npmRoot()}: ${name} (keeping original spec)`);
			}
			// Prefer the exact installed version. This is the whole point of the
			// tool: the target machine should reproduce this machine, not "latest".
			const pinned = installed ? `${name}@${installed}` : name + (range ? `@${range}` : "");
			if (!installed && (range === "latest" || range === undefined)) {
				warnings.push(`unpinned npm spec: ${raw} — target machine may get a different build`);
			}
			out.push({
				spec: `npm:${pinned}`,
				kind: "npm",
				name,
				version: installed,
				source: raw,
			});
			continue;
		}

		if (raw.startsWith("git:")) {
			const { repo, ref } = parseGitSpec(raw);
			const head = gitHead(repo);
			const pinnedRef = ref ?? head?.slice(0, 12);
			if (!pinnedRef) {
				warnings.push(`git package has no resolvable ref: ${raw}`);
			}
			out.push({
				spec: pinnedRef ? `git:${repo}@${pinnedRef}` : raw,
				kind: "git",
				name: repo,
				ref: pinnedRef,
				source: raw,
			});
			continue;
		}

		warnings.push(`unrecognised package spec: ${raw}`);
	}

	// Local extensions configured via settings.extensions (absolute paths).
	const localPaths = Array.isArray(settings.extensions) ? (settings.extensions as string[]) : [];
	for (const p of localPaths) {
		if (typeof p === "string") {
			warnings.push(`settings.extensions path is machine-specific and not shipped: ${p}`);
		}
	}

	return out;
}

/** Collect loose extensions from ~/.pi/agent/extensions/. */
export function collectLocalExtensions(): LocalExtension[] {
	const dir = join(AGENT_DIR, "extensions");
	if (!existsSync(dir)) return [];
	const out: LocalExtension[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry.startsWith(".")) continue;
		// macOS resource-fork siblings (`._foo`) are metadata, not source.
		if (entry.startsWith("._")) continue;
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isFile() && /\.(ts|js|mts|mjs)$/.test(entry)) {
			out.push({
				source: full,
				bundlePath: entry,
				content: readFileSync(full, "utf8"),
			});
		} else if (st.isDirectory() && existsSync(join(full, "index.ts"))) {
			out.push({
				source: full,
				bundlePath: `${entry}/index.ts`,
				content: readFileSync(join(full, "index.ts"), "utf8"),
			});
		}
	}
	return out;
}

/** Collect providers from models.json, redacting secrets. */
export function collectProviders(
	opts: ExportOptions,
	warnings: string[],
): ProviderEntry[] {
	if (!opts.providers) return [];
	const models = readJson<{ providers?: Record<string, Record<string, unknown>> }>(
		join(AGENT_DIR, "models.json"),
	);
	if (!models?.providers) {
		warnings.push("models.json has no providers section; nothing to ship");
		return [];
	}

	const wanted = opts.providerNames?.length ? new Set(opts.providerNames) : undefined;
	const out: ProviderEntry[] = [];

	for (const [name, config] of Object.entries(models.providers)) {
		if (wanted && !wanted.has(name)) continue;
		const r = redactConfig(config, name);
		for (const u of r.unresolved) {
			warnings.push(`could not confidently redact ${u}; review before committing the bundle`);
		}
		const modelCount = Array.isArray(config.models) ? (config.models as unknown[]).length : 0;
		out.push({
			name,
			config: r.config,
			secretKeys: r.envNames,
			modelCount,
		});
	}
	return out;
}

/** Collect opted-in config files, redacting each. */
export function collectConfigFiles(
	opts: ExportOptions,
	warnings: string[],
): ConfigFileEntry[] {
	if (!opts.configFiles) return [];
	const names = opts.configFileNames?.length
		? opts.configFileNames
		: [...DEFAULT_CONFIG_FILES];

	const out: ConfigFileEntry[] = [];
	for (const n of names) {
		if ((NEVER_SHIP as readonly string[]).includes(n)) {
			warnings.push(`refused to ship ${n}: it contains credentials or machine state`);
			continue;
		}
		const src = join(AGENT_DIR, n);
		if (!existsSync(src)) {
			warnings.push(`config file not found, skipped: ${n}`);
			continue;
		}
		const raw = readFileSync(src, "utf8");
		const label = basename(n, ".json");
		const r = redactText(raw, label);
		out.push({
			source: src,
			bundlePath: n,
			targetRel: n,
			content: r.text,
			redacted: r.changed,
		});
	}
	return out;
}

/** Filter settings.json down to the portable keys. */
export function collectSettings(): Record<string, unknown> {
	const settings = readSettings();
	const out: Record<string, unknown> = {};
	for (const k of SHIPPABLE_SETTINGS) {
		if (k in settings) out[k] = settings[k];
	}
	return out;
}

/** Build the full manifest. */
export function collect(opts: ExportOptions): ShipManifest {
	const warnings: string[] = [];
	const extensions = collectPackages(warnings);
	const localExtensions = collectLocalExtensions();
	const providers = collectProviders(opts, warnings);
	const configFiles = collectConfigFiles(opts, warnings);
	const settings = collectSettings();

	const requiredEnv = new Set<string>();
	for (const p of providers) for (const k of p.secretKeys) requiredEnv.add(k);

	return {
		schemaVersion: 1,
		createdAt: new Date().toISOString(),
		source: {
			hostname: hostname(),
			platform: platform(),
			arch: arch(),
			piVersion: detectPiVersion(),
			nodeVersion: process.version,
		},
		layers: { extensions, localExtensions, providers, configFiles },
		settings,
		requiredEnv: [...requiredEnv],
		warnings,
	};
}

export function relFromAgent(p: string): string {
	return relative(AGENT_DIR, p);
}