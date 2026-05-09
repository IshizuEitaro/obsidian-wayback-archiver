import { afterEach, describe, it, expect, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../core/settings";
import {
	applyLinkModification,
	findLatestLinkIndex,
	selectFullyContainedLinkMatches,
} from "./contentManipulator";

describe("Content Manipulator - Match-at-Insertion", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("should find the link index accurately in original content", () => {
		const content = "Check this [Link](https://example.com) out.";
		const url = "https://example.com";
		const index = findLatestLinkIndex(content, url, 11);
		expect(index).toBe(11); // Start of [Link]
	});

	it("should find the link index even if content shifted forward", () => {
		const content = "New prefix! Check this [Link](https://example.com) out.";
		const url = "https://example.com";
		// Original index was 11, now it is 23
		const index = findLatestLinkIndex(content, url, 11);
		expect(index).toBe(23);
	});

	it("should find the link index even if content shifted backward", () => {
		const content = "[Link](https://example.com) out.";
		const url = "https://example.com";
		// Original index was 11, now it is 0
		const index = findLatestLinkIndex(content, url, 11);
		expect(index).toBe(0);
	});

	it("should return null if the link is no longer present", () => {
		const content = "The link is gone.";
		const url = "https://example.com";
		const index = findLatestLinkIndex(content, url, 11);
		expect(index).toBeNull();
	});

	it("should find the correct occurrence if multiple identical links exist", () => {
		const content = "[Link](https://example.com) and [Link](https://example.com)";
		const url = "https://example.com";

		// Target the second one
		const index2 = findLatestLinkIndex(content, url, 32);
		expect(index2).toBe(32);

		// Target the first one
		const index1 = findLatestLinkIndex(content, url, 0);
		expect(index1).toBe(0);
	});

	it("should correctly insert an archive link after original", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-17T00:00:00Z"));

		const result = applyLinkModification(
			"Read [Link](https://example.com) now.",
			"https://example.com",
			"https://web.archive.org/web/20260417000000/https://example.com",
			5,
			DEFAULT_SETTINGS,
			{ isReplacement: false },
		);

		expect(result).toEqual({
			content:
				"Read [Link](https://example.com) [(Archived on 2026-04-17)](https://web.archive.org/web/20260417000000/https://example.com) now.",
			modified: true,
			deltaLength:
				" [(Archived on 2026-04-17)](https://web.archive.org/web/20260417000000/https://example.com)"
					.length,
			newIndex: 5,
		});
	});

	it("applyLinkModification inserts after the latest link location when content shifted forward", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-17T00:00:00Z"));

		const latestContent = "# Added\n\nRead [Link](https://example.com) now.";

		const result = applyLinkModification(
			latestContent,
			"https://example.com",
			"https://web.archive.org/web/20260417000000/https://example.com",
			5, // old approximate index
			DEFAULT_SETTINGS,
			{ isReplacement: false },
		);

		expect(result.content).toBe(
			"# Added\n\nRead [Link](https://example.com) [(Archived on 2026-04-17)](https://web.archive.org/web/20260417000000/https://example.com) now.",
		);
	});

	it("should replace an adjacent archive link after the original", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-17T00:00:00Z"));

		const content =
			"Read [Link](https://example.com) [(Archived on 2026-04-10)](https://web.archive.org/web/20260410000000/https://example.com) now.";
		const oldArchiveStart = content.indexOf(" [(Archived on 2026-04-10)]");

		const result = applyLinkModification(
			content,
			"https://example.com",
			"https://web.archive.org/web/20260417000000/https://example.com",
			5,
			DEFAULT_SETTINGS,
			{ isReplacement: true },
		);

		expect(oldArchiveStart).toBe(32);
		expect(result.content).toBe(
			"Read [Link](https://example.com) [(Archived on 2026-04-17)](https://web.archive.org/web/20260417000000/https://example.com) now.",
		);
		expect(result.modified).toBe(true);
		expect(result.deltaLength).toBe(
			" [(Archived on 2026-04-17)](https://web.archive.org/web/20260417000000/https://example.com)"
				.length -
			" [(Archived on 2026-04-10)](https://web.archive.org/web/20260410000000/https://example.com)"
				.length,
		);
	});

	it("should replace the adjacent archive link found in latest content instead of using stale oldLinkEndIndex", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-17T00:00:00Z"));

		const latestContent =
			"Intro added. Read [Link](https://example.com) [(Archived on 2026-04-10)](https://web.archive.org/web/20260410000000/https://example.com) now.";

		const result = applyLinkModification(
			latestContent,
			"https://example.com",
			"https://web.archive.org/web/20260417000000/https://example.com",
			5,
			DEFAULT_SETTINGS,
			{ isReplacement: true },
		);

		expect(result.content).toBe(
			"Intro added. Read [Link](https://example.com) [(Archived on 2026-04-17)](https://web.archive.org/web/20260417000000/https://example.com) now.",
		);
		expect(result.content).toContain("Intro added.");
		expect(result.content).toContain(" now.");
		expect(result.modified).toBe(true);
	});

	it("should not treat a later non-adjacent archive link as the original link's adjacent archive", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-17T00:00:00Z"));

		const content =
			"[main](https://example.com) some text [other archive](https://archive.md/20260410000000/https://other.example)";

		const result = applyLinkModification(
			content,
			"https://example.com",
			"https://archive.md/20260417000000/https://example.com",
			0,
			DEFAULT_SETTINGS,
			{ isReplacement: true },
		);

		expect(result.content).toBe(
			"[main](https://example.com) [(Archived on 2026-04-17)](https://archive.md/20260417000000/https://example.com) some text [other archive](https://archive.md/20260410000000/https://other.example)",
		);
		expect(result.content).toContain(
			"some text [other archive](https://archive.md/20260410000000/https://other.example)",
		);
	});

	it("should not replace an adjacent archive link for a different target in normal mode", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-17T00:00:00Z"));

		const content =
			"[main](https://example.com) [(Archived on 2026-04-10)](https://archive.md/20260410000000/https://other.example)";

		const result = applyLinkModification(
			content,
			"https://example.com",
			"https://archive.md/20260417000000/https://example.com",
			0,
			DEFAULT_SETTINGS,
			{ isReplacement: true },
		);

		expect(result.content).toBe(
			"[main](https://example.com) [(Archived on 2026-04-17)](https://archive.md/20260417000000/https://example.com) [(Archived on 2026-04-10)](https://archive.md/20260410000000/https://other.example)",
		);

		vi.useRealTimers();
	});

	it("should replace an adjacent archive link for a different target in force mode", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-17T00:00:00Z"));

		const content =
			"[main](https://example.com) [(Archived on 2026-04-10)](https://archive.md/20260410000000/https://other.example)";

		const result = applyLinkModification(
			content,
			"https://example.com",
			"https://archive.md/20260417000000/https://example.com",
			0,
			DEFAULT_SETTINGS,
			{ isReplacement: true, allowMismatchedReplacement: true },
		);

		expect(result.content).toBe(
			"[main](https://example.com) [(Archived on 2026-04-17)](https://archive.md/20260417000000/https://example.com)",
		);

		vi.useRealTimers();
	});

	it("should leave content unchanged when the original link disappeared", () => {
		const result = applyLinkModification(
			"Read this note instead.",
			"https://example.com",
			"https://web.archive.org/web/20260417000000/https://example.com",
			5,
			DEFAULT_SETTINGS,
			{ isReplacement: false },
		);

		expect(result).toEqual({
			content: "Read this note instead.",
			modified: false,
			deltaLength: 0,
			newIndex: 5,
		});
	});

	describe("Index Shift Resilience (User-Edit Simulation)", () => {
		it("should find link after text is added at beginning", () => {
			// Simulates user adding a header while archiving is in progress
			const originalContent = "[Link](https://example.com) is here.";
			const editedContent = "# New Header\n\n" + originalContent;
			const url = "https://example.com";

			// Original index was 0, now shifted by 14 characters
			const index = findLatestLinkIndex(editedContent, url, 0);
			expect(index).toBe(14);
		});

		it("should find link after text is added in the middle (before target)", () => {
			const editedContent =
				"First [Link1](https://a.com) EXTRA TEXT and [Link2](https://b.com).";
			const url = "https://b.com";

			// Original index was 33, now shifted forward by 11 characters
			const index = findLatestLinkIndex(editedContent, url, 33);
			expect(index).toBe(44);
		});

		it("should find link after newlines are added", () => {
			const editedContent = "\n\n\n[Link](https://example.com)";
			const url = "https://example.com";
			const index = findLatestLinkIndex(editedContent, url, 0);
			expect(index).toBe(3);
		});

		it("should handle plain URLs with shift", () => {
			const editedContent = "Please visit https://example.com for info.";
			const url = "https://example.com";

			const index = findLatestLinkIndex(editedContent, url, 6);
			expect(index).toBe(13);
		});
	});

	describe("Partial Selection", () => {
		it("only returns links fully contained within the selection", () => {
			const content =
				"Before [first](https://first.example) middle https://second.example/path and [third](https://third.example) after";
			const fullySelectedStart = content.indexOf("[first]");
			const fullySelectedEnd = fullySelectedStart + "[first](https://first.example)".length;
			const partialUrlStart = content.indexOf("https://second.example/path") + 8;
			const partialUrlEnd = content.indexOf("https://second.example/path") + 22;
			const spanningStart = content.indexOf("[first]");
			const spanningEnd =
				content.indexOf("[third]") + "[third](https://third.example)".length;

			const fullySelected = selectFullyContainedLinkMatches(
				content,
				fullySelectedStart,
				fullySelectedEnd,
			);
			const partialSelection = selectFullyContainedLinkMatches(
				content,
				partialUrlStart,
				partialUrlEnd,
			);
			const emptySelection = selectFullyContainedLinkMatches(content, 10, 10);
			const spanningSelection = selectFullyContainedLinkMatches(
				content,
				spanningStart,
				spanningEnd,
			);

			expect(fullySelected.map((match) => match.url)).toEqual(["https://first.example"]);
			expect(partialSelection).toEqual([]);
			expect(emptySelection).toEqual([]);
			expect(spanningSelection.map((match) => match.url)).toEqual([
				"https://first.example",
				"https://second.example/path",
				"https://third.example",
			]);
		});
	});
});
