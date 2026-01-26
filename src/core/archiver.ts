import { App, Editor, MarkdownView, MarkdownFileInfo, Notice, requestUrl, TFile } from 'obsidian';
import { format } from 'date-fns';
import { ADJACENT_ARCHIVE_LINK_REGEX, applySubstitutionRules, checkAdjacentLinkFreshness, createArchiveLink, getUrlFromMatch, isFollowedByArchiveLink, LINK_REGEX, matchesAnyPattern } from '../utils/LinkUtils';
import { ConfirmationModal, FileSelectModal } from '../ui/modals';
import { FailedArchiveEntry, getFreshnessThresholdMs, WaybackArchiverData, WaybackArchiverSettings } from './settings';
import WaybackArchiverPlugin from '../main';
import { findLatestLinkIndex } from '../utils/contentManipulator';

export type ArchiveMode = 'selection' | 'file' | 'vault';

export interface ArchiveContext {
    mode: ArchiveMode;
    isForce: boolean;
    file: TFile;
    editor?: Editor;
    selectionOffset?: number;
}

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
        fullContent: string,
        isForce: boolean,
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

            if (url.includes('web.archive.org/')) {
                return false;
            }

            if (matchesAnyPattern(url, this.activeSettings.ignorePatterns)) {
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


    private async processSingleUrlArchival(originalUrl: string, isForce: boolean): Promise<SingleArchiveOutcome> {
        const cached = this.recentArchiveCache.get(originalUrl);
        if (!isForce && cached && (Date.now() - cached.timestamp) < getFreshnessThresholdMs(this.activeSettings)) {
            // console.log(`[DEBUG] Using cached archive result for: ${originalUrl}`);
            if (cached.status === 'success') {
                return { status: 'cache_hit_success', url: cached.url };
            } else { // (cached.status === 'too_many_captures') 
                return { status: 'cache_hit_limited', url: cached.url };
            }
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

    /**
     * Unified file processing method using app.vault.process for atomic per-link updates.
     * Handles both file-mode and vault-wide archiving with a single codebase.
     * Each link is processed and saved immediately, preventing stale state issues.
     */
    private async processFileWithContext(
        file: TFile,
        isForce: boolean,
        counters: { archivedCount: number; failedCount: number; skippedCount: number }
    ): Promise<void> {
        let fileContent: string;
        try {
            fileContent = await this.app.vault.read(file);
        } catch (err) {
            new Notice(`Error reading file: ${file.path}`);
            return;
        }

        // Check path and word patterns if configured
        if (this.activeSettings.pathPatterns?.length > 0 && !matchesAnyPattern(file.path, this.activeSettings.pathPatterns)) {
            return; // File path doesn't match, silently skip
        }
        if (this.activeSettings.wordPatterns?.length > 0 && !this.activeSettings.wordPatterns.some(p => fileContent.includes(p))) {
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
        for (const match of linksToProcess) {
            const originalUrl = getUrlFromMatch(match);
            const originalMatchIndex = match.index;

            if (originalMatchIndex === undefined) {
                counters.skippedCount++;
                continue;
            }

            // Perform API call first (this is the slow part)
            const archiveOutcome = await this.processSingleUrlArchival(originalUrl, isForce);

            if (archiveOutcome.status === 'archived_failed') {
                counters.failedCount++;
                await this.logFailedArchive(originalUrl, file.path, `Archiving failed (${archiveOutcome.error || 'Unknown error'})`, 0);
                continue;
            }

            // Now apply the edit atomically using vault.process
            try {
                await this.app.vault.process(file, (latestContent: string) => {
                    // Re-find the link in the latest content (user may have edited)
                    const latestIndex = findLatestLinkIndex(latestContent, originalUrl, originalMatchIndex);

                    if (latestIndex === null) {
                        // Link was deleted by user during processing, skip
                        return latestContent;
                    }

                    // Re-match to get the full match at the new index
                    const latestMatches = Array.from(latestContent.matchAll(LINK_REGEX));
                    const currentMatch = latestMatches.find(m => m.index === latestIndex);

                    if (!currentMatch) {
                        return latestContent;
                    }

                    const insertionPosIndex = latestIndex + currentMatch[0].length;
                    const textAfterLink = latestContent.substring(insertionPosIndex, insertionPosIndex + 300);
                    const isAdjacent = isFollowedByArchiveLink(textAfterLink);

                    // Check freshness for existing adjacent links
                    if (isAdjacent && !isForce) {
                        const adjMatch = textAfterLink.match(ADJACENT_ARCHIVE_LINK_REGEX);
                        if (adjMatch) {
                            const timestamp = adjMatch[2] || adjMatch[4];
                            const freshness = checkAdjacentLinkFreshness(timestamp, this.activeSettings);
                            if (!freshness.shouldProcess) {
                                return latestContent; // Skip, already fresh
                            }
                        }
                    }

                    const newArchiveLink = createArchiveLink(currentMatch, archiveOutcome.url, this.activeSettings);

                    if (isAdjacent) {
                        // Replace existing archive link
                        const existingArchiveMatch = textAfterLink.match(ADJACENT_ARCHIVE_LINK_REGEX);
                        if (existingArchiveMatch) {
                            const oldLinkEndIndex = insertionPosIndex + existingArchiveMatch[0].length;
                            return latestContent.slice(0, insertionPosIndex) + newArchiveLink + latestContent.slice(oldLinkEndIndex);
                        }
                    }

                    // Insert new archive link
                    const nextChar = latestContent.charAt(insertionPosIndex);
                    const needsSpace = !(nextChar === '' || nextChar === '\n' || nextChar === ' ');
                    const insertionText = needsSpace ? ' ' + newArchiveLink : newArchiveLink;
                    return latestContent.slice(0, insertionPosIndex) + insertionText + latestContent.slice(insertionPosIndex);
                });
                counters.archivedCount++;
            } catch (err) {
                counters.failedCount++;
                new Notice(`Error saving archive link for ${originalUrl}`);
            }
        }
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
        const file = ctx.file;
        if (!file) {
            new Notice('Error: Could not get the current file.');
            return;
        }

        const selectedText = editor.getSelection();
        const isSelection = selectedText.length > 0;
        let archivedCount = 0;
        let failedCount = 0;
        let skippedCount = 0;
        const counters = { archivedCount, failedCount, skippedCount };

        if (isSelection) {
            const selectionStartOffset = editor.posToOffset(editor.getCursor('from'));
            const fullDocContent = editor.getValue();
            const allMatches = Array.from(selectedText.matchAll(LINK_REGEX));

            const filterResult = this.filterLinksForArchiving(allMatches, selectedText, false, {
                isSelection: true,
                selectionStartOffset,
                fullDocContent
            });

            if (!filterResult.linksToProcess.length) {
                new Notice('No suitable links found in selection.');
                return;
            }

            new Notice(`Processing ${filterResult.linksToProcess.length} links in selection...`);

            // For Selection mode, we process each link and apply it to the editor immediately.
            for (const match of filterResult.linksToProcess) {
                const originalUrl = getUrlFromMatch(match);
                const originalMatchIndexInSelection = match.index;
                if (originalMatchIndexInSelection === undefined) continue;

                const absoluteOriginalIndex = selectionStartOffset + originalMatchIndexInSelection;

                // API call
                const archiveOutcome = await this.processSingleUrlArchival(originalUrl, false);
                if (archiveOutcome.status === 'archived_failed') {
                    counters.failedCount++;
                    await this.logFailedArchive(originalUrl, file.path, `Archiving failed (${archiveOutcome.error || 'Unknown error'})`, 0);
                    continue;
                }

                // Apply edit surgically to editor
                const applied = this.applyLinkEditToEditor(editor, originalUrl, absoluteOriginalIndex, archiveOutcome.url, false);
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
        new Notice(summary);
    };

    archiveAllLinksVaultAction = async (): Promise<void> => {
        new Notice('Starting vault-wide link archiving... This may take time.');
        const markdownFiles = this.app.vault.getMarkdownFiles();
        const counters = { archivedCount: 0, failedCount: 0, skippedCount: 0 };

        for (const file of markdownFiles) {
            await this.processFileWithContext(file, false, counters);
        }

        await this.saveSettings();
        new Notice(`Vault archival complete. Archived: ${counters.archivedCount}, Failed: ${counters.failedCount}, Skipped: ${counters.skippedCount}.`);
    };

    forceReArchiveLinksAction = async (editor: Editor, ctx: MarkdownView | MarkdownFileInfo): Promise<void> => {
        const file = ctx.file;
        if (!file) {
            new Notice('Error: Could not get the current file.');
            return;
        }

        const selectedText = editor.getSelection();
        const isSelection = selectedText.length > 0;
        const counters = { archivedCount: 0, failedCount: 0, skippedCount: 0 };

        if (isSelection) {
            const selectionStartOffset = editor.posToOffset(editor.getCursor('from'));
            const fullDocContent = editor.getValue();
            const allMatches = Array.from(selectedText.matchAll(LINK_REGEX));

            const filterResult = this.filterLinksForArchiving(allMatches, selectedText, true, {
                isSelection: true,
                selectionStartOffset,
                fullDocContent
            });

            if (!filterResult.linksToProcess.length) {
                new Notice('No suitable links found in selection to force re-archive.');
                return;
            }

            new Notice(`Force re-archiving ${filterResult.linksToProcess.length} links in selection...`);

            for (const match of filterResult.linksToProcess) {
                const originalUrl = getUrlFromMatch(match);
                const originalMatchIndexInSelection = match.index;
                if (originalMatchIndexInSelection === undefined) continue;

                const absoluteOriginalIndex = selectionStartOffset + originalMatchIndexInSelection;

                // API call
                const archiveOutcome = await this.processSingleUrlArchival(originalUrl, true);
                if (archiveOutcome.status === 'archived_failed') {
                    counters.failedCount++;
                    await this.logFailedArchive(originalUrl, file.path, `Archiving failed (${archiveOutcome.error || 'Unknown error'})`, 0);
                    continue;
                }

                // Apply edit surgically to editor
                const applied = this.applyLinkEditToEditor(editor, originalUrl, absoluteOriginalIndex, archiveOutcome.url, true);
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
        new Notice(summary);
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
        isForce: boolean
    ): boolean {
        const latestContent = editor.getValue();
        const latestIndex = findLatestLinkIndex(latestContent, originalUrl, originalAbsoluteIndex);

        if (latestIndex === null) {
            return false; // Link was deleted
        }

        const latestMatches = Array.from(latestContent.matchAll(LINK_REGEX));
        const currentMatch = latestMatches.find(m => m.index === latestIndex);
        if (!currentMatch) return false;

        const insertionPosIndex = latestIndex + currentMatch[0].length;
        const textAfterLink = latestContent.substring(insertionPosIndex, insertionPosIndex + 300);
        const isAdjacent = isFollowedByArchiveLink(textAfterLink);

        // Freshness check for standard mode
        if (isAdjacent && !isForce) {
            const adjMatch = textAfterLink.match(ADJACENT_ARCHIVE_LINK_REGEX);
            if (adjMatch) {
                const timestamp = adjMatch[2] || adjMatch[4];
                const freshness = checkAdjacentLinkFreshness(timestamp, this.activeSettings);
                if (!freshness.shouldProcess) return false;
            }
        }

        const newArchiveLink = createArchiveLink(currentMatch, archiveUrl, this.activeSettings);

        if (isAdjacent) {
            const adjMatch = textAfterLink.match(ADJACENT_ARCHIVE_LINK_REGEX);
            if (adjMatch) {
                const startPos = editor.offsetToPos(insertionPosIndex);
                const endPos = editor.offsetToPos(insertionPosIndex + adjMatch[0].length);
                editor.replaceRange(newArchiveLink, startPos, endPos);
                return true;
            }
        }

        // Standard insertion
        const nextChar = latestContent.charAt(insertionPosIndex);
        const needsSpace = !(nextChar === '' || nextChar === '\n' || nextChar === ' ');
        const insertionText = needsSpace ? ' ' + newArchiveLink : newArchiveLink;
        const pos = editor.offsetToPos(insertionPosIndex);
        editor.replaceRange(insertionText, pos);
        return true;
    }

    forceReArchiveAllLinksAction = async (): Promise<void> => {
        new Notice('Starting vault-wide force re-archiving... This may take time.');
        const markdownFiles = this.app.vault.getMarkdownFiles();
        const counters = { archivedCount: 0, failedCount: 0, skippedCount: 0 };

        for (const file of markdownFiles) {
            await this.processFileWithContext(file, true, counters);
        }

        await this.saveSettings();
        new Notice(`Vault force re-Archival complete. Archived: ${counters.archivedCount}, Failed: ${counters.failedCount}, Skipped: ${counters.skippedCount}.`);
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
                                        const originalUrl = getUrlFromMatch(match);
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
                                    let fileModifiedInProcess = false;
                                    await this.app.vault.process(file, (currentContent) => {
                                        let newContent = currentContent;
                                        const matches = Array.from(newContent.matchAll(LINK_REGEX));
                                        for (const match of matches.reverse()) {
                                            const originalUrlInFile = getUrlFromMatch(match);
                                            if (originalUrlInFile !== entry.url) continue;

                                            const matchIndex = match.index;
                                            if (matchIndex === undefined) continue;

                                            const insertionPosIndex = matchIndex + match[0].length;
                                            const textAfterLink = newContent.substring(insertionPosIndex, insertionPosIndex + 300);
                                            const isHtmlLink = match[2] || match[3] || match[4] || match[5];
                                            const existingArchiveMatch = textAfterLink.match(ADJACENT_ARCHIVE_LINK_REGEX);

                                            const archiveDate = format(new Date(), this.activeSettings.dateFormat);
                                            const archiveLinkText = this.activeSettings.archiveLinkText.replace('{date}', archiveDate);
                                            const archiveLink = isHtmlLink
                                                ? ` <a href=\"${result.url}\">${archiveLinkText}</a>`
                                                : ` [${archiveLinkText}](${result.url})`;

                                            let startIndexToReplace = insertionPosIndex;
                                            let endIndexToReplace = insertionPosIndex;

                                            if (existingArchiveMatch && forceReplace) {
                                                endIndexToReplace = insertionPosIndex + existingArchiveMatch[0].length;
                                            } else if (existingArchiveMatch && !forceReplace) {
                                                // console.log(`Skipping insertion for ${entry.url}, adjacent link found (final check with vault.process).`);
                                                break;
                                            }

                                            newContent = newContent.slice(0, startIndexToReplace) + archiveLink + newContent.slice(endIndexToReplace);
                                            fileModifiedInProcess = true;
                                            // console.log(`Updated note ${entry.filePath} for URL ${entry.url} via vault.process`);
                                            break;
                                        }
                                        return newContent;
                                    });

                                    if (fileModifiedInProcess) {
                                        // console.log(`File ${entry.filePath} was processed for URL ${entry.url}. Check content if update occurred.`);
                                    } else {
                                        // console.warn(`Link for ${entry.url} not found or not updated in ${entry.filePath} during retry (vault.process). This could be due to !forceReplace and existing link, or link not present.`);
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
                                                const originalUrl = getUrlFromMatch(match);
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
                                            let fileModifiedInProcess = false;
                                            await this.app.vault.process(file, (currentContent) => {
                                                let newContent = currentContent;
                                                const matches = Array.from(newContent.matchAll(LINK_REGEX));
                                                for (const match of matches.reverse()) {
                                                    const originalUrlInFile = getUrlFromMatch(match);
                                                    if (originalUrlInFile !== entry.url) continue;

                                                    const matchIndex = match.index;
                                                    if (matchIndex === undefined) continue;

                                                    const insertionPosIndex = matchIndex + match[0].length;
                                                    const textAfterLink = newContent.substring(insertionPosIndex, insertionPosIndex + 300);
                                                    const isHtmlLink = match[2] || match[3] || match[4] || match[5];
                                                    const existingArchiveMatch = textAfterLink.match(ADJACENT_ARCHIVE_LINK_REGEX);

                                                    const archiveDate = format(new Date(), this.activeSettings.dateFormat);
                                                    const archiveLinkText = this.activeSettings.archiveLinkText.replace('{date}', archiveDate);
                                                    const archiveLink = isHtmlLink
                                                        ? ` <a href=\"${result.url}\">${archiveLinkText}</a>`
                                                        : ` [${archiveLinkText}](${result.url})`;

                                                    let startIndexToReplace = insertionPosIndex;
                                                    let endIndexToReplace = insertionPosIndex;

                                                    if (existingArchiveMatch && forceReplace) {
                                                        endIndexToReplace = insertionPosIndex + existingArchiveMatch[0].length;
                                                    } else if (existingArchiveMatch && !forceReplace) {
                                                        // console.log(`Skipping insertion for ${entry.url}, adjacent link found (final check with vault.process).`);
                                                        break;
                                                    }

                                                    newContent = newContent.slice(0, startIndexToReplace) + archiveLink + newContent.slice(endIndexToReplace);
                                                    fileModifiedInProcess = true;
                                                    // console.log(`Updated note ${entry.filePath} for URL ${entry.url} via vault.process (modal flow)`);
                                                    break;
                                                }
                                                return newContent;
                                            });
                                            if (fileModifiedInProcess) {
                                                // console.log(`File ${entry.filePath} was processed for URL ${entry.url} (modal flow). Check content if update occurred.`);
                                            } else {
                                                // console.warn(`Link for ${entry.url} not found or not updated in ${entry.filePath} during retry (modal flow with vault.process).`);
                                            }
                                        } else {
                                            // console.warn(`File not found or not TFile: ${entry.filePath} (modal flow)`);
                                        }
                                    } catch (e) {
                                        // console.warn(`Failed to update note ${entry.filePath} for URL ${entry.url} (modal flow):`, e);
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