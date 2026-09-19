/**
 * pi-migrate — bundle writer.
 *
 * Materialises a manifest into a bundle directory.
 *
 * Two files deserve comment:
 *
 *   .secrets.env   Only written when the user explicitly opted into carrying
 *                  secret *values*. The runbook applies it additively — a name
 *                  already set on the target is never overwritten. Mode 600.
 *
 *   .pi-ship.conf  Where the runbook stores interactive answers, so a second
 *                  run does not ask again.
 *
 * macOS resource-fork siblings (`._name`) are never written; they are metadata
 * debris that confuses `tar` on Linux targets.
 */

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildEnvExample, buildMigratedEnvFile, planSecretMigration } from "./secrets.ts";
import {
	generateReadme,
	generateRunbook,
	MERGE_MODELS_MJS,
	MERGE_SETTINGS_MJS,
} from "./runbook.ts";
import type { ShipManifest } from "./types.ts";

export type WriteResult = {
	dir: string;
	files: string[];
	/** Names whose values were carried in .secrets.env (opt-in only). */
	carriedSecrets: string[];
};

export type WriteOptions = {
	force?: boolean;
	/**
	 * Secret values to carry, keyed by env var name. Empty by default: the
	 * bundle then only names the variables and the user supplies them.
	 */
	secrets?: Record<string, string>;
};

export async function writeBundle(
	m: ShipManifest,
	outDir: string,
	opts: WriteOptions = {},
): Promise<WriteResult> {
	if (existsSync(outDir)) {
		if (!opts.force) {
			throw new Error(`output directory already exists: ${outDir} (pass force to overwrite)`);
		}
		rmSync(outDir, { recursive: true, force: true });
	}

	const files: string[] = [];
	const track = (p: string) => files.push(p.slice(outDir.length + 1));

	mkdirSync(outDir, { recursive: true });
	mkdirSync(join(outDir, "config"), { recursive: true });
	mkdirSync(join(outDir, "bin"), { recursive: true });

	// ── manifest ────────────────────────────────────────────────────────────
	const manifestPath = join(outDir, "pi-ship.json");
	writeFileSync(manifestPath, `${JSON.stringify(m, null, 2)}\n`);
	track(manifestPath);

	// ── runbook ─────────────────────────────────────────────────────────────
	const runbookPath = join(outDir, "install.sh");
	writeFileSync(runbookPath, generateRunbook(m));
	chmodSync(runbookPath, 0o755);
	track(runbookPath);

	// ── helpers ─────────────────────────────────────────────────────────────
	writeFileSync(join(outDir, "bin", "merge-models.mjs"), MERGE_MODELS_MJS);
	track(join(outDir, "bin", "merge-models.mjs"));
	writeFileSync(join(outDir, "bin", "merge-settings.mjs"), MERGE_SETTINGS_MJS);
	track(join(outDir, "bin", "merge-settings.mjs"));

	// ── env templates ───────────────────────────────────────────────────────
	const envExample = join(outDir, ".env.example");
	writeFileSync(envExample, buildEnvExample(m.requiredEnv));
	track(envExample);

	const carriedSecrets: string[] = [];
	if (opts.secrets && Object.keys(opts.secrets).length > 0) {
		// Values are written unconditionally here: the *decision* about whether a
		// name may be written belongs to the target machine (it knows what it
		// already has). `planSecretMigration` with an empty target marks every
		// non-empty value as "set", which is what we want for the payload file.
		const plans = planSecretMigration(opts.secrets, {});
		const envFile = join(outDir, ".secrets.env");
		writeFileSync(envFile, buildMigratedEnvFile(plans));
		chmodSync(envFile, 0o600);
		track(envFile);
		for (const p of plans) if (p.action === "set") carriedSecrets.push(p.name);
	}

	// ── config files ────────────────────────────────────────────────────────
	for (const c of m.layers.configFiles) {
		const p = join(outDir, "config", c.bundlePath);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, c.content);
		track(p);
	}

	// ── providers ───────────────────────────────────────────────────────────
	if (m.layers.providers.length > 0) {
		const providers: Record<string, unknown> = {};
		for (const p of m.layers.providers) providers[p.name] = p.config;
		const p = join(outDir, "config", "models.json");
		writeFileSync(p, `${JSON.stringify({ providers }, null, 2)}\n`);
		track(p);
	}

	// ── settings ────────────────────────────────────────────────────────────
	if (Object.keys(m.settings).length > 0) {
		const p = join(outDir, "config", "settings.json");
		writeFileSync(p, `${JSON.stringify(m.settings, null, 2)}\n`);
		track(p);
	}

	// ── local extensions ────────────────────────────────────────────────────
	for (const le of m.layers.localExtensions) {
		const p = join(outDir, "extensions", le.bundlePath);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, le.content);
		track(p);
	}

	// ── docs / hygiene ──────────────────────────────────────────────────────
	writeFileSync(join(outDir, "README.md"), generateReadme(m));
	track(join(outDir, "README.md"));

	// A bundle may legitimately contain secret values, so exclude them plus the
	// interactive answers and any backups from version control.
	writeFileSync(
		join(outDir, ".gitignore"),
		["# never commit real credentials or machine-specific state", ".env", ".secrets.env", ".pi-ship.conf", "*.bak-pi-migrate", ""].join("\n"),
	);
	track(join(outDir, ".gitignore"));

	return { dir: outDir, files, carriedSecrets };
}