import { describe, expect, it } from "vitest";
import { summarizeArchiveWork, type ArchiveWorkItem } from "./vaultScan";

describe("summarizeArchiveWork", () => {
	it("counts affected notes, link occurrences, and unique URLs", () => {
		const items: ArchiveWorkItem[] = [
			{
				id: "a.md:0",
				filePath: "a.md",
				url: "https://one.example",
				approximateIndex: 0,
				isForce: false,
			},
			{
				id: "a.md:30",
				filePath: "a.md",
				url: "https://one.example",
				approximateIndex: 30,
				isForce: false,
			},
			{
				id: "b.md:0",
				filePath: "b.md",
				url: "https://two.example",
				approximateIndex: 0,
				isForce: false,
			},
		];

		expect(summarizeArchiveWork(items)).toMatchObject({
			noteCount: 2,
			linkCount: 3,
			uniqueUrlCount: 2,
		});
	});
});
