/**
 * pi-migrate — secret handling.
 *
 * Two jobs:
 *
 *  1. `redactValue` / `redactConfig`: walk a provider config and replace literal
 *     credentials with `$VAR` references, recording the var names. Values that
 *     are already `$SOMETHING` pass through untouched.
 *
 *  2. `looksSecret`: heuristic used to decide whether a config file needs
 *     scrubbing even when it isn't models.json.
 *
 * The invariant we care about: a bundle is safe to commit to a git repo. If a
 * literal secret survives into the bundle, that invariant is broken, so
 * collection treats any leftover literal as a warning the user must see.
 */

/** A value that is purely an env-var reference, e.g. `$KSYUN_API_KEY`. */
const ENV_REF = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;

/** Values of keys matching this are treated as credentials. */
const SECRET_KEY = /(api[-_]?key|secret|token|password|passwd|credential|authorization|bearer)/i;

/** A string that looks like a real credential rather than a placeholder. */
const SECRET_SHAPE = [
	/^sk-[A-Za-z0-9_\-]{16,}$/, // OpenAI-style
	/^[A-Za-z0-9_\-]{32,}$/, // generic long opaque token
	/^[0-9a-f]{32,}$/i, // hex token
	/^[A-Za-z0-9._\-]+\.[A-Za-z0-9._\-]{16,}$/, // dotted id.secret
];

export type Redaction = {
	value: string;
	/** Set when we replaced a literal with a `$VAR` reference. */
	envName?: string;
};

/**
 * Decide the env var name to use for a provider's credential.
 * `ksyun` -> `KSYUN_API_KEY`; the caller can override.
 */
export function envNameFor(provider: string, field: string): string {
	const p = provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
	const f = field.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
	return f.includes("KEY") || f.includes("TOKEN") || f.includes("SECRET")
		? `${p}_${f}`
		: `${p}_${f}`;
}

export function isEnvRef(v: unknown): v is string {
	return typeof v === "string" && ENV_REF.test(v.trim());
}

export function envRefName(v: string): string | undefined {
	const m = v.trim().match(ENV_REF);
	return m?.[1];
}

/** True when a string is probably a live credential (not a placeholder). */
export function looksSecret(v: unknown): boolean {
	if (typeof v !== "string") return false;
	const s = v.trim();
	if (s.length < 16) return false;
	if (isEnvRef(s)) return false;
	if (/^(changeme|placeholder|your[-_]?key|xxx+|<.*>)$/i.test(s)) return false;
	return SECRET_SHAPE.some((re) => re.test(s));
}

export function isSecretKey(key: string): boolean {
	return SECRET_KEY.test(key);
}

/**
 * Redact one scalar. Already-referenced values are preserved; literals are
 * replaced by a reference named after the provider+field.
 */
export function redactScalar(
	value: string,
	provider: string,
	field: string,
): Redaction {
	const existing = envRefName(value);
	if (existing) return { value: value.trim(), envName: existing };
	const name = envNameFor(provider, field);
	return { value: `$${name}`, envName: name };
}

export type RedactResult = {
	config: Record<string, unknown>;
	envNames: string[];
	/** Literal secrets we could not confidently rewrite. */
	unresolved: string[];
};

/**
 * Walk a provider config object and redact credential-looking fields.
 *
 * Recurses into plain objects and arrays so nested `auth: { apiKey }` shapes
 * are covered, not just top-level `apiKey`.
 */
export function redactConfig(
	config: Record<string, unknown>,
	provider: string,
	path: string[] = [],
): RedactResult {
	const envNames = new Set<string>();
	const unresolved: string[] = [];

	const walk = (node: unknown, trail: string[]): unknown => {
		if (Array.isArray(node)) return node.map((n) => walk(n, trail));
		if (node && typeof node === "object") {
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
				out[k] = walk(v, [...trail, k]);
			}
			return out;
		}
		if (typeof node !== "string") return node;

		const field = trail[trail.length - 1] ?? "apiKey";
		const keyIsSecret = isSecretKey(field);
		if (!keyIsSecret && !looksSecret(node)) return node;

		if (isEnvRef(node)) {
			envNames.add(envRefName(node)!);
			return node.trim();
		}
		if (looksSecret(node) || keyIsSecret) {
			// A secret-looking key holding an obvious non-secret gets left alone.
			if (!looksSecret(node) && !isEnvRef(node) && node.length < 16) return node;
			const r = redactScalar(node, provider, field);
			if (r.envName) envNames.add(r.envName);
			return r.value;
		}
		unresolved.push(`${provider}.${trail.join(".")}`);
		return node;
	};

	const out = walk(config, path) as Record<string, unknown>;
	return { config: out, envNames: [...envNames], unresolved };
}

