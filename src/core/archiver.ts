import { App, Editor, MarkdownView, MarkdownFileInfo, Notice, requestUrl, TFile } from "obsidian";
import { format } from "date-fns";
import {
	ADJACENT_LINK_SEARCH_LIMIT,
	getAdjacentArchiveLinkMatch,
	applySubstitutionRules,
	checkAdjacentLinkFreshness,
	extractArchiveTimestamp,
	getUrlFromMatch,
	isFollowedByArchiveLink,
	LINK_REGEX,
	matchesAnyPattern,
	normalizeArchiveUrl,
	ARCHIVE_TODAY_HOST_PATTERN,
	decodeHtmlEntities,
	normalizeUrlForComparison,
	isSnapshotForTargetUrl,
	extractProviderSnapshotFromText,
} from "../utils/LinkUtils";
import { ConfirmationModal, FileSelectModal } from "../ui/modals";
import {
	FailedArchiveEntry,
	FailedArchiveStage,
	ArchiveProviderId,
	ArchiveServiceId,
	getFreshnessThresholdMs,
	PendingArchiveEntry,
	WaybackArchiverData,
	WaybackArchiverSettings,
	appendFailedArchiveEntry,
} from "./settings";
import {
	serializeFailedArchiveEntriesToCsv,
	parseFailedArchiveEntriesFromCsv,
} from "./failedArchiveLog";
import WaybackArchiverPlugin from "../main";
import {
	applyLinkModification,
	findLatestLinkIndex,
	selectFullyContainedLinkMatches,
} from "../utils/contentManipulator";

export type ArchiveMode = "selection" | "file" | "vault";

export interface ArchiveContext {
	mode: ArchiveMode;
	isForce: boolean;
	file: TFile;
	editor?: Editor;
	selectionOffset?: number;
}

type SingleArchiveOutcome =
	| { status: "cache_hit_success"; url: string }
	| { status: "cache_hit_limited"; url: string }
	| { status: "archived_success"; url: string }
	| { status: "archived_limited"; url: string }
	| { status: "submitted" }
	| {
			status: "archived_failed";
			error?: string;
			stage?: FailedArchiveStage;
			manualProviderIds?: ArchiveProviderId[];
			targetUrl?: string;
	  };

type ArchiveUrlResult =
	| { status: "success"; url: string }
	| { status: "too_many_captures"; url: string }
	| { status: "submitted"; targetUrl: string; provider: "archiveToday" }
	| {
			status: "failed";
			status_ext?: string;
			stage?: FailedArchiveStage;
			manualProviderIds?: ArchiveProviderId[];
			targetUrl?: string;
	  };

export type ArchiveTodaySubmitQueueResult =
	| { status: "queued"; id: string }
	| { status: "duplicate" }
	| { status: "queue_full" }
	| { status: "failed" };

interface EffectiveArchivePolicy {
	providers: ArchiveServiceId[];
	archiveTodayExperimentalSubmit: boolean;
}

const ARCHIVE_TODAY_CANONICAL_HOST = "archive.md";

const ARCHIVE_TODAY_FIXED_SNAPSHOT_REGEX = new RegExp(
	String.raw`^https?:\/\/${ARCHIVE_TODAY_HOST_PATTERN}\/\d{14}\/`,
);

const ARCHIVE_PROVIDER_RESOLVERS: Record<
	ArchiveProviderId,
	{
		name: string;
		latestUrl: (url: string) => string;
		saveUrl: (url: string) => string;
		isSnapshotUrl: (url: string) => boolean;
	}
> = {
	archiveToday: {
		name: "archive.today",
		latestUrl: (url) =>
			`https://${ARCHIVE_TODAY_CANONICAL_HOST}/latest/${encodeURIComponent(url)}`,
		saveUrl: (url) =>
			`https://${ARCHIVE_TODAY_CANONICAL_HOST}/submit/?url=${encodeURIComponent(url)}`,
		isSnapshotUrl: (url) => ARCHIVE_TODAY_FIXED_SNAPSHOT_REGEX.test(url),
	},
	megalodon: {
		name: "Web Gyotaku",
		latestUrl: (url) => `https://megalodon.jp/${url}`,
		saveUrl: (url) => `https://gyo.tc/${encodeURIComponent(url)}`,
		isSnapshotUrl: (url) => /^https?:\/\/megalodon\.jp\/\d{4}-\d{4}-\d{4}-\d{2}\//.test(url),
	},
};

export class ArchiverService {
	private plugin: WaybackArchiverPlugin;
	private app: App;
	private _schedulerStarted = false;
	private _pendingQueueCycleRunning = false;
	private _pendingQueueTimer: number | null = null;
	// In-memory cache for recent archive results (not persisted)
	private recentArchiveCache: Map<string, { status: string; url: string; timestamp: number }> =
		new Map();

	constructor(plugin: WaybackArchiverPlugin) {
		this.plugin = plugin;
		this.app = plugin.app;
	}

	private get data(): WaybackArchiverData {
		return this.plugin.data;
	}

	private get activeSettings(): WaybackArchiverSettings {
		return this.plugin.activeSettings;
	}

	private async saveSettings(): Promise<void> {
		await this.plugin.saveSettings();
	}

