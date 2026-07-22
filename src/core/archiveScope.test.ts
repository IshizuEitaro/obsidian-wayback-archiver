import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./settings";
import {
	areSameSourceUrl,
	collectUrlOccurrences,
	reconcileOccurrences,
} from "./archiveScope";

const settings = { ...DEFAULT_SETTINGS, archiveBareUrls: true };

describe("archive URL scope", () => {
	it("collects the same URL from markdown, images, HTML, and enabled bare URLs", () => {
		const content = [
			"[link](https://Example.com:443/a?q=1#x)",
			"![image](https://Example.com:443/a?q=1#x)",
			'<a href="https://Example.com:443/a?q=1#x">link</a>',
			'<img src="https://Example.com:443/a?q=1#x">',
			"https://Example.com:443/a?q=1#x",
		].join("\n");

		expect(
			collectUrlOccurrences(content, "https://example.com/a?q=1#x", settings),
		).toHaveLength(5);
	});

	it.each([
		"http://example.com/a?q=1#x",
		"https://example.com/a?q=2#x",
		"https://example.com/a?q=1#y",
	])("does not conflate a semantic URL difference: %s", (other) => {
		expect(areSameSourceUrl("https://example.com/a?q=1#x", other)).toBe(false);
	});

	it("honors the bare URL setting without excluding images", () => {
		const content = "![image](https://e.example)\nhttps://e.example";
		expect(
			collectUrlOccurrences(content, "https://e.example", {
				...settings,
				archiveBareUrls: false,
			}),
		).toHaveLength(1);
	});

	it("keeps only original occurrences after content changes", () => {
		const original = collectUrlOccurrences(
			"[a](https://e.example)\n[b](https://e.example)",
			"https://e.example",
			settings,
		);
		const latest =
			"prefix\n[a](https://e.example)\n[b](https://e.example)\n[new](https://e.example)";
		const resolved = reconcileOccurrences(original, latest, settings);

		expect(resolved).toHaveLength(2);
		expect(resolved.every((item) => item.matchText !== "[new](https://e.example)")).toBe(
			true,
		);
	});

	it("does not retarget a changed or deleted occurrence", () => {
		const original = collectUrlOccurrences(
			"[a](https://e.example)\n[b](https://e.example)",
			"https://e.example",
			settings,
		);
		const latest = "[a](https://changed.example)\n[new](https://e.example)";

		expect(reconcileOccurrences(original, latest, settings)).toEqual([]);
	});

	it("skips an ambiguous signature when an identical occurrence is added", () => {
		const original = collectUrlOccurrences(
			"[same](https://e.example)\n[same](https://e.example)",
			"https://e.example",
			settings,
		);
		const latest =
			"[same](https://e.example)\n[same](https://e.example)\n[same](https://e.example)";

		expect(reconcileOccurrences(original, latest, settings)).toEqual([]);
	});

	it("re-resolves moved occurrences by their original match text", () => {
		const original = collectUrlOccurrences(
			"[a](https://e.example)\n[b](https://e.example)",
			"https://e.example",
			settings,
		);
		const latest = "prefix\n[b](https://e.example)\n[a](https://e.example)";

		expect(
			reconcileOccurrences(original, latest, settings).map((item) => item.matchText),
		).toEqual(["[a](https://e.example)", "[b](https://e.example)"]);
	});
});
