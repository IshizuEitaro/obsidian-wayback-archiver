import { format } from 'date-fns';
import { getFreshnessThresholdMs,WaybackArchiverSettings } from '../core/settings';

/**
 * Regex to find various link types: Markdown, HTML A/Img, Plain URL
 * - Group 0: The primary link structure (Markdown, HTML A, HTML Img, or Plain URL)
 * - Group 1: URL from Markdown `(![...](URL) or [...](URL))`
 * - Group 2: URL from HTML `<a href="URL">`
 * - Group 3: URL from HTML `<img src="URL">`
 * - Group 4: Plain HTTP/HTTPS URL
 * Markdown URL/Img Regex: !?\[[^\[\]]*\]\((https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})\)
 * HTML A/Img Regex: <a\b(?=[^>]*href=["'])[^>]*href="((?:https?:\/\/|www\.)[^"]+)"[^>]*>.*?<\/a>|<img\b(?=[^>]*src=["'])[^>]*src="((?:https?:\/\/|www\.)[^"]+)"[^>]*>
 * Raw URL Regex: ^(https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})
 * Combined Regex: !?\[[^\[\]]*\]\((https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})\)|<a\b(?=[^>]*href=["'])[^>]*href="((?:https?:\/\/|www\.)[^"]+)"[^>]*>.*?<\/a>|<img\b(?=[^>]*src=["'])[^>]*src="((?:https?:\/\/|www\.)[^"]+)"[^>]*>|^(https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})
 * Thank you https://regex101.com/ and zolrath for auto link title 
 */
export const LINK_REGEX = new RegExp('!?\\[[^\\[\\]]*\\]\\((https?:\\\/\\\/(?:www\\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\\.[^\\s]{2,}|www\\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\\.[^\\s]{2,}|https?:\\\/\\\/(?:www\\.|(?!www))[a-zA-Z0-9]+\\.[^\\s]{2,}|www\\.[a-zA-Z0-9]+\\.[^\\s]{2,})\\)|<a\\b(?=[^>]*href=["\'])[^>]*href="((?:https?:\\\/\\\/|www\\.)[^"]+)"[^>]*>.*?<\\\/a>|<img\\b(?=[^>]*src=["\'])[^>]*src="((?:https?:\\\/\\\/|www\\.)[^"]+)"[^>]*>|^(https?:\\\/\\\/(?:www\\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\\.[^\\s]{2,}|www\\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\\.[^\\s]{2,}|https?:\\\/\\\/(?:www\\.|(?!www))[a-zA-Z0-9]+\\.[^\\s]{2,}|www\\.[a-zA-Z0-9]+\\.[^\\s]{2,})', 'img')

export const getUrlFromMatch = (match: RegExpMatchArray) => match[1] || match[2] || match[3] || match[4] || '';

// Regex to match both markdown and HTML adjacent archive links
export const ADJACENT_ARCHIVE_LINK_REGEX = new RegExp(
	// Markdown: [text](https://web.archive.org/web/123456789/http...)
	String.raw`^\s*\n*\s*(\[.*?\]\(https?:\/\/web\.archive\.org\/web\/(\d+|\*)\/.+?\))` +
	// OR HTML: <a href="https://web.archive.org/web/123456789/http...">text</a>
	String.raw`|(\s*\n*\s*<a [^>]*href=\\?"https?:\/\/web\.archive\.org\/web\/(\d+|\*)\/.+?\\?"[^>]*>.*?<\/a>)`,
	's'
);

export function isFollowedByArchiveLink(textFollowingLink: string): boolean {
    return ADJACENT_ARCHIVE_LINK_REGEX.test(textFollowingLink);
}

/**
 * Checks if a string matches any of the provided patterns using case-insensitive regex
 * with a fallback to string inclusion if the pattern is invalid regex.
 *
 * @param text The string to test (e.g., URL, file path).
 * @param patterns An array of pattern strings.
 * @returns True if the text matches at least one pattern, false otherwise.
 *          Returns false if the patterns array is null or empty.
 */
