import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { DEFAULT_SETTINGS, WaybackArchiverData } from "./settings";

const requestUrlMock = vi.fn();
const noticeMock = vi.fn();

vi.mock("obsidian", () => ({
	Modal: class Modal {
		contentEl = {
			createEl: vi.fn(() => ({ addEventListener: vi.fn(), focus: vi.fn(), value: "" })),
			createDiv: vi.fn(() => ({
				createEl: vi.fn(() => ({ addEventListener: vi.fn() })),
			})),
			empty: vi.fn(),
		};

		constructor(_app: unknown) {}

		open() {}

		close() {}
	},
	Notice: noticeMock,
	requestUrl: requestUrlMock,
	TFile: class TFile {},
}));

vi.mock("../main", () => ({
	default: class WaybackArchiverPlugin {},
}));

const { ArchiverService } = await import("./archiver");

describe("ArchiverService.archiveUrl", () => {
	const createService = (overrides: Partial<WaybackArchiverData> = {}) => {
		const data: WaybackArchiverData = {
			activeProfileId: "default",
			profiles: { default: DEFAULT_SETTINGS },
			failedArchives: [],
			spnAccessKey: "access",
			spnSecretKey: "secret",
			...overrides,
		};
		const plugin = {
			app: {},
			data,
			activeSettings: {
				...DEFAULT_SETTINGS,
				apiDelay: 0,
				maxRetries: 2,
				captureScreenshot: true,
				captureAll: true,
				jsBehaviorTimeout: 5000,
				forceGet: true,
				captureOutlinks: true,
				archiveFreshnessDays: 3,
			},
			saveSettings: vi.fn(),
		};

		return new ArchiverService(plugin as unknown as ConstructorParameters<typeof ArchiverService>[0]);
	};

	beforeEach(() => {
		requestUrlMock.mockReset();
		noticeMock.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns a configuration error without API keys and does not call the network", async () => {
		const service = createService({ spnAccessKey: "", spnSecretKey: "" });

		await expect(service.archiveUrl("https://example.com")).resolves.toEqual({
			status: "failed",
			status_ext: "Configuration Error",
		});
		expect(requestUrlMock).not.toHaveBeenCalled();
		expect(noticeMock).toHaveBeenCalledWith(
			"Error: Archive.org SPN API keys not configured in settings.",
		);
	});

	it("passes all SPN options through and returns a successful archive URL", async () => {
		requestUrlMock
			.mockResolvedValueOnce({ status: 200, json: { job_id: "job-1" } })
			.mockResolvedValueOnce({
				status: 200,
				json: {
					status: "success",
					timestamp: "20260417010203",
					original_url: "https://example.com",
				},
			});
		const service = createService();

		await expect(service.archiveUrl("https://example.com")).resolves.toEqual({
			status: "success",
			url: "https://web.archive.org/web/20260417010203/https://example.com",
		});

		const initRequest = requestUrlMock.mock.calls[0][0];
		expect(initRequest).toMatchObject({
			method: "POST",
			url: "https://web.archive.org/save",
			headers: {
				Authorization: "LOW access:secret",
			},
		});
		expect(Array.from(new URLSearchParams(initRequest.body).entries())).toEqual(
			expect.arrayContaining([
				["url", "https://example.com"],
				["capture_outlinks", "1"],
				["capture_screenshot", "1"],
				["force_get", "1"],
				["capture_all", "1"],
				["skip_first_archive", "1"],
				["js_behavior_timeout", "5000"],
				["if_not_archived_within", "259200s"],
			]),
		);
		expect(requestUrlMock.mock.calls[1][0]).toMatchObject({
			method: "GET",
			url: "https://web.archive.org/save/status/job-1",
		});
	});

	it("records a timeout when status checks never complete", async () => {
		requestUrlMock
			.mockResolvedValueOnce({ status: 200, json: { job_id: "job-1" } })
			.mockResolvedValue({ status: 200, json: { status: "pending" } });
		const service = createService();

		await expect(service.archiveUrl("https://example.com")).resolves.toEqual({
			status: "failed",
			status_ext: "Timeout",
		});
		expect(requestUrlMock).toHaveBeenCalledTimes(3);
	});

	it("uses the latest snapshot when capture is rate-limited", async () => {
		requestUrlMock
			.mockResolvedValueOnce({ status: 429, json: {} })
			.mockResolvedValueOnce({
				status: 200,
				json: [["timestamp"], ["20260416000000"]],
				text: '[["timestamp"],["20260416000000"]]',
			});
		const service = createService();

		await expect(service.archiveUrl("https://example.com")).resolves.toEqual({
			status: "too_many_captures",
			url: "https://web.archive.org/web/20260416000000/https://example.com",
		});
	});
});

