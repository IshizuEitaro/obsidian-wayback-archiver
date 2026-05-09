export const FAILED_ARCHIVE_STAGE_VALUES = [
	"wayback-initiation-failed",
	"wayback-job-error",
	"wayback-timeout",
	"fallback-not-found",
	"fallback-provider-error",
	"archive-today-autosave-failed",
	"archive-today-autosave-timeout",
	"archive-today-pending-timeout",
] as const;

export type FailedArchiveStage = (typeof FAILED_ARCHIVE_STAGE_VALUES)[number];

export const ARCHIVE_PROVIDER_ID_VALUES = ["archiveToday", "megalodon"] as const;

export type ArchiveProviderId = (typeof ARCHIVE_PROVIDER_ID_VALUES)[number];

export type ArchiveServiceId = "wayback" | ArchiveProviderId;

export interface ArchivePolicyRule {
	/**
	 * A case-insensitive regular expression pattern to match the target URL.
	 * If the pattern is an invalid regular expression, matches by simple substring inclusion.
	 * Example: "^https://x\\.com/" or "wikipedia.org"
	 */
	pattern: string;
	providers: ArchiveServiceId[];
	archiveTodayExperimentalSubmit?: boolean;
}

export interface WaybackArchiverSettings {
	dateFormat: string;
	/**
	 * Template for the appended archive link text.
	 * Placeholders:
	 * - `{date}`: replaced with the formatted archive date.
	 * - `{provider}`: replaced with the name of the archive provider (e.g., "Wayback Machine", "archive.today", "Web Gyotaku").
	 * Default: "(Archived on {date})"
	 */
	archiveLinkText: string;
	ignorePatterns: string[];
	substitutionRules: { find: string; replace: string; regex: boolean }[];
	apiDelay: number;
	maxRetries: number;
	archiveFreshnessDays: number;
	pathPatterns: string[];
	urlPatterns: string[];
	wordPatterns: string[];
	// SPN2 API options
	captureScreenshot: boolean;
	captureAll: boolean;
	jsBehaviorTimeout: number;
	forceGet: boolean;
	captureOutlinks: boolean;
	//
	autoClearFailedLogs: boolean;
	archiveTodayExperimentalSubmit: boolean;
	archiveTodaySubmitDelayMs: number;
	archiveTodayPendingPollIntervalMs: number;
	archiveTodayPendingPollBatchSize: number;
	archiveTodayPendingMaxWaitMs: number;
	archiveTodayMaxPendingCount: number;
	manualSaveBatchSize: number;
	defaultArchiveProviders: ArchiveServiceId[];
	archivePolicies: ArchivePolicyRule[];
}

export const DEFAULT_SETTINGS: WaybackArchiverSettings = {
	dateFormat: "yyyy-MM-dd",
	archiveLinkText: "(Archived on {date})",
	ignorePatterns: [
		"web.archive.org/",
		"archive.md/",
		"archive.today/",
		"archive.ph/",
		"archive.is/",
		"megalodon.jp/",
	],
	substitutionRules: [],
	apiDelay: 2000, // Default 2 seconds delay
	maxRetries: 3,
	archiveFreshnessDays: 0, // 0 means always archive if not present
	pathPatterns: [],
	urlPatterns: [],
	wordPatterns: [],
	// SPN2 API options defaults
	captureScreenshot: false,
	captureAll: false,
	jsBehaviorTimeout: 0,
	forceGet: false,
	captureOutlinks: false,
	//
	autoClearFailedLogs: false,
	archiveTodayExperimentalSubmit: false,
	archiveTodaySubmitDelayMs: 5000,
	archiveTodayPendingPollIntervalMs: 60000,
	archiveTodayPendingPollBatchSize: 3,
	archiveTodayPendingMaxWaitMs: 600000,
	archiveTodayMaxPendingCount: 30,
	manualSaveBatchSize: 5,
	defaultArchiveProviders: ["wayback"],
	archivePolicies: [],
};

