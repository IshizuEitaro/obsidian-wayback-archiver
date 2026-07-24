import type { TFile } from "obsidian";
import type { WaybackArchiverSettings } from "./settings";
import { getUrlFromMatch, isBareUrlMatch, LINK_REGEX } from "../utils/LinkUtils";

export type ArchiveScope =
	| { kind: "url"; file: TFile; sourceUrl: string }
	| { kind: "files"; files: TFile[] };

export interface SourceOccurrence {
	url: string;
	matchText: string;
	index: number;
	format: "markdown" | "markdown-image" | "html" | "html-image" | "bare";
	ordinal: number;
}

export function canonicalizeSourceUrl(url: string): string | null {
	try {
		const parsed = new URL(url.startsWith("www.") ? `https://${url}` : url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
		parsed.protocol = parsed.protocol.toLowerCase();
		parsed.hostname = parsed.hostname.toLowerCase();
		if (
			(parsed.protocol === "https:" && parsed.port === "443") ||
			(parsed.protocol === "http:" && parsed.port === "80")
		) {
			parsed.port = "";
		}
		return parsed.href;
	} catch {
		return null;
	}
}

export function areSameSourceUrl(left: string, right: string): boolean {
	if (left === right) return true;
	const canonicalLeft = canonicalizeSourceUrl(left);
	return canonicalLeft !== null && canonicalLeft === canonicalizeSourceUrl(right);
}

function getOccurrenceFormat(match: RegExpMatchArray): SourceOccurrence["format"] {
	if (match[1]) return match[0].startsWith("!") ? "markdown-image" : "markdown";
	if (match[2] || match[3]) return "html";
	if (match[4] || match[5]) return "html-image";
	return "bare";
}

function collectMatches(
	content: string,
	settings: Pick<WaybackArchiverSettings, "archiveBareUrls">,
): SourceOccurrence[] {
	const ordinalBySignature = new Map<string, number>();
	return Array.from(content.matchAll(LINK_REGEX)).flatMap((match) => {
		if (isBareUrlMatch(match) && !settings.archiveBareUrls) return [];
		const index = match.index;
		const url = getUrlFromMatch(match);
		if (index === undefined || !url) return [];
		const signature = `${url}\u0000${match[0]}`;
		const ordinal = ordinalBySignature.get(signature) ?? 0;
		ordinalBySignature.set(signature, ordinal + 1);
		return [{ url, matchText: match[0], index, format: getOccurrenceFormat(match), ordinal }];
	});
}

export function collectUrlOccurrences(
	content: string,
	menuUrl: string,
	settings: Pick<WaybackArchiverSettings, "archiveBareUrls">,
): SourceOccurrence[] {
	const matches = collectMatches(content, settings);
	const exact = matches.filter((item) => item.url === menuUrl);
	return exact.length > 0 ? exact : matches.filter((item) => areSameSourceUrl(item.url, menuUrl));
}

export function reconcileOccurrences(
	original: SourceOccurrence[],
	latestContent: string,
	settings: Pick<WaybackArchiverSettings, "archiveBareUrls">,
): SourceOccurrence[] {
	if (original.length === 0) return [];
	const latest = collectMatches(latestContent, settings);
	const signature = (item: SourceOccurrence) => `${item.url}\u0000${item.matchText}`;
	const originalCounts = new Map<string, number>();
	const latestCounts = new Map<string, number>();
	for (const item of original) {
		originalCounts.set(signature(item), (originalCounts.get(signature(item)) ?? 0) + 1);
	}
	for (const item of latest) {
		latestCounts.set(signature(item), (latestCounts.get(signature(item)) ?? 0) + 1);
	}
	const claimed = new Set<number>();
	const resolved: SourceOccurrence[] = [];

	for (const source of original) {
		const sourceSignature = signature(source);
		if ((latestCounts.get(sourceSignature) ?? 0) > (originalCounts.get(sourceSignature) ?? 0)) {
			continue;
		}
		const candidates = latest.filter(
			(item, index) =>
				!claimed.has(index) &&
				item.matchText === source.matchText &&
				item.url === source.url &&
				item.ordinal === source.ordinal,
		);
		if (candidates.length !== 1) continue;
		const match = candidates[0];
		const matchIndex = latest.indexOf(match);
		claimed.add(matchIndex);
		resolved.push(match);
	}

	return resolved;
}
