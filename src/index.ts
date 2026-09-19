/**
 * pi-ship — pi extension entry point.
 *
 * Commands:
 *   /ship export [--providers] [--config] [--out DIR]
 *   /ship plan <bundle-dir>
 *   /ship verify <bundle-dir>
 *   /ship inspect <bundle-dir>       # show what a bundle contains, no target needed
 *
 * Also registers a `ship` tool so the model can drive exports/plans itself.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { collect } from "./collect.ts";
import { formatPlan, planBundle, readManifest, verifyBundle } from "./bundle.ts";
import { writeBundle } from "./writer.ts";
import { findNode, formatPreflight, preflight, PI_NODE_MIN } from "./preflight.ts";
import type { ExportOptions } from "./types.ts";

type ParsedArgs = {
	positional: string[];
	flags: Set<string>;
	values: Map<string, string>;
};

function parseArgs(raw: string): ParsedArgs {
	const parts = raw.trim().split(/\s+/).filter(Boolean);
	const positional: string[] = [];
	const flags = new Set<string>();
	const values = new Map<string, string>();
	for (const p of parts) {
		if (p.startsWith("--")) {
			const eq = p.indexOf("=");
			if (eq === -1) {
				flags.add(p.slice(2));
			} else {
				values.set(p.slice(2, eq), p.slice(eq + 1));
			}
		} else {
			positional.push(p);
		}
	}
	return { positional, flags, values };
}

function defaultOutDir(): string {
	const stamp = new Date().toISOString().slice(0, 10);
	const host = homedir().split("/").pop() ?? "machine";
	return resolve(process.cwd(), `pi-ship-${host}-${stamp}`);
}

/**
 * Gather the values for the secret names a bundle needs, straight from this
 * process's environment. This is what makes "carry my keys" possible without
 * ever putting them in a repo by accident: the values live only in
 * `.secrets.env`, which is gitignored and mode 600.
 */
function gatherSecrets(names: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const n of names) {
		const v = process.env[n];
		if (v) out[n] = v;
	}
	return out;
}

