import { App, Editor, MarkdownView, MarkdownFileInfo, Notice, requestUrl, TFile } from 'obsidian';
import { format } from 'date-fns';
import { ADJACENT_ARCHIVE_LINK_REGEX, applySubstitutionRules, checkAdjacentLinkFreshness, createArchiveLink, getUrlFromMatch, isFollowedByArchiveLink, LINK_REGEX, matchesAnyPattern } from '../utils/LinkUtils';
import { ConfirmationModal, FileSelectModal } from '../ui/modals';
import { FailedArchiveEntry, getFreshnessThresholdMs, WaybackArchiverData, WaybackArchiverSettings } from './settings';
import WaybackArchiverPlugin from '../main';

type SingleArchiveOutcome = 
    | { status: 'cache_hit_success'; url: string } 
    | { status: 'cache_hit_limited'; url: string } 
    | { status: 'archived_success'; url: string } 
    | { status: 'archived_limited'; url: string } 
    | { status: 'archived_failed'; error?: string }; 

export class ArchiverService {
    private plugin: WaybackArchiverPlugin;
    private app: App;
    // In-memory cache for recent archive results (not persisted)
	private recentArchiveCache: Map<string, { status: string, url: string, timestamp: number }> = new Map();

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
        fullContent: string, // The content string where matches were found (selection or file)
        isForce: boolean, // Add isForce parameter
        // Context for adjacent check, especially needed if fullContent != actual document content
        context: { isSelection?: boolean; selectionStartOffset?: number; fullDocContent?: string } = {}
    ): { linksToProcess: RegExpMatchArray[]; skippedCount: number } {
        let localSkippedCount = 0;
    

        const filteredMatches = allMatches.filter(match => {
            const url = getUrlFromMatch(match);
            const matchIndex = match.index;

            if (matchIndex === undefined) {
                localSkippedCount++; return false; 
            }
    
            // --- Adjacent Check ---
            let checkStartIndex = matchIndex + match[0].length;
            let contentToCheckAdjacent = fullContent;
            if (context.isSelection && context.selectionStartOffset !== undefined && context.fullDocContent) {
                 checkStartIndex = context.selectionStartOffset + matchIndex + match[0].length;
                 contentToCheckAdjacent = context.fullDocContent;
            }
            const cached = this.recentArchiveCache.get(url);
            const textAfter = contentToCheckAdjacent.substring(checkStartIndex, checkStartIndex + 300);
            if (!isForce && isFollowedByArchiveLink(textAfter) && cached && (Date.now() - cached.timestamp) < getFreshnessThresholdMs(this.activeSettings)) {
                localSkippedCount++; return false;
            }

            if (matchesAnyPattern(url, this.activeSettings.ignorePatterns) || url.includes('web.archive.org/')) {
                localSkippedCount++; return false;
            }
    
            if (this.activeSettings.urlPatterns?.length > 0 && !matchesAnyPattern(url, this.activeSettings.urlPatterns)) {
                // console.log(`[DEBUG filterLinks] Skipping: Not HTTP/HTTPS.`);
                localSkippedCount++; return false;
            }
    
            if (!url.match(/^https?:\/\//i)) {
                localSkippedCount++; return false;
            }
            return true; 
        });
        return { linksToProcess: filteredMatches, skippedCount: localSkippedCount };
    }

    private shouldProcessLink(
        match: RegExpMatchArray,
        fullContent: string, 
        context: {} = {}
    ): boolean {
        const url = getUrlFromMatch(match);
        const matchIndex = match.index;
    
        if (matchIndex === undefined) return false; // Cannot reliably check
    
        const checkStartIndex = matchIndex + match[0].length;
        const textAfter = fullContent.substring(checkStartIndex, checkStartIndex + 300);
        if (isFollowedByArchiveLink(textAfter)) return false;
    
        if (matchesAnyPattern(url, this.activeSettings.ignorePatterns) || url.includes('web.archive.org/')) return false;
    
        if (this.activeSettings.urlPatterns?.length > 0 && !matchesAnyPattern(url, this.activeSettings.urlPatterns)) return false;

        if (!url.match(/^https?:\/\//i)) return false;
    
        return true;
    }

    private async processSingleUrlArchival(originalUrl: string, isForce: boolean): Promise<SingleArchiveOutcome> {
        const cached = this.recentArchiveCache.get(originalUrl);
        if (!isForce && cached && (Date.now() - cached.timestamp) < getFreshnessThresholdMs(this.activeSettings)) {
            // console.log(`[DEBUG] Using cached archive result for: ${originalUrl}`);
            if (cached.status === 'success') {
                return { status: 'cache_hit_success', url: cached.url };
            } else { // (cached.status === 'too_many_captures') 
                return { status: 'cache_hit_limited', url: cached.url };
            }
            // If cache contains something else (e.g., 'failed'), treat as stale/miss
        } else {
            // console.log(`[DEBUG] Calling archiveUrl (cache miss/stale) for: ${originalUrl}`);
            const archiveResult = await this.archiveUrl(originalUrl);
            // console.log(`[DEBUG] archiveUrl returned:`, archiveResult);
            if (archiveResult.status === 'success') {
                this.recentArchiveCache.set(originalUrl, { status: 'success', url: archiveResult.url, timestamp: Date.now() });
                return { status: 'archived_success', url: archiveResult.url };
            } else if (archiveResult.status === 'too_many_captures') {
                this.recentArchiveCache.set(originalUrl, { status: 'too_many_captures', url: archiveResult.url, timestamp: Date.now() });
                return { status: 'archived_limited', url: archiveResult.url };
            } else { // status === 'failed'
                // Note: We generally don't cache failures long-term here, but could if desired.
                return { status: 'archived_failed', error: archiveResult.status_ext };
            }
        }
    }

    private async logFailedArchive(originalUrl: string, filePath: string, error: string, retryCount: number = 0): Promise<void> {
        if (!this.data.failedArchives) {
            this.data.failedArchives = [];
        }
        this.data.failedArchives.push({ url: originalUrl, filePath, timestamp: Date.now(), error, retryCount });
        await this.saveSettings();
    }

	async archiveUrl(url: string): Promise<{ status: 'success', url: string } | { status: 'too_many_captures', url: string } | { status: 'failed', status_ext?: string }> {
		if (!this.data.spnAccessKey || !this.data.spnSecretKey) {
			// console.error("SPN API keys are not configured in the plugin settings.");
			new Notice("Error: Archive.org SPN API keys not configured in settings.");
			return { status: 'failed', status_ext: 'Configuration Error' };
		}

		const substitutedUrl = applySubstitutionRules(url, this.activeSettings.substitutionRules); 
		// console.log(`Attempting to archive (after substitution): ${substitutedUrl}`); 

		// Enforce fixed delay before initial archive request to avoid 429 rate limits
		// console.log(`Waiting ${this.activeSettings.apiDelay}ms before archiving to respect SPN2 rate limits...`); 
		await new Promise(resolve => setTimeout(resolve, this.activeSettings.apiDelay));
		// console.log('Proceeding with archive request...'); 

		try {
			const params: Record<string, string> = {
				url: substitutedUrl,
				capture_outlinks: this.activeSettings.captureOutlinks ? '1' : '0',
				capture_screenshot: this.activeSettings.captureScreenshot ? '1' : '0',
				force_get: this.activeSettings.forceGet ? '1' : '0',
				capture_all: this.activeSettings.captureAll ? '1' : '0',
				skip_first_archive: '1'
			};
			if (this.activeSettings.jsBehaviorTimeout > 0) {
				params['js_behavior_timeout'] = this.activeSettings.jsBehaviorTimeout.toString();
			}
			if (this.activeSettings.archiveFreshnessDays > 0) {
				// Convert days to seconds for if_not_archived_within
				const seconds = this.activeSettings.archiveFreshnessDays * 86400;
				params['if_not_archived_within'] = `${seconds}s`;
			}

			// console.log(`Initiating capture for ${substitutedUrl} via requestUrl...`); 
			const initResponse = await requestUrl({
				method: 'POST',
				url: 'https://web.archive.org/save',
				headers: {
					'Accept': 'application/json',
					'Authorization': `LOW ${this.data.spnAccessKey}:${this.data.spnSecretKey}`,
					'Content-Type': 'application/x-www-form-urlencoded'
				},
				body: new URLSearchParams(params).toString()
			});

			// console.log(`Capture initiation response status: ${initResponse.status}`); 
			// console.log(`Capture initiation response JSON:`, initResponse.json); 

			if (initResponse.status === 429) {
				// console.warn(`Rate limit hit (429) when initiating capture for ${substitutedUrl}.`);
				const latestSnapshotUrl = await this.getLatestSnapshotUrl(substitutedUrl);
				if (latestSnapshotUrl) {
					new Notice(`Daily capture limit likely reached. Using latest snapshot for ${substitutedUrl}.`);
					return { status: 'too_many_captures', url: latestSnapshotUrl };
				} else {
					const fallbackUrl = `https://web.archive.org/web/*/${substitutedUrl}`;
					new Notice(`Daily capture limit likely reached. No recent snapshot found, using wildcard URL.`);
					return { status: 'too_many_captures', url: fallbackUrl };
				}
			}

			if (initResponse.status !== 200 || !initResponse.json?.job_id) {
				if (initResponse.status === 200 && initResponse.json?.message?.includes('The same snapshot had been made')) {
					// console.warn(`Recent snapshot exists for ${substitutedUrl}. Trying to get latest specific snapshot URL.`);
					const latestSnapshotUrl = await this.getLatestSnapshotUrl(substitutedUrl);
					if (latestSnapshotUrl) {
						return { status: 'too_many_captures', url: latestSnapshotUrl };
					} else {
						const fallbackUrl = `https://web.archive.org/web/*/${substitutedUrl}`;
						return { status: 'too_many_captures', url: fallbackUrl };
					}
				}
				// console.error(`Failed to initiate capture for ${substitutedUrl}. Status: ${initResponse.status}`, initResponse.text);
				return { status: 'failed', status_ext: `Initiation failed (${initResponse.status})` };
			}

			const jobId = initResponse.json.job_id;
			// console.log(`Capture initiated. Job ID: ${jobId}`); 

			let retries = 0;
			while (retries < this.activeSettings.maxRetries) {
				await new Promise(resolve => setTimeout(resolve, this.activeSettings.apiDelay));

				try {
					// console.log(`Checking status for Job ID: ${jobId} (Attempt ${retries + 1}/${this.activeSettings.maxRetries})`); 
					const statusResponse = await requestUrl({
						method: 'GET',
						url: `https://web.archive.org/save/status/${jobId}`,
						headers: {
							'Accept': 'application/json',
							'Authorization': `LOW ${this.data.spnAccessKey}:${this.data.spnSecretKey}`
						}
					});

					// console.log(`Status check response status: ${statusResponse.status}`); 
					// console.log(`Status check response JSON:`, statusResponse.json); 

					if (statusResponse.status !== 200) {
						// console.warn(`Status check failed for Job ID ${jobId}. Status: ${statusResponse.status}. Retrying...`);
						retries++;
						continue;
					}

					const statusData = statusResponse.json;
					if (statusData.status === 'success') {
						const timestamp = statusData.timestamp || format(new Date(), 'yyyyMMddHHmmss'); // Fallback timestamp
						const finalUrl = `https://web.archive.org/web/${timestamp}/${statusData.original_url}`;
						// console.log(`Archiving successful for ${substitutedUrl}. Final URL: ${finalUrl}`); 
						return { status: 'success', url: finalUrl };
					} else if (statusData.status === 'error') {
						// console.error(`Archiving failed for ${substitutedUrl}. Job ID: ${jobId}. Reason: ${statusData.status_ext || 'Unknown error'}`, statusData);
						return { status: 'failed', status_ext: statusData.status_ext || 'Unknown error' };
					} else {
						// console.log(`Job ${jobId} is still pending...`); 
						retries++;
						if (retries >= this.activeSettings.maxRetries) {
							// console.warn(`Max retries reached for pending job ${jobId}.`);
							break; 
						}
					}
				} catch (statusError: any) {
					// console.error(`Error during status check for Job ID ${jobId}:`, statusError);
					retries++; 
					if (retries >= this.activeSettings.maxRetries) {
						// console.warn(`Max retries reached after status check error for job ${jobId}.`);
						break; 
					}
				}
			}

			// If loop finishes without success or explicit error, it timed out
			const timeoutMessage = `Archiving timed out for ${substitutedUrl} after ${this.activeSettings.maxRetries} retries.`;
			// console.warn(`${timeoutMessage} (Job ID: ${jobId})`);
			return { status: 'failed', status_ext: 'Timeout' };

		} catch (error: any) {
			// console.error(`Unexpected error during archiving process for ${substitutedUrl}:`, error);
			return { status: 'failed', status_ext: `Unexpected Error: ${error?.message}` };
		}
	}

    // Query Wayback Machine CDX API for the latest snapshot timestamp. See https://archive.org/developers/wayback-cdx-server.html
	async getLatestSnapshotUrl(targetUrl: string): Promise<string | null> {
		try {
			const apiUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(targetUrl)}&output=json&fl=timestamp&filter=statuscode:200&limit=1&sort=reverse`;
			const response = await requestUrl({ url: apiUrl, method: 'GET' });

			if (response.status !== 200) {
				return null;
			}

			let jsonData: any;
			try {
				jsonData = typeof response.json === 'object' ? response.json : JSON.parse(response.text);
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

	archiveLinksAction = async (editor: Editor, ctx: MarkdownView | MarkdownFileInfo): Promise<void> => {
        let linksToProcess: RegExpMatchArray[] = [];
        let archivedCount = 0;
        let failedCount = 0;
        let skippedCount = 0;
        const selectedText = editor.getSelection();
        const isSelection = selectedText.length > 0;
        const file = ctx.file; 
        let filePath = file?.path || 'unknown'; 

        if (!file) {
            new Notice('Error: Could not get the current file.');
            // console.error('archiveLinksAction: ctx.file is null or undefined.');
            return;
        }

        if (isSelection) {
        	// console.log('Archiving links in current selection (Editor Mode)...'); 
        	const selectionStartOffset = editor.posToOffset(editor.getCursor('from'));
        	const content = selectedText;
        	let allMatches = Array.from(content.matchAll(LINK_REGEX));
        	// console.log(`Found potential links in selection:`, allMatches.map(link => getUrlFromMatch(link))); 
      
        	const fullDocContent = editor.getValue(); 
            let skippedCount = 0; 

            const filterResult = this.filterLinksForArchiving(
                allMatches,
                selectedText,
                false,
                {
                    isSelection: true,
                    selectionStartOffset: selectionStartOffset,
                    fullDocContent: fullDocContent
                }
            );

            linksToProcess = filterResult.linksToProcess;
            skippedCount += filterResult.skippedCount; 

            if (!linksToProcess.length) {
                new Notice('No suitable links found in selection to process.');
                return;
            }
         
            new Notice(`Found ${linksToProcess.length} links in selection to process. Starting archival...`);
            // console.log(`Links to process (selection):`, linksToProcess.map(link => getUrlFromMatch(link))); 
         
            const reversedLinks = linksToProcess.reverse();

            const processSingleLinkEditor = async (match: RegExpMatchArray) => {
                const originalUrl = getUrlFromMatch(match); 
                const fullMatch = match[0];
                const matchIndex = match.index;

                if (matchIndex === undefined) {
                    // console.warn("Match found without index (selection), skipping:", fullMatch);
                    skippedCount++;
                    return;
                }

                // Calculate absolute position in the document for insertion check and insertion
                const absoluteMatchIndex = selectionStartOffset + matchIndex;
                const insertionOffset = absoluteMatchIndex + fullMatch.length; // Position *after* the original link text `[text](url)`
                const insertionPos = editor.offsetToPos(insertionOffset);
                const textAfterLink = fullDocContent.substring(insertionOffset, insertionOffset + 300);
                const isAdjacent = isFollowedByArchiveLink(textAfterLink);

                const archiveOutcome = await this.processSingleUrlArchival(originalUrl, false);
                const cached = this.recentArchiveCache.get(originalUrl);
                if (isAdjacent && cached && (Date.now() - cached.timestamp) < getFreshnessThresholdMs(this.activeSettings)){
                	// console.log(`Skipping link (selection) already followed by an archive link (pre-insert check): ${originalUrl}`); 
                	skippedCount++;
                	return;
                }
                switch (archiveOutcome.status) {
                    case 'cache_hit_success':
                    case 'archived_success':{
                        const newArchiveLink = createArchiveLink(match, archiveOutcome.url, this.activeSettings);      
                        // console.log(`Successfully processed (from ${archiveOutcome.status}): ${originalUrl} -> ${archiveOutcome.url}`);                      
                        if (isAdjacent) {
                            const existingArchiveMatch = textAfterLink.match(ADJACENT_ARCHIVE_LINK_REGEX);
                            if (existingArchiveMatch) {
                                const oldLinkText = existingArchiveMatch[0];
                                const oldLinkLength = oldLinkText.length;
                                const oldLinkToRemoveEndPos = editor.offsetToPos(insertionOffset + oldLinkLength);
                                editor.replaceRange(newArchiveLink, insertionPos, oldLinkToRemoveEndPos);
                                // console.log(`Successfully REPLACED archive link (from ${archiveOutcome.status}): ${originalUrl} -> ${archiveOutcome.url}`);
                                archivedCount++;
                            }
                        } else {
                            editor.replaceRange(newArchiveLink, insertionPos);
                            // console.log(`Successfully INSERTED archive link (from ${archiveOutcome.status}): ${originalUrl} -> ${archiveOutcome.url}`);
                            archivedCount++;
                        }}
                        break;         
                    case 'cache_hit_limited':
                    case 'archived_limited':{
                        const archiveLinkLimited = createArchiveLink(match, archiveOutcome.url, this.activeSettings);
                        // console.log(`Inserted latest archive link (${archiveOutcome.status}): ${originalUrl} -> ${archiveOutcome.url}`);           
                        if (isAdjacent) {
                            // If adjacent exists but archive returns limited/same, do nothing.
                            // console.warn(`Archive limited/same snapshot, adjacent link exists. Skipping insertion for ${originalUrl}`);
                            failedCount++;
                        } else {
                            // If no adjacent link and archive returns limited/same snapshot, insert the returned URL (latest snapshot/wildcard). 
                            // Freshness was implicitly checked by API.
                            editor.replaceRange(archiveLinkLimited, insertionPos);
                            // console.log(`Successfully INSERTED latest/limited archive link (from ${archiveOutcome.status}): ${originalUrl} -> ${archiveOutcome.url}`);
                            archivedCount++;
                        }
                    }
                        break;
                    case 'archived_failed':
                        // Logic for failed archive
                        failedCount++;
                        // console.log(`Failed to archive: ${originalUrl}`);
                        this.logFailedArchive(originalUrl, filePath, `Archiving failed (${archiveOutcome.error || 'Unknown error'})`, 0);
                        break;
                }
            };

            for (const match of reversedLinks) {
                await processSingleLinkEditor(match);
                // Delay is handled within archiveUrl before the API call
                // await new Promise(resolve => setTimeout(resolve, 50)); Optional small delay
            }

        } else {
        	// console.log('Archiving links in current note (File Mode)...'); 
        	// console.log(`Processing file: ${file.path}`); 
      
        	let fileContent: string;
        	try {
                fileContent = await this.app.vault.read(file);
            } catch (err) {
                new Notice(`Error reading file: ${file.path}`);
                // console.error(`Error reading file ${file.path}:`, err);
                return;
            }
            let fileModified = false;
         
            let allMatches = Array.from(fileContent.matchAll(LINK_REGEX));
            let skippedCount = 0;

            const filterResult = this.filterLinksForArchiving(
                allMatches,
                fileContent,
                false
            );

            linksToProcess = filterResult.linksToProcess;
            skippedCount += filterResult.skippedCount;

            if (!linksToProcess.length) {
                new Notice('No suitable links found after filtering.');
                return;
            }
         
            new Notice(`Found ${linksToProcess.length} links to process. Starting archival...`);
            // console.log(`Links to process:`, linksToProcess.map(link => getUrlFromMatch(link))); 
         
            const reversedLinks = linksToProcess.reverse();
            const processSingleLinkFile = async (match: RegExpMatchArray) => {
                const originalUrl = getUrlFromMatch(match);
                const fullMatch = match[0];
                const matchIndex = match.index;
                
                if (matchIndex === undefined) {
                    // console.warn("Match found without index, skipping:", fullMatch);
                    skippedCount++;
                    return;
                }

                const insertionPosIndex = matchIndex + fullMatch.length; // Position *after* the original link text `[text](url)`
                const textAfterLink = fileContent.substring(insertionPosIndex, insertionPosIndex + 300);
                const isAdjacent = isFollowedByArchiveLink(textAfterLink);
                const nextChar = fileContent.charAt(insertionPosIndex);
                const needsSpace = !(nextChar === '' || nextChar === '\n' || nextChar === ' ');

                if (!originalUrl.match(/^https?:\/\//i)) {
                	// console.log(`Skipping non-HTTP(S) link: ${originalUrl}`);
                	skippedCount++;
                	return;
                }

                const archiveOutcome = await this.processSingleUrlArchival(originalUrl, false);
                const cached = this.recentArchiveCache.get(originalUrl);
                if (isAdjacent && cached && (Date.now() - cached.timestamp) < getFreshnessThresholdMs(this.activeSettings)){
                	// console.log(`Skipping link (file) already followed by an archive link (pre-insert check): ${originalUrl}`); 
                	skippedCount++;
                	return;
                }
                switch (archiveOutcome.status) {
                    case 'cache_hit_success':
                    case 'archived_success': {
                        const newArchiveLink = createArchiveLink(match, archiveOutcome.url, this.activeSettings);
                        if (isAdjacent) {
                            const existingArchiveMatch = textAfterLink.match(ADJACENT_ARCHIVE_LINK_REGEX);
                            if (existingArchiveMatch) {
                                const oldLinkText = existingArchiveMatch[0];
                                const oldLinkStartIndex = insertionPosIndex;
                                const oldLinkEndIndex = insertionPosIndex + oldLinkText.length;
                                fileContent = fileContent.slice(0, oldLinkStartIndex) + newArchiveLink + fileContent.slice(oldLinkEndIndex);
                                fileModified = true;
                                // console.log(`Successfully REPLACED archive link (from ${archiveOutcome.status}): ${originalUrl} -> ${archiveOutcome.url}`);
                                archivedCount++;
                            }
                        } else {
                            const insertionText = needsSpace ? ' ' + newArchiveLink : newArchiveLink;
                            fileContent = fileContent.slice(0, insertionPosIndex) + insertionText + fileContent.slice(insertionPosIndex);
                            fileModified = true;
                            // console.log(`Successfully INSERTED archive link (from ${archiveOutcome.status}): ${originalUrl} -> ${archiveOutcome.url}`);
                            archivedCount++;
                        }
                        break;
                    }
                    case 'cache_hit_limited':
                    case 'archived_limited': {
                        const newArchiveLink = createArchiveLink(match, archiveOutcome.url, this.activeSettings);
                        if (isAdjacent) {
                            // console.warn(`Archive limited/same snapshot, adjacent link exists. Skipping insertion for ${originalUrl}`);
                            failedCount++; 
                        } else {
                            const insertionText = needsSpace ? ' ' + newArchiveLink : newArchiveLink;
                            fileContent = fileContent.slice(0, insertionPosIndex) + insertionText + fileContent.slice(insertionPosIndex);
                            fileModified = true;
                            // console.log(`Successfully INSERTED latest/limited archive link (from ${archiveOutcome.status}): ${originalUrl} -> ${archiveOutcome.url}`);
                            archivedCount++;
                        }
                        break;
                    }
                    case 'archived_failed':
                        failedCount++;
                        this.logFailedArchive(originalUrl, filePath, `Archiving failed (${archiveOutcome.error || 'Unknown error'})`, 0);
                        break;
                }
            };

            // Process links sequentially to avoid race conditions with index calculation
            for (const match of reversedLinks) {
                await processSingleLinkFile(match);
                // The delay is now handled within archiveUrl or processSingleLinkFile if needed,
                // but the primary delay should be before the API call itself.
                // A small delay here might still be useful if API calls are very fast,
                // but let's rely on the pre-API call delay for now.
                // await new Promise(resolve => setTimeout(resolve, 50)); Optional small delay between links
            }

            if (fileModified) {
                try {
                    await this.app.vault.modify(file, fileContent);
                    // console.log(`Modified ${file.path} with ${archivedCount} new archives, ${failedCount} failures.`);
                } catch (err) {
                    new Notice(`Error saving file: ${file.path}`);
                    // console.error(`Error saving file ${file.path}:`, err);
                }
            } else {
                // console.log(`No changes made to ${file.path}.`);
            }
        }

        let summary = `Archival complete. Archived: ${archivedCount}, Failed: ${failedCount}`;
        if (skippedCount > 0) {
            summary += `, Skipped: ${skippedCount}`;
        }
        new Notice(summary);
    };

    archiveAllLinksVaultAction = async (): Promise<void> => {
        // console.log('Initiating archive all links in vault command...');
        new Notice('Starting vault-wide link archiving... This may take time.');

        const markdownFiles = this.app.vault.getMarkdownFiles();
        let totalLinksFound = 0;
        let totalArchived = 0;
        let totalFailed = 0;
        let totalSkipped = 0; // Includes ignored, non-http, already archived
        let filesProcessed = 0;
        let filesModified = 0;

        // console.log(`Found ${markdownFiles.length} markdown files to process.`);

        for (const file of markdownFiles) {
            filesProcessed++;
            // console.log(`Processing file ${filesProcessed}/${markdownFiles.length}: ${file.path}`);
            let fileContent = await this.app.vault.read(file);
            let fileLinksArchived = 0;
            let fileLinksFailed = 0;
            let fileLinksSkipped = 0;
            let fileModified = false;

            try {
                if (this.activeSettings.pathPatterns && this.activeSettings.pathPatterns.length > 0) {
                    if (!matchesAnyPattern(file.path, this.activeSettings.pathPatterns)) {
                         // console.log(`Skipping file ${file.path} - does not match path patterns.`);
                         continue;
                    }
                }
                if (this.activeSettings.wordPatterns.length > 0) {
                    const fileHasWord = this.activeSettings.wordPatterns.some(pattern =>
                    	pattern && pattern.trim() !== '' && fileContent.includes(pattern)
                    );
                if (!fileHasWord) {
                    	// console.log(`Skipping file ${file.path} - no matching word patterns found`); 
                    	continue;
                    }
                }

                const allMatches = Array.from(fileContent.matchAll(LINK_REGEX));
                for (const match of allMatches.reverse()) { // Process reversed to avoid index issues
                    const originalUrl = getUrlFromMatch(match);
                    const fullMatch = match[0];
                    const matchIndex = match.index;

                    if (matchIndex === undefined) { fileLinksSkipped++; continue; }

                    if (matchesAnyPattern(originalUrl, this.activeSettings.ignorePatterns) || originalUrl.includes('web.archive.org/')) {
                        fileLinksSkipped++; continue;
                    }
                    if (this.activeSettings.urlPatterns?.length > 0 && !matchesAnyPattern(originalUrl, this.activeSettings.urlPatterns)) {
                        fileLinksSkipped++; continue;
                    }
                    if (!originalUrl.match(/^https?:\/\//i)) {
                        fileLinksSkipped++; continue;
                    }

                    totalLinksFound++;

                    const insertionPosIndex = matchIndex + fullMatch.length;
                    const textAfterLink = fileContent.substring(insertionPosIndex, insertionPosIndex + 300);
                    const isAdjacent = isFollowedByArchiveLink(textAfterLink);
                    const needsSpace = !(fileContent.charAt(insertionPosIndex) === '' || fileContent.charAt(insertionPosIndex) === '\n' || fileContent.charAt(insertionPosIndex) === ' ');

                    let shouldProcess = true;
                    let replaceExisting = false;
                    let existingLinkLength = 0;

                    if (isAdjacent) {
                        const existingMatch = ADJACENT_ARCHIVE_LINK_REGEX.exec(textAfterLink);
                        if (existingMatch && existingMatch[0]) {
                            existingLinkLength = existingMatch[0].length;
                            const adjacentTimestamp = existingMatch[3];
                            const { shouldProcess: shouldProcessAdjacent, replaceExisting: replaceExistingAdjacent } = checkAdjacentLinkFreshness(adjacentTimestamp, this.activeSettings);
                            shouldProcess = shouldProcessAdjacent;
                            replaceExisting = replaceExistingAdjacent;
                            if (!shouldProcess) {
                                fileLinksSkipped++;
                            }
                        }
                    }

                    if (!shouldProcess) {
                        continue; 
                    }

                    const archiveOutcome = await this.processSingleUrlArchival(originalUrl, false); // isForce = false for standard vault archive

                    switch (archiveOutcome.status) {
                        case 'cache_hit_success':
                        case 'archived_success': {
                            const newArchiveLink = createArchiveLink(match, archiveOutcome.url, this.activeSettings);
                            const insertionText = needsSpace && !replaceExisting ? ' ' + newArchiveLink : newArchiveLink;
                            const startIndex = insertionPosIndex;
                            const endIndex = replaceExisting ? insertionPosIndex + existingLinkLength : insertionPosIndex;

                            fileContent = fileContent.slice(0, startIndex) + insertionText + fileContent.slice(endIndex);
                            fileModified = true;
                            fileLinksArchived++;
                            // console.log(`Successfully ${replaceExisting ? 'REPLACED' : 'INSERTED'} archive link (from ${archiveOutcome.status}): ${originalUrl} -> ${archiveOutcome.url}`);
                            break;
                        }
                        case 'cache_hit_limited':
                        case 'archived_limited': {
                            if (replaceExisting) {
                                // console.warn(`Archive limited/same snapshot, adjacent link exists (and was old). Skipping replacement for ${originalUrl}`);
                                fileLinksFailed++; 
                            } else {
                                const newArchiveLink = createArchiveLink(match, archiveOutcome.url, this.activeSettings);
                                const insertionText = needsSpace ? ' ' + newArchiveLink : newArchiveLink;
                                fileContent = fileContent.slice(0, insertionPosIndex) + insertionText + fileContent.slice(insertionPosIndex);
                                fileModified = true;
                                // console.log(`Successfully INSERTED latest/limited archive link (from ${archiveOutcome.status}): ${originalUrl} -> ${archiveOutcome.url}`);
                                fileLinksArchived++;
                            }
                            break;
                        }
                        case 'archived_failed':
                            fileLinksFailed++;
                            this.logFailedArchive(originalUrl, file.path, `Archiving failed (${archiveOutcome.error || 'Unknown error'})`, 0);
                            break;
                    }
                }

                if (fileModified) {
                     try {
                        await this.app.vault.modify(file, fileContent);
                        filesModified++;
                        // console.log(`Successfully processed ${file.path} with ${fileLinksArchived} new archives, ${fileLinksFailed} failures.`);
                    } catch (err: any) {
                         // console.error(`Error processing file ${file.path} via vault.process:`, err);
                         totalFailed++;
                         if (!this.data.failedArchives) this.data.failedArchives = [];
                         this.data.failedArchives.push({
                             url: `Error processing file during vault.process`,
                             filePath: file.path,
                             timestamp: Date.now(),
                             error: `vault.process Error: ${err?.message || 'Unknown error'}`,
                             retryCount: 0
                         });
                    }
                }

                totalArchived += fileLinksArchived;
                totalFailed += fileLinksFailed;
                totalSkipped += fileLinksSkipped;

            } catch (error: any) {
                // console.error(`Error processing file ${file.path}:`, error);
                totalFailed++;
                if (!this.data.failedArchives) this.data.failedArchives = [];
                this.data.failedArchives.push({
                    url: `Error processing file`,
                    filePath: file.path,
                    timestamp: Date.now(),
                    error: `Error: ${error?.message || 'Unknown error'}`,
                    retryCount: 0
                });
            }
        }

        await this.saveSettings();
        // console.log(`Vault-wide archiving complete. Processed ${filesProcessed} files, modified ${filesModified}.`);
        new Notice(`Vault archival complete. Found: ${totalLinksFound}, archived: ${totalArchived}, failed: ${totalFailed}, skipped: ${totalSkipped}.`);
    }

	forceReArchiveLinksAction = async (editor: Editor, ctx: MarkdownView | MarkdownFileInfo): Promise<void> => {
        let linksToProcess: RegExpMatchArray[] = [];
        let archivedCount = 0;
        let failedCount = 0;
        let skippedCount = 0;
        const selectedText = editor.getSelection();
        const isSelection = selectedText.length > 0;
        const file = ctx.file;
        let filePath = file?.path || 'unknown';

        if (!file) {
            new Notice('Error: Could not get the current file.');
            // console.error('forceReArchiveLinksAction: ctx.file is null or undefined.');
            return;
        }

        if (isSelection) {
        	// console.log('Force Re-archiving links in current selection (Editor Mode)...'); 
        	const selectionStartOffset = editor.posToOffset(editor.getCursor('from'));
        	const content = selectedText;
        	const fullDocContent = editor.getValue();
        	let allMatches = Array.from(content.matchAll(LINK_REGEX));
            let skippedCount = 0; 
        	// console.log(`Found potential links in selection:`, allMatches.map(link => getUrlFromMatch(link))); 
        
            const filterResult = this.filterLinksForArchiving(
                allMatches,
                selectedText,
                true,
                {
                    isSelection: true,
                    selectionStartOffset: selectionStartOffset,
                    fullDocContent: fullDocContent
                }
            );

            linksToProcess = filterResult.linksToProcess;
            skippedCount += filterResult.skippedCount; 

            if (!linksToProcess.length) {
                new Notice('No suitable links found in selection to force re-archive.');
                return;
            }
         
            new Notice(`Found ${linksToProcess.length} links in selection to force re-archive. Starting...`);
            // console.log(`Links to process (selection - force):`, linksToProcess.map(link => getUrlFromMatch(link))); 
         
            const reversedLinks = linksToProcess.reverse();
            const processSingleLinkEditorForce = async (match: RegExpMatchArray) => {
                const originalUrl = getUrlFromMatch(match);
                const fullMatch = match[0];
                const matchIndexRelative = match.index;
                if (matchIndexRelative === undefined) {
                    skippedCount++;
                    return;
                }
                const absoluteMatchStartIndex = selectionStartOffset + matchIndexRelative;
                const absoluteInsertionOffset = absoluteMatchStartIndex + fullMatch.length;
                const insertionPos = editor.offsetToPos(absoluteInsertionOffset);
                let oldLinkToRemoveEndPos = insertionPos;
                const textAfterLinkInDoc = fullDocContent.substring(absoluteInsertionOffset, absoluteInsertionOffset + 300);
                const existingArchiveMatch = textAfterLinkInDoc.match(ADJACENT_ARCHIVE_LINK_REGEX);
                if (existingArchiveMatch && existingArchiveMatch[0]) {
                    const oldLinkText = existingArchiveMatch[0];
                    const oldLinkLength = oldLinkText.length;
                    oldLinkToRemoveEndPos = editor.offsetToPos(absoluteInsertionOffset + oldLinkLength);
                }
                const archiveOutcome = await this.processSingleUrlArchival(originalUrl, true);
                switch (archiveOutcome.status) {
                    case 'archived_success':
                    case 'archived_limited':
                        {
                            const archiveLink = createArchiveLink(match, archiveOutcome.url, this.activeSettings);
                            editor.replaceRange(archiveLink, insertionPos, oldLinkToRemoveEndPos);
                            archivedCount++;
                        }
                        break;
                    case 'archived_failed':
                        failedCount++;
                        this.logFailedArchive(originalUrl, filePath, `Force re-archiving failed (${archiveOutcome.error || 'Unknown error'})`, 0);
                        break;
                }
            };
            for (const match of reversedLinks) {
            	await processSingleLinkEditorForce(match);
            }
           } else {
            // console.log('Force Re-archiving links in current note (File Mode)...'); 
            // console.log(`Processing file: ${file.path}`); 
         
            let fileContent: string;
            try {
                fileContent = await this.app.vault.read(file);
            } catch (err) {
                new Notice(`Error reading file: ${file.path}`);
                // console.error(`Error reading file ${file.path}:`, err);
                return;
            }
            let fileModified = false;
            let allMatches = Array.from(fileContent.matchAll(LINK_REGEX));
            let skippedCount = 0;
            // console.log(`Found all potential links:`, allMatches.map(link => getUrlFromMatch(link))); 

            const filterResult = this.filterLinksForArchiving(
                allMatches,
                fileContent,
                true
            );

            linksToProcess = filterResult.linksToProcess;
            skippedCount += filterResult.skippedCount;

            if (!linksToProcess.length) {
                new Notice('No suitable links found in file to force re-archive.');
                return;
            }
         
            new Notice(`Found ${linksToProcess.length} links in file to force re-archive. Starting...`);
            // console.log(`Links to process (file - force):`, linksToProcess.map(link => getUrlFromMatch(link))); 
         
            const reversedLinks = linksToProcess.reverse();
            const processSingleLinkFileForce = async (match: RegExpMatchArray) => {
                const originalUrl = getUrlFromMatch(match);
                const fullMatch = match[0];
                const matchIndex = match.index;
                if (matchIndex === undefined) {
                    skippedCount++;
                    return;
                }
                const insertionPosIndex = matchIndex + fullMatch.length;
                let startIndexToRemove = insertionPosIndex;
                let endIndexToRemove = insertionPosIndex;
                const textAfterLinkInContent = fileContent.substring(insertionPosIndex, insertionPosIndex + 300);
                const existingArchiveMatch = textAfterLinkInContent.match(ADJACENT_ARCHIVE_LINK_REGEX);
                if (existingArchiveMatch && existingArchiveMatch[0]) {
                    const oldLinkLength = existingArchiveMatch[0].length;
                    endIndexToRemove = insertionPosIndex + oldLinkLength;
                }
                const archiveOutcome = await this.processSingleUrlArchival(originalUrl, true);
                switch (archiveOutcome.status) {
                    case 'archived_success':
                         {
                            const archiveLink = createArchiveLink(match, archiveOutcome.url, this.activeSettings);
                            fileContent = fileContent.slice(0, startIndexToRemove) + archiveLink + fileContent.slice(endIndexToRemove);
                            fileModified = true;
                            archivedCount++;
                        }
                        break;
                    case 'archived_limited':
                        failedCount++;
                        this.logFailedArchive(originalUrl, filePath, `Force re-archiving failed (${archiveOutcome.status || 'Too many captures'})`, 0);
                        break;
                    case 'archived_failed':
                        failedCount++;
                        this.logFailedArchive(originalUrl, filePath, `Force re-archiving failed (${archiveOutcome.error || 'Unknown error'})`, 0);
                        break;
                }
            };
            for (const match of reversedLinks) {
                await processSingleLinkFileForce(match);
            }
            if (fileModified) {
                await this.app.vault.modify(file, fileContent);
            }
        }

        let summary = `Force re-archival complete. Re-archived: ${archivedCount}, failed: ${failedCount}`;
        if (skippedCount > 0) {
            summary += `, skipped: ${skippedCount}`;
        }
        new Notice(summary);
    };

	forceReArchiveAllLinksAction = async (): Promise<void> => {
        // console.log('Initiating force re-archive all links in vault command...');
        // console.log('User confirmed vault-wide force re-archiving.');
        new Notice('Starting vault-wide force re-archiving... This may take time.');

        const markdownFiles = this.app.vault.getMarkdownFiles();
        let totalLinksFound = 0;
        let totalArchived = 0;
        let totalFailed = 0;
        let totalSkipped = 0;
        let filesProcessed = 0;
        let filesModified = 0;

        for (const file of markdownFiles) {
            filesProcessed++;
            // console.log(`Processing file ${filesProcessed}/${markdownFiles.length}: ${file.path}`);
            let fileContent = await this.app.vault.read(file);
            let fileLinksArchived = 0;
            let fileLinksFailed = 0;
            let fileLinksSkipped = 0;
            let fileModified = false;

            try {
                if (this.activeSettings.pathPatterns && this.activeSettings.pathPatterns.length > 0) {
                    if (!matchesAnyPattern(file.path, this.activeSettings.pathPatterns)) {
                         // console.log(`Skipping file ${file.path} - does not match path patterns.`);
                         continue; 
                    }
                }
                   if (this.activeSettings.wordPatterns.length > 0) {
                    const fileHasWord = this.activeSettings.wordPatterns.some(pattern =>
                    	pattern && pattern.trim() !== '' && fileContent.includes(pattern)
                    );
                    if (!fileHasWord) {
                    	// console.log(`Skipping file ${file.path} - no matching word patterns found`); 
                    	continue;
                    }
                   }

                const allMatches = Array.from(fileContent.matchAll(LINK_REGEX));
                if (!allMatches.length) continue;

                for (const match of allMatches.reverse()) {
                    const originalUrl = getUrlFromMatch(match);
                    const fullMatch = match[0];
                    const matchIndex = match.index;

                    if (matchIndex === undefined) { fileLinksSkipped++; continue; }

                    if (matchesAnyPattern(originalUrl, this.activeSettings.ignorePatterns) || originalUrl.includes('web.archive.org/')) {
                        fileLinksSkipped++;
                        continue;
                    }

                    if (this.activeSettings.urlPatterns && this.activeSettings.urlPatterns.length > 0) {
                        if (!matchesAnyPattern(originalUrl, this.activeSettings.urlPatterns)) {
                            fileLinksSkipped++;
                            continue;
                        }
                    }
                    if (!originalUrl.match(/^https?:\/\//i)) { fileLinksSkipped++; continue; }

                    const insertionPosIndex = matchIndex + fullMatch.length;
                    const textAfterLink = fileContent.substring(insertionPosIndex, insertionPosIndex + 300);
                    const archiveUrlPattern = 'https?:\\/\\/web\\.archive\\.org\\/web\\/\\d+\\/.+?';
                    const fullArchiveLinkRegex = new RegExp(`^(\\s*\\n*\\s*\\[.*?\\]\\(${archiveUrlPattern}\\))|(\\s*\\n*\\s*<a [^>]*href=\\"${archiveUrlPattern}\\"[^>]*>.*?<\\/a>)`, 's');
                    const existingArchiveMatch = textAfterLink.match(fullArchiveLinkRegex);
                    let startIndexToRemove = insertionPosIndex;
                    let endIndexToRemove = insertionPosIndex;
               
                    if (existingArchiveMatch && existingArchiveMatch[0]) {
                    	const oldLinkLength = existingArchiveMatch[0].length;
                    	endIndexToRemove = insertionPosIndex + oldLinkLength;
                    	// console.log(`Found existing archive link to remove in ${file.path}: ${existingArchiveMatch[0]}`); 
                    } else {
                    	totalLinksFound++;
                    }

                    // console.log(`Waiting ${this.activeSettings.apiDelay}ms before re-archiving ${originalUrl} in ${file.path}`); 
                    const archiveOutcome = await this.processSingleUrlArchival(originalUrl, true); // Pass isForce = true
                    switch (archiveOutcome.status) {
                        case 'archived_success':
                            { 
                                const archiveLink = createArchiveLink(match, archiveOutcome.url, this.activeSettings);
                                fileContent = fileContent.slice(0, startIndexToRemove) + archiveLink + fileContent.slice(endIndexToRemove);
                                fileModified = true;
                                fileLinksArchived++; 
                                // console.log(`Force re-archived (from ${archiveOutcome.status}): ${originalUrl} -> ${archiveOutcome.url}`);
                            }
                            break;
                        case 'archived_limited':
                            fileLinksFailed++;
                            this.logFailedArchive(
                                originalUrl,
                                file.path,
                                `Force re-archiving limited (status: ${archiveOutcome.status}, fallback not inserted in vault-force mode)`,
                                0
                            );
                            // console.log(`Force re-archive limited, no new link inserted for: ${originalUrl} in ${file.path}`);
                            break;
                        case 'archived_failed':
                            fileLinksFailed++;
                            this.logFailedArchive(
                                originalUrl,
                                file.path,
                                `Force re-archiving failed (${archiveOutcome.error || 'Unknown error'})`,
                                0
                            );
                            // console.log(`Failed to force re-archive: ${originalUrl}`);
                            break;
                    }
                }

                if (fileModified) {
                     try {
                        await this.app.vault.modify(file, fileContent);
                        filesModified++;
                        // console.log(`Successfully processed ${file.path} with ${fileLinksArchived} re-archives, ${fileLinksFailed} failures.`);
                    } catch (err: any) {
                         // console.error(`Error processing file ${file.path} via vault.process (force re-archive):`, err);
                         totalFailed++; 
                         if (!this.data.failedArchives) this.data.failedArchives = [];
                         this.data.failedArchives.push({
                             url: `Error processing file during vault.process (force re-archive)`,
                             filePath: file.path,
                             timestamp: Date.now(),
                             error: `vault.process Error: ${err?.message || 'Unknown error'}`,
                             retryCount: 0
                         });
                    }
                }
                totalArchived += fileLinksArchived;
                totalFailed += fileLinksFailed;
                totalSkipped += fileLinksSkipped;
            } catch (error: any) {
                // console.error(`Error processing file ${file.path} during force re-archive:`, error);
                totalFailed++;
                if (!this.data.failedArchives) this.data.failedArchives = [];
                this.data.failedArchives.push({
                    url: `Error processing file`,
                    filePath: file.path,
                    timestamp: Date.now(),
                    error: `Force re-archive Error: ${error?.message || 'Unknown error'}`,
                    retryCount: 0
                });
            }
        }

        await this.saveSettings();
        // console.log(`Vault-wide force re-archiving complete. Processed ${filesProcessed} files, modified ${filesModified}.`);
        new Notice(`Vault force re-Archival complete. Found: ${totalLinksFound}, re-Archived: ${totalArchived}, failed: ${totalFailed}, skipped: ${totalSkipped}.`);
    };

    retryFailedArchives = async (forceReplace: boolean): Promise<void> => {
        const logFolderPath = this.app.vault.configDir + '/plugins/wayback-archiver/failed_logs';
        let failedLogFiles: string[] = [];
        try {
            const adapter = this.app.vault.adapter;
            if (await adapter.exists(logFolderPath)) {
                const listResult = await adapter.list(logFolderPath);
                const logFileRegex = /^wayback-archiver-failed-log-\d+\.(json|csv)$/;
                failedLogFiles = listResult.files.filter(filePath => {
                    const fileName = filePath.split('/').pop() || '';
                    return logFileRegex.test(fileName);
                });
            } else {
                // console.log(`Log folder "${logFolderPath}" does not exist.`);
            }
        } catch (error) {
            // console.error(`Error listing files in "${logFolderPath}":`, error);
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            new Notice(`Error accessing log folder: ${errorMessage}`);
            return;
        }

        if (failedLogFiles.length === 0) {
            new Notice('No failed log files found in folder.');
            return;
        }

        new FileSelectModal(this.app, failedLogFiles, async (selectedFileName: string | null) => {
            if (!selectedFileName) {
                new Notice('Retry cancelled.');
                return;
            }
         
            try {
            	// console.log(`Modal returned selectedFileName: "${selectedFileName}"`); 
            	const content = await this.app.vault.adapter.read(selectedFileName);
            	let parsedEntries: FailedArchiveEntry[] = [];

                if (selectedFileName.endsWith('.json')) {
                    parsedEntries = JSON.parse(content).map((entry: any) => ({
                        url: entry.url,
                        filePath: entry.filePath,
                        timestamp: entry.timestamp,
                        error: entry.error,
                        retryCount: entry.retryCount ?? 0
                    }));
                } else if (selectedFileName.endsWith('.csv')) {
                    const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');
                    lines.shift();
                    parsedEntries = lines.map(line => {
                        const parts = [];
                        let current = '';
                        let inQuotes = false;
                        for (let i = 0; i < line.length; i++) {
                            const char = line[i];
                            if (char === '"') {
                                if (inQuotes && line[i + 1] === '"') {
                                    current += '"';
                                    i++;
                                } else {
                                    inQuotes = !inQuotes;
                                }
                            } else if (char === ',' && !inQuotes) {
                                parts.push(current);
                                current = '';
                            } else {
                                current += char;
                            }
                        }
                        parts.push(current);
                        return {
                            url: parts[0],
                            filePath: parts[1],
                            timestamp: Number(parts[2]),
                            error: parts[3],
                            retryCount: Number(parts[4] ?? 0)
                        };
                    });
                } else {
                    new Notice('Unsupported file format.');
                    return;
                }

                if (!parsedEntries || parsedEntries.length === 0) {
                    new Notice('No failed archives found in selected file.');
                    return;
                }

                const failedCount = parsedEntries.length;
                let listPreview = parsedEntries.slice(0, 5).map(f => `${f.url} (${f.filePath})`).join('\n');
                if (failedCount > 5) listPreview += `\n...and ${failedCount - 5} more`;

                if (this.activeSettings.autoClearFailedLogs) {
                    let successCount = 0;
                    const originalFailedList = [...parsedEntries];
                    let stillFailed: FailedArchiveEntry[] = [];

                    new Notice(`Retrying ${failedCount} failed archives...`);

                    for (const entry of originalFailedList) {
                        // console.log(`Retrying: ${entry.url} (from ${entry.filePath})`);

                        let shouldSkip = false;
                        if (!forceReplace) {
                            try {
                                const file = this.app.vault.getAbstractFileByPath(entry.filePath);
                                if (file && file instanceof TFile) {
                                    const content = await this.app.vault.read(file);
                                    const matches = Array.from(content.matchAll(LINK_REGEX));
                                    for (const match of matches) { 
                                        const originalUrl = match[1] || match[2] || match[3] || match[4] || '';
                                        if (originalUrl !== entry.url) continue;

                                        const matchIndex = match.index;
                                        if (matchIndex === undefined) continue;

                                        const insertionPosIndex = matchIndex + match[0].length;
                                        const textAfterLink = content.substring(insertionPosIndex, insertionPosIndex + 300);
                                        const existingArchiveMatch = textAfterLink.match(ADJACENT_ARCHIVE_LINK_REGEX);

                                        if (existingArchiveMatch) {
                                        	// console.log(`Skipping retry API call, adjacent archive link already exists for ${entry.url}`); 
                                        	shouldSkip = true;
                                        	if (this.data.failedArchives) {
                                        		const idx = this.data.failedArchives.findIndex(e => e.url === entry.url && e.filePath === entry.filePath);
                                                if (idx !== -1) {
                                                    this.data.failedArchives.splice(idx, 1);
                                                    await this.saveSettings();
                                                }
                                            }
                                            const indexToRemove = parsedEntries.findIndex(e => e.url === entry.url && e.filePath === entry.filePath);
                                            if (indexToRemove !== -1) {
                                                parsedEntries.splice(indexToRemove, 1);
                                            }
                                            break; 
                                        }
                                    }
                                }
                            } catch (e) {
                                // console.warn(`Error during pre-check for ${entry.url} in ${entry.filePath}:`, e);
                            }
                        }

                        if (shouldSkip) {
                            continue; 
                        }

                        await new Promise(res => setTimeout(res, this.activeSettings.apiDelay));
                        const result = await this.archiveUrl(entry.url);
                        if (result.status === 'success' || result.status === 'too_many_captures') {
                        	successCount++;
                        	// console.log(`Retry successful: ${entry.url}`); 
                  
                        	if (this.data.failedArchives) {
                        		const idx = this.data.failedArchives.findIndex(e => e.url === entry.url && e.filePath === entry.filePath);
                                if (idx !== -1) {
                                    this.data.failedArchives.splice(idx, 1);
                                    await this.saveSettings();
                                }
                            }

                            try {
                                const file = this.app.vault.getAbstractFileByPath(entry.filePath);
                                if (file && file instanceof TFile) {
                                    const leaf = this.app.workspace.getLeaf(false);
                                    await leaf.openFile(file); 
                                    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                                    if (view) {
                                        const editor = view.editor;
                                        const content = editor.getValue(); 
                                        const matches = Array.from(content.matchAll(LINK_REGEX));
                                        for (const match of matches.reverse()) { 
                                            const originalUrl = match[1] || match[2] || match[3] || match[4] || '';
                                            if (originalUrl !== entry.url) continue;

                                            const matchIndex = match.index;
                                            if (matchIndex === undefined) continue;

                                            const insertionPosIndex = matchIndex + match[0].length;
                                            const insertionPos = editor.offsetToPos(insertionPosIndex);

                                            // Check again right before insertion (redundant if pre-check worked, but safe)
                                            const textAfterLink = content.substring(insertionPosIndex, insertionPosIndex + 300);
                                            const isHtmlLink = match[2] || match[3];
                                            const existingArchiveMatch = textAfterLink.match(ADJACENT_ARCHIVE_LINK_REGEX);

                                            const archiveDate = format(new Date(), this.activeSettings.dateFormat);
                                            const archiveLinkText = this.activeSettings.archiveLinkText.replace('{date}', archiveDate);
                                            const archiveLink = isHtmlLink
                                                ? ` <a href=\"${result.url}\">${archiveLinkText}</a>`
                                                : ` [${archiveLinkText}](${result.url})`;

                                            let replaceEndPos = insertionPos;
                                            if (existingArchiveMatch && forceReplace) {
                                                replaceEndPos = editor.offsetToPos(insertionPosIndex + existingArchiveMatch[0].length);
                                               } else if (existingArchiveMatch && !forceReplace) {
                                                // console.log(`Skipping insertion for ${entry.url}, adjacent link found (final check).`); 
                                                break;
                                               }
                                       
                                               editor.replaceRange(archiveLink, insertionPos, replaceEndPos);
                                               // console.log(`Updated note ${entry.filePath} for URL ${entry.url}`); 
                                               break;
                                              }
                                             } else {
                                         // console.warn(`Could not get MarkdownView for ${entry.filePath} to update content.`);
                                    }
                                } else {
                                     // console.warn(`File not found or not TFile: ${entry.filePath}`);
                                }
                            } catch (e) {
                                // console.warn(`Failed to update note ${entry.filePath} for URL ${entry.url}:`, e);
                            }

                            const indexToRemove = parsedEntries.findIndex(e => e.url === entry.url && e.filePath === entry.filePath);
                            if (indexToRemove !== -1) {
                                parsedEntries.splice(indexToRemove, 1);
                            }
                     
                           } else {
                            // console.log(`Retry failed again: ${entry.url}`); 
                            stillFailed.push({
                            	...entry,
                            	error: `Retry failed (status: ${result.status})`,
                                retryCount: (entry.retryCount ?? 0) + 1
                            });
                        }
                    }

                    try {
                        if (parsedEntries.length > 0) {
                            let newContent = '';
                            if (selectedFileName.endsWith('.json')) {
                                newContent = JSON.stringify(parsedEntries, null, 2);
                            } else if (selectedFileName.endsWith('.csv')) {
                                const header = 'url,filePath,timestamp,error,retryCount';
                                const rows = parsedEntries.map(e => {
                                    const escape = (field: string | number | undefined) => {
                                        if (field === undefined) return '';
                                        const s = String(field);
                                        if (s.includes('"') || s.includes(',') || s.includes('\n')) {
                                            return `"${s.replace(/"/g, '""')}"`;
                                        }
                                        return s;
                                    };
                                    return [escape(e.url), escape(e.filePath), escape(e.timestamp), escape(e.error), escape(e.retryCount)].join(',');
                                });
                                newContent = [header, ...rows].join('\n');
                            }
                            await this.app.vault.adapter.write(selectedFileName, newContent);
                            // console.log(`Updated failed log file: ${selectedFileName}`);
                        } else {
                            await this.app.vault.adapter.remove(selectedFileName);
                            new Notice('All failed entries retried successfully. Log file deleted.');
                            // console.log(`Deleted empty failed log file: ${selectedFileName}`);
                        }
                    } catch (e) {
                        // console.error('Error updating or deleting failed log file:', e);
                        const errorMsg = e instanceof Error ? e.message : 'Unknown error';
                        new Notice(`Error updating or deleting failed log file: ${errorMsg}`);
                    }

                    new Notice(`Retry complete. Retried ${failedCount} links. Success: ${successCount}, still failed: ${stillFailed.length}.`);
                } else {
                    new ConfirmationModal(
                        this.app,
                        forceReplace ? 'Force retry failed archives?' : 'Retry failed archives?',
                        `${forceReplace ? 'Force retry' : 'Retry'} all ${failedCount} failed archives?\n\nSample:\n${listPreview}`,
                        forceReplace ? 'Yes, force retry all' : 'Yes, retry all',
                        async (confirmed: boolean) => {
                            if (!confirmed) {
                                new Notice('Retry cancelled.');
                                return;
                            }

                            let successCount = 0;
                            const originalFailedList = [...parsedEntries];
                            let stillFailed: FailedArchiveEntry[] = [];

                            new Notice(`Retrying ${failedCount} failed archives...`);

                            for (const entry of originalFailedList) {
                                // console.log(`Retrying: ${entry.url} (from ${entry.filePath})`);

                                let shouldSkip = false;
                                if (!forceReplace) {
                                    try {
                                        const file = this.app.vault.getAbstractFileByPath(entry.filePath);
                                        if (file && file instanceof TFile) {
                                            const content = await this.app.vault.read(file);
                                            const matches = Array.from(content.matchAll(LINK_REGEX));
                                            for (const match of matches) {
                                                const originalUrl = match[1] || match[2] || match[3] || match[4] || '';
                                                if (originalUrl !== entry.url) continue;

                                                const matchIndex = match.index;
                                                if (matchIndex === undefined) continue;

                                                const insertionPosIndex = matchIndex + match[0].length;
                                                const textAfterLink = content.substring(insertionPosIndex, insertionPosIndex + 300);
                                                const existingArchiveMatch = textAfterLink.match(ADJACENT_ARCHIVE_LINK_REGEX);

                                                if (existingArchiveMatch) {
                                                	// console.log(`Skipping retry API call, adjacent archive link already exists for ${entry.url}`); 
                                                	shouldSkip = true;
                                                	if (this.data.failedArchives) {
                                                		const idx = this.data.failedArchives.findIndex(e => e.url === entry.url && e.filePath === entry.filePath);
                                                        if (idx !== -1) {
                                                            this.data.failedArchives.splice(idx, 1);
                                                            await this.saveSettings();
                                                        }
                                                    }
                                                    const indexToRemove = parsedEntries.findIndex(e => e.url === entry.url && e.filePath === entry.filePath);
                                                    if (indexToRemove !== -1) {
                                                        parsedEntries.splice(indexToRemove, 1);
                                                    }
                                                    break; 
                                                }
                                            }
                                        }
                                    } catch (e) {
                                        // console.warn(`Error during pre-check for ${entry.url} in ${entry.filePath}:`, e);
                                    }
                                }

                                if (shouldSkip) {
                                    continue;
                                }

                                await new Promise(res => setTimeout(res, this.activeSettings.apiDelay));
                                const result = await this.archiveUrl(entry.url);
                                if (result.status === 'success' || result.status === 'too_many_captures') {
                                	successCount++;
                                	// console.log(`Retry successful: ${entry.url}`); 
                       
                                	if (this.data.failedArchives) {
                                        const idx = this.data.failedArchives.findIndex(e => e.url === entry.url && e.filePath === entry.filePath);
                                        if (idx !== -1) {
                                            this.data.failedArchives.splice(idx, 1);
                                            await this.saveSettings();
                                        }
                                    }

                                    try {
                                        const file = this.app.vault.getAbstractFileByPath(entry.filePath);
                                        if (file && file instanceof TFile) {
                                            const leaf = this.app.workspace.getLeaf(false);
                                            await leaf.openFile(file);
                                            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                                            if (view) {
                                                const editor = view.editor;
                                                const content = editor.getValue(); 
                                                const matches = Array.from(content.matchAll(LINK_REGEX));
                                                for (const match of matches.reverse()) { 
                                                    const originalUrl = match[1] || match[2] || match[3] || match[4] || '';
                                                    if (originalUrl !== entry.url) continue;

                                                    const matchIndex = match.index;
                                                    if (matchIndex === undefined) continue;

                                                    const insertionPosIndex = matchIndex + match[0].length;
                                                    const insertionPos = editor.offsetToPos(insertionPosIndex);

                                                    // Check again right before insertion (redundant if pre-check worked, but safe)
                                                    const textAfterLink = content.substring(insertionPosIndex, insertionPosIndex + 300);
                                                    const isHtmlLink = match[2] || match[3];
                                                    const existingArchiveMatch = textAfterLink.match(ADJACENT_ARCHIVE_LINK_REGEX);

                                                    const archiveDate = format(new Date(), this.activeSettings.dateFormat);
                                                    const archiveLinkText = this.activeSettings.archiveLinkText.replace('{date}', archiveDate);
                                                    const archiveLink = isHtmlLink
                                                        ? ` <a href=\"${result.url}\">${archiveLinkText}</a>`
                                                        : ` [${archiveLinkText}](${result.url})`;

                                                    let replaceEndPos = insertionPos;
                                                    if (existingArchiveMatch && forceReplace) {
                                                        replaceEndPos = editor.offsetToPos(insertionPosIndex + existingArchiveMatch[0].length);
                                                       } else if (existingArchiveMatch && !forceReplace) {
                                                        // console.log(`Skipping insertion for ${entry.url}, adjacent link found (final check).`); 
                                                        break;
                                                       }
                                             
                                                       editor.replaceRange(archiveLink, insertionPos, replaceEndPos);
                                                       // console.log(`Updated note ${entry.filePath} for URL ${entry.url}`); 
                                                       break;
                                                      }
                                                     } else {
                                                 // console.warn(`Could not get MarkdownView for ${entry.filePath} to update content.`);
                                            }
                                        } else {
                                             // console.warn(`File not found or not TFile: ${entry.filePath}`);
                                        }
                                    } catch (e) {
                                        // console.warn(`Failed to update note ${entry.filePath} for URL ${entry.url}:`, e);
                                    }

                                    const indexToRemove = parsedEntries.findIndex(e => e.url === entry.url && e.filePath === entry.filePath);
                                    if (indexToRemove !== -1) {
                                        parsedEntries.splice(indexToRemove, 1);
                                    }

                                } else {
                                	// console.log(`Retry failed again: ${entry.url}`); 
                                	stillFailed.push({
                                		...entry,
                                		error: `Retry failed (status: ${result.status})`,
                                        retryCount: (entry.retryCount ?? 0) + 1
                                    });
                                }
                            }

                            try {
                                if (parsedEntries.length > 0) {
                                    let newContent = '';
                                    if (selectedFileName.endsWith('.json')) {
                                        newContent = JSON.stringify(parsedEntries, null, 2);
                                    } else if (selectedFileName.endsWith('.csv')) {
                                        const header = 'url,filePath,timestamp,error,retryCount';
                                        const rows = parsedEntries.map(e => {
                                            const escape = (field: string | number | undefined) => {
                                                if (field === undefined) return '';
                                                const s = String(field);
                                                if (s.includes('"') || s.includes(',') || s.includes('\n')) {
                                                    return `"${s.replace(/"/g, '""')}"`;
                                                }
                                                return s;
                                            };
                                            return [escape(e.url), escape(e.filePath), escape(e.timestamp), escape(e.error), escape(e.retryCount)].join(',');
                                        });
                                        newContent = [header, ...rows].join('\n');
                                    }
                                    await this.app.vault.adapter.write(selectedFileName, newContent);
                                    // console.log(`Updated failed log file: ${selectedFileName}`);
                                } else {
                                    await this.app.vault.adapter.remove(selectedFileName);
                                    new Notice('All failed entries retried successfully. Log file deleted.');
                                    // console.log(`Deleted empty failed log file: ${selectedFileName}`);
                                }
                            } catch (e) {
                                // console.error('Error updating or deleting failed log file:', e);
                                const errorMsg = e instanceof Error ? e.message : 'Unknown error';
                                new Notice(`Error updating or deleting failed log file: ${errorMsg}`);
                            }

                            new Notice(`Retry complete. Retried ${failedCount} links. Success: ${successCount}, Still Failed: ${stillFailed.length}.`);
                        }
                    ).open();
                }

            } catch (e) {
                // console.error('Error loading failed log file:', e);
                new Notice('Error loading failed log file.');
            }
        }).open();
    };
}