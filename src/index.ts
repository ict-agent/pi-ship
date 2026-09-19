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
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { collect } from "./collect.ts";
import { formatPlan, planBundle, readManifest, verifyBundle } from "./bundle.ts";
import { writeBundle } from "./writer.ts";
import { findNode, formatPreflight, preflight, PI_NODE_MIN } from "./preflight.ts";
import type { ExportOptions, PackageKind } from "./types.ts";

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

/** The package source kinds pi-ship can replay on another machine. */
const KNOWN_KINDS: PackageKind[] = ["npm", "git", "url"];

/**
 * Resolve a user-supplied kind list, rejecting anything we cannot replay.
 *
 * Returning undefined means "no restriction" (all replayable kinds). An empty
 * result is treated the same way, so a typo cannot silently produce a bundle
 * with no packages at all — that failure would be baffling.
 */
function normalizeKinds(raw: unknown): PackageKind[] | undefined {
	if (!Array.isArray(raw) || raw.length === 0) return undefined;
	const wanted = raw
		.map((k) => String(k).trim().toLowerCase())
		.filter((k): k is PackageKind => (KNOWN_KINDS as string[]).includes(k));
	if (wanted.length === 0) return undefined;
	return [...new Set(wanted)];
}

/** Parse `--kinds=a,b`. Deliberately lenient for the same reason as above. */
function parseKinds(value: string | undefined): PackageKind[] | undefined {
	if (!value) return undefined;
	return normalizeKinds(value.split(","));
}

/**
 * Tab completions for `/ship <TAB>`.
 *
 * Each entry pairs the literal to insert with a one-line explanation of what it
 * does, so the command is usable without reading any docs. Once a subcommand is
 * already typed we offer its flags instead of the subcommand list again.
 */