	private filterLinksForArchiving(
		allMatches: RegExpMatchArray[],
		fullContent: string,
		isForce: boolean,
		context: {
			isSelection?: boolean;
			selectionStartOffset?: number;
			fullDocContent?: string;
		} = {},
	): { linksToProcess: RegExpMatchArray[]; skippedCount: number } {
		let localSkippedCount = 0;

		const filteredMatches = allMatches.filter((match) => {
			const url = getUrlFromMatch(match);
			const matchIndex = match.index;

			if (matchIndex === undefined) {
				localSkippedCount++;
				return false;
			}

			// --- Adjacent Check ---
			let checkStartIndex = matchIndex + match[0].length;
			let contentToCheckAdjacent = fullContent;
			if (
				context.isSelection &&
				context.selectionStartOffset !== undefined &&
				context.fullDocContent
			) {
				checkStartIndex = context.selectionStartOffset + matchIndex + match[0].length;
				contentToCheckAdjacent = context.fullDocContent;
			}
			const cached = this.recentArchiveCache.get(url);
			const textAfter = contentToCheckAdjacent.substring(
				checkStartIndex,
				checkStartIndex + ADJACENT_LINK_SEARCH_LIMIT,
			);
			if (
				!isForce &&
				isFollowedByArchiveLink(textAfter) &&
				cached &&
				Date.now() - cached.timestamp < getFreshnessThresholdMs(this.activeSettings)
			) {
				localSkippedCount++;
				return false;
			}

			if (this.isUrlIgnored(url)) {
				localSkippedCount++;
				return false;
			}

			if (
				this.activeSettings.urlPatterns?.length > 0 &&
				!matchesAnyPattern(url, this.activeSettings.urlPatterns)
			) {
				// console.log(`[DEBUG filterLinks] Skipping: Not HTTP/HTTPS.`);
				localSkippedCount++;
				return false;
			}

			if (!url.match(/^https?:\/\//i)) {
				localSkippedCount++;
				return false;
			}
			return true;
		});
		return { linksToProcess: filteredMatches, skippedCount: localSkippedCount };
	}

	private isUrlIgnored(url: string): boolean {
		try {
			const urlObj = new URL(url);
			const hostname = urlObj.hostname.toLowerCase();
			if (hostname === "web.archive.org" || hostname === "megalodon.jp") {
				return true;
			}
			const archiveTodayHostRegex = /^(?:www\.)?archive\.(?:today|is|md|ph|vn|li|fo)$/i;
			if (archiveTodayHostRegex.test(hostname)) {
				return true;
			}
		} catch {
			// fallback to substring-matching if URL parsing fails
			if (url.includes("web.archive.org/") || url.includes("megalodon.jp/")) {
				return true;
			}
			const archiveTodayHostRegex = new RegExp(
				String.raw`archive\.(?:today|is|md|ph|vn|li|fo)\/`,
				"i",
			);
			if (archiveTodayHostRegex.test(url)) {
				return true;
			}
		}
		return matchesAnyPattern(url, this.activeSettings.ignorePatterns);
	}

	private async processSingleUrlArchival(
		originalUrl: string,
		isForce: boolean,
		filePath: string,
		approximateIndex?: number,
	): Promise<SingleArchiveOutcome> {
		const cached = this.recentArchiveCache.get(originalUrl);
		if (
			!isForce &&
			cached &&
			Date.now() - cached.timestamp < getFreshnessThresholdMs(this.activeSettings)
		) {
			// console.log(`[DEBUG] Using cached archive result for: ${originalUrl}`);
			if (cached.status === "success") {
				return { status: "cache_hit_success", url: cached.url };
			} else {
				// (cached.status === 'too_many_captures')
				return { status: "cache_hit_limited", url: cached.url };
			}
		} else {
			// console.log(`[DEBUG] Calling archiveUrl (cache miss/stale) for: ${originalUrl}`);
			const archiveResult = await this.archiveUrl(originalUrl);
			// console.log(`[DEBUG] archiveUrl returned:`, archiveResult);
			if (archiveResult.status === "success") {
				this.recentArchiveCache.set(originalUrl, {
					status: "success",
					url: archiveResult.url,
					timestamp: Date.now(),
				});
				return { status: "archived_success", url: archiveResult.url };
			} else if (archiveResult.status === "too_many_captures") {
				this.recentArchiveCache.set(originalUrl, {
					status: "too_many_captures",
					url: archiveResult.url,
					timestamp: Date.now(),
				});
				return { status: "archived_limited", url: archiveResult.url };
			} else if (archiveResult.status === "submitted") {
				await this.registerPendingArchive(
					originalUrl,
					archiveResult.targetUrl,
					filePath,
					approximateIndex,
				);
				return { status: "submitted" };
			} else {
				// status === 'failed'
				return {
					status: "archived_failed",
					error: archiveResult.status_ext,
					stage: archiveResult.stage,
					manualProviderIds: archiveResult.manualProviderIds,
					targetUrl: archiveResult.targetUrl,
				};
			}
		}
	}

	private async logFailedArchive(
		originalUrl: string,
		filePath: string,
		error: string,
		retryCount: number = 0,
		metadata: Pick<FailedArchiveEntry, "stage" | "manualProviderIds" | "targetUrl"> = {},
	): Promise<void> {
		await this.appendFailedArchive({
			url: originalUrl,
			filePath,
			timestamp: Date.now(),
			error,
			retryCount,
			...metadata,
		});
	}

	private async appendFailedArchive(
		entry: FailedArchiveEntry,
		options: { save?: boolean } = {},
	): Promise<void> {
		this.data.failedArchives = appendFailedArchiveEntry(this.data.failedArchives ?? [], entry);
		if (options.save !== false) {
			await this.saveSettings();
		}
	}

	/**
	 * Unified file processing method using app.vault.process for atomic per-link updates.
	 * Handles both file-mode and vault-wide archiving with a single codebase.
	 * Each link is processed and saved immediately, preventing stale state issues.
	 */
	private async processFileWithContext(
		file: TFile,
		isForce: boolean,
		counters: {
			archivedCount: number;
			failedCount: number;
			skippedCount: number;
			submittedCount?: number;
		},
	): Promise<void> {
		let fileContent: string;
		try {
			fileContent = await this.app.vault.read(file);
		} catch {
			new Notice(`Error reading file: ${file.path}`);
			return;
		}

		// Check path and word patterns if configured
		if (
			this.activeSettings.pathPatterns?.length > 0 &&
			!matchesAnyPattern(file.path, this.activeSettings.pathPatterns)
		) {
			return; // File path doesn't match, silently skip
		}
		if (
			this.activeSettings.wordPatterns?.length > 0 &&
			!this.activeSettings.wordPatterns.some((p) => fileContent.includes(p))
		) {
			return; // File content doesn't match word patterns, silently skip
		}

		const allMatches = Array.from(fileContent.matchAll(LINK_REGEX));
		const filterResult = this.filterLinksForArchiving(allMatches, fileContent, isForce);
		const linksToProcess = filterResult.linksToProcess;
		counters.skippedCount += filterResult.skippedCount;

		if (!linksToProcess.length) {
			return; // No links to process in this file
		}

		// Process each link individually with atomic vault.process calls
		const total = linksToProcess.length;
		let current = 0;
		for (const match of linksToProcess) {
			current++;
			this.plugin.setStatusBarText?.(
				`⌛ Archiving link ${current}/${total} in ${file.basename}...`,
			);
			const originalUrl = getUrlFromMatch(match);
			const originalMatchIndex = match.index;

			if (originalMatchIndex === undefined) {
				counters.skippedCount++;
				continue;
			}

			// Perform API call first (this is the slow part)
			const archiveOutcome = await this.processSingleUrlArchival(
				originalUrl,
				isForce,
				file.path,
				originalMatchIndex,
			);

			if (archiveOutcome.status === "submitted") {
				if (counters.submittedCount !== undefined) {
					counters.submittedCount++;
				}
				continue;
			}

			if (archiveOutcome.status === "archived_failed") {
				counters.failedCount++;
				await this.logFailedArchive(
					originalUrl,
					file.path,
					`Archiving failed (${archiveOutcome.error || "Unknown error"})`,
					0,
					{
						stage: archiveOutcome.stage,
						manualProviderIds: archiveOutcome.manualProviderIds,
						targetUrl: archiveOutcome.targetUrl,
					},
				);
				continue;
			}
			if (
				isForce &&
				(archiveOutcome.status === "archived_limited" ||
					archiveOutcome.status === "cache_hit_limited")
			) {
				counters.skippedCount++;
				continue;
			}

			// Now apply the edit atomically using vault.process
			try {
				await this.app.vault.process(file, (latestContent: string) => {
					// Re-find the link in the latest content (user may have edited)
					const latestIndex = findLatestLinkIndex(
						latestContent,
						originalUrl,
						originalMatchIndex,
					);

					if (latestIndex === null) {
						// Link was deleted by user during processing, skip
						return latestContent;
					}

					// Re-match to get the full match at the new index
					const latestMatches = Array.from(latestContent.matchAll(LINK_REGEX));
					const currentMatch = latestMatches.find((m) => m.index === latestIndex);

					if (!currentMatch) {
						return latestContent;
					}

					const insertionPosIndex = latestIndex + currentMatch[0].length;
					const textAfterLink = latestContent.substring(
						insertionPosIndex,
						insertionPosIndex + ADJACENT_LINK_SEARCH_LIMIT,
					);
					const isAdjacent = isFollowedByArchiveLink(textAfterLink);
					const isLimitedOutcome =
						archiveOutcome.status === "archived_limited" ||
						archiveOutcome.status === "cache_hit_limited";

					if (isAdjacent && isLimitedOutcome && !isForce) {
						return latestContent;
					}

					// Check freshness for existing adjacent links
					if (isAdjacent && !isForce) {
						const adjMatch = getAdjacentArchiveLinkMatch(textAfterLink);
						if (adjMatch) {
							const timestamp = extractArchiveTimestamp(adjMatch[0]);
							const freshness = checkAdjacentLinkFreshness(
								timestamp,
								this.activeSettings,
							);
							if (!freshness.shouldProcess) {
								return latestContent; // Skip, already fresh
							}
						}
					}

					return applyLinkModification(
						latestContent,
						originalUrl,
						archiveOutcome.url,
						originalMatchIndex,
						this.activeSettings,
						{ isReplacement: isAdjacent, allowMismatchedReplacement: isForce },
					).content;
				});
				counters.archivedCount++;
			} catch {
				counters.failedCount++;
				new Notice(`Error saving archive link for ${originalUrl}`);
			}
		}
	}

	async archiveUrl(url: string): Promise<ArchiveUrlResult> {
		const substitutedUrl = applySubstitutionRules(url, this.activeSettings.substitutionRules);
		const policy = this.getArchivePolicy(substitutedUrl);

		if (!policy.providers.includes("wayback")) {
			return await this.archiveWithProviderPolicy(
				substitutedUrl,
				policy,
				"Wayback skipped by policy",
			);
		}

		if (!this.data.spnAccessKey || !this.data.spnSecretKey) {
			if (policy.providers.some((p) => p !== "wayback")) {
				return await this.resolveFallbackArchive(
					substitutedUrl,
					"Archive.org SPN API keys are not configured",
					policy,
					"wayback-initiation-failed",
				);
			}

			new Notice("Error: Archive.org SPN API keys not configured in settings.");
			return {
				status: "failed",
				status_ext: "Configuration Error",
				stage: "wayback-initiation-failed",
				targetUrl: substitutedUrl,
			};
		}

		// console.log(`Attempting to archive (after substitution): ${substitutedUrl}`);

		// Enforce fixed delay before initial archive request to avoid 429 rate limits
		// console.log(`Waiting ${this.activeSettings.apiDelay}ms before archiving to respect SPN2 rate limits...`);
		await new Promise((resolve) => setTimeout(resolve, this.activeSettings.apiDelay));
		// console.log('Proceeding with archive request...');

		try {
			const params: Record<string, string> = {
				url: substitutedUrl,
				capture_outlinks: this.activeSettings.captureOutlinks ? "1" : "0",
				capture_screenshot: this.activeSettings.captureScreenshot ? "1" : "0",
				force_get: this.activeSettings.forceGet ? "1" : "0",
				capture_all: this.activeSettings.captureAll ? "1" : "0",
				skip_first_archive: "1",
			};
			if (this.activeSettings.jsBehaviorTimeout > 0) {
				params["js_behavior_timeout"] = this.activeSettings.jsBehaviorTimeout.toString();
			}
			if (this.activeSettings.archiveFreshnessDays > 0) {
				// Convert days to seconds for if_not_archived_within
				const seconds = this.activeSettings.archiveFreshnessDays * 86400;
				params["if_not_archived_within"] = `${seconds}s`;
			}

			// console.log(`Initiating capture for ${substitutedUrl} via requestUrl...`);
			const initResponse = await requestUrl({
				method: "POST",
				url: "https://web.archive.org/save",
				headers: {
					Accept: "application/json",
					Authorization: `LOW ${this.data.spnAccessKey}:${this.data.spnSecretKey}`,
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams(params).toString(),
			});

			// console.log(`Capture initiation response status: ${initResponse.status}`);
			// console.log(`Capture initiation response JSON:`, initResponse.json);

			if (initResponse.status === 429) {
				// console.warn(`Rate limit hit (429) when initiating capture for ${substitutedUrl}.`);
				const latestSnapshotUrl = await this.getLatestSnapshotUrl(substitutedUrl);
				if (latestSnapshotUrl) {
					new Notice(
						`Daily capture limit likely reached. Using latest snapshot for ${substitutedUrl}.`,
					);
					return { status: "too_many_captures", url: latestSnapshotUrl };
				} else {
					const fallbackUrl = `https://web.archive.org/web/*/${substitutedUrl}`;
					new Notice(
						`Daily capture limit likely reached. No recent snapshot found, using wildcard URL.`,
					);
					return { status: "too_many_captures", url: fallbackUrl };
				}
			}

			if (initResponse.status !== 200 || !initResponse.json?.job_id) {
				if (
					initResponse.status === 200 &&
					initResponse.json?.message?.includes("The same snapshot had been made")
				) {
					// console.warn(`Recent snapshot exists for ${substitutedUrl}. Trying to get latest specific snapshot URL.`);
					const latestSnapshotUrl = await this.getLatestSnapshotUrl(substitutedUrl);
					if (latestSnapshotUrl) {
						return { status: "too_many_captures", url: latestSnapshotUrl };
					} else {
						const fallbackUrl = `https://web.archive.org/web/*/${substitutedUrl}`;
						return { status: "too_many_captures", url: fallbackUrl };
					}
				}
				// console.error(`Failed to initiate capture for ${substitutedUrl}. Status: ${initResponse.status}`, initResponse.text);
				return await this.resolveFallbackArchive(
					substitutedUrl,
					`Initiation failed (${initResponse.status})`,
					policy,
					"wayback-initiation-failed",
				);
			}

			const jobId = initResponse.json.job_id;
			// console.log(`Capture initiated. Job ID: ${jobId}`);

			let retries = 0;
			while (retries < this.activeSettings.maxRetries) {
				await new Promise((resolve) => setTimeout(resolve, this.activeSettings.apiDelay));

				try {
					// console.log(`Checking status for Job ID: ${jobId} (Attempt ${retries + 1}/${this.activeSettings.maxRetries})`);
					const statusResponse = await requestUrl({
						method: "GET",
						url: `https://web.archive.org/save/status/${jobId}`,
						headers: {
							Accept: "application/json",
							Authorization: `LOW ${this.data.spnAccessKey}:${this.data.spnSecretKey}`,
						},
					});

					// console.log(`Status check response status: ${statusResponse.status}`);
					// console.log(`Status check response JSON:`, statusResponse.json);

					if (statusResponse.status !== 200) {
						// console.warn(`Status check failed for Job ID ${jobId}. Status: ${statusResponse.status}. Retrying...`);
						retries++;
						continue;
					}

					const statusData = statusResponse.json;
					if (statusData.status === "success") {
						const timestamp =
							statusData.timestamp || format(new Date(), "yyyyMMddHHmmss"); // Fallback timestamp
						const finalUrl = `https://web.archive.org/web/${timestamp}/${statusData.original_url}`;
						// console.log(`Archiving successful for ${substitutedUrl}. Final URL: ${finalUrl}`);
						return { status: "success", url: finalUrl };
					} else if (statusData.status === "error") {
						// console.error(`Archiving failed for ${substitutedUrl}. Job ID: ${jobId}. Reason: ${statusData.status_ext || 'Unknown error'}`, statusData);
						return await this.resolveFallbackArchive(
							substitutedUrl,
							`Wayback job error: ${statusData.status_ext || "Unknown error"}`,
							policy,
							"wayback-job-error",
						);
					} else {
						// console.log(`Job ${jobId} is still pending...`);
						retries++;
						if (retries >= this.activeSettings.maxRetries) {
							// console.warn(`Max retries reached for pending job ${jobId}.`);
							break;
						}
					}
				} catch {
					// console.error(`Error during status check for Job ID ${jobId}:`, statusError);
					retries++;
					if (retries >= this.activeSettings.maxRetries) {
						// console.warn(`Max retries reached after status check error for job ${jobId}.`);
						break;
					}
				}
			}

			return await this.resolveFallbackArchive(
				substitutedUrl,
				"Wayback job check timeout",
				policy,
				"wayback-timeout",
			);
		} catch (error: unknown) {
			// console.error(`Unexpected error during archiving process for ${substitutedUrl}:`, error);
			return await this.resolveFallbackArchive(
				substitutedUrl,
				`Unexpected Error: ${error instanceof Error ? error.message : String(error)}`,
				policy,
				"wayback-initiation-failed",
			);
		}
	}

	private getArchivePolicy(targetUrl: string): EffectiveArchivePolicy {
		const defaultProviders =
			this.activeSettings.defaultArchiveProviders?.length > 0
				? this.activeSettings.defaultArchiveProviders
				: (["wayback"] as ArchiveServiceId[]);

		for (const rule of this.activeSettings.archivePolicies ?? []) {
			if (!rule.pattern || !rule.providers?.length) {
				continue;
			}
			try {
				if (!new RegExp(rule.pattern, "iu").test(targetUrl)) {
					continue;
				}
			} catch {
				if (!targetUrl.includes(rule.pattern)) {
					continue;
				}
			}
			return {
				providers: this.normalizeProviderOrder(rule.providers),
				archiveTodayExperimentalSubmit:
					rule.archiveTodayExperimentalSubmit ??
					this.activeSettings.archiveTodayExperimentalSubmit,
			};
		}

		return {
			providers: this.normalizeProviderOrder(defaultProviders),
			archiveTodayExperimentalSubmit: this.activeSettings.archiveTodayExperimentalSubmit,
		};
	}

	private normalizeProviderOrder(providers: ArchiveServiceId[]): ArchiveServiceId[] {
		const allowed = new Set<ArchiveServiceId>(["wayback", "archiveToday", "megalodon"]);
		return providers.filter(
			(provider, index) => allowed.has(provider) && providers.indexOf(provider) === index,
		);
	}

	private async archiveWithProviderPolicy(
		targetUrl: string,
		policy: EffectiveArchivePolicy,
		failureReason: string,
		waybackStage?: FailedArchiveStage,
	): Promise<ArchiveUrlResult> {
		let providerHadRetryableError = false;

		const fallbackProviders = policy.providers.filter(
			(provider): provider is ArchiveProviderId => provider !== "wayback",
		);

		for (const providerId of policy.providers) {
			if (providerId === "wayback") {
				continue;
			}
			if (providerId === "archiveToday" && policy.archiveTodayExperimentalSubmit) {
				const resolution = await this.resolveProviderSnapshot(providerId, targetUrl);
				if (resolution.url) {
					const timestamp = extractArchiveTimestamp(resolution.url);
					const freshness = checkAdjacentLinkFreshness(timestamp, this.activeSettings);
					if (!freshness.replaceExisting) {
						return { status: "success", url: resolution.url };
					}
				}

				try {
					const response = await requestUrl({
						method: "GET",
						url: ARCHIVE_PROVIDER_RESOLVERS.archiveToday.saveUrl(targetUrl),
					});
					if (!this.isSuccessfulArchiveTodaySubmitResponse(response.status)) {
						return {
							status: "failed",
							status_ext: `archive.today submit failed with HTTP ${response.status}`,
							stage: "archive-today-autosave-failed",
							manualProviderIds: ["archiveToday"],
							targetUrl,
						};
					}
					return { status: "submitted", targetUrl, provider: "archiveToday" };
				} catch (e) {
					return {
						status: "failed",
						status_ext: `archive.today submit failed: ${(e as Error).message}`,
						stage: "archive-today-autosave-failed",
						manualProviderIds: ["archiveToday"],
						targetUrl,
					};
				}
			}

			const resolution = await this.resolveProviderSnapshot(providerId, targetUrl);
			if (resolution.retryableError) {
				providerHadRetryableError = true;
			}
			if (resolution.url) {
				return { status: "success", url: resolution.url };
			}
		}

		const manualMessage = this.determineFailureMessage(
			fallbackProviders,
			providerHadRetryableError,
			false,
			false,
			failureReason,
		);

		const stage = this.determineFailureStage(
			fallbackProviders,
			providerHadRetryableError,
			false,
			false,
			waybackStage,
		);

		return {
			status: "failed",
			status_ext: manualMessage,
			stage,
			manualProviderIds: fallbackProviders.length > 0 ? fallbackProviders : undefined,
			targetUrl,
		};
	}

	private determineFailureStage(
		fallbackProviders: ArchiveProviderId[],
		providerHadRetryableError: boolean,
		archiveTodayAutosaveTimeout: boolean,
		archiveTodayAutosaveFailed: boolean,
		waybackStage?: FailedArchiveStage,
	): FailedArchiveStage {
		if (fallbackProviders.length === 0) {
			return waybackStage ?? "wayback-initiation-failed";
		}
		if (archiveTodayAutosaveTimeout) return "archive-today-autosave-timeout";
		if (archiveTodayAutosaveFailed) return "archive-today-autosave-failed";
		if (providerHadRetryableError) return "fallback-provider-error";
		return "fallback-not-found";
	}

	private determineFailureMessage(
		fallbackProviders: ArchiveProviderId[],
		providerHadRetryableError: boolean,
		archiveTodayAutosaveTimeout: boolean,
		archiveTodayAutosaveFailed: boolean,
		failureReason: string,
	): string {
		if (fallbackProviders.length === 0) {
			return failureReason;
		}
		if (archiveTodayAutosaveTimeout) {
			return `archive.today autosave was submitted but not resolved yet; retry later or open manually (after Wayback: ${failureReason})`;
		}
		if (archiveTodayAutosaveFailed) {
			return `archive.today autosave failed; fallback not found; manual save may help (after Wayback: ${failureReason})`;
		}
		if (providerHadRetryableError) {
			return `Fallback provider error/rate limit; retry later (after Wayback: ${failureReason})`;
		}
		return `Fallback not found; manual save may help (after Wayback: ${failureReason})`;
	}

	private async resolveFallbackArchive(
		targetUrl: string,
		failureReason: string,
		policy: EffectiveArchivePolicy,
		waybackStage?: FailedArchiveStage,
	): Promise<ArchiveUrlResult> {
		return await this.archiveWithProviderPolicy(targetUrl, policy, failureReason, waybackStage);
	}

	private async resolveProviderSnapshot(
		providerId: ArchiveProviderId,
		targetUrl: string,
	): Promise<{ url: string | null; retryableError: boolean }> {
		const provider = ARCHIVE_PROVIDER_RESOLVERS[providerId];
		if (!provider) {
			return { url: null, retryableError: false };
		}

		const resolverUrl = provider.latestUrl(targetUrl);
		try {
			const response = await requestUrl({ method: "GET", url: resolverUrl });
			if (response.status === 429 || response.status >= 500) {
				return { url: null, retryableError: true };
			}
			const responseUrl = (response as { url?: string }).url;
			const location =
				response.headers?.location ??
				response.headers?.Location ??
				response.headers?.LOCATION;
			const resolvedUrl =
				typeof responseUrl === "string" && responseUrl
					? responseUrl
					: location || resolverUrl;
			if (
				provider.isSnapshotUrl(resolvedUrl) &&
				this.isSnapshotForUrl(providerId, resolvedUrl, targetUrl)
			) {
				return {
					url: this.normalizeProviderSnapshotUrl(providerId, resolvedUrl),
					retryableError: false,
				};
			}
			const textSnapshot = this.extractProviderSnapshotFromText(
				providerId,
				response.text,
				targetUrl,
			);
			if (textSnapshot) {
				return {
					url: this.normalizeProviderSnapshotUrl(providerId, textSnapshot),
					retryableError: false,
				};
			}
		} catch {
			return { url: null, retryableError: true };
		}

		return { url: null, retryableError: false };
	}

	private isSuccessfulArchiveTodaySubmitResponse(status: number | undefined): boolean {
		return status === undefined || (status >= 200 && status < 400);
	}

	private async registerPendingArchive(
		url: string,
		targetUrl: string,
		filePath: string,
		approximateIndex?: number,
	): Promise<string> {
		if (!this.data.pendingArchives) this.data.pendingArchives = [];

		const isDuplicate = this.data.pendingArchives.some(
			(entry) =>
				entry.filePath === filePath &&
				entry.url === url &&
				entry.targetUrl === targetUrl &&
				entry.approximateIndex === approximateIndex,
		);
		if (isDuplicate) {
			const existing = this.data.pendingArchives.find(
				(entry) =>
					entry.filePath === filePath &&
					entry.url === url &&
					entry.targetUrl === targetUrl &&
					entry.approximateIndex === approximateIndex,
			);
			return existing?.id ?? "";
		}

		const id =
			typeof crypto !== "undefined" && crypto.randomUUID
				? crypto.randomUUID()
				: `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const entry: PendingArchiveEntry = {
			id,
			providerId: "archiveToday",
			url,
			targetUrl,
			filePath,
			approximateIndex,
			createdAt: Date.now(),
			checkCount: 0,
			maxWaitMs: this.activeSettings.archiveTodayPendingMaxWaitMs ?? 600000,
			status: "submitted",
		};
		this.data.pendingArchives.push(entry);
		await this.saveSettings();
		return id;
	}

	private async submitArchiveTodayUrl(
		url: string,
		targetUrl: string,
		filePath: string,
		approximateIndex?: number,
	): Promise<ArchiveTodaySubmitQueueResult> {
		if (!this.data.pendingArchives) this.data.pendingArchives = [];

		const isDuplicate = this.data.pendingArchives.some(
			(entry) =>
				entry.filePath === filePath &&
				entry.url === url &&
				entry.targetUrl === targetUrl &&
				entry.approximateIndex === approximateIndex,
		);
		if (isDuplicate) return { status: "duplicate" };

		const maxPending = this.activeSettings.archiveTodayMaxPendingCount ?? 30;
		if (this.data.pendingArchives.length >= maxPending) {
			new Notice(
				`archive.today pending queue is full (${maxPending} entries). Wait for pending snapshots to resolve, run "Check pending archive.today snapshots now", or reduce the number of links.`,
			);
			return { status: "queue_full" };
		}

		const isTargetAlreadySubmitted = this.data.pendingArchives.some(
			(entry) => entry.targetUrl === targetUrl,
		);
		if (!isTargetAlreadySubmitted) {
			try {
				const response = await requestUrl({
					method: "GET",
					url: ARCHIVE_PROVIDER_RESOLVERS.archiveToday.saveUrl(targetUrl),
				});
				if (!this.isSuccessfulArchiveTodaySubmitResponse(response.status)) {
					await this.logFailedArchive(
						url,
						filePath,
						`archive.today submit failed with HTTP ${response.status}`,
						0,
						{
							stage: "archive-today-autosave-failed",
							manualProviderIds: ["archiveToday"],
							targetUrl,
						},
					);
					return { status: "failed" };
				}
			} catch (e) {
				await this.logFailedArchive(
					url,
					filePath,
					`archive.today submit failed: ${(e as Error).message}`,
					0,
					{
						stage: "archive-today-autosave-failed",
						manualProviderIds: ["archiveToday"],
						targetUrl,
					},
				);
				return { status: "failed" };
			}
		}

		const id = await this.registerPendingArchive(url, targetUrl, filePath, approximateIndex);

		return { status: "queued", id };
	}

	async runPendingQueueCycle(): Promise<void> {
		if (this._pendingQueueCycleRunning) return;
		this._pendingQueueCycleRunning = true;
		try {
			await this.runPendingQueueCycleImpl();
		} finally {
			this._pendingQueueCycleRunning = false;
		}
	}

	private async runPendingQueueCycleImpl(): Promise<void> {
		if (!this.data.pendingArchives?.length) return;

		const now = Date.now();
		const pollIntervalMs = this.activeSettings.archiveTodayPendingPollIntervalMs ?? 60000;
		const batchSize = this.activeSettings.archiveTodayPendingPollBatchSize ?? 3;
		const expired: PendingArchiveEntry[] = [];

		for (const entry of this.data.pendingArchives) {
			if (now - entry.createdAt >= entry.maxWaitMs) {
				expired.push(entry);
			}
		}

		// 1. Log and remove expired items
		const expiredIds = new Set(expired.map((entry) => entry.id));
		for (const entry of expired) {
			await this.appendFailedArchive(
				{
					url: entry.url,
					targetUrl: entry.targetUrl,
					filePath: entry.filePath,
					timestamp: now,
					error: "archive.today pending snapshot was not resolved before max wait",
					retryCount: 0,
					stage: "archive-today-pending-timeout",
					manualProviderIds: ["archiveToday"],
				},
				{
					save: false,
				},
			);
		}

		this.data.pendingArchives = this.data.pendingArchives.filter(
			(entry) => !expiredIds.has(entry.id),
		);

		// 2. Identify and prepare candidates (increment check counts and save timestamps)
		const candidates = this.data.pendingArchives
			.filter(
				(entry) =>
					entry.lastCheckedAt === undefined ||
					now - entry.lastCheckedAt >= pollIntervalMs,
			)
			.slice(0, batchSize);

		for (const candidate of candidates) {
			candidate.lastCheckedAt = now;
			candidate.checkCount++;
			candidate.status = "submitted";
		}

		// Save prepared candidate timestamps and counters immediately before async requests
		await this.saveSettings();

		// 3. Process the prepared candidates
		for (const entry of candidates) {
			try {
				const resolution = await this.resolveProviderSnapshot(
					"archiveToday",
					entry.targetUrl,
				);

				if (!resolution.url) {
					// Entry stays in queue with the updated lastCheckedAt & checkCount
					continue;
				}
				const resolvedSnapshotUrl = resolution.url;

				const file = this.app.vault.getAbstractFileByPath(entry.filePath);
				if (!file || !(file instanceof TFile)) {
					// Permanent failure: target file no longer exists. Remove from queue.
					this.data.pendingArchives = this.data.pendingArchives.filter(
						(pending) => pending.id !== entry.id,
					);
					continue;
				}

				let inserted = false;
				let skippedBecauseAlreadyArchived = false;
				let isReplacement = false;
				await this.app.vault.process(file, (latestContent: string) => {
					const latestIndex = findLatestLinkIndex(
						latestContent,
						entry.url,
						entry.approximateIndex ?? 0,
					);
					if (latestIndex === null) return latestContent;

					const latestMatches = Array.from(latestContent.matchAll(LINK_REGEX));
					const currentMatch = latestMatches.find((match) => match.index === latestIndex);
					if (!currentMatch) return latestContent;

					const insertionPos = latestIndex + currentMatch[0].length;
					const textAfterLink = latestContent.slice(insertionPos, insertionPos + 300);

					const adjacentMatch = getAdjacentArchiveLinkMatch(textAfterLink);
					if (adjacentMatch) {
						const adjacentTimestamp = extractArchiveTimestamp(adjacentMatch[0]);
						const resolvedTimestamp = extractArchiveTimestamp(resolvedSnapshotUrl);

						if (!adjacentTimestamp || !resolvedTimestamp) {
							skippedBecauseAlreadyArchived = true;
							return latestContent;
						}

						if (resolvedTimestamp > adjacentTimestamp) {
							isReplacement = true;
						} else {
							skippedBecauseAlreadyArchived = true;
							return latestContent;
						}
					}

					const archiveUrl = normalizeArchiveUrl(resolvedSnapshotUrl);
					const modification = applyLinkModification(
						latestContent,
						entry.url,
						archiveUrl,
						entry.approximateIndex ?? 0,
						this.activeSettings,
						{ isReplacement, allowMismatchedReplacement: true },
					);
					if (!modification.modified) return latestContent;
					inserted = true;
					return modification.content;
				});

				// Remove from queue upon success/handling
				this.data.pendingArchives = this.data.pendingArchives.filter(
					(pending) => pending.id !== entry.id,
				);

				if (inserted) {
					new Notice(`Inserted archive.today snapshot in ${entry.filePath}.`);
					this.plugin.setStatusBarText?.("✅ archive.today snapshot inserted!");
					setTimeout(() => this.plugin.setStatusBarText?.(""), 4000);
				} else if (skippedBecauseAlreadyArchived) {
					new Notice(
						`archive.today snapshot resolved but link was already archived in ${entry.filePath}.`,
					);
				} else {
					new Notice(
						`archive.today snapshot resolved but URL no longer found in ${entry.filePath}.`,
					);
				}
			} catch {
				// On error, the entry remains in the queue (already has updated lastCheckedAt / checkCount)
			}
		}

		await this.saveSettings();
	}

	startPendingQueueScheduler(): void {
		if (this._schedulerStarted) return;
		this._schedulerStarted = true;

		const scheduleNext = () => {
			if (!this._schedulerStarted) return;

			const intervalMs = this.activeSettings.archiveTodayPendingPollIntervalMs ?? 60000;
			this._pendingQueueTimer = window.setTimeout(async () => {
				try {
					await this.runPendingQueueCycle();
				} finally {
					scheduleNext();
				}
			}, intervalMs);
		};

		void this.runPendingQueueCycle().finally(scheduleNext);
	}

	stopPendingQueueScheduler(): void {
		this._schedulerStarted = false;
		if (this._pendingQueueTimer !== null) {
			window.clearTimeout(this._pendingQueueTimer);
			this._pendingQueueTimer = null;
		}
	}

	private extractProviderSnapshotFromText(
		providerId: ArchiveProviderId,
		text: string | undefined,
		targetUrl: string,
	): string | null {
		if (providerId === "archiveToday" || providerId === "megalodon") {
			return extractProviderSnapshotFromText(providerId, text, targetUrl);
		}
		return null;
	}

	private isSnapshotForUrl(
		providerId: ArchiveProviderId,
		snapshotUrl: string,
		targetUrl: string,
	): boolean {
		if (providerId === "archiveToday" || providerId === "megalodon") {
			return isSnapshotForTargetUrl(providerId, snapshotUrl, targetUrl);
		}
		return false;
	}

	private normalizeUrlForComparison(url: string): string {
		return normalizeUrlForComparison(url);
	}

	private normalizeProviderSnapshotUrl(providerId: ArchiveProviderId, url: string): string {
		return providerId === "archiveToday"
			? normalizeArchiveUrl(this.decodeHtmlEntities(url))
			: url;
	}

	private decodeHtmlEntities(value: string): string {
		return decodeHtmlEntities(value);
	}

	openManualSavePagesForFailedArchives = async (providerId: ArchiveProviderId): Promise<void> => {
		const provider = ARCHIVE_PROVIDER_RESOLVERS[providerId];
		if (!provider) {
			new Notice("Unknown archive provider.");
			return;
		}

		const failedArchives = this.data.failedArchives ?? [];
		if (failedArchives.length === 0) {
			new Notice("No failed archives to open.");
			return;
		}

		const eligibleEntries = failedArchives
			.map((entry, index) => ({ entry, index }))
			.filter(({ entry }) => this.canManuallyOpenWithProvider(entry, providerId))
			.sort((a, b) => {
				const aOpened = a.entry.manualOpenedAt ?? 0;
				const bOpened = b.entry.manualOpenedAt ?? 0;
				return aOpened - bOpened;
			});

		if (eligibleEntries.length === 0) {
			new Notice(`No failed archives are eligible for ${provider.name} manual save.`);
			return;
		}

		const batchSize = Math.min(
			Math.max(this.activeSettings.manualSaveBatchSize || 5, 1),
			5,
			eligibleEntries.length,
		);
		for (const { entry } of eligibleEntries.slice(0, batchSize)) {
			const targetUrl =
				entry.targetUrl ??
				applySubstitutionRules(entry.url, this.activeSettings.substitutionRules);

			globalThis.open?.(provider.saveUrl(targetUrl), "_blank", "noopener");
			entry.manualOpenedAt = Date.now();
			entry.manualOpenCount = (entry.manualOpenCount ?? 0) + 1;
		}
		await this.saveSettings();
		new Notice(`Opened ${batchSize} ${provider.name} save page${batchSize === 1 ? "" : "s"}.`);
	};

	private canManuallyOpenWithProvider(
		entry: FailedArchiveEntry,
		providerId: ArchiveProviderId,
	): boolean {
		if (entry.manualProviderIds?.length) {
			return entry.manualProviderIds.includes(providerId);
		}
		const targetUrl =
			entry.targetUrl ??
			applySubstitutionRules(entry.url, this.activeSettings.substitutionRules);
		return this.getArchivePolicy(targetUrl).providers.includes(providerId);
	}

	// Query Wayback Machine CDX API for the latest snapshot timestamp. See https://archive.org/developers/wayback-cdx-server.html
	async getLatestSnapshotUrl(targetUrl: string): Promise<string | null> {
		try {
			const apiUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(targetUrl)}&output=json&fl=timestamp&filter=statuscode:200&limit=1&sort=reverse`;
			const response = await requestUrl({ url: apiUrl, method: "GET" });

			if (response.status !== 200) {
				return null;
			}

			let jsonData: unknown;
			try {
				jsonData =
					typeof response.json === "object" ? response.json : JSON.parse(response.text);
			} catch {
				return null;
			}

			if (!Array.isArray(jsonData) || jsonData.length < 2) {
				return null;
			}

			const latestTimestamp = jsonData[1][0];
			if (!latestTimestamp) {
				return null;
			}

			return `https://web.archive.org/web/${latestTimestamp}/${targetUrl}`;
		} catch {
			return null;
		}
	}

	archiveLinksAction = async (
		editor: Editor,
		ctx: MarkdownView | MarkdownFileInfo,
	): Promise<void> => {
		const file = ctx.file;
		if (!file) {
			new Notice("Error: Could not get the current file.");
			return;
		}

		const selectedText = editor.getSelection();
		const isSelection = selectedText.length > 0;
		const archivedCount = 0;
		const failedCount = 0;
		const skippedCount = 0;
		const counters = { archivedCount, failedCount, skippedCount, submittedCount: 0 };

		if (isSelection) {
			const selectionStartOffset = editor.posToOffset(editor.getCursor("from"));
			const selectionEndOffset = editor.posToOffset(editor.getCursor("to"));
			const fullDocContent = editor.getValue();
			const selectedLinks = selectFullyContainedLinkMatches(
				fullDocContent,
				selectionStartOffset,
				selectionEndOffset,
			);
			const allMatches = selectedLinks.map((link) => link.match);

			const filterResult = this.filterLinksForArchiving(allMatches, fullDocContent, false, {
				isSelection: true,
				fullDocContent,
			});

			if (!filterResult.linksToProcess.length) {
				new Notice("No suitable links found in selection.");
				return;
			}

			new Notice(`Processing ${filterResult.linksToProcess.length} links in selection...`);

			// For Selection mode, we process each link and apply it to the editor immediately.
			const total = filterResult.linksToProcess.length;
			let current = 0;
			for (const match of filterResult.linksToProcess) {
				current++;
				this.plugin.setStatusBarText?.(`⌛ Archiving link ${current}/${total}...`);
				const originalUrl = getUrlFromMatch(match);
				const absoluteOriginalIndex = match.index;
				if (absoluteOriginalIndex === undefined) continue;

				// API call
				const archiveOutcome = await this.processSingleUrlArchival(
					originalUrl,
					false,
					file.path,
					absoluteOriginalIndex,
				);
				if (archiveOutcome.status === "submitted") {
					counters.submittedCount++;
					continue;
				}
				if (archiveOutcome.status === "archived_failed") {
					counters.failedCount++;
					await this.logFailedArchive(
						originalUrl,
						file.path,
						`Archiving failed (${archiveOutcome.error || "Unknown error"})`,
						0,
						{
							stage: archiveOutcome.stage,
							manualProviderIds: archiveOutcome.manualProviderIds,
							targetUrl: archiveOutcome.targetUrl,
						},
					);
					continue;
				}
				// Apply edit surgically to editor
				const applied = this.applyLinkEditToEditor(
					editor,
					originalUrl,
					absoluteOriginalIndex,
					archiveOutcome.url,
					false,
				);
				if (applied) {
					counters.archivedCount++;
				} else {
					counters.skippedCount++;
				}
			}
			counters.skippedCount += filterResult.skippedCount;
		} else {
			new Notice(`Archiving links in ${file.basename}...`);
			await this.processFileWithContext(file, false, counters);
		}

		let summary = `Archival complete. Archived: ${counters.archivedCount}, Failed: ${counters.failedCount}`;
		if (counters.skippedCount > 0) summary += `, Skipped: ${counters.skippedCount}`;
		if (counters.submittedCount > 0) summary += `, Submitted: ${counters.submittedCount}`;
		new Notice(summary);
		this.plugin.setStatusBarText?.(
			`✅ Archived: ${counters.archivedCount}, Failed: ${counters.failedCount}`,
		);
		setTimeout(() => this.plugin.setStatusBarText?.(""), 4000);
	};

	archiveAllLinksVaultAction = async (): Promise<void> => {
		new Notice("Starting vault-wide link archiving... This may take time.");
		const markdownFiles = this.app.vault.getMarkdownFiles();
		const counters = { archivedCount: 0, failedCount: 0, skippedCount: 0 };

		const totalFiles = markdownFiles.length;
		let fileIndex = 0;
		for (const file of markdownFiles) {
			fileIndex++;
			this.plugin.setStatusBarText?.(`⌛ Vault archive: file ${fileIndex}/${totalFiles}...`);
			await this.processFileWithContext(file, false, counters);
		}

		await this.saveSettings();
		new Notice(
			`Vault archival complete. Archived: ${counters.archivedCount}, Failed: ${counters.failedCount}, Skipped: ${counters.skippedCount}.`,
		);
		this.plugin.setStatusBarText?.(
			`✅ Vault archived! Success: ${counters.archivedCount}, Failed: ${counters.failedCount}`,
		);
		setTimeout(() => this.plugin.setStatusBarText?.(""), 5000);
	};

	submitAllLinksVaultToArchiveTodayAction = async (): Promise<void> => {
		new Notice("Starting vault-wide link submission to archive.today... This may take time.");
		const markdownFiles = this.app.vault.getMarkdownFiles();

		let processedCount = 0;
		let skippedCount = 0;
		let failedCount = 0;
		let pendingCount = 0;

		const totalFiles = markdownFiles.length;
		let fileIndex = 0;

		for (const file of markdownFiles) {
			fileIndex++;
			this.plugin.setStatusBarText?.(
				`⌛ Vault archiveToday submit: file ${fileIndex}/${totalFiles}...`,
			);

			let fileContent: string;
			try {
				fileContent = await this.app.vault.read(file);
			} catch {
				continue;
			}

			if (
				this.activeSettings.pathPatterns?.length > 0 &&
				!matchesAnyPattern(file.path, this.activeSettings.pathPatterns)
			) {
				continue;
			}
			if (
				this.activeSettings.wordPatterns?.length > 0 &&
				!this.activeSettings.wordPatterns.some((p) => fileContent.includes(p))
			) {
				continue;
			}

			const allMatches = Array.from(fileContent.matchAll(LINK_REGEX));
			const filterResult = this.filterLinksForArchiving(allMatches, fileContent, false);
			skippedCount += filterResult.skippedCount;

			const linksToProcess = filterResult.linksToProcess;
			if (!linksToProcess.length) continue;

			const totalLinks = linksToProcess.length;
			let linkIndex = 0;
			for (const match of linksToProcess) {
				linkIndex++;
				processedCount++;
				this.plugin.setStatusBarText?.(
					`⌛ Submitting link ${linkIndex}/${totalLinks} in ${file.basename} to archive.today...`,
				);

				const originalUrl = getUrlFromMatch(match);
				const absoluteOriginalIndex = match.index;
				if (absoluteOriginalIndex === undefined) {
					skippedCount++;
					continue;
				}

				const substitutedUrl = applySubstitutionRules(
					originalUrl,
					this.activeSettings.substitutionRules,
				);

				const result = await this.submitArchiveTodayUrl(
					originalUrl,
					substitutedUrl,
					file.path,
					absoluteOriginalIndex,
				);

				if (result.status === "queued") {
					pendingCount++;
				} else if (result.status === "duplicate") {
					skippedCount++;
				} else if (result.status === "queue_full") {
					failedCount++;
				} else {
					failedCount++;
				}

				const submitDelayMs = this.activeSettings.archiveTodaySubmitDelayMs ?? 5000;
				if (submitDelayMs > 0) {
					await new Promise((resolve) => setTimeout(resolve, submitDelayMs));
				}
			}
		}

		await this.saveSettings();
		new Notice(
			`Vault archive.today submission complete.\n` +
				`Processed: ${processedCount}\n` +
				`Queued (Pending): ${pendingCount}\n` +
				`Skipped: ${skippedCount}\n` +
				`Failed: ${failedCount}`,
		);
		this.plugin.setStatusBarText?.(
			`✅ Vault archive.today complete! Queued: ${pendingCount}, Failed: ${failedCount}`,
		);
		setTimeout(() => this.plugin.setStatusBarText?.(""), 5000);
	};

	insertLatestFallbackSnapshotsVaultAction = async (
		providerId: ArchiveProviderId,
		isForce: boolean,
	): Promise<void> => {
		const providerName = providerId === "archiveToday" ? "archive.today" : "Web Gyotaku";
		new Notice(`Starting vault-wide ${providerName} snapshot retrieval... This may take time.`);
		const markdownFiles = this.app.vault.getMarkdownFiles();

		let processedCount = 0;
		let insertedCount = 0;
		let skippedCount = 0;
		let failedCount = 0;
		const pendingCount = 0;

		const totalFiles = markdownFiles.length;
		let fileIndex = 0;

		for (const file of markdownFiles) {
			fileIndex++;
			this.plugin.setStatusBarText?.(
				`⌛ Vault ${providerName} retrieve: file ${fileIndex}/${totalFiles}...`,
			);

			let fileContent: string;
			try {
				fileContent = await this.app.vault.read(file);
			} catch {
				continue;
			}

			if (
				this.activeSettings.pathPatterns?.length > 0 &&
				!matchesAnyPattern(file.path, this.activeSettings.pathPatterns)
			) {
				continue;
			}
			if (
				this.activeSettings.wordPatterns?.length > 0 &&
				!this.activeSettings.wordPatterns.some((p) => fileContent.includes(p))
			) {
				continue;
			}

			const allMatches = Array.from(fileContent.matchAll(LINK_REGEX));
			const filterResult = this.filterLinksForArchiving(allMatches, fileContent, isForce);
			skippedCount += filterResult.skippedCount;

			const linksToProcess = filterResult.linksToProcess;
			if (!linksToProcess.length) continue;

			const totalLinks = linksToProcess.length;
			let linkIndex = 0;
			for (const match of linksToProcess) {
				linkIndex++;
				processedCount++;
				this.plugin.setStatusBarText?.(
					`⌛ Retrieving snapshot ${linkIndex}/${totalLinks} from ${providerName} in ${file.basename}...`,
				);

				const originalUrl = getUrlFromMatch(match);
				const absoluteOriginalIndex = match.index;
				if (absoluteOriginalIndex === undefined) {
					skippedCount++;
					continue;
				}

				const substitutedUrl = applySubstitutionRules(
					originalUrl,
					this.activeSettings.substitutionRules,
				);

				const resolution = await this.resolveProviderSnapshot(providerId, substitutedUrl);

				if (resolution.url) {
					let applied = false;
					await this.app.vault.process(file, (latestContent: string) => {
						const latestIndex = findLatestLinkIndex(
							latestContent,
							originalUrl,
							absoluteOriginalIndex,
						);
						if (latestIndex === null) return latestContent;

						const latestMatches = Array.from(latestContent.matchAll(LINK_REGEX));
						const currentMatch = latestMatches.find((m) => m.index === latestIndex);
						if (!currentMatch) return latestContent;

						const modification = applyLinkModification(
							latestContent,
							originalUrl,
							resolution.url!,
							latestIndex,
							this.activeSettings,
							{ isReplacement: isForce, allowMismatchedReplacement: isForce },
						);

						if (modification.modified) {
							applied = true;
							return modification.content;
						}
						return latestContent;
					});

					if (applied) {
						insertedCount++;
					} else {
						skippedCount++;
					}
				} else {
					failedCount++;
				}

				const lookupDelayMs = this.activeSettings.apiDelay ?? 1000;
				if (lookupDelayMs > 0) {
					await new Promise((resolve) => setTimeout(resolve, lookupDelayMs));
				}
			}
		}

		await this.saveSettings();
		new Notice(
			`Vault ${providerName} retrieval complete.\n` +
				`Processed: ${processedCount}\n` +
				`Inserted: ${insertedCount}\n` +
				`Skipped: ${skippedCount}\n` +
				`Failed: ${failedCount}\n` +
				`Pending: ${pendingCount}`,
		);
		this.plugin.setStatusBarText?.(
			`✅ Vault ${providerName} done! Inserted: ${insertedCount}, Failed: ${failedCount}`,
		);
		setTimeout(() => this.plugin.setStatusBarText?.(""), 5000);
	};

	forceReArchiveLinksAction = async (
		editor: Editor,
		ctx: MarkdownView | MarkdownFileInfo,
	): Promise<void> => {
		const file = ctx.file;
		if (!file) {
			new Notice("Error: Could not get the current file.");
			return;
		}

		const selectedText = editor.getSelection();
		const isSelection = selectedText.length > 0;
		const counters = { archivedCount: 0, failedCount: 0, skippedCount: 0, submittedCount: 0 };

		if (isSelection) {
			const selectionStartOffset = editor.posToOffset(editor.getCursor("from"));
			const selectionEndOffset = editor.posToOffset(editor.getCursor("to"));
			const fullDocContent = editor.getValue();
			const selectedLinks = selectFullyContainedLinkMatches(
				fullDocContent,
				selectionStartOffset,
				selectionEndOffset,
			);
			const allMatches = selectedLinks.map((link) => link.match);

			const filterResult = this.filterLinksForArchiving(allMatches, fullDocContent, true, {
				isSelection: true,
				fullDocContent,
			});

			if (!filterResult.linksToProcess.length) {
				new Notice("No suitable links found in selection to force re-archive.");
				return;
			}

			new Notice(
				`Force re-archiving ${filterResult.linksToProcess.length} links in selection...`,
			);

			const total = filterResult.linksToProcess.length;
			let current = 0;
			for (const match of filterResult.linksToProcess) {
				current++;
				this.plugin.setStatusBarText?.(`⌛ Force re-archiving link ${current}/${total}...`);
				const originalUrl = getUrlFromMatch(match);
				const absoluteOriginalIndex = match.index;
				if (absoluteOriginalIndex === undefined) continue;

				// API call
				const archiveOutcome = await this.processSingleUrlArchival(
					originalUrl,
					true,
					file.path,
					absoluteOriginalIndex,
				);
				if (archiveOutcome.status === "submitted") {
					counters.submittedCount++;
					continue;
				}
				if (archiveOutcome.status === "archived_failed") {
					counters.failedCount++;
					await this.logFailedArchive(
						originalUrl,
						file.path,
						`Archiving failed (${archiveOutcome.error || "Unknown error"})`,
						0,
						{
							stage: archiveOutcome.stage,
							manualProviderIds: archiveOutcome.manualProviderIds,
							targetUrl: archiveOutcome.targetUrl,
						},
					);
					continue;
				}
				if (
					archiveOutcome.status === "archived_limited" ||
					archiveOutcome.status === "cache_hit_limited"
				) {
					counters.skippedCount++;
					continue;
				}

				// Apply edit surgically to editor
				const applied = this.applyLinkEditToEditor(
					editor,
					originalUrl,
					absoluteOriginalIndex,
					archiveOutcome.url,
					true,
				);
				if (applied) {
					counters.archivedCount++;
				} else {
					counters.skippedCount++;
				}
			}
			counters.skippedCount += filterResult.skippedCount;
		} else {
			new Notice(`Force re-archiving links in ${file.basename}...`);
			await this.processFileWithContext(file, true, counters);
		}

		let summary = `Force re-archival complete. Archived: ${counters.archivedCount}, Failed: ${counters.failedCount}`;
		if (counters.skippedCount > 0) summary += `, Skipped: ${counters.skippedCount}`;
		if (counters.submittedCount > 0) summary += `, Submitted: ${counters.submittedCount}`;
		new Notice(summary);
		this.plugin.setStatusBarText?.(
			`✅ Force re-archived: ${counters.archivedCount}, Failed: ${counters.failedCount}`,
		);
		setTimeout(() => this.plugin.setStatusBarText?.(""), 4000);
	};

	/**
	 * Helper to apply a link edit (insertion or replacement) surgically to the editor.
	 * Uses findLatestLinkIndex to be resilient to text shifts during the delay.
	 */
	private applyLinkEditToEditor(
		editor: Editor,
		originalUrl: string,
		originalAbsoluteIndex: number,
		archiveUrl: string,
		isForce: boolean,
	): boolean {
		const latestContent = editor.getValue();
		const latestIndex = findLatestLinkIndex(latestContent, originalUrl, originalAbsoluteIndex);

		if (latestIndex === null) {
			return false; // Link was deleted
		}

		const latestMatches = Array.from(latestContent.matchAll(LINK_REGEX));
		const currentMatch = latestMatches.find((m) => m.index === latestIndex);
		if (!currentMatch) return false;

		const insertionPosIndex = latestIndex + currentMatch[0].length;
		const textAfterLink = latestContent.substring(
			insertionPosIndex,
			insertionPosIndex + ADJACENT_LINK_SEARCH_LIMIT,
		);
		const isAdjacent = isFollowedByArchiveLink(textAfterLink);

		// Freshness check for standard mode
		if (isAdjacent && !isForce) {
			const adjMatch = getAdjacentArchiveLinkMatch(textAfterLink);
			if (adjMatch) {
				const timestamp = extractArchiveTimestamp(adjMatch[0]);
				const freshness = checkAdjacentLinkFreshness(timestamp, this.activeSettings);
				if (!freshness.shouldProcess) return false;
			}
		}

		const modification = applyLinkModification(
			latestContent,
			originalUrl,
			archiveUrl,
			originalAbsoluteIndex,
			this.activeSettings,
			{ isReplacement: isAdjacent, allowMismatchedReplacement: isForce },
		);
		if (!modification.modified) return false;

		const change = this.findContentReplacement(latestContent, modification.content);
		const from = editor.offsetToPos(change.start);
		if (change.start === change.end) {
			editor.replaceRange(change.replacement, from);
		} else {
			const to = editor.offsetToPos(change.end);
			editor.replaceRange(change.replacement, from, to);
		}
		return true;
	}

	private findContentReplacement(
		before: string,
		after: string,
	): { start: number; end: number; replacement: string } {
		let start = 0;
		while (start < before.length && start < after.length && before[start] === after[start]) {
			start++;
		}

		let beforeEnd = before.length;
		let afterEnd = after.length;
		while (
			beforeEnd > start &&
			afterEnd > start &&
			before[beforeEnd - 1] === after[afterEnd - 1]
		) {
			beforeEnd--;
			afterEnd--;
		}

		return {
			start,
			end: beforeEnd,
			replacement: after.slice(start, afterEnd),
		};
	}

	archiveLinksInCurrentNoteToArchiveTodayAction = async (
		editor: Editor,
		ctx: MarkdownView | MarkdownFileInfo,
	): Promise<void> => {
		const file = ctx.file;
		if (!file) {
			new Notice("Error: Could not get the current file.");
			return;
		}

		const selectedText = editor.getSelection();
		const isSelection = selectedText.length > 0;

		const selectionStartOffset = isSelection ? editor.posToOffset(editor.getCursor("from")) : 0;
		const selectionEndOffset = isSelection
			? editor.posToOffset(editor.getCursor("to"))
			: editor.getValue().length;
		const fullDocContent = editor.getValue();
		const selectedLinks = selectFullyContainedLinkMatches(
			fullDocContent,
			selectionStartOffset,
			selectionEndOffset,
		);
		const allMatches = selectedLinks.map((link) => link.match);

		const filterResult = this.filterLinksForArchiving(allMatches, fullDocContent, false, {
			isSelection: isSelection,
			fullDocContent,
		});

		if (!filterResult.linksToProcess.length) {
			new Notice(
				isSelection
					? "No suitable links found in selection."
					: "No suitable links found in current note.",
			);
			return;
		}

		new Notice(
			isSelection
				? `Submitting ${filterResult.linksToProcess.length} selected links to archive.today...`
				: `Submitting ${filterResult.linksToProcess.length} links in ${file.basename} to archive.today...`,
		);

		let archivedCount = 0;
		let pendingCount = 0;
		let failedCount = 0;
		let duplicateCount = 0;
		let queueFullCount = 0;

		const total = filterResult.linksToProcess.length;
		let current = 0;
		for (const match of filterResult.linksToProcess) {
			current++;
			this.plugin.setStatusBarText?.(
				`⌛ Submitting link ${current}/${total} to archive.today...`,
			);
			const originalUrl = getUrlFromMatch(match);
			const absoluteOriginalIndex = match.index;
			if (absoluteOriginalIndex === undefined) continue;

			const substitutedUrl = applySubstitutionRules(
				originalUrl,
				this.activeSettings.substitutionRules,
			);

			if (this.activeSettings.archiveTodayExperimentalSubmit) {
				const result = await this.submitArchiveTodayUrl(
					originalUrl,
					substitutedUrl,
					file.path,
					absoluteOriginalIndex,
				);
				if (result.status === "queued") pendingCount++;
				if (result.status === "failed") failedCount++;
				if (result.status === "duplicate") duplicateCount++;
				if (result.status === "queue_full") queueFullCount++;

				const submitDelayMs = this.activeSettings.archiveTodaySubmitDelayMs ?? 5000;
				if (current < total && submitDelayMs > 0) {
					await new Promise((resolve) => setTimeout(resolve, submitDelayMs));
				}
			} else {
				const policy: EffectiveArchivePolicy = {
					providers: ["archiveToday"],
					archiveTodayExperimentalSubmit: false,
				};
				const outcome = await this.archiveWithProviderPolicy(
					substitutedUrl,
					policy,
					"Manual command to archive.today",
				);

				if (outcome.status === "success") {
					const applied = this.applyLinkEditToEditor(
						editor,
						originalUrl,
						absoluteOriginalIndex,
						outcome.url,
						true,
					);
					if (applied) archivedCount++;
				} else {
					failedCount++;
					await this.logFailedArchive(
						originalUrl,
						file.path,
						`archive.today command failed (${(outcome as { status_ext?: string }).status_ext || "Unknown error"})`,
						0,
						{
							stage: (outcome as { stage?: FailedArchiveStage }).stage,
							manualProviderIds: ["archiveToday"],
							targetUrl: substitutedUrl,
						},
					);
				}
			}
		}

		if (pendingCount > 0) {
			const msg =
				`Queued ${pendingCount} link(s) for archive.today.` +
				(duplicateCount ? ` Skipped ${duplicateCount} duplicate(s).` : "") +
				(queueFullCount ? ` Queue full for ${queueFullCount} link(s).` : "") +
				" Snapshots will be inserted when resolved.";
			new Notice(msg);
			this.plugin.setStatusBarText?.(
				`⏳ ${pendingCount} archive.today snapshot(s) pending...`,
			);
			setTimeout(() => this.plugin.setStatusBarText?.(""), 6000);
		} else if (archivedCount > 0) {
			const msg =
				"archive.today archival complete." +
				` Archived: ${archivedCount}, Failed: ${failedCount}` +
				(duplicateCount ? `, Skipped duplicate: ${duplicateCount}` : "") +
				(queueFullCount ? `, Queue full: ${queueFullCount}` : "");
			new Notice(msg);
			this.plugin.setStatusBarText?.(
				`✅ archive.today done! Archived: ${archivedCount}, Failed: ${failedCount}`,
			);
			setTimeout(() => this.plugin.setStatusBarText?.(""), 4000);
		} else if (failedCount > 0 || queueFullCount > 0 || duplicateCount > 0) {
			const msg =
				"No new archive.today snapshots queued or inserted." +
				(failedCount ? ` Failed: ${failedCount}` : "") +
				(duplicateCount ? ` Skipped duplicate: ${duplicateCount}` : "") +
				(queueFullCount ? ` Queue full: ${queueFullCount}` : "");
			new Notice(msg);
			this.plugin.setStatusBarText?.("No new archive.today snapshots queued or inserted.");
			setTimeout(() => this.plugin.setStatusBarText?.(""), 4000);
		} else {
			new Notice("No new archive.today snapshots queued or inserted.");
			this.plugin.setStatusBarText?.("");
		}
	};

	insertLatestFallbackSnapshotAction = async (
		editor: Editor,
		ctx: MarkdownView | MarkdownFileInfo,
		providerId: ArchiveProviderId,
		isForce: boolean,
	): Promise<void> => {
		const file = ctx.file;
		if (!file) {
			new Notice("Error: Could not get the current file.");
			return;
		}

		const selectedText = editor.getSelection();
		const isSelection = selectedText.length > 0;
		const fullDocContent = editor.getValue();

		const selectionStartOffset = isSelection ? editor.posToOffset(editor.getCursor("from")) : 0;
		const selectionEndOffset = isSelection
			? editor.posToOffset(editor.getCursor("to"))
			: fullDocContent.length;

		const selectedLinks = selectFullyContainedLinkMatches(
			fullDocContent,
			selectionStartOffset,
			selectionEndOffset,
		);
		const allMatches = selectedLinks.map((link) => link.match);

		const filterResult = this.filterLinksForArchiving(allMatches, fullDocContent, isForce, {
			isSelection,
			fullDocContent,
		});

		if (!filterResult.linksToProcess.length) {
			new Notice(
				isSelection
					? "No suitable links found in selection."
					: "No suitable links found in current note.",
			);
			return;
		}

		const providerName = providerId === "archiveToday" ? "archive.today" : "Web Gyotaku";
		const scopeText = isSelection ? "selected" : "current note";
		new Notice(
			`Retrieving latest ${providerName} snapshots for ${filterResult.linksToProcess.length} ${scopeText} links...`,
		);

		let insertedCount = 0;
		let failedCount = 0;

		const total = filterResult.linksToProcess.length;
		let current = 0;
		for (const match of filterResult.linksToProcess) {
			current++;
			this.plugin.setStatusBarText?.(
				`⌛ Retrieving snapshot ${current}/${total} from ${providerName}...`,
			);
			const originalUrl = getUrlFromMatch(match);
			const absoluteOriginalIndex = match.index;
			if (absoluteOriginalIndex === undefined) continue;

			const substitutedUrl = applySubstitutionRules(
				originalUrl,
				this.activeSettings.substitutionRules,
			);
			const resolution = await this.resolveProviderSnapshot(providerId, substitutedUrl);

			if (resolution.url) {
				const applied = this.applyLinkEditToEditor(
					editor,
					originalUrl,
					absoluteOriginalIndex,
					resolution.url,
					isForce,
				);
				if (applied) {
					insertedCount++;
				}
			} else {
				failedCount++;
				new Notice(`No snapshot found on ${providerName} for ${originalUrl}`);
			}
		}

		new Notice(
			`${providerName} snapshot retrieval complete. Inserted: ${insertedCount}, Not Found: ${failedCount}`,
		);
		this.plugin.setStatusBarText?.(
			`✅ ${providerName} done! Inserted: ${insertedCount}, Not Found: ${failedCount}`,
		);
		setTimeout(() => this.plugin.setStatusBarText?.(""), 4000);
	};

	forceReArchiveAllLinksAction = async (): Promise<void> => {
		new Notice("Starting vault-wide force re-archiving... This may take time.");
		const markdownFiles = this.app.vault.getMarkdownFiles();
		const counters = { archivedCount: 0, failedCount: 0, skippedCount: 0 };

		const totalFiles = markdownFiles.length;
		let fileIndex = 0;
		for (const file of markdownFiles) {
			fileIndex++;
			this.plugin.setStatusBarText?.(
				`⌛ Vault force re-archive: file ${fileIndex}/${totalFiles}...`,
			);
			await this.processFileWithContext(file, true, counters);
		}

		await this.saveSettings();
		new Notice(
			`Vault force re-Archival complete. Archived: ${counters.archivedCount}, Failed: ${counters.failedCount}, Skipped: ${counters.skippedCount}.`,
		);
		this.plugin.setStatusBarText?.(
			`✅ Vault force re-archived! Success: ${counters.archivedCount}, Failed: ${counters.failedCount}`,
		);
		setTimeout(() => this.plugin.setStatusBarText?.(""), 5000);
	};

	retryFailedArchives = async (forceReplace: boolean): Promise<void> => {
		const logFolderPath = this.app.vault.configDir + "/plugins/wayback-archiver/failed_logs";
		let failedLogFiles: string[] = [];
		try {
			const adapter = this.app.vault.adapter;
			if (await adapter.exists(logFolderPath)) {
				const listResult = await adapter.list(logFolderPath);
				const logFileRegex = /^wayback-archiver-failed-log-\d+\.(json|csv)$/;
				failedLogFiles = listResult.files.filter((filePath) => {
					const fileName = filePath.split("/").pop() || "";
					return logFileRegex.test(fileName);
				});
			} else {
				// console.log(`Log folder "${logFolderPath}" does not exist.`);
			}
		} catch (error) {
			// console.error(`Error listing files in "${logFolderPath}":`, error);
			const errorMessage = error instanceof Error ? error.message : "Unknown error";
			new Notice(`Error accessing log folder: ${errorMessage}`);
			return;
		}

		if (failedLogFiles.length === 0) {
			new Notice("No failed log files found in folder.");
			return;
		}

		new FileSelectModal(this.app, failedLogFiles, async (selectedFileName: string | null) => {
			if (!selectedFileName) {
				new Notice("Retry cancelled.");
				return;
			}

			try {
				// console.log(`Modal returned selectedFileName: "${selectedFileName}"`);
				const content = await this.app.vault.adapter.read(selectedFileName);
				let parsedEntries: FailedArchiveEntry[] = [];

				if (selectedFileName.endsWith(".json")) {
					parsedEntries = JSON.parse(content).map((entry: FailedArchiveEntry) => ({
						...entry,
						url: entry.url,
						filePath: entry.filePath,
						timestamp: entry.timestamp,
						error: entry.error,
						retryCount: entry.retryCount ?? 0,
					}));
				} else if (selectedFileName.endsWith(".csv")) {
					parsedEntries = parseFailedArchiveEntriesFromCsv(content);
				} else {
					new Notice("Unsupported file format.");
					return;
				}

				if (!parsedEntries || parsedEntries.length === 0) {
					new Notice("No failed archives found in selected file.");
					return;
				}

				const failedCount = parsedEntries.length;
				let listPreview = parsedEntries
					.slice(0, 5)
					.map((f) => `${f.url} (${f.filePath})`)
					.join("\n");
				if (failedCount > 5) listPreview += `\n...and ${failedCount - 5} more`;

				if (this.activeSettings.autoClearFailedLogs) {
					await this.executeRetryOfFailedArchives(
						selectedFileName,
						parsedEntries,
						failedCount,
						forceReplace,
					);
				} else {
					new ConfirmationModal(
						this.app,
						forceReplace ? "Force retry failed archives?" : "Retry failed archives?",
						`${forceReplace ? "Force retry" : "Retry"} all ${failedCount} failed archives?\n\nSample:\n${listPreview}`,
						forceReplace ? "Yes, force retry all" : "Yes, retry all",
						async (confirmed: boolean) => {
							if (!confirmed) {
								new Notice("Retry cancelled.");
								return;
							}

							await this.executeRetryOfFailedArchives(
								selectedFileName,
								parsedEntries,
								failedCount,
								forceReplace,
							);
						},
					).open();
				}
			} catch {
				new Notice("Error loading failed log file.");
			}
		}).open();
	};

	private async executeRetryOfFailedArchives(
		selectedFileName: string,
		parsedEntries: FailedArchiveEntry[],
		failedCount: number,
		forceReplace: boolean,
	): Promise<void> {
		let successCount = 0;
		const originalFailedList = [...parsedEntries];
		const stillFailed: FailedArchiveEntry[] = [];

		new Notice(`Retrying ${failedCount} failed archives...`);

		for (const entry of originalFailedList) {
			let shouldSkip = false;
			if (!forceReplace) {
				try {
					const file = this.app.vault.getAbstractFileByPath(entry.filePath);
					if (file && file instanceof TFile) {
						const content = await this.app.vault.read(file);
						const matches = Array.from(content.matchAll(LINK_REGEX));
						for (const match of matches) {
							const originalUrl = getUrlFromMatch(match);
							if (originalUrl !== entry.url) continue;

							const matchIndex = match.index;
							if (matchIndex === undefined) continue;

							const insertionPosIndex = matchIndex + match[0].length;
							const textAfterLink = content.substring(
								insertionPosIndex,
								insertionPosIndex + ADJACENT_LINK_SEARCH_LIMIT,
							);
							const existingArchiveMatch = getAdjacentArchiveLinkMatch(textAfterLink);

							if (existingArchiveMatch) {
								shouldSkip = true;
								if (this.data.failedArchives) {
									const idx = this.data.failedArchives.findIndex(
										(e) => e.url === entry.url && e.filePath === entry.filePath,
									);
									if (idx !== -1) {
										this.data.failedArchives.splice(idx, 1);
										await this.saveSettings();
									}
								}
								const indexToRemove = parsedEntries.findIndex(
									(e) => e.url === entry.url && e.filePath === entry.filePath,
								);
								if (indexToRemove !== -1) {
									parsedEntries.splice(indexToRemove, 1);
								}
								break;
							}
						}
					}
				} catch {
					// Ignored
				}
			}

			if (shouldSkip) {
				continue;
			}

			await new Promise((res) => setTimeout(res, this.activeSettings.apiDelay));
			const result = await this.archiveUrl(entry.url);
			if (result.status === "success" || result.status === "too_many_captures") {
				successCount++;

				if (this.data.failedArchives) {
					const idx = this.data.failedArchives.findIndex(
						(e) => e.url === entry.url && e.filePath === entry.filePath,
					);
					if (idx !== -1) {
						this.data.failedArchives.splice(idx, 1);
						await this.saveSettings();
					}
				}

				try {
					const file = this.app.vault.getAbstractFileByPath(entry.filePath);
					if (file && file instanceof TFile) {
						await this.app.vault.process(file, (currentContent) => {
							const matches = Array.from(
								currentContent.matchAll(LINK_REGEX),
							).reverse();

							for (const match of matches) {
								if (getUrlFromMatch(match) !== entry.url) continue;

								const matchIndex = match.index;
								if (matchIndex === undefined) continue;

								const insertionPosIndex = matchIndex + match[0].length;
								const textAfterLink = currentContent.substring(
									insertionPosIndex,
									insertionPosIndex + 300,
								);
								const isAdjacent = isFollowedByArchiveLink(textAfterLink);

								if (isAdjacent && !forceReplace) {
									return currentContent;
								}

								const modification = applyLinkModification(
									currentContent,
									entry.url,
									result.url,
									matchIndex,
									this.activeSettings,
									{ isReplacement: isAdjacent && forceReplace },
								);

								return modification.modified
									? modification.content
									: currentContent;
							}

							return currentContent;
						});
					}
				} catch {
					// Ignored
				}

				const indexToRemove = parsedEntries.findIndex(
					(e) =>
						e.url === entry.url &&
						e.filePath === entry.filePath &&
						e.timestamp === entry.timestamp,
				);
				if (indexToRemove !== -1) {
					parsedEntries.splice(indexToRemove, 1);
				}
			} else {
				const matchingIndex = parsedEntries.findIndex(
					(e) =>
						e.url === entry.url &&
						e.filePath === entry.filePath &&
						e.timestamp === entry.timestamp,
				);
				const updatedMetadata = {
					...entry,
					error:
						result.status === "failed" && result.status_ext
							? `Retry failed (status: ${result.status}): ${result.status_ext}`
							: `Retry failed (status: ${result.status})`,
					retryCount: (entry.retryCount ?? 0) + 1,
					stage: result.status === "failed" ? result.stage : entry.stage,
					manualProviderIds:
						result.status === "failed"
							? result.manualProviderIds
							: entry.manualProviderIds,
				};
				if (matchingIndex !== -1) {
					parsedEntries[matchingIndex] = updatedMetadata;
				}
				stillFailed.push(updatedMetadata);
			}
		}

		try {
			if (parsedEntries.length > 0) {
				let newContent = "";
				if (selectedFileName.endsWith(".json")) {
					newContent = JSON.stringify(parsedEntries, null, 2);
				} else if (selectedFileName.endsWith(".csv")) {
					newContent = serializeFailedArchiveEntriesToCsv(parsedEntries);
				}
				await this.app.vault.adapter.write(selectedFileName, newContent);
			} else {
				await this.app.vault.adapter.remove(selectedFileName);
				new Notice("All failed entries retried successfully. Log file deleted.");
			}
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : "Unknown error";
			new Notice(`Error updating or deleting failed log file: ${errorMsg}`);
		}

		new Notice(
			`Retry complete. Retried ${failedCount} links. Success: ${successCount}, still failed: ${stillFailed.length}.`,
		);
	}

	public parseCsvEntries(csvContent: string): FailedArchiveEntry[] {
		return parseFailedArchiveEntriesFromCsv(csvContent);
	}
}
