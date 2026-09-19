/**
 * pi-migrate — reading and verifying bundles.
 *
 * `plan` is the safe half: it never writes anything, only reports the
 * difference between a bundle and the current machine. `verify` runs after an
 * apply to confirm the target actually matches.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_DIR, parseNpmSpec, readSettings } from "./collect.ts";
import type { ShipManifest } from "./types.ts";

export function readManifest(bundleDir: string): ShipManifest {
	const p = join(bundleDir, "pi-ship.json");
	if (!existsSync(p)) throw new Error(`not a pi-migrate bundle (missing pi-ship.json): ${bundleDir}`);
	const m = JSON.parse(readFileSync(p, "utf8")) as ShipManifest;
	if (m.schemaVersion !== 1) {
		throw new Error(`unsupported bundle schema: ${m.schemaVersion} (this tool understands 1)`);
	}
	return m;
}

export type PlanItem = {
	layer: "extensions" | "localExtensions" | "providers" | "configFiles" | "settings";
	target: string;
	action: "install" | "update" | "copy" | "merge" | "skip";
	detail: string;
};

export type Plan = {
	bundle: string;
	items: PlanItem[];
	requiredEnv: string[];
	/** env vars referenced by the bundle that are not set on this machine. */
	missingEnv: string[];
	conflicts: string[];
};

/** Compute what applying this bundle to the current machine would do. */
export function planBundle(bundleDir: string): Plan {
	const m = readManifest(bundleDir);
	const items: PlanItem[] = [];
	const conflicts: string[] = [];
	const settings = readSettings();
	const installed = new Set(
		(Array.isArray(settings.packages) ? (settings.packages as string[]) : []).map((s) => s),
	);

	// extensions
	const installedNames = new Map<string, string>();
	for (const spec of installed) {
		if (typeof spec !== "string" || !spec.startsWith("npm:")) continue;
		const { name } = parseNpmSpec(spec);
		const pkgJson = join(AGENT_DIR, "npm", "node_modules", name, "package.json");
		if (existsSync(pkgJson)) {
			try {
				installedNames.set(name, JSON.parse(readFileSync(pkgJson, "utf8")).version);
			} catch {
				installedNames.set(name, "?");
			}
		}
	}

	for (const e of m.layers.extensions) {
		if (e.kind === "npm") {
			const cur = installedNames.get(e.name);
			if (!cur) {
				items.push({ layer: "extensions", target: e.spec, action: "install", detail: "not installed" });
			} else if (e.version && cur !== e.version) {
				items.push({
					layer: "extensions",
					target: e.spec,
					action: "update",
					detail: `${cur} -> ${e.version}`,
				});
			} else {
				items.push({
					layer: "extensions",
					target: e.spec,
					action: "skip",
					detail: `already at ${cur}`,
				});
			}
		} else {
			const present = installed.has(e.source);
			items.push({
				layer: "extensions",
				target: e.spec,
				action: present ? "skip" : "install",
				detail: present ? "already configured" : "git package",
			});
		}
	}

	// local extensions
	for (const le of m.layers.localExtensions) {
		const dest = join(AGENT_DIR, "extensions", le.bundlePath);
		if (!existsSync(dest)) {
			items.push({ layer: "localExtensions", target: le.bundlePath, action: "copy", detail: "missing" });
		} else if (readFileSync(dest, "utf8") === le.content) {
			items.push({ layer: "localExtensions", target: le.bundlePath, action: "skip", detail: "identical" });
		} else {
			items.push({
				layer: "localExtensions",
				target: le.bundlePath,
				action: "copy",
				detail: "differs — will be overwritten",
			});
			conflicts.push(`extensions/${le.bundlePath} exists and differs`);
		}
	}

	// providers
	const modelsPath = join(AGENT_DIR, "models.json");
	let existingProviders = new Set<string>();
	if (existsSync(modelsPath)) {
		try {
			const mp = JSON.parse(readFileSync(modelsPath, "utf8"));
			existingProviders = new Set(Object.keys(mp.providers ?? {}));
		} catch {
			conflicts.push("models.json is not valid JSON; merge will refuse to run");
		}
	}
	for (const p of m.layers.providers) {
		const has = existingProviders.has(p.name);
		items.push({
			layer: "providers",
			target: p.name,
			action: has ? "skip" : "merge",
			detail: has ? `already defined (${p.modelCount} models)` : `add ${p.modelCount} models`,
		});
	}

	// config files
	for (const c of m.layers.configFiles) {
		const dest = join(AGENT_DIR, c.targetRel);
		if (!existsSync(dest)) {
			items.push({ layer: "configFiles", target: c.bundlePath, action: "copy", detail: "missing" });
		} else if (readFileSync(dest, "utf8") === c.content) {
			items.push({ layer: "configFiles", target: c.bundlePath, action: "skip", detail: "identical" });
		} else {
			items.push({
				layer: "configFiles",
				target: c.bundlePath,
				action: "copy",
				detail: "differs — will be overwritten",
			});
			conflicts.push(`${c.bundlePath} exists and differs`);
		}
	}

	// settings
	for (const [k, v] of Object.entries(m.settings)) {
		const cur = settings[k];
		if (JSON.stringify(cur) === JSON.stringify(v)) {
			items.push({ layer: "settings", target: k, action: "skip", detail: "already set" });
		} else {
			items.push({
				layer: "settings",
				target: k,
				action: "merge",
				detail: `${JSON.stringify(cur)} -> ${JSON.stringify(v)}`,
			});
		}
	}

	const missingEnv = m.requiredEnv.filter((e) => !process.env[e]);

	return { bundle: bundleDir, items, requiredEnv: m.requiredEnv, missingEnv, conflicts };
}

