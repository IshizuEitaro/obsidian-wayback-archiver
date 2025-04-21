import { App, Editor, MarkdownView, MarkdownFileInfo, Notice, requestUrl, TFile } from 'obsidian';
import { format } from 'date-fns';
import { LINK_REGEX } from '../utils/LinkUtils';
import { ConfirmationModal, FileSelectModal } from '../ui/modals';
import { FailedArchiveEntry, WaybackArchiverData, WaybackArchiverSettings } from './settings';
import WaybackArchiverPlugin from '../main';

export class ArchiverService {
    private plugin: WaybackArchiverPlugin;
    private app: App;
    // In-memory cache for recent archive results (not persisted)
	private recentArchiveCache: Map<string, { status: string, url: string, timestamp: number }> = new Map();

    // Regex to match both markdown and HTML adjacent archive links
    private static readonly ADJACENT_ARCHIVE_LINK_REGEX = new RegExp(
        // Markdown: [text](https://web.archive.org/web/123456789/http...)
        String.raw`^\s*\n*\s*(\[.*?\]\(https?:\/\/web\.archive\.org\/web\/(\d+|\*)\/.+?\))` +
        // OR HTML: <a href="https://web.archive.org/web/123456789/http...">text</a>
        String.raw`|(\s*\n*\s*<a [^>]*href=\\?"https?:\/\/web\.archive\.org\/web\/(\d+|\*)\/.+?\\?"[^>]*>.*?<\/a>)`,
        's'
    );

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


