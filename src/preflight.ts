/**
 * pi-migrate — preflight inspection.
 *
 * Runs BEFORE anything is written. Its job is to answer "can this bundle be
 * applied here, and what would have to happen first?" so the runbook can act
 * automatically instead of failing halfway through.
 *
 * Every check reports one of:
 *   ok       — nothing to do
 *   fixable  — we know how to remedy it automatically
 *   blocked  — the user must intervene
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type CheckStatus = "ok" | "fixable" | "blocked";

export type Check = {
	id: string;
	title: string;
	status: CheckStatus;
	detail: string;
	/** Human-readable remediation, printed when fixable or blocked. */
	remedy?: string;
};

export type PreflightReport = {
	checks: Check[];
	/** True when nothing is blocked. */
	canProceed: boolean;
	/** True when at least one check needs an automated fix step. */
	needsFixes: boolean;
};

export const PI_NODE_MIN = "22.19.0";

/** Compare dotted versions numerically. */
export function versionAtLeast(actual: string, required: string): boolean {
	const a = actual.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
	const r = required.split(".").map((n) => Number.parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(a.length, r.length); i++) {
		const av = a[i] ?? 0;
		const rv = r[i] ?? 0;
		if (av > rv) return true;
		if (av < rv) return false;
	}
	return true;
}

/** Locate the node binary the user would actually want, preferring a version
 *  that satisfies pi. Candidates are probed and ranked rather than
 *  first-match-wins, because a machine usually has several nodes installed
 *  and the one on PATH is often the oldest. */
export function findNode(): { path: string; version: string } | undefined {
	const candidates: string[] = [];
	const home = homedir();

	// nvm keeps versions under a predictable layout
	const nvmDir = process.env.NVM_DIR ?? join(home, ".nvm");
	const nvmVersions = join(nvmDir, "versions", "node");
	if (existsSync(nvmVersions)) {
		try {
			for (const v of readdirSync(nvmVersions)) {
				candidates.push(join(nvmVersions, v, "bin", "node"));
			}
		} catch {
			/* ignore */
		}
	}

	// PATH first, then the usual install locations
	const fromPath = (process.env.PATH ?? "")
		.split(":")
		.filter(Boolean)
		.map((d) => join(d, "node"));
	candidates.push(
		...fromPath,
		"/usr/local/bin/node",
		"/usr/bin/node",
		"/opt/homebrew/bin/node",
		join(home, ".local/bin/node"),
		join(home, ".volta/bin/node"),
		join(home, ".fnm/aliases/default/bin/node"),
	);

	const found: { path: string; version: string }[] = [];
	for (const c of candidates) {
		if (!existsSync(c)) continue;
		try {
			const version = execFileSync(c, ["--version"], { encoding: "utf8" }).trim();
			if (!found.some((f) => f.path === c)) found.push({ path: c, version });
		} catch {
			/* not runnable */
		}
	}
	if (found.length === 0) return undefined;

	// Prefer one that meets pi's minimum; among those, the newest.
	const usable = found.filter((f) => versionAtLeast(f.version, PI_NODE_MIN));
	const pool = usable.length > 0 ? usable : found;
	pool.sort((a, b) => (versionAtLeast(a.version, b.version) ? -1 : 1));
	return pool[0];
}

/**
 * Inspect the target machine. `needNode`/`needPi` are driven by the bundle:
 * we only care about node if we must install pi or run a merge helper.
 */