export function matchesAnyPattern(text: string, patterns: string[] | null | undefined): boolean {
    if (!patterns || patterns.length === 0) {
        return false;
    }

    return patterns.some(pattern => {
        if (!pattern || pattern.trim() === '') {
            return false;
        }

        try {
            return new RegExp(pattern, 'iu').test(text);
        } catch (e) {
            console.warn(`Invalid regex pattern: "${pattern}". Falling back to string inclusion check.`);
            return text.includes(pattern);
        }
    });
}

export function applySubstitutionRules(url: string, rules: { find: string; replace: string; regex?: boolean }[]): string {
	let result = url;
	for (const rule of rules) {
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

/**
 * Creates the archive link string (Markdown or HTML) to be inserted.
 *
 * @param match - The RegExpMatchArray from matching the original link (using LINK_REGEX).
 * @param archiveUrl - The URL of the successful archive.
 * @param settings - The active plugin settings.
 * @returns The formatted archive link string (e.g., " [archive](url)" or " <a href='url'>archive</a>").
 */
export function createArchiveLink(
    match: RegExpMatchArray,
    archiveUrl: string,
    settings: WaybackArchiverSettings
	): string {
    const archiveDate = format(new Date(), settings.dateFormat);

    const archiveLinkText = settings.archiveLinkText.replace('{date}', archiveDate);

    const isHtmlLink = match[2] || match[3];

    if (isHtmlLink) {
        const escapedArchiveUrl = archiveUrl.replace(/"/g, '&quot;');
        return ` <a href="${escapedArchiveUrl}">${archiveLinkText}</a>`;
    } else {
        return ` [${archiveLinkText}](${archiveUrl})`;
    }
}

/**
     * Checks the freshness of an existing adjacent archive link based on its timestamp.
     * Determines if the original link should be processed and if the adjacent link should be replaced.
     * @param adjacentTimestamp The timestamp string (YYYYMMDDHHMMSS) extracted from the adjacent link, or undefined if none found.
     * @returns An object { shouldProcess: boolean, replaceExisting: boolean }
     */
export const checkAdjacentLinkFreshness = (adjacentTimestamp: string | undefined, settings: WaybackArchiverSettings): { shouldProcess: boolean, replaceExisting: boolean } => {
    let shouldProcess = true;
    let replaceExisting = false;

    if (adjacentTimestamp) {
        try {
            const adjacentDate = new Date(
                parseInt(adjacentTimestamp.substring(0, 4)),     // Year
                parseInt(adjacentTimestamp.substring(4, 6)) - 1, // Month (0-indexed)
                parseInt(adjacentTimestamp.substring(6, 8)),     // Day
                parseInt(adjacentTimestamp.substring(8, 10)),    // Hour
                parseInt(adjacentTimestamp.substring(10, 12)),   // Minute
                parseInt(adjacentTimestamp.substring(12, 14))    // Second
            );
            if (!isNaN(adjacentDate.getTime())) {
                const isFresh = (Date.now() - adjacentDate.getTime()) < getFreshnessThresholdMs(settings);
                if (isFresh) {
                    // Adjacent link exists and is fresh, skip.
                    shouldProcess = false;
                } else {
                    // Adjacent link exists but is older, mark for replacement.
                    replaceExisting = true;
                }
            } else {
                // Could not parse timestamp, assume it's old/invalid, mark for replacement
                replaceExisting = true;
            }
        } catch (e) {
            // Error parsing date, assume old/invalid
            console.warn("Error parsing adjacent link timestamp:", adjacentTimestamp, e);
            replaceExisting = true;
        }
    } else {
        // Adjacent link exists but no timestamp captured (e.g., wildcard), treat as old, mark for replacement
        replaceExisting = true;
    }

    return { shouldProcess, replaceExisting };
}