	async archiveUrl(url: string): Promise<{ status: 'success', url: string } | { status: 'too_many_captures', url: string } | { status: 'failed', status_ext?: string }> {
		if (!this.data.spnAccessKey || !this.data.spnSecretKey) {
			console.error("SPN API keys are not configured in the plugin settings.");
			new Notice("Error: Archive.org SPN API keys not configured in settings.");
			return { status: 'failed', status_ext: 'Configuration Error' };
		}

		const substitutedUrl = this.applySubstitutionRules(url);
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
				console.warn(`Rate limit hit (429) when initiating capture for ${substitutedUrl}.`);
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
					console.warn(`Recent snapshot exists for ${substitutedUrl}. Trying to get latest specific snapshot URL.`);
					const latestSnapshotUrl = await this.getLatestSnapshotUrl(substitutedUrl);
					if (latestSnapshotUrl) {
						return { status: 'too_many_captures', url: latestSnapshotUrl };
					} else {
						const fallbackUrl = `https://web.archive.org/web/*/${substitutedUrl}`;
						return { status: 'too_many_captures', url: fallbackUrl };
					}
				}
				console.error(`Failed to initiate capture for ${substitutedUrl}. Status: ${initResponse.status}`, initResponse.text);
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
						console.warn(`Status check failed for Job ID ${jobId}. Status: ${statusResponse.status}. Retrying...`);
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
						console.error(`Archiving failed for ${substitutedUrl}. Job ID: ${jobId}. Reason: ${statusData.status_ext || 'Unknown error'}`, statusData);
						return { status: 'failed', status_ext: statusData.status_ext || 'Unknown error' };
					} else {
						// console.log(`Job ${jobId} is still pending...`); 
						retries++;
						if (retries >= this.activeSettings.maxRetries) {
							console.warn(`Max retries reached for pending job ${jobId}.`);
							break; 
						}
					}
				} catch (statusError: any) {
					console.error(`Error during status check for Job ID ${jobId}:`, statusError);
					retries++; 
					if (retries >= this.activeSettings.maxRetries) {
						console.warn(`Max retries reached after status check error for job ${jobId}.`);
						break; 
					}
				}
			}

			// If loop finishes without success or explicit error, it timed out
			const timeoutMessage = `Archiving timed out for ${substitutedUrl} after ${this.activeSettings.maxRetries} retries.`;
			console.warn(`${timeoutMessage} (Job ID: ${jobId})`);
			return { status: 'failed', status_ext: 'Timeout' };

		} catch (error: any) {
			console.error(`Unexpected error during archiving process for ${substitutedUrl}:`, error);
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

    applySubstitutionRules(url: string): string {
		let result = url;
		for (const rule of this.activeSettings.substitutionRules) {
			if (!rule.find) continue; 
			try {
				if (rule.regex) {
					const regex = new RegExp(rule.find, 'g'); 
					result = result.replace(regex, rule.replace || '');
				} else {
					result = result.split(rule.find).join(rule.replace || '');
				}
			} catch (e: any) {
				console.warn(`Error applying substitution rule: Find="${rule.find}", Regex=${rule.regex}. Error: ${e.message}`);
			}
		}
		return result;
	}


	archiveLinksAction = async (editor: Editor, ctx: MarkdownView | MarkdownFileInfo): Promise<void> => {
        let linksToProcess: RegExpMatchArray[] = [];
        let archivedCount = 0;
        let failedCount = 0;
        let skippedCount = 0;
        const selectedText = editor.getSelection();
        const isSelection = selectedText.length > 0;
        const file = ctx.file; // Needed for both modes
        let filePath = file?.path || 'unknown'; // Use file path for logging failures

        if (!file) {
            new Notice('Error: Could not get the current file.');
            console.error('archiveLinksAction: ctx.file is null or undefined.');
            return;
        }

        const getUrlFromMatch = (match: RegExpMatchArray) => match[1] || match[2] || match[3] || match[4] || '';

        if (isSelection) {
        	// Editor Mode (Selection Exists) 
        	// console.log('Archiving links in current selection (Editor Mode)...'); 
        	const selectionStartOffset = editor.posToOffset(editor.getCursor('from'));
        	const content = selectedText;
        	let allMatches = Array.from(content.matchAll(LINK_REGEX));
        	// console.log(`Found potential links in selection:`, allMatches.map(link => getUrlFromMatch(link))); 
      
        	const fullDocContent = editor.getValue();
        	allMatches = allMatches.filter(match => {
                const matchIndex = match.index ?? -1;
                if (matchIndex === -1) return true;
                const absoluteMatchIndex = selectionStartOffset + matchIndex;
                const insertionPosIndex = absoluteMatchIndex + match[0].length;
                const textAfter = fullDocContent.substring(insertionPosIndex, insertionPosIndex + 300);
                const isAdjacent = ArchiverService.ADJACENT_ARCHIVE_LINK_REGEX.test(textAfter);
                // if (isAdjacent) // console.log('Skipping match (selection) already followed by an archive link:', getUrlFromMatch(match)); 
                return !isAdjacent;
               });
            
               linksToProcess = allMatches.filter(match => {
                const url = getUrlFromMatch(match);
                const isIgnored = this.activeSettings.ignorePatterns.some(pattern => {
                    if (!pattern || pattern.trim() === '') return false;
                    try { return new RegExp(pattern, 'i').test(url); }
                    catch (e) { return url.includes(pattern); }
                   });
                   if (isIgnored || url.includes('web.archive.org/')) {
                    // console.log(`Filtering out ignored/archive link (selection): ${url}`); 
                    return false;
                   }
                   return true;
            });

            linksToProcess = linksToProcess.filter(match => {
                const url = getUrlFromMatch(match);
                if (this.activeSettings.urlPatterns.length > 0) {
                    const urlMatches = this.activeSettings.urlPatterns.some(pattern => {
                        if (!pattern || pattern.trim() === '') return false;
                        try { return new RegExp(pattern, 'i').test(url); }
                        catch (e) { return url.includes(pattern); }
                    });
                    if (!urlMatches) {
                    	// console.log(`Filtering out link due to urlPatterns (selection): ${url}`); 
                    	return false;
                    }
                   }
                   if (!url.match(/^https?:\/\//i)) {
                    // console.log(`Skipping non-HTTP(S) link (selection): ${url}`); 
                    skippedCount++;
                    return false;
                   }
                return true;
            });

            if (!linksToProcess.length) {
                new Notice('No suitable links found in selection to process.');
                return;
            }
         
            new Notice(`Found ${linksToProcess.length} links in selection to process. Starting archival...`);
            // console.log(`Links to process (selection):`, linksToProcess.map(link => getUrlFromMatch(link))); 
         
            // Process links in reverse order (relative to selection)
            const reversedLinks = linksToProcess.reverse();

            const processSingleLinkEditor = async (match: RegExpMatchArray) => {
                const originalUrl = getUrlFromMatch(match); 
                const fullMatch = match[0];
                const matchIndex = match.index;

                if (matchIndex === undefined) {
                    console.warn("Match found without index (selection), skipping:", fullMatch);
                    skippedCount++;
                    return;
                }

                // Calculate absolute position in the document for insertion check and insertion
                const absoluteMatchIndex = selectionStartOffset + matchIndex;
                const insertionOffset = absoluteMatchIndex + fullMatch.length; // Position *after* the original link text `[text](url)`
                const insertionPos = editor.offsetToPos(insertionOffset);

                const textAfterLink = fullDocContent.substring(insertionOffset, insertionOffset + 300);
                const isAdjacent = ArchiverService.ADJACENT_ARCHIVE_LINK_REGEX.test(textAfterLink);
                if (isAdjacent) {
                	// console.log(`Skipping link (selection) already followed by an archive link (pre-insert check): ${originalUrl}`); 
                	skippedCount++;
                	return;
                }

                // Cache check remains the same
                const cached = this.recentArchiveCache.get(originalUrl);
                const freshnessThresholdMs = 24 * 60 * 60 * 1000;
                let archiveResult: { status: 'success'; url: string } | { status: 'too_many_captures'; url: string } | { status: 'failed'; status_ext?: string | undefined };

                if (cached && (Date.now() - cached.timestamp) < freshnessThresholdMs) {
                    //// console.log(`[DEBUG] Using cached archive result for (selection): ${originalUrl}`);
                    archiveResult = { status: cached.status as any, url: cached.url };
                } else {
                    //// console.log(`[DEBUG] Calling archiveUrl for (selection): ${originalUrl}`);
                    archiveResult = await this.archiveUrl(originalUrl);
                    //// console.log(`[DEBUG] archiveUrl returned (selection):`, archiveResult);
                    if (archiveResult.status === 'success' || archiveResult.status === 'too_many_captures') {
                        this.recentArchiveCache.set(originalUrl, { status: archiveResult.status, url: archiveResult.url, timestamp: Date.now() });
                    }
                }

                if (archiveResult.status === 'success' || archiveResult.status === 'too_many_captures') {
                    const archiveDate = format(new Date(), this.activeSettings.dateFormat);
                    const archiveLinkText = this.activeSettings.archiveLinkText.replace('{date}', archiveDate);
                    const isHtmlLink = match[2] || match[3];
                    const archiveLink = isHtmlLink
                        ? ` <a href="${archiveResult.url}">${archiveLinkText}</a>`
                        : ` [${archiveLinkText}](${archiveResult.url})`;

                    const currentDocForCheck = editor.getValue(); 
                    const currentInsertionOffset = editor.posToOffset(insertionPos); 
                    const currentTextAfter = currentDocForCheck.substring(currentInsertionOffset, currentInsertionOffset + 300);
                    const isAdjacent = ArchiverService.ADJACENT_ARCHIVE_LINK_REGEX.test(currentTextAfter);
                    if (archiveResult.status === 'too_many_captures' && isAdjacent) {
                    	// console.log(`Skipping insertion (selection - daily limit) because adjacent archive link already exists: ${originalUrl}`); 
                    	skippedCount++;
                    } else {
                    	editor.replaceRange(archiveLink, insertionPos);
                    	if (archiveResult.status === 'success') {
                    		archivedCount++;
                    		// console.log(`Successfully archived (selection): ${originalUrl} -> ${archiveResult.url}`); 
                    	} else {
                    		failedCount++; // Count 'too_many_captures' as failed for summary, though link inserted
                    		// console.log(`Inserted latest archive link (selection - daily limit): ${originalUrl} -> ${archiveResult.url}`); 
                    	}
                    }
                   } else {
                    failedCount++;
                    // console.log(`Failed to archive (selection): ${originalUrl}`); 
                    if (!this.data.failedArchives) this.data.failedArchives = [];
                    this.data.failedArchives.push({ url: originalUrl, filePath: filePath, timestamp: Date.now(), error: `Archiving failed (status: ${archiveResult.status})`, retryCount: 0 });
                    await this.saveSettings();
                }
            };

            // Process links sequentially to avoid race conditions with editor modifications
            for (const match of reversedLinks) {
                await processSingleLinkEditor(match);
                // Delay is handled within archiveUrl before the API call
                // await new Promise(resolve => setTimeout(resolve, 50)); Optional small delay
            }

        } else {
        	// File Mode (No Selection)
        	// console.log('Archiving links in current note (File Mode)...'); 
        	// console.log(`Processing file: ${file.path}`); 
      
        	let fileContent: string;
        	try {
                fileContent = await this.app.vault.read(file);
            } catch (err) {
                new Notice(`Error reading file: ${file.path}`);
                console.error(`Error reading file ${file.path}:`, err);
                return;
            }
            const originalContent = fileContent;
            let fileModified = false;
         
            let allMatches = Array.from(fileContent.matchAll(LINK_REGEX));
            // console.log(`Found all potential links:`, allMatches.map(link => getUrlFromMatch(link))); 
         
            allMatches = allMatches.filter(match => {
            	const matchIndex = match.index ?? -1;
                if (matchIndex === -1) return true;
                const insertionPosIndex = matchIndex + match[0].length; // Position after the link `[text](url)`
                const textAfter = fileContent.substring(insertionPosIndex, insertionPosIndex + 300);
                const isAdjacentArchiveLink = ArchiverService.ADJACENT_ARCHIVE_LINK_REGEX.test(textAfter);
                if (isAdjacentArchiveLink) {
                	// console.log('Skipping match already followed by an archive link:', getUrlFromMatch(match)); 
                	return false;
                }
                return true;
            });

            linksToProcess = allMatches.filter(match => {
                const url = getUrlFromMatch(match);
                const isIgnored = this.activeSettings.ignorePatterns.some(pattern => {
                    if (!pattern || pattern.trim() === '') return false;
                    try {
                        return new RegExp(pattern, 'i').test(url);
                    } catch (e) {
                        console.warn(`Invalid regex pattern in ignore list: "${pattern}". Falling back to string inclusion check.`);
                        return url.includes(pattern);
                    }
                });

                if (isIgnored) {
                	// console.log(`Filtering out ignored link: ${url}`); 
                	return false;
                }
                if (url.includes('web.archive.org/')) {
                	// console.log(`Filtering out archive.org link: ${url}`); 
                	return false;
                }
                return true;
            });

            if (ctx.file?.path) {
                filePath = ctx.file.path;
            } else {
                if (this.activeSettings.pathPatterns.length > 0) {
                    console.warn("Could not determine file path for path pattern filtering in the current context.");
                }
            }

            linksToProcess = linksToProcess.filter(match => {
                const url = getUrlFromMatch(match);
                if (this.activeSettings.urlPatterns.length > 0) {
                    const urlMatches = this.activeSettings.urlPatterns.some(pattern => {
                        if (!pattern || pattern.trim() === '') return false;
                        try {
                            return new RegExp(pattern, 'i').test(url);
                        } catch (e) {
                            console.warn(`Invalid regex pattern in urlPatterns: "${pattern}". Falling back to string inclusion check.`);
                            return url.includes(pattern);
                        }
                    });
                    if (!urlMatches) {
                    	// console.log(`Filtering out link due to urlPatterns: ${url}`); 
                    	return false;
                    }
                   }
               
                   if (!url.match(/^https?:\/\//i)) {
                    // console.log(`Skipping non-HTTP(S) link (file): ${url}`); 
                    skippedCount++;
                    return false;
                   }
                return true;
            });

            if (!linksToProcess.length) {
                new Notice('No non-archived/non-ignored/non-filtered markdown links found to process.');
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
                    console.warn("Match found without index, skipping:", fullMatch);
                    skippedCount++;
                    return;
                }

                const insertionPosIndex = matchIndex + fullMatch.length; // Position *after* the original link text `[text](url)`

                const nextChar = fileContent.charAt(insertionPosIndex);
                const needsSpace = !(nextChar === '' || nextChar === '\n' || nextChar === ' ');

                const textAfterLink = fileContent.substring(insertionPosIndex, insertionPosIndex + 300);
                const isAdjacentArchiveLink = ArchiverService.ADJACENT_ARCHIVE_LINK_REGEX.test(textAfterLink);

                if (isAdjacentArchiveLink) {
                	// console.log(`Skipping link already followed by an archive link: ${originalUrl}`); 
                	skippedCount++;
                	return;
                }
            
                if (!originalUrl.match(/^https?:\/\//i)) {
                	// console.log(`Skipping non-HTTP(S) link: ${originalUrl}`); 
                	skippedCount++;
                	return;
                }

                // Check recent cache before making API call
                const cached = this.recentArchiveCache.get(originalUrl);
                const freshnessThresholdMs = 24 * 60 * 60 * 1000; // 24 hours

                let archiveResult:
                    | { status: 'success'; url: string }
                    | { status: 'too_many_captures'; url: string }
                    | { status: 'failed'; status_ext?: string | undefined };

                // Cache check remains the same
                if (cached && (Date.now() - cached.timestamp) < freshnessThresholdMs) {
                    //// console.log(`[DEBUG] Using cached archive result for (file): ${originalUrl}`);
                    archiveResult = { status: cached.status as any, url: cached.url };
                } else {
                    //// console.log(`[DEBUG] Calling archiveUrl for (file): ${originalUrl}`);
                    archiveResult = await this.archiveUrl(originalUrl);
                    //// console.log(`[DEBUG] archiveUrl returned (file):`, archiveResult);
                    if (archiveResult.status === 'success' || archiveResult.status === 'too_many_captures') {
                        this.recentArchiveCache.set(originalUrl, {
                            status: archiveResult.status,
                            url: archiveResult.url,
                            timestamp: Date.now()
                        });
                    }
                }

                if (archiveResult.status === 'success' || archiveResult.status === 'too_many_captures') {
                    const archiveDate = format(new Date(), this.activeSettings.dateFormat);
                    const archiveLinkText = this.activeSettings.archiveLinkText.replace('{date}', archiveDate);
                    const isHtmlLink = match[2] || match[3];
                    const archiveLink = isHtmlLink
                        ? ` <a href="${archiveResult.url}">${archiveLinkText}</a>`
                        : ` [${archiveLinkText}](${archiveResult.url})`;

                    // Need to recalculate insertionPosIndex based on current fileContent length if modifications happened before this link in the loop (reverse processing helps avoid this)
                    const currentInsertionPosIndex = matchIndex + fullMatch.length;
                    const currentTextAfter = fileContent.substring(currentInsertionPosIndex, currentInsertionPosIndex + 300);
                    const isAdjacentArchiveLink = ArchiverService.ADJACENT_ARCHIVE_LINK_REGEX.test(currentTextAfter); // Use currentTextAfter

                    if (archiveResult.status === 'too_many_captures' && isAdjacentArchiveLink) {
                    	// console.log(`Skipping insertion (file - daily limit) because adjacent archive link already exists: ${originalUrl}`); 
                    	skippedCount++;
                    } else {
                    	const insertionOffset = matchIndex + fullMatch.length; // Position *after* original link
               
                    	//// console.log('[DEBUG] Full match (file):', fullMatch);
                    	//// console.log('[DEBUG] Original URL (file):', originalUrl);
               
                    	const insertionText = needsSpace ? ' ' + archiveLink : archiveLink;
                    	fileContent = fileContent.slice(0, insertionOffset) + insertionText + fileContent.slice(insertionOffset);
                    	fileModified = true;
               
                    	if (archiveResult.status === 'success') {
                    		archivedCount++;
                    		// console.log(`Successfully archived (file): ${originalUrl} -> ${archiveResult.url}`); 
                    	} else {
                    		failedCount++;
                    		// console.log(`Inserted latest archive link (file - daily limit): ${originalUrl} -> ${archiveResult.url}`); 
                    	}
                    }
                   } else {
                    failedCount++;
                    //// console.log(`[DEBUG] Entering 'failed' block for (file): ${originalUrl}`);
                    // console.log(`Failed to archive (file): ${originalUrl}`); 
                    if (!this.data.failedArchives) this.data.failedArchives = [];
                    this.data.failedArchives.push({ url: originalUrl, filePath: filePath, timestamp: Date.now(), error: `Archiving failed (status: ${archiveResult.status})`, retryCount: 0 });
                    await this.saveSettings();
                    //// console.log(`[DEBUG] Exiting 'failed' block for (file): ${originalUrl}`);
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

            // --- Save File if Modified (File Mode) ---
            if (fileModified) {
                try {
                    await this.app.vault.modify(file, fileContent);
                    // console.log(`Modified ${file.path} with ${archivedCount} new archives, ${failedCount} failures.`);
                } catch (err) {
                    new Notice(`Error saving file: ${file.path}`);
                    console.error(`Error saving file ${file.path}:`, err);
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

        const getUrlFromMatch = (match: RegExpMatchArray) => match[1] || match[2] || match[3] || match[4] || '';

        for (const file of markdownFiles) {
            filesProcessed++;
            // console.log(`Processing file ${filesProcessed}/${markdownFiles.length}: ${file.path}`);
            let fileContent = await this.app.vault.read(file);
            let originalContent = fileContent;
            let fileLinksArchived = 0;
            let fileLinksFailed = 0;
            let fileLinksSkipped = 0;
            let fileModified = false;

            try {
                // File Level Filtering
                // 1. Path Patterns
                if (this.activeSettings.pathPatterns.length > 0) {
                    const pathMatches = this.activeSettings.pathPatterns.some(pattern => {
                        if (!pattern || pattern.trim() === '') return false;
                        try { return new RegExp(pattern, 'i').test(file.path); }
                        catch (e) { return file.path.includes(pattern); }
                    });
                    if (!pathMatches) {
                    	// console.log(`Skipping file ${file.path} - does not match path patterns.`); 
                    	continue;
                    }
                   }
                   // 2. Word Patterns
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

                    if (matchIndex === undefined) {
                        fileLinksSkipped++;
                        continue;
                    }

                    // Link Level Filtering
                    const isIgnored = this.activeSettings.ignorePatterns.some(pattern => {
                        if (!pattern || pattern.trim() === '') return false;
                        try { return new RegExp(pattern, 'i').test(originalUrl); }
                        catch (e) { return originalUrl.includes(pattern); }
                    });
                    if (isIgnored || originalUrl.includes('web.archive.org/')) { fileLinksSkipped++; continue; }

                    if (this.activeSettings.urlPatterns.length > 0) {
                        const urlMatches = this.activeSettings.urlPatterns.some(pattern => {
                            if (!pattern || pattern.trim() === '') return false;
                            try { return new RegExp(pattern, 'i').test(originalUrl); }
                            catch (e) { return originalUrl.includes(pattern); }
                        });
                        if (!urlMatches) { fileLinksSkipped++; continue; }
                    }
                    if (!originalUrl.match(/^https?:\/\//i)) { fileLinksSkipped++; continue; }

                    const insertionPosIndex = matchIndex + fullMatch.length;
                    const textAfterLink = fileContent.substring(insertionPosIndex, insertionPosIndex + 300);
                    const archiveUrlPattern = 'https?:\\/\\/web\\.archive\\.org\\/web\\/\\d+\\/.+?';
                    const fullArchiveLinkRegex = new RegExp(`^(\\s*\\n*\\s*\\[.*?\\]\\(${archiveUrlPattern}\\))|(\\s*\\n*\\s*<a [^>]*href=\\"${archiveUrlPattern}\\"[^>]*>.*?<\\/a>)`, 's');
                    const existingArchiveMatch = textAfterLink.match(fullArchiveLinkRegex);
                    if (existingArchiveMatch && existingArchiveMatch[0]) {
                        fileLinksSkipped++;
                        continue;
                    }

                    totalLinksFound++;

                    await new Promise(resolve => setTimeout(resolve, this.activeSettings.apiDelay));
                    const archiveResult = await this.archiveUrl(originalUrl);

                    if (archiveResult.status === 'success' || archiveResult.status === 'too_many_captures') {
                        const archiveDate = format(new Date(), this.activeSettings.dateFormat);
                        const archiveLinkText = this.activeSettings.archiveLinkText.replace('{date}', archiveDate);
                        const isHtmlLink = match[2] || match[3];
                        const archiveLink = isHtmlLink
                            ? ` <a href="${archiveResult.url}">${archiveLinkText}</a>`
                            : ` [${archiveLinkText}](${archiveResult.url})`;

                        fileContent = fileContent.slice(0, insertionPosIndex) + archiveLink + fileContent.slice(insertionPosIndex);
                        fileModified = true;

                        if (archiveResult.status === 'success') {
                            fileLinksArchived++;
                        } else {
                            fileLinksFailed++;
                        }
                    } else {
                        fileLinksFailed++;
                        if (!this.data.failedArchives) this.data.failedArchives = [];
                        this.data.failedArchives.push({
                            url: originalUrl,
                            filePath: file.path,
                            timestamp: Date.now(),
                            error: `Archiving failed (status: ${archiveResult.status})`,
                            retryCount: 0
                        });
                    }
                }

                if (fileModified) {
                     try {
                        await this.app.vault.process(file, (currentData) => {
                            // console.log(`Applying modifications to ${file.path} via vault.process`);
                            return fileContent;
                        });
                        filesModified++;
                        // console.log(`Successfully processed ${file.path} with ${fileLinksArchived} new archives, ${fileLinksFailed} failures.`);
                    } catch (err: any) {
                         console.error(`Error processing file ${file.path} via vault.process:`, err);
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
                console.error(`Error processing file ${file.path}:`, error);
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
        new Notice(`Vault Archival Complete. Found: ${totalLinksFound}, Archived: ${totalArchived}, Failed: ${totalFailed}, Skipped: ${totalSkipped}.`);
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
            console.error('forceReArchiveLinksAction: ctx.file is null or undefined.');
            return;
        }

        const getUrlFromMatch = (match: RegExpMatchArray) => match[1] || match[2] || match[3] || match[4] || '';

        if (isSelection) {
        	// console.log('Force Re-archiving links in current selection (Editor Mode)...'); 
        	const selectionStartOffset = editor.posToOffset(editor.getCursor('from'));
        	const content = selectedText;
        	const fullDocContent = editor.getValue();
        	let allMatches = Array.from(content.matchAll(LINK_REGEX));
        	// console.log(`Found potential links in selection:`, allMatches.map(link => getUrlFromMatch(link))); 
      
        	linksToProcess = allMatches.filter(match => {
        		const url = getUrlFromMatch(match);
                const isIgnored = this.activeSettings.ignorePatterns.some(pattern => {
                    if (!pattern || pattern.trim() === '') return false;
                    try { return new RegExp(pattern, 'i').test(url); }
                    catch (e) { return url.includes(pattern); }
                   });
                   if (isIgnored || url.includes('web.archive.org/')) {
                    // console.log(`Filtering out ignored/archive link (selection - force): ${url}`); 
                    skippedCount++;
                    return false;
                   }
                if (this.activeSettings.urlPatterns.length > 0) {
                    const urlMatches = this.activeSettings.urlPatterns.some(pattern => {
                        if (!pattern || pattern.trim() === '') return false;
                        try { return new RegExp(pattern, 'i').test(url); }
                        catch (e) { return url.includes(pattern); }
                    });
                    if (!urlMatches) {
                    	// console.log(`Filtering out link due to urlPatterns (selection - force): ${url}`); 
                    	skippedCount++;
                    	return false;
                    }
                   }
                   if (!url.match(/^https?:\/\//i)) {
                    // console.log(`Skipping non-HTTP(S) link (selection - force): ${url}`); 
                    skippedCount++;
                    return false;
                   }
                return true;
            });

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
                let oldLinkToRemoveStartPos = insertionPos;
                let oldLinkToRemoveEndPos = insertionPos;
                const textAfterLinkInDoc = fullDocContent.substring(absoluteInsertionOffset, absoluteInsertionOffset + 300);
                const isHtmlLink = match[2] || match[3];
                const existingArchiveMatch = textAfterLinkInDoc.match(ArchiverService.ADJACENT_ARCHIVE_LINK_REGEX);
                if (existingArchiveMatch && existingArchiveMatch[0]) {
                    const oldLinkText = existingArchiveMatch[0];
                    const oldLinkLength = oldLinkText.length;
                    oldLinkToRemoveEndPos = editor.offsetToPos(absoluteInsertionOffset + oldLinkLength);
                }
                const cached = this.recentArchiveCache.get(originalUrl);
                const freshnessThresholdMs = 24 * 60 * 60 * 1000;
                let archiveResult;
                if (cached && (Date.now() - cached.timestamp) < freshnessThresholdMs) {
                    archiveResult = { status: cached.status, url: cached.url };
                } else {
                    await new Promise(resolve => setTimeout(resolve, this.activeSettings.apiDelay));
                    archiveResult = await this.archiveUrl(originalUrl);
                    if (archiveResult.status === 'success' || archiveResult.status === 'too_many_captures') {
                        this.recentArchiveCache.set(originalUrl, { status: archiveResult.status, url: archiveResult.url, timestamp: Date.now() });
                    }
                }
                if (archiveResult.status === 'success' || archiveResult.status === 'too_many_captures') {
                    const archiveDate = format(new Date(), this.activeSettings.dateFormat);
                    const archiveLinkText = this.activeSettings.archiveLinkText.replace('{date}', archiveDate);
                    const archiveLink = isHtmlLink
                        ? ` <a href=\"${archiveResult.url}\">${archiveLinkText}</a>`
                        : ` [${archiveLinkText}](${archiveResult.url})`;
                    editor.replaceRange(archiveLink, insertionPos, oldLinkToRemoveEndPos);
                    archivedCount++;
                } else {
                    failedCount++;
                    if (!this.data.failedArchives) this.data.failedArchives = [];
                    this.data.failedArchives.push({
                        url: originalUrl,
                        filePath: filePath,
                        timestamp: Date.now(),
                        error: `Force re-archiving failed (status: ${archiveResult.status})`,
                        retryCount: 0
                    });
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
                console.error(`Error reading file ${file.path}:`, err);
                return;
            }
            const originalContent = fileContent;
            let fileModified = false;
         
            let allMatches = Array.from(fileContent.matchAll(LINK_REGEX));
            // console.log(`Found all potential links:`, allMatches.map(link => getUrlFromMatch(link))); 
         
            linksToProcess = allMatches.filter(match => {
            	const url = getUrlFromMatch(match);
                const isIgnored = this.activeSettings.ignorePatterns.some(pattern => {
                    if (!pattern || pattern.trim() === '') return false;
                    try { return new RegExp(pattern, 'i').test(url); }
                    catch (e) { return url.includes(pattern); }
                   });
                   if (isIgnored || url.includes('web.archive.org/')) {
                    // console.log(`Filtering out ignored/archive link (file - force): ${url}`); 
                    skippedCount++;
                    return false;
                   }
                if (this.activeSettings.urlPatterns.length > 0) {
                    const urlMatches = this.activeSettings.urlPatterns.some(pattern => {
                        if (!pattern || pattern.trim() === '') return false;
                        try { return new RegExp(pattern, 'i').test(url); }
                        catch (e) { return url.includes(pattern); }
                    });
                    if (!urlMatches) {
                    	// console.log(`Filtering out link due to urlPatterns (file - force): ${url}`); 
                    	skippedCount++;
                    	return false;
                    }
                   }
                   if (!url.match(/^https?:\/\//i)) {
                    // console.log(`Skipping non-HTTP(S) link (file - force): ${url}`); 
                    skippedCount++;
                    return false;
                   }
                return true;
            });

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
                const isHtmlLink = match[2] || match[3];
                const existingArchiveMatch = textAfterLinkInContent.match(ArchiverService.ADJACENT_ARCHIVE_LINK_REGEX);
                if (existingArchiveMatch && existingArchiveMatch[0]) {
                    const oldLinkLength = existingArchiveMatch[0].length;
                    endIndexToRemove = insertionPosIndex + oldLinkLength;
                }
                const cached = this.recentArchiveCache.get(originalUrl);
                const freshnessThresholdMs = 24 * 60 * 60 * 1000;
                let archiveResult;
                if (cached && (Date.now() - cached.timestamp) < freshnessThresholdMs) {
                    archiveResult = { status: cached.status, url: cached.url };
                } else {
                    await new Promise(resolve => setTimeout(resolve, this.activeSettings.apiDelay));
                    archiveResult = await this.archiveUrl(originalUrl);
                    if (archiveResult.status === 'success' || archiveResult.status === 'too_many_captures') {
                        this.recentArchiveCache.set(originalUrl, { status: archiveResult.status, url: archiveResult.url, timestamp: Date.now() });
                    }
                }
                if (archiveResult.status === 'success') {
                    const archiveDate = format(new Date(), this.activeSettings.dateFormat);
                    const archiveLinkText = this.activeSettings.archiveLinkText.replace('{date}', archiveDate);
                    const archiveLink = isHtmlLink
                        ? ` <a href=\"${archiveResult.url}\">${archiveLinkText}</a>`
                        : ` [${archiveLinkText}](${archiveResult.url})`;
                    fileContent = fileContent.slice(0, startIndexToRemove) + archiveLink + fileContent.slice(endIndexToRemove);
                    fileModified = true;
                    archivedCount++;
                } else {
                    failedCount++;
                    if (!this.data.failedArchives) this.data.failedArchives = [];
                    this.data.failedArchives.push({
                        url: originalUrl,
                        filePath: filePath,
                        timestamp: Date.now(),
                        error: `Force re-archiving failed (status: ${archiveResult.status})`,
                        retryCount: 0
                    });
                }
            };
            for (const match of reversedLinks) {
                await processSingleLinkFileForce(match);
            }
            if (fileModified) {
                await this.app.vault.modify(file, fileContent);
            }
        }

        let summary = `Force Re-archival complete. Re-archived: ${archivedCount}, Failed: ${failedCount}`;
        if (skippedCount > 0) {
            summary += `, Skipped: ${skippedCount}`;
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

        const getUrlFromMatch = (match: RegExpMatchArray) => match[1] || match[2] || match[3] || match[4] || '';

        for (const file of markdownFiles) {
            filesProcessed++;
            // console.log(`Processing file ${filesProcessed}/${markdownFiles.length}: ${file.path}`);
            let fileContent = await this.app.vault.read(file);
            let originalContent = fileContent;
            let fileLinksArchived = 0;
            let fileLinksFailed = 0;
            let fileLinksSkipped = 0;
            let fileModified = false;

            try {
                if (this.activeSettings.pathPatterns.length > 0) {
                    const pathMatches = this.activeSettings.pathPatterns.some(pattern => {
                        if (!pattern || pattern.trim() === '') return false;
                        try { return new RegExp(pattern, 'i').test(file.path); }
                        catch (e) { return file.path.includes(pattern); }
                    });
                    if (!pathMatches) {
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

                    const isIgnored = this.activeSettings.ignorePatterns.some(pattern => {
                        if (!pattern || pattern.trim() === '') return false;
                        try { return new RegExp(pattern, 'i').test(originalUrl); }
                        catch (e) { return originalUrl.includes(pattern); }
                    });
                    if (isIgnored || originalUrl.includes('web.archive.org/')) { fileLinksSkipped++; continue; }

                    if (this.activeSettings.urlPatterns.length > 0) {
                        const urlMatches = this.activeSettings.urlPatterns.some(pattern => {
                            if (!pattern || pattern.trim() === '') return false;
                            try { return new RegExp(pattern, 'i').test(originalUrl); }
                            catch (e) { return originalUrl.includes(pattern); }
                        });
                        if (!urlMatches) { fileLinksSkipped++; continue; }
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
                    await new Promise(resolve => setTimeout(resolve, this.activeSettings.apiDelay));
               
                    const archiveResult = await this.archiveUrl(originalUrl);

                    if (archiveResult.status === 'success') {
                        const archiveDate = format(new Date(), this.activeSettings.dateFormat);
                        const archiveLinkText = this.activeSettings.archiveLinkText.replace('{date}', archiveDate);
                        const archiveLink = match[2] || match[3]
                            ? ` <a href="${archiveResult.url}">${archiveLinkText}</a>`
                            : ` [${archiveLinkText}](${archiveResult.url})`;
                        
                        fileContent = fileContent.slice(0, startIndexToRemove) + archiveLink + fileContent.slice(endIndexToRemove);
                        fileModified = true;
                  
                        fileLinksArchived++;
                        // console.log(`Successfully force re-archived (replaced existing? ${!!(existingArchiveMatch && existingArchiveMatch[0])}): ${originalUrl} -> ${archiveResult.url} in ${file.path}`); 
                       } else {
                        fileLinksFailed++;
                        // console.log(`Force re-archive failed or daily limit reached, no new link inserted for: ${originalUrl} in ${file.path}`); 
                        if (!this.data.failedArchives) this.data.failedArchives = [];
                        this.data.failedArchives.push({
                        	url: originalUrl,
                            filePath: file.path,
                            timestamp: Date.now(),
                            error: `Force re-archiving failed or limited (status: ${archiveResult.status})`,
                            retryCount: 0
                        });
                    }
                }

                if (fileModified) {
                     try {
                        await this.app.vault.process(file, (currentData) => {
                            // console.log(`Applying modifications to ${file.path} via vault.process (force re-archive)`);
                            return fileContent;
                        });
                        filesModified++;
                        // console.log(`Successfully processed ${file.path} with ${fileLinksArchived} re-archives, ${fileLinksFailed} failures.`);
                    } catch (err: any) {
                         console.error(`Error processing file ${file.path} via vault.process (force re-archive):`, err);
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
                console.error(`Error processing file ${file.path} during force re-archive:`, error);
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
        new Notice(`Vault Force Re-Archival Complete. Found: ${totalLinksFound}, Re-Archived: ${totalArchived}, Failed: ${totalFailed}, Skipped: ${totalSkipped}.`);
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
            console.error(`Error listing files in "${logFolderPath}":`, error);
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
                                        const existingArchiveMatch = textAfterLink.match(ArchiverService.ADJACENT_ARCHIVE_LINK_REGEX);

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
                                console.warn(`Error during pre-check for ${entry.url} in ${entry.filePath}:`, e);
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
                                            const existingArchiveMatch = textAfterLink.match(ArchiverService.ADJACENT_ARCHIVE_LINK_REGEX);

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
                                         console.warn(`Could not get MarkdownView for ${entry.filePath} to update content.`);
                                    }
                                } else {
                                     console.warn(`File not found or not TFile: ${entry.filePath}`);
                                }
                            } catch (e) {
                                console.warn(`Failed to update note ${entry.filePath} for URL ${entry.url}:`, e);
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
                        console.error('Error updating or deleting failed log file:', e);
                        const errorMsg = e instanceof Error ? e.message : 'Unknown error';
                        new Notice(`Error updating or deleting failed log file: ${errorMsg}`);
                    }

                    new Notice(`Retry complete. Retried ${failedCount} links. Success: ${successCount}, Still Failed: ${stillFailed.length}.`);
                } else {
                    new ConfirmationModal(
                        this.app,
                        forceReplace ? 'Force Retry Failed Archives?' : 'Retry Failed Archives?',
                        `${forceReplace ? 'Force retry' : 'Retry'} all ${failedCount} failed archives?\n\nSample:\n${listPreview}`,
                        forceReplace ? 'Yes, Force Retry All' : 'Yes, Retry All',
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
                                                const existingArchiveMatch = textAfterLink.match(ArchiverService.ADJACENT_ARCHIVE_LINK_REGEX);

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
                                        console.warn(`Error during pre-check for ${entry.url} in ${entry.filePath}:`, e);
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
                                                    const existingArchiveMatch = textAfterLink.match(ArchiverService.ADJACENT_ARCHIVE_LINK_REGEX);


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
                                                 console.warn(`Could not get MarkdownView for ${entry.filePath} to update content.`);
                                            }
                                        } else {
                                             console.warn(`File not found or not TFile: ${entry.filePath}`);
                                        }
                                    } catch (e) {
                                        console.warn(`Failed to update note ${entry.filePath} for URL ${entry.url}:`, e);
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
                                console.error('Error updating or deleting failed log file:', e);
                                const errorMsg = e instanceof Error ? e.message : 'Unknown error';
                                new Notice(`Error updating or deleting failed log file: ${errorMsg}`);
                            }

                            new Notice(`Retry complete. Retried ${failedCount} links. Success: ${successCount}, Still Failed: ${stillFailed.length}.`);
                        }
                    ).open();
                }

            } catch (e) {
                console.error('Error loading failed log file:', e);
                new Notice('Error loading failed log file.');
            }
        }).open();
    };
}