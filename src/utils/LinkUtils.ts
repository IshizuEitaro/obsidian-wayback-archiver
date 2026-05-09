import { format } from "date-fns";
import { getFreshnessThresholdMs, WaybackArchiverSettings } from "../core/settings";

/**
 * Regex to find various link types: Markdown, HTML A/Img, Plain URL
 * - Group 0: The primary link structure (Markdown, HTML A, HTML Img, or Plain URL)
 * - Group 1: URL from Markdown `(![...](URL) or [...](URL))`
 * - Group 2: URL from HTML `<a href="URL">` (double quotes)
 * - Group 3: URL from HTML `<a href='URL'>` (single quotes)
 * - Group 4: URL from HTML `<img src="URL">` (double quotes)
 * - Group 5: URL from HTML `<img src='URL'>` (single quotes)
 * - Group 6: Plain HTTP/HTTPS URL
 * Markdown URL/Img Regex: !?\[[^\[\]]*\]\((https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})\)
 * HTML A/Img Regex: <a\b(?=[^>]*href=["'])[^>]*href="((?:https?:\/\/|www\.)[^"]+)"[^>]*>.*?<\/a>|<img\b(?=[^>]*src=["'])[^>]*src="((?:https?:\/\/|www\.)[^"]+)"[^>]*>
 * Raw URL Regex: ^(https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})
 * Combined Regex: !?\[[^\[\]]*\]\((https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})\)|<a\b(?=[^>]*href=["'])[^>]*href="((?:https?:\/\/|www\.)[^"]+)"[^>]*>.*?<\/a>|<img\b(?=[^>]*src=["'])[^>]*src="((?:https?:\/\/|www\.)[^"]+)"[^>]*>|^(https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})
 * Thank you https://regex101.com/ and zolrath for auto link title
 */
const MARKDOWN_LINK =
	/!?\[(?:[^[\]]|\[[^[\]]*\])*\]\(((?:https?:\/\/|www\.)(?:[^\s()]+|\((?:[^\s()]+|\([^\s()]+\))*\))+)\)/
		.source;
