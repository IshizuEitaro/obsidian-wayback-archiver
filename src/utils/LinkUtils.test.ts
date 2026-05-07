import { describe, it, expect, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../core/settings";
import {
	applySubstitutionRules,
	checkAdjacentLinkFreshness,
	createArchiveLink,
	LINK_REGEX,
	getUrlFromMatch,
	isFollowedByArchiveLink,
	matchesAnyPattern,
} from "./LinkUtils";

describe("Link Detection (Balanced Parentheses & Edge Cases)", () => {
	const getMatches = (text: string) => {
		return Array.from(text.matchAll(LINK_REGEX)).map((m) => getUrlFromMatch(m));
	};

	describe("Markdown Links & Images", () => {
		it("should handle nested parentheses in Wikipedia links", () => {
			const text = "[Erica](https://en.wikipedia.org/wiki/Erica_(plant))";
			expect(getMatches(text)).toContain("https://en.wikipedia.org/wiki/Erica_(plant)");
		});

		it("should handle complex nested parentheses in RHS links", () => {
			const text =
				"[Viola](https://www.rhs.org.uk/plants/68664/i-viola-i-belmont-blue-(c)/details)";
			expect(getMatches(text)).toContain(
				"https://www.rhs.org.uk/plants/68664/i-viola-i-belmont-blue-(c)/details",
			);
		});

		it("should handle markdown images", () => {
			const text = "![Alt](https://site.com/img.png)";
			expect(getMatches(text)).toContain("https://site.com/img.png");
		});
	});

	describe("HTML Tags", () => {
		it("should handle standard anchor tags", () => {
			const text = '<a href="https://example.com">Link</a>';
			expect(getMatches(text)).toContain("https://example.com");
		});

		it("should handle single quoted href", () => {
			const text = "<a href='https://example.com'>Link</a>";
			expect(getMatches(text)).toContain("https://example.com");
		});

		it("should handle image tags", () => {
			const text = '<img src="https://example.com/pic.jpg">';
			expect(getMatches(text)).toContain("https://example.com/pic.jpg");
		});

		it("should handle extra attributes and mixed-case tags", () => {
			const text =
				'<A class="external" HREF="https://example.com/page" id="top">Link</A> <IMG alt="pic" SRC="https://example.com/pic.jpg">';
			expect(getMatches(text)).toEqual([
				"https://example.com/page",
				"https://example.com/pic.jpg",
			]);
		});
	});

	describe("Plain URLs (Balanced punctuation)", () => {
		it("should match a plain URL in the middle of text", () => {
			const text = "Visit https://example.com for more info.";
			expect(getMatches(text)).toContain("https://example.com");
		});

		it("should NOT include trailing parenthesis in plain URLs", () => {
			const text = "(See https://example.com)";
			expect(getMatches(text)).toContain("https://example.com");
		});

		it("should include trailing parenthesis if it is balanced", () => {
			const text = "Check out https://en.wikipedia.org/wiki/Erica_(plant)";
			expect(getMatches(text)).toContain("https://en.wikipedia.org/wiki/Erica_(plant)");
		});
	});

	describe("Adjacent Archive Link Detection", () => {
		it("should correctly detect archive links with parentheses", () => {
			const nextText =
				" [(Archived on 2026-01-25)](https://web.archive.org/web/20260125095621/https://www.rhs.org.uk/plants/68664/i-viola-i-belmont-blue-(c)/details)";
			expect(isFollowedByArchiveLink(nextText)).toBe(true);
		});

		it("should handle HTML archive links with parentheses", () => {
			const nextText =
				' <a href="https://web.archive.org/web/20260125095621/https://www.rhs.org.uk/plants/68664/i-viola-i-belmont-blue-(c)/details">Archive</a>';
			expect(isFollowedByArchiveLink(nextText)).toBe(true);
		});
	});

	describe("Non-HTTP links", () => {
		it("should ignore mailto and ftp links", () => {
			const text =
				'[Email](mailto:test@example.com) <a href="ftp://example.com/file">FTP</a> ftp://example.com/file';
			expect(getMatches(text)).toEqual([]);
		});
	});

	describe("Pattern Matching", () => {
		it("matches regex patterns and treats empty pattern lists as no match", () => {
			expect(matchesAnyPattern("https://docs.example.com/page", ["docs\\.example\\.com"])).toBe(
				true,
			);
			expect(matchesAnyPattern("https://api.example.com/page", ["docs\\.example\\.com"])).toBe(
				false,
			);
			expect(matchesAnyPattern("https://api.example.com/page", [])).toBe(false);
			expect(matchesAnyPattern("https://api.example.com/page", undefined)).toBe(false);
		});

		it("falls back to literal inclusion for invalid regex patterns", () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

			expect(matchesAnyPattern("https://example.com/[draft", ["[draft"])).toBe(true);
			expect(matchesAnyPattern("https://example.com/live", ["[draft"])).toBe(false);
			expect(warn).toHaveBeenCalled();

			warn.mockRestore();
		});
	});

	describe("Substitution Rules", () => {
		it("applies plain, regex, empty, ordered, and case-sensitive substitutions", () => {
			const result = applySubstitutionRules("https://Example.com/articles/123?ref=RSS", [
				{ find: "Example.com", replace: "example.com", regex: false },
				{ find: "\\?ref=[A-Z]+", replace: "", regex: true },
				{ find: "/articles/", replace: "/posts/", regex: false },
				{ find: "example", replace: "docs", regex: false },
			]);

			expect(result).toBe("https://docs.com/posts/123");
		});

		it("keeps the URL unchanged for an invalid regex substitution rule", () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

			expect(
				applySubstitutionRules("https://example.com/[draft", [
					{ find: "[draft", replace: "published", regex: true },
				]),
			).toBe("https://example.com/[draft");
			expect(warn).toHaveBeenCalled();

			warn.mockRestore();
		});
	});

	describe("Archive Link Formatting", () => {
		it("uses the configured text and date format for markdown and HTML links", () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-04-17T10:20:30Z"));

			const markdownMatch = Array.from("[Docs](https://example.com)".matchAll(LINK_REGEX))[0];
			const htmlMatch = Array.from(
				'<a class="external" href="https://example.com">Docs</a>'.matchAll(LINK_REGEX),
			)[0];
			const settings = {
				...DEFAULT_SETTINGS,
				dateFormat: "yyyy/MM/dd",
				archiveLinkText: "Archived {date}",
			};

			expect(createArchiveLink(markdownMatch, "https://web.archive.org/web/1/x", settings)).toBe(
				" [Archived 2026/04/17](https://web.archive.org/web/1/x)",
			);
			expect(createArchiveLink(htmlMatch, 'https://web.archive.org/web/1/a"b', settings)).toBe(
				' <a href="https://web.archive.org/web/1/a&quot;b">Archived 2026/04/17</a>',
			);

			vi.useRealTimers();
		});
	});

	describe("Freshness", () => {
		it("skips fresh adjacent archive links and replaces old or invalid ones", () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-04-17T00:00:00Z"));

			expect(
				checkAdjacentLinkFreshness("20260416000000", {
					...DEFAULT_SETTINGS,
					archiveFreshnessDays: 2,
				}),
			).toEqual({ shouldProcess: false, replaceExisting: false });
			expect(
				checkAdjacentLinkFreshness("20260410000000", {
					...DEFAULT_SETTINGS,
					archiveFreshnessDays: 2,
				}),
			).toEqual({ shouldProcess: true, replaceExisting: true });
			expect(
				checkAdjacentLinkFreshness(undefined, {
					...DEFAULT_SETTINGS,
					archiveFreshnessDays: 2,
				}),
			).toEqual({ shouldProcess: true, replaceExisting: true });

			vi.useRealTimers();
		});
	});
});