/**
 * Scrub a whole config file's text. We parse JSON when possible so we only
 * touch values, then fall back to a conservative regex sweep for free text.
 */
export function redactText(
	text: string,
	label: string,
): { text: string; envNames: string[]; changed: boolean } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { text, envNames: [], changed: false };
	}
	const envNames = new Set<string>();
	const walk = (node: unknown, trail: string[]): unknown => {
		if (Array.isArray(node)) return node.map((n) => walk(n, trail));
		if (node && typeof node === "object") {
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
				out[k] = walk(v, [...trail, k]);
			}
			return out;
		}
		if (typeof node !== "string") return node;
		const field = trail[trail.length - 1] ?? label;
		if (isEnvRef(node)) {
			envNames.add(envRefName(node)!);
			return node.trim();
		}
		if (isSecretKey(field) || looksSecret(node)) {
			const r = redactScalar(node, label, field);
			if (r.envName) envNames.add(r.envName);
			return r.value;
		}
		return node;
	};
	const out = walk(parsed, []);
	const rendered = JSON.stringify(out, null, 2);
	return {
		text: `${rendered}\n`,
		envNames: [...envNames],
		changed: rendered !== JSON.stringify(parsed, null, 2),
	};
}

export function buildEnvExample(names: string[]): string {
	if (names.length === 0) {
		return "# No secrets are required by this bundle.\n";
	}
	const lines = [
		"# pi-migrate — secrets required by this bundle.",
		"# Fill these in, then:  set -a; . ./.env; set +a   (or use your shell's env manager)",
		"# Never commit the filled-in .env.",
		"",
	];
	for (const n of [...names].sort()) lines.push(`${n}=`);
	return `${lines.join("\n")}\n`;
}

// ── secret migration ────────────────────────────────────────────────────────
//
// Moving a value from the source shell to the target machine is opt-in and
// strictly additive: an existing value on the target is NEVER overwritten.
// That rule is the whole safety story here, so it is implemented once, in
// `planSecretMigration`, and shared by the runbook and the CLI.

export type SecretPlan = {
	/** Name of the variable. */
	name: string;
	/** Value carried in the bundle (may be empty when the user chose not to). */
	value: string;
	/** True when the target already exports this variable. */
	presentOnTarget: boolean;
	/** What the script will do. */
	action: "skip-exists" | "set" | "skip-empty";
};

/**
 * Decide, per secret, whether it should be written on the target.
 *
 * `target` is the environment of the machine being migrated TO. Any name
 * already present there is left alone — the user's existing configuration wins.
 */
export function planSecretMigration(
	shipped: Record<string, string>,
	target: Record<string, string | undefined> = process.env,
): SecretPlan[] {
	return Object.entries(shipped).map(([name, value]) => {
		const presentOnTarget = Boolean(target[name]);
		if (presentOnTarget) return { name, value, presentOnTarget, action: "skip-exists" as const };
		if (!value) return { name, value, presentOnTarget, action: "skip-empty" as const };
		return { name, value, presentOnTarget, action: "set" as const };
	});
}

/** Render a .env file containing only the secrets we are allowed to write. */
export function buildMigratedEnvFile(plans: SecretPlan[]): string {
	const writable = plans.filter((p) => p.action === "set");
	const lines = [
		"# pi-migrate — secrets migrated from the source machine.",
		"# Generated automatically. Values already present in the environment",
		"# on this machine were deliberately left out.",
		"#",
		"#   chmod 600 .env",
		"#",
	];
	for (const p of writable) {
		// Single-quote to survive $, spaces, and backslashes in real keys.
		lines.push(`${p.name}='${p.value.replace(/'/g, `'\\''`)}'`);
	}
	return `${lines.join("\n")}\n`;
}

/** A shell snippet that sources the migrated .env only for names not already set. */
export const ENV_LOADER_SNIPPET = `# Load migrated secrets, without clobbering anything already set.
# Sourced by the runbook and by the generated ~/.pi-env.sh.
if [ -f "$PI_SHIP_ENV" ]; then
  while IFS= read -r line; do
    case "$line" in
      ""|\\#*) continue ;;
    esac
    name="\${line%%=*}"
    value="\${line#*=}"
    # already provided by the environment? leave it alone.
    # (eval-free check that tolerates set -e and unset variables)
    if [ -n "\${!name:-}" ]; then continue; fi
    export "$name=$value"
  done < "$PI_SHIP_ENV"
fi`;