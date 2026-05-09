import { describe, it, expect } from "vitest";
import {
	appendFailedArchiveEntry,
	FAILED_ARCHIVE_DUPLICATE_WINDOW_MS,
	FailedArchiveEntry,
} from "./settings";

describe("appendFailedArchiveEntry", () => {
	it("adds a failed archive entry to an empty list", () => {
		const entry: FailedArchiveEntry = {
			url: "https://example.com",
			filePath: "notes/test.md",
			timestamp: 1000,
			error: "Some error",
			retryCount: 0,
			stage: "wayback-timeout",
		};
		const result = appendFailedArchiveEntry([], entry);
		expect(result).toEqual([entry]);
	});

	it("appends a non-duplicate entry", () => {
		const entry1: FailedArchiveEntry = {
			url: "https://example.com",
			filePath: "notes/test.md",
			timestamp: 1000,
			error: "Some error",
			retryCount: 0,
			stage: "wayback-timeout",
		};
		const entry2: FailedArchiveEntry = {
			url: "https://example.org",
			filePath: "notes/test.md",
			timestamp: 2000,
			error: "Another error",
			retryCount: 0,
			stage: "wayback-timeout",
		};
		const result = appendFailedArchiveEntry([entry1], entry2);
		expect(result).toEqual([entry1, entry2]);
	});

	it("coalesces a duplicate entry within the duplicate window", () => {
		const entry1: FailedArchiveEntry = {
			url: "https://example.com",
			filePath: "notes/test.md",
			timestamp: 1000,
			error: "First error",
			retryCount: 0,
			stage: "wayback-timeout",
		};
		const entry2: FailedArchiveEntry = {
			url: "https://example.com",
			filePath: "notes/test.md",
			timestamp: 1000 + FAILED_ARCHIVE_DUPLICATE_WINDOW_MS - 10,
			error: "Second error (coalesced)",
			retryCount: 1,
			stage: "wayback-timeout",
		};
		const result = appendFailedArchiveEntry([entry1], entry2);
		expect(result.length).toBe(1);
		expect(result[0]).toEqual({
			url: "https://example.com",
			filePath: "notes/test.md",
			timestamp: 1000 + FAILED_ARCHIVE_DUPLICATE_WINDOW_MS - 10,
			error: "Second error (coalesced)",
			retryCount: 1,
			stage: "wayback-timeout",
		});
	});

	it("does not coalesce duplicates beyond the duplicate window", () => {
		const entry1: FailedArchiveEntry = {
			url: "https://example.com",
			filePath: "notes/test.md",
			timestamp: 1000,
			error: "First error",
			retryCount: 0,
			stage: "wayback-timeout",
		};
		const entry2: FailedArchiveEntry = {
			url: "https://example.com",
			filePath: "notes/test.md",
			timestamp: 1000 + FAILED_ARCHIVE_DUPLICATE_WINDOW_MS + 10,
			error: "Second error",
			retryCount: 1,
			stage: "wayback-timeout",
		};
		const result = appendFailedArchiveEntry([entry1], entry2);
		expect(result).toEqual([entry1, entry2]);
	});

	it("keeps separate entries when targetUrl differs", () => {
		const entry1: FailedArchiveEntry = {
			url: "https://example.com",
			targetUrl: "https://target1.com",
			filePath: "notes/test.md",
			timestamp: 1000,
			error: "Error 1",
			retryCount: 0,
			stage: "wayback-timeout",
		};
		const entry2: FailedArchiveEntry = {
			url: "https://example.com",
			targetUrl: "https://target2.com",
			filePath: "notes/test.md",
			timestamp: 1500,
			error: "Error 2",
			retryCount: 0,
			stage: "wayback-timeout",
		};
		const result = appendFailedArchiveEntry([entry1], entry2);
		expect(result).toEqual([entry1, entry2]);
	});

	it("coalesces duplicate failures with latest failure fields while preserving manual metadata", () => {
		const existing: FailedArchiveEntry = {
			url: "https://example.com",
			targetUrl: "https://example.com",
			filePath: "notes/test.md",
			timestamp: 1000,
			error: "first error",
			retryCount: 1,
			stage: "fallback-not-found",
			manualProviderIds: ["archiveToday"],
			manualOpenedAt: 1500,
			manualOpenCount: 2,
		};

		const entry: FailedArchiveEntry = {
			url: "https://example.com",
			targetUrl: "https://example.com",
			filePath: "notes/test.md",
			timestamp: 2000,
			error: "latest error",
			retryCount: 0,
			stage: "fallback-not-found",
			manualProviderIds: ["megalodon"],
		};

		expect(appendFailedArchiveEntry([existing], entry, 5000)).toEqual([
			{
				url: "https://example.com",
				targetUrl: "https://example.com",
				filePath: "notes/test.md",
				timestamp: 2000,
				error: "latest error",
				retryCount: 0,
				stage: "fallback-not-found",
				manualProviderIds: ["archiveToday", "megalodon"],
				manualOpenedAt: 1500,
				manualOpenCount: 2,
			},
		]);
	});

	it("does not coalesce duplicate failures outside the duplicate window", () => {
		const existing: FailedArchiveEntry = {
			url: "https://example.com",
			targetUrl: "https://example.com",
			filePath: "notes/test.md",
			timestamp: 1000,
			error: "first error",
			retryCount: 0,
			stage: "fallback-not-found",
		};

		const entry: FailedArchiveEntry = {
			url: "https://example.com",
			targetUrl: "https://example.com",
			filePath: "notes/test.md",
			timestamp: 7000,
			error: "later error",
			retryCount: 0,
			stage: "fallback-not-found",
		};

		expect(appendFailedArchiveEntry([existing], entry, 5000)).toHaveLength(2);
	});
});