export const getFreshnessThresholdMs = (settings: WaybackArchiverSettings) =>
	settings.archiveFreshnessDays * 24 * 60 * 60 * 1000; // Convert days to ms

export interface FailedArchiveEntry {
	url: string;
	targetUrl?: string;
	filePath: string;
	timestamp: number;
	error: string;
	retryCount: number;
	stage?: FailedArchiveStage;
	manualProviderIds?: ArchiveProviderId[];
	manualOpenedAt?: number;
	manualOpenCount?: number;
}

export interface PendingArchiveEntry {
	id: string;
	providerId: "archiveToday";
	url: string;
	targetUrl: string;
	filePath: string;
	approximateIndex?: number;
	createdAt: number;
	lastCheckedAt?: number;
	checkCount: number;
	maxWaitMs: number;
	status: "submitted";
}

export interface WaybackArchiverData {
	activeProfileId: string;
	profiles: Record<string, WaybackArchiverSettings>;
	failedArchives?: FailedArchiveEntry[];
	pendingArchives?: PendingArchiveEntry[];
	spnAccessKey: string;
	spnSecretKey: string;
}

/**
 * The time window (in milliseconds) within which duplicate failures for the same URL, file,
 * and stage are coalesced into a single entry to prevent log bloat. (Default: 5 minutes)
 */
export const FAILED_ARCHIVE_DUPLICATE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Duplicate failures are coalesced as a UI/log-bloat control, not as an audit log.
 * The merged entry represents the latest duplicate failure while preserving
 * manual recovery metadata that may have been added by the user.
 */
function mergeDuplicateFailedArchiveEntry(
	existing: FailedArchiveEntry,
	entry: FailedArchiveEntry,
): FailedArchiveEntry {
	const manualProviderIds = Array.from(
		new Set([...(existing.manualProviderIds ?? []), ...(entry.manualProviderIds ?? [])]),
	);

	const manualOpenedAt =
		existing.manualOpenedAt === undefined && entry.manualOpenedAt === undefined
			? undefined
			: Math.max(existing.manualOpenedAt ?? 0, entry.manualOpenedAt ?? 0);

	const manualOpenCount =
		existing.manualOpenCount === undefined && entry.manualOpenCount === undefined
			? undefined
			: Math.max(existing.manualOpenCount ?? 0, entry.manualOpenCount ?? 0);

	return {
		...existing,

		// Keep duplicate identity fields stable.
		url: existing.url,
		filePath: existing.filePath,
		stage: existing.stage,
		targetUrl: existing.targetUrl,

		// Coalesced entries represent the latest duplicate failure, not a full audit history.
		timestamp: entry.timestamp,
		error: entry.error,
		retryCount: entry.retryCount,

		// Preserve manual-recovery metadata instead of losing it on duplicate failures.
		manualProviderIds: manualProviderIds.length ? manualProviderIds : undefined,
		manualOpenedAt,
		manualOpenCount,
	};
}

/**
 * Appends a failed archive entry to a list of entries, coalescing duplicates within a specified time window.
 * This is a pure function used uniformly across all failed log pathways.
 */
export function appendFailedArchiveEntry(
	entries: FailedArchiveEntry[] | null | undefined,
	entry: FailedArchiveEntry,
	windowMs: number = FAILED_ARCHIVE_DUPLICATE_WINDOW_MS,
): FailedArchiveEntry[] {
	const safeEntries = entries || [];
	const duplicateIndex = safeEntries.findIndex(
		(existing) =>
			existing.url === entry.url &&
			existing.filePath === entry.filePath &&
			existing.stage === entry.stage &&
			(existing.targetUrl ?? "") === (entry.targetUrl ?? "") &&
			entry.timestamp >= existing.timestamp &&
			entry.timestamp - existing.timestamp <= windowMs,
	);
	if (duplicateIndex !== -1) {
		const updated = [...safeEntries];
		updated[duplicateIndex] = mergeDuplicateFailedArchiveEntry(updated[duplicateIndex], entry);
		return updated;
	}
	return [...safeEntries, entry];
}