describe("ArchiverService file processing", () => {
	const createFileService = (content: string, settings = DEFAULT_SETTINGS) => {
		let currentContent = content;
		const file = { path: "notes/example.md", basename: "example" };
		const data: WaybackArchiverData = {
			activeProfileId: "default",
			profiles: { default: settings },
			failedArchives: [],
			spnAccessKey: "access",
			spnSecretKey: "secret",
		};
		const plugin = {
			app: {
				vault: {
					read: vi.fn(async () => currentContent),
					process: vi.fn(async (_file: unknown, updater: (latest: string) => string) => {
						currentContent = updater(currentContent);
					}),
				},
			},
			data,
			activeSettings: { ...settings, apiDelay: 0 },
			saveSettings: vi.fn(),
		};
		const service = new ArchiverService(
			plugin as unknown as ConstructorParameters<typeof ArchiverService>[0],
		);
		const processFile = (
			counters = { archivedCount: 0, failedCount: 0, skippedCount: 0 },
			isForce = false,
		) =>
			(
				service as unknown as {
					processFileWithContext: typeof service["processFileWithContext"];
				}
			).processFileWithContext(file as never, isForce, counters);

		return {
			data,
			file,
			getContent: () => currentContent,
			plugin,
			processFile,
			service,
		};
	};

	it("archives an eligible markdown link and appends the configured archive link", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-17T00:00:00Z"));
		const setup = createFileService("Read [Docs](https://example.com).");
		vi.spyOn(setup.service, "archiveUrl").mockResolvedValue({
			status: "success",
			url: "https://web.archive.org/web/20260417000000/https://example.com",
		});
		const counters = { archivedCount: 0, failedCount: 0, skippedCount: 0 };

		await setup.processFile(counters);

		expect(setup.getContent()).toBe(
			"Read [Docs](https://example.com) [(Archived on 2026-04-17)](https://web.archive.org/web/20260417000000/https://example.com).",
		);
		expect(counters).toEqual({ archivedCount: 1, failedCount: 0, skippedCount: 0 });
	});

	it("leaves note content unchanged and records a failure when archiving fails", async () => {
		const setup = createFileService("Read https://example.com.");
		vi.spyOn(setup.service, "archiveUrl").mockResolvedValue({
			status: "failed",
			status_ext: "network error",
		});
		const counters = { archivedCount: 0, failedCount: 0, skippedCount: 0 };

		await setup.processFile(counters);

		expect(setup.getContent()).toBe("Read https://example.com.");
		expect(setup.data.failedArchives).toEqual([
			expect.objectContaining({
				url: "https://example.com",
				filePath: "notes/example.md",
				error: "Archiving failed (network error)",
				retryCount: 0,
			}),
		]);
		expect(counters).toEqual({ archivedCount: 0, failedCount: 1, skippedCount: 0 });
	});

	it("replaces an old adjacent archive link in standard mode", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-17T00:00:00Z"));
		const setup = createFileService(
			"Read https://example.com [(Archived on 2026-04-10)](https://web.archive.org/web/20260410000000/https://example.com).",
			{ ...DEFAULT_SETTINGS, archiveFreshnessDays: 2 },
		);
		vi.spyOn(setup.service, "archiveUrl").mockResolvedValue({
			status: "success",
			url: "https://web.archive.org/web/20260417000000/https://example.com",
		});

		await setup.processFile();

		expect(setup.getContent()).toBe(
			"Read https://example.com [(Archived on 2026-04-17)](https://web.archive.org/web/20260417000000/https://example.com).",
		);
	});

	it("does not replace a fresh adjacent archive link in standard mode", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-17T00:00:00Z"));
		const content =
			"Read https://example.com [(Archived on 2026-04-16)](https://web.archive.org/web/20260416000000/https://example.com).";
		const setup = createFileService(content, {
			...DEFAULT_SETTINGS,
			archiveFreshnessDays: 2,
		});
		vi.spyOn(setup.service, "archiveUrl").mockResolvedValue({
			status: "success",
			url: "https://web.archive.org/web/20260417000000/https://example.com",
		});

		await setup.processFile();

		expect(setup.getContent()).toBe(content);
	});

	it("standard archiving inserts a rate-limited latest snapshot only when no adjacent archive exists", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-17T00:00:00Z"));
		const withoutAdjacent = createFileService("Read https://example.com.");
		vi.spyOn(withoutAdjacent.service, "archiveUrl").mockResolvedValue({
			status: "too_many_captures",
			url: "https://web.archive.org/web/20260416000000/https://example.com",
		});

		await withoutAdjacent.processFile();

		expect(withoutAdjacent.getContent()).toBe(
			"Read https://example.com [(Archived on 2026-04-17)](https://web.archive.org/web/20260416000000/https://example.com).",
		);

		const contentWithAdjacent =
			"Read https://example.com [(Archived on 2026-04-10)](https://web.archive.org/web/20260410000000/https://example.com).";
		const withAdjacent = createFileService(contentWithAdjacent);
		vi.spyOn(withAdjacent.service, "archiveUrl").mockResolvedValue({
			status: "too_many_captures",
			url: "https://web.archive.org/web/20260416000000/https://example.com",
		});

		await withAdjacent.processFile();

		expect(withAdjacent.getContent()).toBe(contentWithAdjacent);
	});

	it("force re-archive replaces an existing adjacent archive link on success", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-17T00:00:00Z"));
		const setup = createFileService(
			"Read https://example.com [(Archived on 2026-04-16)](https://web.archive.org/web/20260416000000/https://example.com).",
			{ ...DEFAULT_SETTINGS, archiveFreshnessDays: 30 },
		);
		vi.spyOn(setup.service, "archiveUrl").mockResolvedValue({
			status: "success",
			url: "https://web.archive.org/web/20260417000000/https://example.com",
		});

		await setup.processFile(undefined, true);

		expect(setup.getContent()).toBe(
			"Read https://example.com [(Archived on 2026-04-17)](https://web.archive.org/web/20260417000000/https://example.com).",
		);
	});

	it("force re-archive inserts a new archive link when none exists", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-17T00:00:00Z"));
		const setup = createFileService("Read https://example.com.");
		vi.spyOn(setup.service, "archiveUrl").mockResolvedValue({
			status: "success",
			url: "https://web.archive.org/web/20260417000000/https://example.com",
		});

		await setup.processFile(undefined, true);

		expect(setup.getContent()).toBe(
			"Read https://example.com [(Archived on 2026-04-17)](https://web.archive.org/web/20260417000000/https://example.com).",
		);
	});

	it("force re-archive leaves the old archive link untouched when archiving fails", async () => {
		const content =
			"Read https://example.com [(Archived on 2026-04-16)](https://web.archive.org/web/20260416000000/https://example.com).";
		const setup = createFileService(content);
		vi.spyOn(setup.service, "archiveUrl").mockResolvedValue({
			status: "failed",
			status_ext: "network error",
		});

		await setup.processFile(undefined, true);

		expect(setup.getContent()).toBe(content);
	});

	it("force re-archive leaves the note unchanged when the new archive is rate-limited", async () => {
		const content =
			"Read https://example.com [(Archived on 2026-04-16)](https://web.archive.org/web/20260416000000/https://example.com).";
		const setup = createFileService(content);
		vi.spyOn(setup.service, "archiveUrl").mockResolvedValue({
			status: "too_many_captures",
			url: "https://web.archive.org/web/20260416000000/https://example.com",
		});

		await setup.processFile(undefined, true);

		expect(setup.getContent()).toBe(content);
	});
});