export function preflight(opts: {
	needNode: boolean;
	needPi: boolean;
	requiredEnv: string[];
	expectedPiVersion?: string;
}): PreflightReport {
	const checks: Check[] = [];
	const home = homedir();
	const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

	// ── platform ────────────────────────────────────────────────────────────
	checks.push({
		id: "platform",
		title: "platform",
		status: "ok",
		detail: `${process.platform}/${process.arch}`,
	});

	// ── node ────────────────────────────────────────────────────────────────
	const node = findNode();
	if (!opts.needNode) {
		checks.push({ id: "node", title: "node", status: "ok", detail: "not required by this bundle" });
	} else if (!node) {
		checks.push({
			id: "node",
			title: "node",
			status: "fixable",
			detail: `not found (pi requires >= ${PI_NODE_MIN})`,
			remedy: "install via nvm (apt's nodejs is too old to run pi)",
		});
	} else if (!versionAtLeast(node.version, PI_NODE_MIN)) {
		checks.push({
			id: "node",
			title: "node",
			status: "fixable",
			detail: `${node.version} at ${node.path} is below pi's minimum ${PI_NODE_MIN}`,
			remedy: "install a newer node via nvm",
		});
	} else {
		checks.push({
			id: "node",
			title: "node",
			status: "ok",
			detail: `${node.version} at ${node.path}`,
		});
	}

	// ── npm ─────────────────────────────────────────────────────────────────
	if (opts.needPi) {
		const npmOk = node
			? existsSync(join(node.path, "..", "npm"))
			: false;
		checks.push({
			id: "npm",
			title: "npm",
			status: node && npmOk ? "ok" : node ? "fixable" : "blocked",
			detail: node && npmOk ? "available next to node" : "not found next to node",
			remedy: node ? undefined : "install node first",
		});
	}

	// ── pi ──────────────────────────────────────────────────────────────────
	if (!opts.needPi) {
		checks.push({ id: "pi", title: "pi", status: "ok", detail: "not required by this bundle" });
	} else {
			let piVersion: string | undefined;
		try {
			piVersion = execFileSync("pi", ["--version"], { encoding: "utf8" }).trim().split("\n")[0];
		} catch {
			piVersion = undefined;
		}
		if (!piVersion) {
			checks.push({
				id: "pi",
				title: "pi",
				status: "fixable",
				detail: "not installed",
				remedy: "npm install -g @earendil-works/pi-coding-agent",
			});
		} else if (opts.expectedPiVersion && !piVersion.includes(opts.expectedPiVersion)) {
			checks.push({
				id: "pi",
				title: "pi",
				status: "ok",
				detail: `installed ${piVersion}, bundle was made with ${opts.expectedPiVersion} (usually fine)`,
			});
		} else {
			checks.push({ id: "pi", title: "pi", status: "ok", detail: `installed ${piVersion}` });
		}
	}

	// ── write permissions ───────────────────────────────────────────────────
	const agentDir = process.env.PI_AGENT_DIR ?? join(home, ".pi", "agent");
	checks.push({
		id: "agentdir",
		title: "agent dir",
		status: "ok",
		detail: existsSync(agentDir) ? `${agentDir} (exists)` : `${agentDir} (will be created)`,
	});

	if (isRoot) {
		checks.push({
			id: "root",
			title: "user",
			status: "fixable",
			detail: "running as root; files would be owned by root",
			remedy: "run as the target user, or pass --owner=<user> so files are chowned",
		});
	} else {
		checks.push({ id: "root", title: "user", status: "ok", detail: `uid ${process.getuid?.() ?? "?"}` });
	}

	// ── PATH visibility of node/pi ───────────────────────────────────────────
	// This is the failure that bit us on a real host: node lives in nvm, is not
	// on the non-interactive PATH, so `pi` is invisible to future shells.
	if (opts.needPi && node) {
		const nodeBinDir = join(node.path, "..");
		const onPath = (process.env.PATH ?? "").split(":").includes(nodeBinDir);
		const shellHasNvm = [".bashrc", ".zshrc", ".zshenv", ".profile"].some((f) => {
			const p = join(home, f);
			if (!existsSync(p)) return false;
			try {
				return readFileSync(p, "utf8").includes("nvm.sh");
			} catch {
				return false;
			}
		});
		checks.push({
			id: "path",
			title: "shell PATH",
			status: onPath || shellHasNvm ? "ok" : "fixable",
			detail:
				onPath || shellHasNvm
					? "node is reachable from new shells"
					: `${nodeBinDir} is not on PATH and no shell profile sources nvm`,
			remedy: `add ${nodeBinDir} to PATH via a shell profile`,
		});
	}

	// ── network reachability of the registry ─────────────────────────────────
	checks.push({
		id: "network",
		title: "npm registry",
		status: "ok",
		detail: "checked at install time (a failure there is reported, not fatal)",
	});

	// ── secrets ─────────────────────────────────────────────────────────────
	if (opts.requiredEnv.length > 0) {
		const missing = opts.requiredEnv.filter((e) => !process.env[e]);
		checks.push({
			id: "secrets",
			title: "secrets",
			status: missing.length === 0 ? "ok" : "fixable",
			detail:
				missing.length === 0
					? `all ${opts.requiredEnv.length} present in the environment`
					: `missing: ${missing.join(", ")}`,
			remedy: missing.length ? "supply them in .env (existing values are never overwritten)" : undefined,
		});
	}

	const canProceed = checks.every((c) => c.status !== "blocked");
	return {
		checks,
		canProceed,
		needsFixes: checks.some((c) => c.status === "fixable"),
	};
}

export function formatPreflight(r: PreflightReport): string {
	const icon = { ok: "✓", fixable: "→", blocked: "✗" } as const;
	const lines = r.checks.map((c) => `  ${icon[c.status]} ${c.title}: ${c.detail}${c.remedy ? `\n      will: ${c.remedy}` : ""}`);
	return [
		r.canProceed ? "preflight: can proceed" : "preflight: BLOCKED",
		...lines,
	].join("\n");
}