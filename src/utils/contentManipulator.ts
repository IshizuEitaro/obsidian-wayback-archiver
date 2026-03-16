import { LINK_REGEX, getUrlFromMatch, createArchiveLink } from "./LinkUtils";
import { WaybackArchiverSettings } from "../core/settings";

/**
 * Resolves the correct insertion index by re-scanning the latest content
 * for the original link that matches the provided URL.
 *
 * If multiple identical URLs exist, it picks the one closest to approximateIndex.
 */
export function findLatestLinkIndex(
	content: string,
	originalUrl: string,
	approximateIndex: number,
): number | null {
	const matches = Array.from(content.matchAll(LINK_REGEX));

	// Filter matches that have the matching URL
	const eligibleMatches = matches.filter((m) => getUrlFromMatch(m) === originalUrl);

	if (eligibleMatches.length === 0) {
		return null;
	}

	// Find the match closest to the original approximate index
	let bestMatch = eligibleMatches[0];
	let minDistance = Math.abs((bestMatch.index || 0) - approximateIndex);

	for (let i = 1; i < eligibleMatches.length; i++) {
		const currentMatch = eligibleMatches[i];
		const distance = Math.abs((currentMatch.index || 0) - approximateIndex);
		if (distance < minDistance) {
			minDistance = distance;
			bestMatch = currentMatch;
		}
	}

	return bestMatch.index ?? null;
}

/**
 * Interface for the result of a content modification.
 */
export interface ContentModification {
	content: string;
	modified: boolean;
	insertedLength: number;
	newIndex: number;
}

/**
 * Robustly applies a link modification (insertion or replacement) to content.
 * It re-scans the content for the correct position at the moment of modification.
 */
export function applyLinkModification(
	content: string,
	originalUrl: string,
	archiveUrl: string,
	approximateIndex: number,
	settings: WaybackArchiverSettings,
	options: { isReplacement: boolean; oldLinkEndIndex?: number },
): ContentModification {
	const latestIndex = findLatestLinkIndex(content, originalUrl, approximateIndex);

	if (latestIndex === null) {
		return {
			content,
			modified: false,
			insertedLength: 0,
			newIndex: approximateIndex,
		};
	}

	// Find the full match at this index to determine the format (HTML/MD)
	const matches = Array.from(content.matchAll(LINK_REGEX));
	const currentMatch = matches.find((m) => m.index === latestIndex);

	if (!currentMatch) {
		return {
			content,
			modified: false,
			insertedLength: 0,
			newIndex: latestIndex,
		};
	}

	const archiveLinkText = createArchiveLink(currentMatch, archiveUrl, settings);

	let newContent: string;
	let insertedLength: number;
	const newIndex = latestIndex;

	if (options.isReplacement && options.oldLinkEndIndex !== undefined) {
		// Find existing archive link if possible
		// Note: Replacing is tricky because the user might have deleted the adjacent link.
		const before = content.slice(0, latestIndex + currentMatch[0].length);

		newContent = before + archiveLinkText + content.slice(options.oldLinkEndIndex);
		insertedLength = archiveLinkText.length;
	} else {
		const insertionPoint = latestIndex + currentMatch[0].length;
		newContent =
			content.slice(0, insertionPoint) + archiveLinkText + content.slice(insertionPoint);
		insertedLength = archiveLinkText.length;
	}

	return {
		content: newContent,
		modified: true,
		insertedLength,
		newIndex,
	};
}