export type VerifyResult = {
	ok: boolean;
	checks: { name: string; ok: boolean; detail: string }[];
};

/** Post-apply verification against the live machine. */
export function verifyBundle(bundleDir: string): VerifyResult {
	const m = readManifest(bundleDir);
	const checks: VerifyResult["checks"] = [];
	const settings = readSettings();
	const configured = new Set(
		(Array.isArray(settings.packages) ? (settings.packages as string[]) : []).filter(
			(s): s is string => typeof s === "string",
		),
	);

	for (const e of m.layers.extensions) {
		const name = e.kind === "npm" ? e.name : e.name;
		const configuredNow = [...configured].some((s) => s.includes(name));
		checks.push({
			name: `package ${name}`,
			ok: configuredNow,
			detail: configuredNow ? "configured in settings.json" : "NOT configured",
		});
	}

	for (const le of m.layers.localExtensions) {
		const dest = join(AGENT_DIR, "extensions", le.bundlePath);
		const same = existsSync(dest) && readFileSync(dest, "utf8") === le.content;
		checks.push({
			name: `extension ${le.bundlePath}`,
			ok: same,
			detail: same ? "matches bundle" : "missing or differs",
		});
	}

	const modelsPath = join(AGENT_DIR, "models.json");
	let providers: Record<string, unknown> = {};
	if (existsSync(modelsPath)) {
		try {
			providers = JSON.parse(readFileSync(modelsPath, "utf8")).providers ?? {};
		} catch {
			/* reported by the check below */
		}
	}
	for (const p of m.layers.providers) {
		checks.push({
			name: `provider ${p.name}`,
			ok: p.name in providers,
			detail: p.name in providers ? "present in models.json" : "MISSING",
		});
	}

	for (const c of m.layers.configFiles) {
		const dest = join(AGENT_DIR, c.targetRel);
		const same = existsSync(dest) && readFileSync(dest, "utf8") === c.content;
		checks.push({
			name: `config ${c.bundlePath}`,
			ok: same,
			detail: same ? "matches bundle" : "missing or differs",
		});
	}

	for (const e of m.requiredEnv) {
		const set = Boolean(process.env[e]);
		checks.push({
			name: `env ${e}`,
			ok: set,
			detail: set ? "set" : "NOT set (providers will fail until provided)",
		});
	}

	return { ok: checks.every((c) => c.ok), checks };
}

export function formatPlan(plan: Plan): string {
	const byLayer = new Map<string, PlanItem[]>();
	for (const it of plan.items) {
		const arr = byLayer.get(it.layer) ?? [];
		arr.push(it);
		byLayer.set(it.layer, arr);
	}
	const icon = { install: "+", update: "^", copy: ">", merge: "~", skip: "=" } as const;
	const out: string[] = [
		`pi-migrate plan for ${plan.bundle}`,
		`target: ${AGENT_DIR}`,
		"",
	];
	for (const [layer, items] of byLayer) {
		out.push(`${layer}:`);
		for (const it of items) {
			out.push(`  [${icon[it.action]}] ${it.target} — ${it.detail}`);
		}
		out.push("");
	}
	if (plan.missingEnv.length > 0) {
		out.push(`missing env vars: ${plan.missingEnv.join(", ")}`, "");
	}
	if (plan.conflicts.length > 0) {
		out.push("destructive (existing files would be overwritten):");
		for (const c of plan.conflicts) out.push(`  ! ${c}`);
		out.push("");
	}
	const actionable = plan.items.filter((i) => i.action !== "skip").length;
	out.push(`${actionable} action(s) needed, ${plan.items.length - actionable} already satisfied.`);
	return out.join("\n");
}