const HTML_A_LINK =
	/<a\b(?=[^>]*href=["'])[^>]*href=(?:"((?:https?:\/\/|www\.)[^"]*)"|'((?:https?:\/\/|www\.)[^']*)')[^>]*>.*?<\/a>/
		.source;
const HTML_IMG_LINK =
	/<img\b(?=[^>]*src=["'])[^>]*src=(?:"((?:https?:\/\/|www\.)[^"]*)"|'((?:https?:\/\/|www\.)[^']*)')[^>]*\/?>/
		.source;
const PLAIN_URL =
	/((?:https?:\/\/|www\.)(?:[^\s()<>]+|\([^()]*\))+(?:\([^()]*\)|[^\s`!()[\]{};:'".,<>?«»“”‘’]))/
		.source;

export const LINK_REGEX = new RegExp(
	`${MARKDOWN_LINK}|${HTML_A_LINK}|${HTML_IMG_LINK}|${PLAIN_URL}`,
	"img",
);

export const getUrlFromMatch = (match: RegExpMatchArray) =>
	match[1] || match[2] || match[3] || match[4] || match[5] || match[6] || "";

export const ARCHIVE_TODAY_HOSTS = [
	"archive.today",
	"archive.is",
	"archive.md",
	"archive.ph",
	"archive.vn",
	"archive.li",
	"archive.fo",
] as const;

export const ARCHIVE_TODAY_HOST_PATTERN = String.raw`archive\.(?:today|is|md|ph|vn|li|fo)`;

// Helper for matching URLs with balanced parentheses
const URL_PATTERN = /(?:https?:\/\/|www\.)(?:[^\s()]+|\((?:[^\s()]+|\([^\s()]+\))*\))+/.source;

const ARCHIVE_URL_PATTERN = String.raw`(?:https?:\/\/web\.archive\.org\/web\/(?:\d+|\*)\/${URL_PATTERN}|https?:\/\/${ARCHIVE_TODAY_HOST_PATTERN}\/\d{14}\/${URL_PATTERN}|https?:\/\/megalodon\.jp\/\d{4}-\d{4}-\d{4}-\d{2}\/${URL_PATTERN})`;

/**
 * The maximum number of characters following an original link to scan for an adjacent archive link.
 * This limit optimizes performance and prevents matching unrelated archive links further down the document.
 */
export const ADJACENT_LINK_SEARCH_LIMIT = 300;

// Regex to match markdown and HTML adjacent archive links
export const ADJACENT_ARCHIVE_LINK_REGEX = new RegExp(
	String.raw`^\s*\n*\s*(\[.*?\]\(${ARCHIVE_URL_PATTERN}\)|<a [^>]*href=["']${ARCHIVE_URL_PATTERN}["'][^>]*>.*?<\/a>)`,
	"s",
);

/**
 * Searches for an adjacent archive link within the text following a link, up to the search limit of 300 characters.
 * Slices the text to ensure adjacency and proper regex performance.
 */
export function getAdjacentArchiveLinkMatch(textFollowingLink: string): RegExpMatchArray | null {
	const searchWindow = textFollowingLink.slice(0, ADJACENT_LINK_SEARCH_LIMIT);
	return searchWindow.match(ADJACENT_ARCHIVE_LINK_REGEX);
}

/**
 * Checks if the text following a link contains an adjacent archive link within the search limit.
 */
export function isFollowedByArchiveLink(textFollowingLink: string): boolean {
	return getAdjacentArchiveLinkMatch(textFollowingLink) !== null;
}

/**
 * Extracts a 14-digit archive timestamp (YYYYMMDDHHMMSS) from an archive URL or text.
 * Supports Wayback Machine, Archive Today (all host aliases), and Megalodon.
 * @param archiveUrlOrText - URL or text containing an archive link
 * @returns 14-digit timestamp string, or undefined if no valid timestamp found
 */
export function extractArchiveTimestamp(archiveUrlOrText: string): string | undefined {
	const wayback = archiveUrlOrText.match(/web\.archive\.org\/web\/(\d{14}|\*)\//);
	if (wayback?.[1] && wayback[1] !== "*") {
		return wayback[1];
	}

	const archiveTodayRegex = new RegExp(String.raw`${ARCHIVE_TODAY_HOST_PATTERN}\/(\d{14})\/`);
	const archiveToday = archiveUrlOrText.match(archiveTodayRegex);
	if (archiveToday?.[1]) {
		return archiveToday[1];
	}

	const megalodon = archiveUrlOrText.match(
		/megalodon\.jp\/(\d{4})-(\d{2})(\d{2})-(\d{2})(\d{2})-(\d{2})\//,
	);
	if (megalodon) {
		return `${megalodon[1]}${megalodon[2]}${megalodon[3]}${megalodon[4]}${megalodon[5]}${megalodon[6]}`;
	}

	return undefined;
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

	return patterns.some((pattern) => {
		if (!pattern || pattern.trim() === "") {
			return false;
		}

		try {
			return new RegExp(pattern, "iu").test(text);
		} catch {
			console.warn(
				`Invalid regex pattern: "${pattern}". Falling back to string inclusion check.`,
			);
			return text.includes(pattern);
		}
	});
}

export function applySubstitutionRules(
	url: string,
	rules: { find: string; replace: string; regex?: boolean }[],
): string {
	let result = url;
	for (const rule of rules) {
		if (!rule.find) continue;
		try {
			if (rule.regex) {
				const regex = new RegExp(rule.find, "g");
				result = result.replace(regex, rule.replace || "");
			} else {
				result = result.split(rule.find).join(rule.replace || "");
			}
		} catch (error) {
			console.warn(
				`Error applying substitution rule: Find="${rule.find}", Regex=${rule.regex}. Error: ${error instanceof Error ? error.message : String(error)}`,
			);
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
/**
 * Normalizes an archive URL. For archive.today, replaces any of its mirror domains with the canonical host "archive.md".
 * @param archiveUrl The original archive URL.
 * @returns The normalized archive URL.
 */
export function normalizeArchiveUrl(archiveUrl: string): string {
	const archiveTodayPattern =
		/^(https?:\/\/)(?:www\.)?archive\.(?:today|is|md|ph|vn|li|fo)(\/.*)$/i;
	if (archiveTodayPattern.test(archiveUrl)) {
		return archiveUrl.replace(archiveTodayPattern, "$1archive.md$2");
	}
	return archiveUrl;
}

export function createArchiveLink(
	match: RegExpMatchArray,
	archiveUrl: string,
	settings: WaybackArchiverSettings,
): string {
	const normalizedUrl = normalizeArchiveUrl(archiveUrl);
	const archiveDate = format(new Date(), settings.dateFormat);
	const providerDisplayName = getProviderDisplayName(normalizedUrl);

	const archiveLinkText = settings.archiveLinkText
		.replace("{date}", archiveDate)
		.replace("{provider}", providerDisplayName);

	const isHtmlLink = match[2] || match[3] || match[4] || match[5];

	if (isHtmlLink) {
		const escapedArchiveUrl = normalizedUrl.replace(/"/g, "&quot;");
		return ` <a href="${escapedArchiveUrl}">${archiveLinkText}</a>`;
	} else {
		return ` [${archiveLinkText}](${normalizedUrl})`;
	}
}

function getProviderDisplayName(archiveUrl: string): string {
	if (archiveUrl.includes("web.archive.org")) {
		return "Wayback Machine";
	}
	if (archiveUrl.includes("megalodon.jp")) {
		return "Web Gyotaku";
	}
	const isArchiveToday = /archive\.(?:today|is|md|ph|vn|li|fo)/i.test(archiveUrl);
	if (isArchiveToday) {
		return "archive.today";
	}
	return "Archive"; // Fallback
}

/**
 * Checks the freshness of an existing adjacent archive link based on its timestamp.
 * Determines if the original link should be processed and if the adjacent link should be replaced.
 * @param adjacentTimestamp The timestamp string (YYYYMMDDHHMMSS) extracted from the adjacent link, or undefined if none found.
 * @returns An object { shouldProcess: boolean, replaceExisting: boolean }
 */
export const checkAdjacentLinkFreshness = (
	adjacentTimestamp: string | undefined,
	settings: WaybackArchiverSettings,
): { shouldProcess: boolean; replaceExisting: boolean } => {
	let shouldProcess = true;
	let replaceExisting = false;

	if (adjacentTimestamp) {
		try {
			const adjacentDate = new Date(
				parseInt(adjacentTimestamp.substring(0, 4)), // Year
				parseInt(adjacentTimestamp.substring(4, 6)) - 1, // Month (0-indexed)
				parseInt(adjacentTimestamp.substring(6, 8)), // Day
				parseInt(adjacentTimestamp.substring(8, 10)), // Hour
				parseInt(adjacentTimestamp.substring(10, 12)), // Minute
				parseInt(adjacentTimestamp.substring(12, 14)), // Second
			);
			if (!isNaN(adjacentDate.getTime())) {
				const isFresh =
					Date.now() - adjacentDate.getTime() < getFreshnessThresholdMs(settings);
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
		} catch (error) {
			// Error parsing date, assume old/invalid
			console.warn("Error parsing adjacent link timestamp:", adjacentTimestamp, error);
			replaceExisting = true;
		}
	} else {
		// Adjacent link exists but no timestamp captured (e.g., wildcard), treat as old, mark for replacement
		replaceExisting = true;
	}

	return { shouldProcess, replaceExisting };
};

/**
 * Decodes standard HTML entities in a string.
 */
export function decodeHtmlEntities(value: string): string {
	return value
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;/g, "'")
		.replace(/&#x2F;/g, "/");
}

/**
 * Normalizes a URL specifically for content comparison.
 * Strips protocol, subdomains, standard ports, and trailing slashes.
 */
export function normalizeUrlForComparison(url: string): string {
	try {
		const decoded = decodeURIComponent(url);
		return decoded
			.toLowerCase()
			.replace(/^https?:\/\//i, "")
			.replace(/^www\./i, "")
			.replace(/:(?:80|443)\b/g, "")
			.replace(/\/+$/, "");
	} catch {
		return url
			.toLowerCase()
			.replace(/^https?:\/\//i, "")
			.replace(/^www\./i, "")
			.replace(/:(?:80|443)\b/g, "")
			.replace(/\/+$/, "");
	}
}

/**
 * Validates if a snapshot URL corresponds to the requested target URL.
 */
export function isSnapshotForTargetUrl(
	providerId: "archiveToday" | "megalodon",
	snapshotUrl: string,
	targetUrl: string,
): boolean {
	if (providerId === "archiveToday") {
		const match = snapshotUrl.match(/\/(\d{14})\/(.*)$/);
		if (!match) {
			return false;
		}
		const extractedTarget = match[2];
		return normalizeUrlForComparison(extractedTarget) === normalizeUrlForComparison(targetUrl);
	} else if (providerId === "megalodon") {
		const match = snapshotUrl.match(/megalodon\.jp\/\d{4}-\d{4}-\d{4}-\d{2}\/(.*)$/i);
		if (!match) {
			return false;
		}
		const extractedTarget = match[1];
		return normalizeUrlForComparison(extractedTarget) === normalizeUrlForComparison(targetUrl);
	}
	return false;
}

/**
 * Extracts absolute and relative provider snapshot URLs from raw text content.
 */
export function extractProviderSnapshotFromText(
	providerId: "archiveToday" | "megalodon",
	text: string | undefined,
	targetUrl: string,
): string | null {
	if (!text) {
		return null;
	}
	const decodedText = decodeHtmlEntities(text);
	if (providerId === "archiveToday") {
		const absolutePattern = new RegExp(
			String.raw`(?:https?:)?\/\/${ARCHIVE_TODAY_HOST_PATTERN}\/\d{14}\/[^\s"'<>]+`,
			"gi",
		);
		const absoluteMatches = decodedText.matchAll(absolutePattern);
		for (const match of absoluteMatches) {
			const candidate = match[0];
			const url = candidate.startsWith("//") ? `https:${candidate}` : candidate;
			if (isSnapshotForTargetUrl("archiveToday", url, targetUrl)) {
				return url;
			}
		}

		const ARCHIVE_TODAY_CANONICAL_HOST = "archive.md";
		const relativePattern = new RegExp(
			String.raw`["'=({\s](\/\d{14}\/https?:\/\/[^\s"'<>)}]+)`,
			"gi",
		);
		const relativeMatches = decodedText.matchAll(relativePattern);
		for (const match of relativeMatches) {
			const relativePath = match[1];
			const url = `https://${ARCHIVE_TODAY_CANONICAL_HOST}${relativePath}`;
			if (isSnapshotForTargetUrl("archiveToday", url, targetUrl)) {
				return url;
			}
		}
		return null;
	}

	if (providerId === "megalodon") {
		const megalodonPattern = /https?:\/\/megalodon\.jp\/\d{4}-\d{4}-\d{4}-\d{2}\/[^\s"'<>]+/gi;
		const megalodonMatches = decodedText.matchAll(megalodonPattern);
		for (const match of megalodonMatches) {
			const candidate = match[0];
			if (isSnapshotForTargetUrl("megalodon", candidate, targetUrl)) {
				return candidate;
			}
		}
		return null;
	}

	return null;
}
