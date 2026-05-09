import {
	ADJACENT_ARCHIVE_LINK_REGEX,
	LINK_REGEX,
	getUrlFromMatch,
	createArchiveLink,
} from "./LinkUtils";
import { WaybackArchiverSettings } from "../core/settings";

export interface ContainedLinkMatch {
	match: RegExpMatchArray;
	url: string;
	startIndex: number;
	endIndex: number;
}

export function selectFullyContainedLinkMatches(
	content: string,
	selectionStart: number,
	selectionEnd: number,
): ContainedLinkMatch[] {
	if (selectionEnd <= selectionStart) {
		return [];
	}

	return Array.from(content.matchAll(LINK_REGEX))
		.filter((match) => {
			const startIndex = match.index;
			if (startIndex === undefined) {
				return false;
			}
			const endIndex = startIndex + match[0].length;
			return startIndex >= selectionStart && endIndex <= selectionEnd;
		})
		.map((match) => {
			const startIndex = match.index ?? 0;
			return {
				match,
				url: getUrlFromMatch(match),
				startIndex,
				endIndex: startIndex + match[0].length,
			};
		});
}

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
	let minDistance = Math.abs((bestMatch.index ?? 0) - approximateIndex);

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
	deltaLength: number;
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
	options: { isReplacement: boolean },
): ContentModification {
	const latestIndex = findLatestLinkIndex(content, originalUrl, approximateIndex);

	if (latestIndex === null) {
		return {
			content,
			modified: false,
			deltaLength: 0,
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
			deltaLength: 0,
			newIndex: latestIndex,
		};
	}

	const archiveLinkText = createArchiveLink(currentMatch, archiveUrl, settings);
	const insertionPoint = latestIndex + currentMatch[0].length;

	let newContent: string;
	let deltaLength: number;
	const newIndex = latestIndex;

	if (options.isReplacement) {
		const textAfterLink = content.slice(insertionPoint, insertionPoint + 300);
		const adjacentArchiveMatch = textAfterLink.match(ADJACENT_ARCHIVE_LINK_REGEX);
		if (adjacentArchiveMatch) {
			const replaceEnd = insertionPoint + adjacentArchiveMatch[0].length;
			newContent =
				content.slice(0, insertionPoint) + archiveLinkText + content.slice(replaceEnd);
			deltaLength = archiveLinkText.length - adjacentArchiveMatch[0].length;
		} else {
			newContent =
				content.slice(0, insertionPoint) + archiveLinkText + content.slice(insertionPoint);
			deltaLength = archiveLinkText.length;
		}
	} else {
		newContent =
			content.slice(0, insertionPoint) + archiveLinkText + content.slice(insertionPoint);
		deltaLength = archiveLinkText.length;
	}

	return {
		content: newContent,
		modified: true,
		deltaLength,
		newIndex,
	};
}
