/**
 * pi-migrate — shared types.
 *
 * The bundle is a directory that looks like this:
 *
 *   pi-migrate-<host>-<date>/
 *     pi-ship.json          # the manifest (layers, versions, everything)
 *     install.sh            # Dockerfile-style runbook, one step per line
 *     .env.example          # secret names the target machine must supply
 *     config/               # L3: opted-in user config files, secrets redacted
 *     extensions/           # L1b: local (non-package) extension sources
 *     README.md             # generated, human-readable
 *
 * Layers exist so the default export is *safe*: L1 (extensions) always ships,
 * everything else must be opted in explicitly.
 */

/** What a single installable extension entry is. */
export type PackageSpec = {
	/** The spec exactly as pi understands it, e.g. `npm:pi-memory@0.4.2`. */
	spec: string;
	/** `npm` or `git`. */
	kind: "npm" | "git";
	/** Package name for npm, or repo path for git. */
	name: string;
	/** Resolved installed version, if we could determine one. */
	version?: string;
	/** Pinned git commit/tag when kind === "git". */
	ref?: string;
	/** Whether pi validated this package during collection. */
	source: string;
};

/** A model provider definition, collected from models.json. */
export type ProviderEntry = {
	name: string;
	/** The provider config verbatim, with secrets already redacted. */
	config: Record<string, unknown>;
	/** Names of secrets we stripped out and replaced with $VARS. */
	secretKeys: string[];
	modelCount: number;
};

/** A user-level config file we may ship. */
export type ConfigFileEntry = {
	/** Absolute path on the source machine. */
	source: string;
	/** Path inside the bundle, under config/. */
	bundlePath: string;
	/** Path to restore to on the target, relative to ~/.pi/agent. */
	targetRel: string;
	/** Redacted contents, ready to write out. */
	content: string;
	/** True when we rewrote at least one secret into a $VAR reference. */
	redacted: boolean;
};

/** A local extension (a .ts file/dir under extensions/, not from a package). */
export type LocalExtension = {
	/** Absolute source path. */
	source: string;
	/** Filename inside the bundle's extensions/ dir. */
	bundlePath: string;
	content: string;
};

/** The whole bundle, serialised as pi-ship.json. */
export type ShipManifest = {
	/** Manifest schema version. */
	schemaVersion: 1;
	/** When this bundle was produced (ISO 8601). */
	createdAt: string;
	/** Machine that produced it. */
	source: {
		hostname: string;
		platform: string;
		arch: string;
		piVersion?: string;
		nodeVersion: string;
	};
	/** Ordered layers. Each maps to one section of the runbook. */
	layers: {
		/** L1 — package installs. Always shipped. */
		extensions: PackageSpec[];
		/** L1b — loose extensions living in ~/.pi/agent/extensions/. */
		localExtensions: LocalExtension[];
		/** L2 — providers from models.json. Opt-in. */
		providers: ProviderEntry[];
		/** L3 — config files. Opt-in per file. */
		configFiles: ConfigFileEntry[];
	};
	/** Settings keys to merge, filtered by what the user opted into. */
	settings: Record<string, unknown>;
	/** Secret names referenced anywhere in the bundle. */
	requiredEnv: string[];
	/** Non-fatal problems encountered while collecting. */
	warnings: string[];
};

export type ExportOptions = {
	/** Include providers from models.json (default: false). */
	providers?: boolean;
	/** Explicit provider names to include; empty/undefined means "all" when providers===true. */
	providerNames?: string[];
	/** Include config files. */
	configFiles?: boolean;
	/** Config basenames to include; empty/undefined means the default safe set. */
	configFileNames?: string[];
	/** Output directory. */
	outDir: string;
};

/** Files that are safe-by-default when the user opts into config shipping. */
export const DEFAULT_CONFIG_FILES = [
	"web-search.json",
	"sol-pi.json",
] as const;

/**
 * Files we will never ship, no matter what, because they hold live
 * credentials or are machine-specific caches.
 */
export const NEVER_SHIP = [
	"auth.json",
	"trust.json",
	"models-store.json",
	"settings.json",
	"sessions",
	"npm",
	"git",
	"bin",
	"web-search-cache",
] as const;

/** settings.json keys that are safe and meaningful to carry across machines. */
export const SHIPPABLE_SETTINGS = [
	"theme",
	"defaultProvider",
	"defaultModel",
	"defaultThinkingLevel",
	"hideThinkingBlock",
	"tuiMode",
	"defaultProjectTrust",
	"followUpMode",
	"steeringMode",
	"showHardwareCursor",
] as const;