function completeShipArgs(prefix: string): { value: string; label: string; description?: string }[] {
	const items: { value: string; label: string; description?: string }[] = [];

	const subcommands = [
		{ value: "export", label: "export", description: "打包本机配置（最常用，不带任何参数就是默认导出）" },
		{ value: "export --providers --config", label: "export --providers --config", description: "连模型 provider 和配置文件一起打包" },
		{ value: "export --with-keys", label: "export --with-keys", description: "连密钥值一起打包（目标机只补自己缺的）" },
		{ value: "inspect", label: "inspect", description: "看看某个 bundle 里有什么" },
		{ value: "plan", label: "plan", description: "如果装到本机，会改哪些东西（不写盘）" },
		{ value: "verify", label: "verify", description: "检查本机是否已符合某个 bundle" },
		{ value: "preflight", label: "preflight", description: "本机是否具备接收 bundle 的条件" },
		{ value: "help", label: "help", description: "显示完整用法说明" },
	];

	// Flags shown once a subcommand has been chosen.
	const flags: Record<string, { value: string; label: string; description: string }[]> = {
		export: [
			{ value: "--providers", label: "--providers", description: "带上 models.json 里的 provider（密钥会被脱敏）" },
			{ value: "--config", label: "--config", description: "带上 web-search.json 等用户配置文件" },
			{ value: "--with-keys", label: "--with-keys", description: "把密钥值写进 .secrets.env，目标机加法式应用" },
			{ value: "--kinds=npm,git", label: "--kinds=npm,git", description: "只带这些来源的包（可选 npm / git / url）" },
			{ value: "--out=", label: "--out=DIR", description: "输出目录（默认 pi-ship-<主机>-<日期>）" },
			{ value: "--force", label: "--force", description: "输出目录已存在时覆盖它" },
		],
	};

	const firstWord = prefix.trim().split(/\s+/)[0] ?? "";
	// Note: test the RAW prefix for a space. `"export "` has no leading word
	// separator once trimmed, but the user has clearly finished the subcommand
	// and wants its flags — so trimming first here would show the wrong list.
	const hasArgSep = /\s/.test(prefix);

	if (hasArgSep && flags[firstWord]) {
		const last = prefix.trim().split(/\s+/).pop() ?? "";
		if (last === firstWord) return flags[firstWord];
		const matches = flags[firstWord].filter((f) => f.value.startsWith(last));
		return matches.length ? matches : flags[firstWord];
	}

	for (const s of subcommands) {
		if (s.value.startsWith(prefix.trim()) || prefix.trim() === "") items.push(s);
	}
	return items;
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
						"pi-ship — 把这台机器的 pi 配置打包，搬到另一台机器",
						"",
						"【最常用】直接导出（扩展 + 散装扩展 + 可移植设置）",
						"    /ship export",
						"",
						"【想连模型 provider 和配置文件一起搬】",
						"    /ship export --providers --config",
						"",
						"【连密钥值也带走】在上面基础上加 --with-keys",
						"    目标机只会补自己缺的，已有同名变量绝不覆盖",
						"",
						"默认导出到当前目录 pi-ship-<主机名>-<日期>/",
						"换目录：--out=/path  覆盖已有：--force",
						"",
						"【导出后得到什么】",
						"一个目录，里面 install.sh 就是安装脚本。",
						"拷到目标机后跑：  ./install.sh          （交互，会问你几个问题）",
						"                  ./install.sh --dry-run（先预演，什么都不改）",
						"",
						"【在你当前这台机器上能跑的其他命令】",
						"    /ship inspect <bundle>  — 看看某个 bundle 里有什么",
						"    /ship plan <bundle>     — 如果装到这里，会改哪些东西（不写盘）",
						"    /ship verify <bundle>   — 检查本机是否已符合该 bundle",
						"    /ship preflight         — 本机是否具备接收条件",
						"",
						"【进阶】只带某些来源的包",
						"    /ship export --kinds=npm,git   （可选项：npm git url）",
						"    默认三类都带；本地路径包永远不带（换机器没意义）",
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
					packageKinds: parseKinds(parsed.values.get("kinds")),
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
				// Report through a *persistent* entry, not a toast. `ui.notify` is a
				// transient banner: a multi-line report scrolls away before it can be
				// read, which looks exactly like "the command did nothing".
				// appendEntry keeps it in the transcript and stays out of LLM context.
				const lines = [
					`bundle written: ${result.dir}`,
					"",
					[
						`${manifest.layers.extensions.length} packages`,
						`${manifest.layers.localExtensions.length} local extensions`,
						opts.providers
							? `${manifest.layers.providers.length} providers`
							: "providers: not included (--providers)",
						opts.configFiles
							? `${manifest.layers.configFiles.length} config files`
							: "config: not included (--config)",
					].join(" · "),
					carryKeys
						? `secrets carried: ${result.carriedSecrets.join(", ") || "(none found in env)"}`
						: "secrets: names only in .env.example (--with-keys carries values)",
				];
				if (missing.length) {
					lines.push(`not found in env: ${missing.join(", ")} — set these on the target`);
				}
				if (manifest.warnings.length) {
					// Print the warnings themselves. Hiding them behind "see README"
					// meant a package could silently fail to ship.
					lines.push("", `${manifest.warnings.length} warning(s):`);
					for (const w of manifest.warnings) lines.push(`  • ${w}`);
				}
				lines.push("", "next: copy this directory to the target and run ./install.sh");

				pi.appendEntry("pi-ship-export", { lines });
				ctx.ui.notify(
					manifest.warnings.length
						? `pi-ship: bundle written (${manifest.warnings.length} warning(s) — see above)`
						: `pi-ship: bundle written → ${result.dir}`,
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
		description: "Package this pi setup into a bundle you can install on another machine",
		handler: commandHandler,
		// Tab-completable subcommands. Without these the command is a blank
		// prompt: you have to already know the verbs to use it.
		getArgumentCompletions: (prefix) => completeShipArgs(prefix),
	});

	// Render the export report as a card in the transcript. Without a renderer
	// the entry is stored but shows nothing in the TUI, so the command would
	// still look like it did nothing.
	pi.registerEntryRenderer("pi-ship-export", (entry, _opts, theme) => {
		const data = entry.data as { lines?: string[] } | undefined;
		const text = (data?.lines ?? []).join("\n");
		return new Text(theme.bg("customMessageBg", `\n${text}\n`));
	});
	pi.registerCommand("migrate", {
		description: "Alias of /ship — migrate a pi setup between machines",
		handler: commandHandler,
		getArgumentCompletions: (prefix) => completeShipArgs(prefix),
	});

	pi.registerTool({
		name: "ship",
		label: "pi-ship",
		description:
			"Move this machine's pi setup to another machine. Generates a bundle directory " +
			"whose install.sh recreates the setup on the target. " +
			"Use action=export to snapshot THIS machine (the common case); use " +
			"action=inspect/plan/verify to examine a bundle you already have. " +
			"Minimal call: {action:'export'} — that already includes extension packages, loose " +
			"extensions and portable settings. Add includeProviders/includeConfig for those " +
			"extra layers. Output defaults to ./pi-ship-<host>-<date>. " +
			"Ships configuration only — never the pi binary and never plaintext credentials.",
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("export"),
					Type.Literal("preflight"),
					Type.Literal("plan"),
					Type.Literal("verify"),
					Type.Literal("inspect"),
				],
				{ description: "export = snapshot THIS machine into a bundle; preflight = is this machine ready to receive one; plan/verify/inspect = examine an existing bundle" },
			),
			outDir: Type.Optional(Type.String({ description: "export: output directory (default pi-ship-<host>-<date> in cwd)" })),
			bundleDir: Type.Optional(Type.String({ description: "plan/verify/inspect: bundle directory produced by an earlier export" })),
			force: Type.Optional(Type.Boolean({ description: "export: overwrite outDir if it already exists" })),
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
			packageKinds: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"export: which package source kinds to carry — any of npm, git, url. Omit for all replayable kinds. Local-path packages are never carried because pi stores them as machine-specific pointers.",
				}),
			),
			configFileNames: Type.Optional(
				Type.Array(Type.String(), { description: "export: limit config files to these basenames" }),
			),
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
						packageKinds: normalizeKinds(params.packageKinds),
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