export default function (pi: ExtensionAPI) {
	// One handler, two names: `/ship` is the short form, `/migrate` matches the
	// package name. Both are discoverable via pi's command list.
	const commandHandler = async (args: string, ctx: ExtensionCommandContext) => {
			const [sub = "help", ...rest] = parseArgs(args).positional;
			const parsed = parseArgs(args);

			if (sub === "help") {
				ctx.ui.notify(
					[
						"/ship export [--providers] [--config] [--with-keys] [--out=DIR]",
						"  snapshot extensions (default); --providers/--config add optional layers",
						"  --with-keys carries secret VALUES, applied additively on the target",
						"/ship preflight [<bundle>] — is this machine ready to receive a bundle?",
						"/ship plan <bundle>     — what applying it here would change (writes nothing)",
						"/ship verify <bundle>   — check this machine matches the bundle",
						"/ship inspect <bundle>  — summarise a bundle's contents",
					].join("\n"),
					"info",
				);
				return;
			}

			if (sub === "export") {
				const outDir = parsed.values.get("out") ?? defaultOutDir();
				const opts: ExportOptions = {
					outDir,
					providers: parsed.flags.has("providers"),
					configFiles: parsed.flags.has("config"),
					providerNames: parsed.values.get("provider")?.split(","),
					configFileNames: parsed.values.get("file")?.split(","),
				};

				const manifest = collect(opts);
				// --with-keys carries secret *values*; the target only ever applies
				// the ones it does not already have.
				const carryKeys = parsed.flags.has("with-keys");
				const secrets = carryKeys ? gatherSecrets(manifest.requiredEnv) : {};
				const result = await writeBundle(manifest, outDir, {
					force: parsed.flags.has("force"),
					secrets,
				});

				const missing = manifest.requiredEnv.filter((n) => !secrets[n]);
				ctx.ui.notify(
					[
						`bundle written: ${result.dir}`,
						[
							`${manifest.layers.extensions.length} packages`,
							`${manifest.layers.localExtensions.length} local extensions`,
							opts.providers ? `${manifest.layers.providers.length} providers` : "providers: not included",
							opts.configFiles ? `${manifest.layers.configFiles.length} config files` : "config: not included",
						].join(" · "),
						carryKeys
							? `secrets carried: ${result.carriedSecrets.join(", ") || "(none found in env)"}`
							: "secrets: names only (re-run with --with-keys to carry values)",
						missing.length ? `not found in env: ${missing.join(", ")}` : "",
						manifest.warnings.length ? `⚠ ${manifest.warnings.length} warning(s) — see README.md` : "",
					]
						.filter(Boolean)
						.join("\n"),
					manifest.warnings.length ? "warning" : "info",
				);
				return;
			}

			if (sub === "preflight") {
				const dir = rest[0] ?? parsed.values.get("dir");
				const bundleDir = dir ? resolve(dir) : undefined;
				const m = bundleDir && existsSync(join(bundleDir, "pi-ship.json")) ? readManifest(bundleDir) : undefined;
				const node = findNode();
				const report = preflight({
					needNode: true,
					needPi: true,
					requiredEnv: m?.requiredEnv ?? [],
					expectedPiVersion: m?.source.piVersion,
				});
				ctx.ui.notify(
					[
						"preflight for this machine:",
						formatPreflight(report),
						"",
						`pi requires node >= ${PI_NODE_MIN}; found: ${node ? `${node.version} (${node.path})` : "none"}`,
					].join("\n"),
					report.canProceed ? "info" : "error",
				);
				return;
			}

			if (sub === "plan" || sub === "verify" || sub === "inspect") {
				const dir = rest[0] ?? parsed.values.get("dir");
				if (!dir) {
					ctx.ui.notify(`usage: /ship ${sub} <bundle-dir>`, "error");
					return;
				}
				const bundleDir = resolve(dir);
				if (!existsSync(join(bundleDir, "pi-ship.json"))) {
					ctx.ui.notify(`not a pi-ship bundle: ${bundleDir}`, "error");
					return;
				}

				if (sub === "plan") {
					ctx.ui.notify(formatPlan(planBundle(bundleDir)), "info");
					return;
				}

				if (sub === "verify") {
					const r = verifyBundle(bundleDir);
					const failed = r.checks.filter((c) => !c.ok);
					ctx.ui.notify(
						[
							r.ok ? "✓ this machine matches the bundle" : `✗ ${failed.length} check(s) failed`,
							...r.checks.map((c) => `  ${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`),
						].join("\n"),
						r.ok ? "info" : "warning",
					);
					return;
				}

				// inspect
				const m = readManifest(bundleDir);
				ctx.ui.notify(
					[
						`bundle: ${bundleDir}`,
						`from:   ${m.source.hostname} (${m.source.platform}/${m.source.arch}) @ ${m.createdAt}`,
						`pi:     ${m.source.piVersion ?? "unknown"}`,
						"",
						...m.layers.extensions.map((e) => `  ${e.spec}`),
						...m.layers.localExtensions.map((e) => `  [local] ${e.bundlePath}`),
						...m.layers.providers.map((p) => `  [provider] ${p.name} (${p.modelCount} models)`),
						...m.layers.configFiles.map((c) => `  [config] ${c.bundlePath}`),
						"",
						`install.sh steps: ${(m.layers.extensions.length ? 1 : 0) + 2 + (m.layers.providers.length ? 1 : 0) + (m.layers.configFiles.length ? 1 : 0)}`,
					].join("\n"),
					"info",
				);
				return;
			}

			ctx.ui.notify(`unknown subcommand: ${sub} (try /ship help)`, "error");
	};

	pi.registerCommand("ship", {
		description: "Snapshot this pi setup into a portable bundle, or plan/verify applying one",
		handler: commandHandler,
	});

	pi.registerCommand("migrate", {
		description: "Alias of /ship — migrate a pi setup between machines",
		handler: commandHandler,
	});

	pi.registerTool({
		name: "ship",
		label: "pi-ship",
		description:
			"Snapshot this machine's pi setup (installed extension packages with pinned versions, optionally model providers and user config files) into a portable bundle directory containing a Dockerfile-style install.sh runbook. Also plans or verifies applying an existing bundle. Ships configuration only — never the pi binary and never plaintext credentials.",
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("export"),
					Type.Literal("preflight"),
					Type.Literal("plan"),
					Type.Literal("verify"),
					Type.Literal("inspect"),
				],
				{ description: "export = snapshot this machine; preflight = is this machine ready; plan/verify/inspect = examine a bundle" },
			),
			outDir: Type.Optional(Type.String({ description: "export: output directory" })),
			bundleDir: Type.Optional(Type.String({ description: "plan/verify/inspect: bundle directory" })),
			includeProviders: Type.Optional(
				Type.Boolean({ description: "export: include model providers from models.json (secrets redacted)" }),
			),
			includeConfig: Type.Optional(
				Type.Boolean({ description: "export: include opted-in user config files (secrets redacted)" }),
			),
			carryKeys: Type.Optional(
				Type.Boolean({
					description:
						"export: carry secret VALUES in .secrets.env. The target applies them additively — a name already set there is never overwritten.",
				}),
			),
			providerNames: Type.Optional(
				Type.Array(Type.String(), { description: "export: limit providers to these names" }),
			),
			configFileNames: Type.Optional(
				Type.Array(Type.String(), { description: "export: limit config files to these basenames" }),
			),
			force: Type.Optional(Type.Boolean({ description: "export: overwrite an existing output directory" })),
		}),
		async execute(_id, params) {
			try {
				if (params.action === "export") {
					const opts: ExportOptions = {
						outDir: params.outDir ?? defaultOutDir(),
						providers: params.includeProviders ?? false,
						configFiles: params.includeConfig ?? false,
						providerNames: params.providerNames,
						configFileNames: params.configFileNames,
					};
					const manifest = collect(opts);
					const secrets = params.carryKeys ? gatherSecrets(manifest.requiredEnv) : {};
					const r = await writeBundle(manifest, opts.outDir, { force: params.force, secrets });
					return {
						content: [
							{
								type: "text",
								text: [
									`Bundle written to ${r.dir}`,
									`Files: ${r.files.join(", ")}`,
									`Packages: ${manifest.layers.extensions.length}`,
									`Local extensions: ${manifest.layers.localExtensions.length}`,
									`Providers: ${manifest.layers.providers.length}`,
									`Config files: ${manifest.layers.configFiles.length}`,
									`Required env: ${manifest.requiredEnv.join(", ") || "(none)"}`,
									params.carryKeys
										? `Secret values carried: ${r.carriedSecrets.join(", ") || "(none found in env)"}`
										: "Secret values: not carried (names only in .env.example)",
									manifest.warnings.length ? `Warnings:\n${manifest.warnings.map((w) => `- ${w}`).join("\n")}` : "",
								]
									.filter(Boolean)
									.join("\n"),
							},
						],
						details: {},
					};
				}

				if (params.action === "preflight") {
					const m = params.bundleDir ? readManifest(resolve(params.bundleDir)) : undefined;
					const node = findNode();
					const report = preflight({
						needNode: true,
						needPi: true,
						requiredEnv: m?.requiredEnv ?? [],
						expectedPiVersion: m?.source.piVersion,
					});
					return {
						content: [
							{
								type: "text",
								text: [
									formatPreflight(report),
									"",
									`node required by pi: >= ${PI_NODE_MIN}`,
									`node found: ${node ? `${node.version} at ${node.path}` : "none"}`,
								].join("\n"),
							},
						],
						details: {},
					};
				}

				if (!params.bundleDir) {
					return {
						content: [{ type: "text", text: `bundleDir is required for ${params.action}` }],
						details: {},
						isError: true,
					};
				}
				const dir = resolve(params.bundleDir);
				if (params.action === "plan") {
					return { content: [{ type: "text", text: formatPlan(planBundle(dir)) }], details: {} };
				}
				if (params.action === "verify") {
					const r = verifyBundle(dir);
					return {
						content: [
							{
								type: "text",
								text: [
									r.ok ? "OK — machine matches bundle" : "MISMATCH",
									...r.checks.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`),
								].join("\n"),
							},
						],
						details: {},
					};
				}
				const m = readManifest(dir);
				return {
					content: [{ type: "text", text: JSON.stringify(m, null, 2) }],
					details: {},
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `pi-ship error: ${(err as Error).message}` }],
					details: {},
					isError: true,
				};
			}
		},
	});

	// A one-line hint on startup when a bundle sits in the cwd, so a fresh
	// machine discovers the runbook immediately.
	pi.on("session_start", async (_event, ctx) => {
		try {
			const candidates = ["install.sh"].map((f) => join(ctx.cwd, f));
			const hasBundle = candidates.some((c) => existsSync(c)) && existsSync(join(ctx.cwd, "pi-ship.json"));
			if (hasBundle) {
				ctx.ui.notify(
					`pi-ship bundle detected in ${ctx.cwd} — apply with ./install.sh --dry-run, then ./install.sh`,
					"info",
				);
			}
		} catch {
			/* startup hints must never break the session */
		}
	});
}