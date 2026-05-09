import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
	DEFAULT_SETTINGS,
	PendingArchiveEntry,
	WaybackArchiverData,
	FailedArchiveEntry,
} from "./settings";
import { App, PluginManifest, Editor, MarkdownView, TFile } from "obsidian";
import WaybackArchiverPlugin from "../main";

import {
	serializeFailedArchiveEntriesToCsv,
	parseFailedArchiveEntriesFromCsv,
	FAILED_LOG_CSV_HEADERS,
} from "./failedArchiveLog";

const { noticeMock, requestUrlMock } = vi.hoisted(() => ({
	noticeMock: vi.fn(),
	requestUrlMock: vi.fn(),
}));

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
	Plugin: class Plugin {
		app: unknown;
		manifest: unknown;
		data: unknown;
		constructor(app: unknown, manifest: unknown) {
			this.app = app;
			this.manifest = manifest;
		}
		loadData() {
			return Promise.resolve(null);
		}
		saveData() {
			return Promise.resolve();
		}
	},
	PluginSettingTab: class PluginSettingTab {
		containerEl = { empty: vi.fn(), createEl: vi.fn() };
		constructor(_app: unknown, _plugin: unknown) {}
	},
	Setting: class Setting {
		constructor(_containerEl: unknown) {}
		setName() {
			return this;
		}
		setDesc() {
			return this;
		}
		addText() {
			return this;
		}
		addToggle() {
			return this;
		}
		addButton() {
			return this;
		}
		addDropdown() {
			return this;
		}
		setHeading() {
			return this;
		}
	},
	ButtonComponent: class ButtonComponent {},
	addIcon: vi.fn(),
	App: class App {},
}));

const { ArchiverService } = await import("./archiver");

const createFileService = (content: string, settings = DEFAULT_SETTINGS) => {
	let currentContent = content;
	const file = Object.assign(Object.create(TFile.prototype), {
		path: "notes/example.md",
		basename: "example",
	});
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
				getAbstractFileByPath: vi.fn(() => file),
				process: vi.fn(async (_file: unknown, updater: (latest: string) => string) => {
					currentContent = updater(currentContent);
				}),
				adapter: undefined as undefined | {
					write: ReturnType<typeof vi.fn>;
					remove: ReturnType<typeof vi.fn>;
				},
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
				processFileWithContext: (typeof service)["processFileWithContext"];
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

describe("ArchiverService.archiveUrl", () => {
	const createService = (
		overrides: Partial<WaybackArchiverData> = {},
		settingsOverrides: Record<string, unknown> = {},
	) => {
		const data: WaybackArchiverData = {
			activeProfileId: "default",
			profiles: { default: { ...DEFAULT_SETTINGS } },
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
				defaultArchiveProviders: ["wayback", "archiveToday", "megalodon"],
				archiveTodayExperimentalSubmit: false,
				archiveTodaySubmitDelayMs: 0,
				archiveTodayPendingPollIntervalMs: 0,
				archiveTodayPendingPollBatchSize: 3,
				archiveTodayPendingMaxWaitMs: 600000,
				archiveTodayMaxPendingCount: 30,
				...settingsOverrides,
			},
			saveSettings: vi.fn(),
		};

		return new ArchiverService(
			plugin as unknown as ConstructorParameters<typeof ArchiverService>[0],
		);
	};

	beforeEach(() => {
		requestUrlMock.mockReset();
		noticeMock.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns a configuration error without API keys and does not call the network", async () => {
		const service = createService(
			{ spnAccessKey: "", spnSecretKey: "" },
			{ defaultArchiveProviders: ["wayback"] },
		);

		await expect(service.archiveUrl("https://example.com")).resolves.toEqual({
			status: "failed",
			status_ext: "Configuration Error",
			stage: "wayback-initiation-failed",
			targetUrl: "https://example.com",
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

	it("records timeout as a fallback-aware workflow failure when no fallback snapshot exists", async () => {
		requestUrlMock
			.mockResolvedValueOnce({ status: 200, json: { job_id: "job-1" } })
			.mockResolvedValue({ status: 200, json: { status: "pending" } });
		const service = createService();

		await expect(service.archiveUrl("https://example.com")).resolves.toEqual({
			status: "failed",
			status_ext:
				"Fallback not found; manual save may help (after Wayback: Wayback job check timeout)",
			stage: "fallback-not-found",
			manualProviderIds: ["archiveToday", "megalodon"],
			targetUrl: "https://example.com",
		});
		expect(requestUrlMock).toHaveBeenCalledTimes(5);
	});

	it("falls back when Wayback status checks time out", async () => {
		requestUrlMock
			.mockResolvedValueOnce({ status: 200, json: { job_id: "job-1" } })
			.mockResolvedValueOnce({ status: 200, json: { status: "pending" } })
			.mockResolvedValueOnce({ status: 200, json: { status: "pending" } })
			.mockResolvedValueOnce({
				status: 200,
				url: "https://archive.md/20260505164448/https://example.com/",
				text: "",
			});
		const service = createService();

		await expect(service.archiveUrl("https://example.com/")).resolves.toEqual({
			status: "success",
			url: "https://archive.md/20260505164448/https://example.com/",
		});
	});

	it("uses the latest snapshot when capture is rate-limited", async () => {
		requestUrlMock.mockResolvedValueOnce({ status: 429, json: {} }).mockResolvedValueOnce({
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

	it("falls back to archive.today latest snapshot when Wayback capture fails", async () => {
		requestUrlMock.mockResolvedValueOnce({ status: 500, json: {} }).mockResolvedValueOnce({
			status: 200,
			url: "https://archive.md/20260505164448/https://test-target.com/",
			text: "",
		});
		const service = createService();

		await expect(service.archiveUrl("https://test-target.com/")).resolves.toEqual({
			status: "success",
			url: "https://archive.md/20260505164448/https://test-target.com/",
		});
		expect(requestUrlMock.mock.calls[1][0]).toMatchObject({
			method: "GET",
			url: "https://archive.md/latest/https%3A%2F%2Ftest-target.com%2F",
		});
	});

	it("falls back to Megalodon latest snapshot after archive.today has no snapshot", async () => {
		requestUrlMock
			.mockResolvedValueOnce({ status: 500, json: {} })
			.mockResolvedValueOnce({
				status: 200,
				url: "https://archive.md/latest/https%3A%2F%2Ftest-target.com%2F",
				text: "",
			})
			.mockResolvedValueOnce({
				status: 200,
				url: "https://megalodon.jp/2026-0507-0001-35/https://test-target.com:443/",
				text: "",
			});
		const service = createService();

		await expect(service.archiveUrl("https://test-target.com/")).resolves.toEqual({
			status: "success",
			url: "https://megalodon.jp/2026-0507-0001-35/https://test-target.com:443/",
		});
	});

	it("does not insert archive.today resolver URLs when no fixed snapshot exists", async () => {
		requestUrlMock
			.mockResolvedValueOnce({ status: 500, json: {} })
			.mockResolvedValueOnce({
				status: 200,
				headers: {},
				text: '<a href="https://archive.md/latest/https://example.com/">latest</a>',
			})
			.mockResolvedValueOnce({
				status: 200,
				headers: {},
				text: "No result",
			});
		const service = createService();

		await expect(service.archiveUrl("https://example.com/")).resolves.toEqual({
			status: "failed",
			status_ext:
				"Fallback not found; manual save may help (after Wayback: Initiation failed (500))",
			stage: "fallback-not-found",
			manualProviderIds: ["archiveToday", "megalodon"],
			targetUrl: "https://example.com/",
		});
	});

	it("can submit archive.today in the background when enabled before resolving fallbacks", async () => {
		requestUrlMock
			.mockResolvedValueOnce({ status: 500, json: {} })
			.mockResolvedValueOnce({ status: 200, text: "No snapshot html" })
			.mockResolvedValueOnce({ status: 200, text: "" });
		const service = createService({}, { archiveTodayExperimentalSubmit: true });

		await expect(service.archiveUrl("https://test-target.com/")).resolves.toEqual({
			status: "submitted",
			targetUrl: "https://test-target.com/",
			provider: "archiveToday",
		});

		expect(requestUrlMock.mock.calls[2][0]).toMatchObject({
			method: "GET",
			url: "https://archive.md/submit/?url=https%3A%2F%2Ftest-target.com%2F",
		});
		expect(service["plugin"].data.pendingArchives ?? []).toHaveLength(0);
	});

	it("keeps archive.today autosave disabled by default", async () => {
		requestUrlMock.mockResolvedValueOnce({ status: 500, json: {} }).mockResolvedValueOnce({
			status: 200,
			url: "https://archive.md/20260505164448/https://example.com/",
			text: "",
		});
		const service = createService();

		await service.archiveUrl("https://example.com/");

		expect(requestUrlMock.mock.calls.map((call) => call[0].url)).not.toContain(
			"https://archive.md/submit/?url=https%3A%2F%2Fexample.com%2F",
		);
	});

	it("archiveUrl returns submitted when archive.today experimental submit fires from archiveWithProviderPolicy", async () => {
		requestUrlMock
			.mockResolvedValueOnce({ status: 200, text: "No snapshot html" })
			.mockResolvedValueOnce({ status: 200, text: "" });
		const service = createService(
			{},
			{
				archivePolicies: [
					{
						pattern: "^https://x\\.com/",
						providers: ["archiveToday"],
						archiveTodayExperimentalSubmit: true,
					},
				],
			},
		);

		await expect(service.archiveUrl("https://x.com/example/status/1")).resolves.toEqual({
			status: "submitted",
			targetUrl: "https://x.com/example/status/1",
			provider: "archiveToday",
		});
		expect(requestUrlMock.mock.calls[1][0].url).toBe(
			"https://archive.md/submit/?url=https%3A%2F%2Fx.com%2Fexample%2Fstatus%2F1",
		);
		expect(requestUrlMock.mock.calls.map((call) => call[0].url)).not.toContain(
			"https://web.archive.org/save",
		);
		expect(service["plugin"].data.pendingArchives ?? []).toHaveLength(0);
	});

	it("archiveUrl returns failed when archive.today experimental submit-only request returns 429", async () => {
		requestUrlMock
			.mockResolvedValueOnce({ status: 200, text: "No snapshot html" })
			.mockResolvedValueOnce({ status: 429, text: "rate limited" });
		const service = createService(
			{},
			{
				archivePolicies: [
					{
						pattern: "^https://x\\.com/",
						providers: ["archiveToday"],
						archiveTodayExperimentalSubmit: true,
					},
				],
			},
		);
		const result = await service.archiveUrl("https://x.com/example/status/1");
		expect(result).toMatchObject({
			status: "failed",
			status_ext: "archive.today submit failed with HTTP 429",
			stage: "archive-today-autosave-failed",
			manualProviderIds: ["archiveToday"],
			targetUrl: "https://x.com/example/status/1",
		});
		expect(service["plugin"].data.pendingArchives ?? []).toHaveLength(0);
	});

	it("archiveUrl returns submitted without pending entry for Wayback fallback experimental submit because no note context is available", async () => {
		requestUrlMock
			.mockResolvedValueOnce({ status: 500, json: {} })
			.mockResolvedValueOnce({ status: 200, text: "No snapshot html" })
			.mockResolvedValueOnce({ status: 200, text: "" });
		const service = createService({}, { archiveTodayExperimentalSubmit: true });
		const result = await service.archiveUrl("https://test-target.com/");
		expect(result).toEqual({
			status: "submitted",
			targetUrl: "https://test-target.com/",
			provider: "archiveToday",
		});
		expect(service["plugin"].data.pendingArchives ?? []).toHaveLength(0);
	});

	it("archiveWithProviderPolicy does not create uninsertable pending entry", async () => {
		requestUrlMock.mockResolvedValueOnce({ status: 200, text: "" });
		const service = createService(
			{},
			{
				defaultArchiveProviders: ["archiveToday"],
				archiveTodayExperimentalSubmit: true,
			},
		);
		await service.archiveUrl("https://x.com/example/status/1");
		expect(service["plugin"].data.pendingArchives ?? []).toHaveLength(0);
	});

	it("archiveUrl returns failed when archive.today experimental submit-only request throws inside archiveWithProviderPolicy", async () => {
		requestUrlMock
			.mockResolvedValueOnce({ status: 200, text: "No snapshot html" })
			.mockRejectedValueOnce(new Error("submit error"));
		const service = createService(
			{},
			{
				archivePolicies: [
					{
						pattern: "^https://x\\.com/",
						providers: ["archiveToday"],
						archiveTodayExperimentalSubmit: true,
					},
				],
			},
		);
		const result = await service.archiveUrl("https://x.com/example/status/1");
		expect(result).toMatchObject({
			status: "failed",
			status_ext: "archive.today submit failed: submit error",
			stage: "archive-today-autosave-failed",
			manualProviderIds: ["archiveToday"],
			targetUrl: "https://x.com/example/status/1",
		});
	});

	it("classifies fallback provider rate limits as retry-later failures", async () => {
		requestUrlMock
			.mockResolvedValueOnce({ status: 500, json: {} })
			.mockResolvedValueOnce({ status: 429, headers: {}, text: "" })
			.mockResolvedValueOnce({ status: 503, headers: {}, text: "" });
		const service = createService();

		await expect(service.archiveUrl("https://example.com/")).resolves.toEqual({
			status: "failed",
			status_ext:
				"Fallback provider error/rate limit; retry later (after Wayback: Initiation failed (500))",
			stage: "fallback-provider-error",
			manualProviderIds: ["archiveToday", "megalodon"],
			targetUrl: "https://example.com/",
		});
	});
});

describe("archive.today pending queue", () => {
	const createPendingService = (
		initialContent: string,
		pendingArchives: PendingArchiveEntry[],
		settingsOverrides: Record<string, unknown> = {},
	) => {
		let currentContent = initialContent;
		const file = Object.assign(Object.create(TFile.prototype), {
			path: "notes/test.md",
			basename: "test",
		});
		const data: WaybackArchiverData = {
			activeProfileId: "default",
			profiles: { default: { ...DEFAULT_SETTINGS } },
			failedArchives: [],
			pendingArchives,
			spnAccessKey: "",
			spnSecretKey: "",
		};
		const plugin = {
			app: {
				vault: {
					read: vi.fn(async () => currentContent),
					getAbstractFileByPath: vi.fn(() => file),
					process: vi.fn(async (_file: unknown, updater: (latest: string) => string) => {
						currentContent = updater(currentContent);
					}),
				},
			},
			data,
			activeSettings: {
				...DEFAULT_SETTINGS,
				archiveTodaySubmitDelayMs: 0,
				archiveTodayPendingPollIntervalMs: 60000,
				archiveTodayPendingPollBatchSize: 3,
				archiveTodayPendingMaxWaitMs: 600000,
				archiveTodayMaxPendingCount: 30,
				apiDelay: 0,
				...settingsOverrides,
			},
			saveSettings: vi.fn(),
			setStatusBarText: vi.fn(),
		};
		const service = new ArchiverService(
			plugin as unknown as ConstructorParameters<typeof ArchiverService>[0],
		);
		return { data, getContent: () => currentContent, plugin, service };
	};

	beforeEach(() => {
		requestUrlMock.mockReset();
		noticeMock.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("submitArchiveTodayUrl enqueues a PendingArchiveEntry on successful submit and returns status: queued", async () => {
		requestUrlMock.mockResolvedValueOnce({ status: 200, text: "" });
		const { service } = createPendingService("", [], { archiveTodayExperimentalSubmit: true });
		const result = await (
			service as unknown as {
				submitArchiveTodayUrl: (
					url: string,
					targetUrl: string,
					filePath: string,
					approximateIndex?: number,
				) => Promise<{ status: string }>;
			}
		).submitArchiveTodayUrl(
			"https://x.com/example/status/1",
			"https://x.com/example/status/1",
			"notes/test.md",
			42,
		);
		expect(result.status).toBe("queued");
		expect(service["plugin"].data.pendingArchives).toHaveLength(1);
		expect(service["plugin"].data.pendingArchives![0]).toMatchObject({
			providerId: "archiveToday",
			url: "https://x.com/example/status/1",
			targetUrl: "https://x.com/example/status/1",
			filePath: "notes/test.md",
			approximateIndex: 42,
			checkCount: 0,
			status: "submitted",
		});
		expect(typeof service["plugin"].data.pendingArchives![0].id).toBe("string");
		expect(typeof service["plugin"].data.pendingArchives![0].createdAt).toBe("number");
		expect(service["plugin"].saveSettings).toHaveBeenCalled();
	});

	it("submitArchiveTodayUrl logs to failedArchives and returns status: failed when submit throws", async () => {
		requestUrlMock.mockRejectedValueOnce(new Error("network"));
		const { service } = createPendingService("", [], { archiveTodayExperimentalSubmit: true });
		const result = await (
			service as unknown as {
				submitArchiveTodayUrl: (
					url: string,
					targetUrl: string,
					filePath: string,
				) => Promise<{ status: string }>;
			}
		).submitArchiveTodayUrl(
			"https://x.com/example/status/1",
			"https://x.com/example/status/1",
			"notes/test.md",
		);
		expect(result.status).toBe("failed");
		expect(service["plugin"].data.pendingArchives ?? []).toHaveLength(0);
		expect(service["plugin"].data.failedArchives).toHaveLength(1);
		expect(service["plugin"].data.failedArchives![0]).toMatchObject({
			url: "https://x.com/example/status/1",
			stage: "archive-today-autosave-failed",
			manualProviderIds: ["archiveToday"],
		});
		expect(service["plugin"].saveSettings).toHaveBeenCalled();
	});

	it("submitArchiveTodayUrl logs to failedArchives and returns status: failed when submit returns 500", async () => {
		requestUrlMock.mockResolvedValueOnce({ status: 500, text: "server error" });
		const { service } = createPendingService("", [], { archiveTodayExperimentalSubmit: true });
		const result = await (
			service as unknown as {
				submitArchiveTodayUrl: (
					url: string,
					targetUrl: string,
					filePath: string,
				) => Promise<{ status: string }>;
			}
		).submitArchiveTodayUrl("https://x.com/1", "https://x.com/1", "notes/test.md");
		expect(result.status).toBe("failed");
		expect(service["plugin"].data.pendingArchives ?? []).toHaveLength(0);
		expect(service["plugin"].data.failedArchives![0]).toMatchObject({
			url: "https://x.com/1",
			stage: "archive-today-autosave-failed",
			error: "archive.today submit failed with HTTP 500",
		});
	});

	it("submitArchiveTodayUrl does not enqueue duplicate and returns status: duplicate", async () => {
		requestUrlMock.mockResolvedValue({ status: 200, text: "" });
		const { service } = createPendingService("", [], { archiveTodayExperimentalSubmit: true });
		const fn = (
			service as unknown as {
				submitArchiveTodayUrl: (
					url: string,
					targetUrl: string,
					filePath: string,
					approximateIndex?: number,
				) => Promise<{ status: string }>;
			}
		).submitArchiveTodayUrl.bind(service);
		const r1 = await fn("https://x.com/1", "https://x.com/1", "notes/test.md", 10);
		const r2 = await fn("https://x.com/1", "https://x.com/1", "notes/test.md", 10);
		expect(r1.status).toBe("queued");
		expect(r2.status).toBe("duplicate");
		expect(service["plugin"].data.pendingArchives).toHaveLength(1);
	});

	it("submitArchiveTodayUrl enqueues different occurrences of same URL but bypasses redundant requestUrl submission", async () => {
		requestUrlMock.mockResolvedValueOnce({ status: 200, text: "" });
		const { service } = createPendingService("", [], { archiveTodayExperimentalSubmit: true });
		const fn = (
			service as unknown as {
				submitArchiveTodayUrl: (
					url: string,
					targetUrl: string,
					filePath: string,
					approximateIndex?: number,
				) => Promise<{ status: string }>;
			}
		).submitArchiveTodayUrl.bind(service);
		const r1 = await fn("https://x.com/1", "https://x.com/1", "notes/test.md", 10);
		const r2 = await fn("https://x.com/1", "https://x.com/1", "notes/test.md", 50);
		expect(r1.status).toBe("queued");
		expect(r2.status).toBe("queued");
		expect(service["plugin"].data.pendingArchives).toHaveLength(2);
		expect(requestUrlMock).toHaveBeenCalledTimes(1);
	});

	it("submitArchiveTodayUrl does not enqueue and returns status: queue_full when at maxPendingCount", async () => {
		const existing: PendingArchiveEntry[] = Array.from({ length: 3 }, (_, i) => ({
			id: `id-${i}`,
			providerId: "archiveToday",
			url: `https://example.com/${i}`,
			targetUrl: `https://example.com/${i}`,
			filePath: "notes/test.md",
			checkCount: 0,
			createdAt: Date.now(),
			maxWaitMs: 600000,
			status: "submitted",
		}));
		const { service } = createPendingService("", existing, { archiveTodayMaxPendingCount: 3 });
		const result = await (
			service as unknown as {
				submitArchiveTodayUrl: (
					url: string,
					targetUrl: string,
					filePath: string,
				) => Promise<{ status: string }>;
			}
		).submitArchiveTodayUrl("https://new.com/", "https://new.com/", "notes/test.md");
		expect(result.status).toBe("queue_full");
		expect(service["plugin"].data.pendingArchives).toHaveLength(3);
		expect(noticeMock).toHaveBeenCalledWith(
			'archive.today pending queue is full (3 entries). Wait for pending snapshots to resolve, run "Check pending archive.today snapshots now", or reduce the number of links.',
		);
	});

	it("runPendingQueueCycle inserts archive link when resolver returns a snapshot", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-09T00:00:00Z"));
		const entry: PendingArchiveEntry = {
			id: "test-id-1",
			providerId: "archiveToday",
			url: "https://example.com",
			targetUrl: "https://example.com",
			filePath: "notes/test.md",
			approximateIndex: 5,
			createdAt: Date.now(),
			checkCount: 0,
			maxWaitMs: 600000,
			status: "submitted",
		};
		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			url: "https://archive.md/20260509000000/https://example.com",
			text: "",
		});
		const { data, getContent, service } = createPendingService(
			"See [Example](https://example.com).",
			[entry],
		);
		await (
			service as unknown as { runPendingQueueCycle: () => Promise<void> }
		).runPendingQueueCycle();
		expect(data.pendingArchives).toHaveLength(0);
		expect(getContent()).toContain("archive.md/20260509000000");
		expect(service["plugin"].saveSettings).toHaveBeenCalled();
	});

	it("runPendingQueueCycle moves expired entry to failedArchives", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-09T00:00:00Z"));
		const entry: PendingArchiveEntry = {
			id: "test-id-2",
			providerId: "archiveToday",
			url: "https://example.com",
			targetUrl: "https://example.com",
			filePath: "notes/test.md",
			createdAt: Date.now() - 700000,
			checkCount: 5,
			maxWaitMs: 600000,
			status: "submitted",
		};
		const { data, service } = createPendingService("See [Example](https://example.com).", [
			entry,
		]);
		await (
			service as unknown as { runPendingQueueCycle: () => Promise<void> }
		).runPendingQueueCycle();
		expect(data.pendingArchives).toHaveLength(0);
		expect(data.failedArchives).toHaveLength(1);
		expect(data.failedArchives![0]).toMatchObject({
			url: "https://example.com",
			filePath: "notes/test.md",
			stage: "archive-today-pending-timeout",
			manualProviderIds: ["archiveToday"],
		});
		expect(service["plugin"].saveSettings).toHaveBeenCalled();
	});

	it("runPendingQueueCycle persists expired failures before resolving remaining candidates", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-09T00:00:00Z"));
		const expiredEntry: PendingArchiveEntry = {
			id: "expired",
			providerId: "archiveToday",
			url: "https://expired.example",
			targetUrl: "https://expired.example",
			filePath: "notes/test.md",
			createdAt: Date.now() - 700000,
			checkCount: 5,
			maxWaitMs: 600000,
			status: "submitted",
		};
		const liveEntry: PendingArchiveEntry = {
			id: "live",
			providerId: "archiveToday",
			url: "https://live.example",
			targetUrl: "https://live.example",
			filePath: "notes/test.md",
			createdAt: Date.now(),
			checkCount: 0,
			maxWaitMs: 600000,
			status: "submitted",
		};
		const events: string[] = [];
		requestUrlMock.mockImplementationOnce(() => {
			events.push("resolve-live");
			throw new Error("resolver failure");
		});
		const { data, plugin, service } = createPendingService("See https://live.example.", [
			expiredEntry,
			liveEntry,
		]);
		plugin.saveSettings = vi.fn(async () => {
			events.push(
				`save:${data.failedArchives?.length ?? 0}:${data.pendingArchives?.length ?? 0}`,
			);
		});

		await (
			service as unknown as { runPendingQueueCycle: () => Promise<void> }
		).runPendingQueueCycle();

		expect(events[0]).toBe("save:1:1");
		expect(events[1]).toBe("resolve-live");
		expect(data.failedArchives).toHaveLength(1);
		expect(data.failedArchives![0].url).toBe("https://expired.example");
	});

	it("runPendingQueueCycle keeps entry pending on retryable resolver error", async () => {
		const entry: PendingArchiveEntry = {
			id: "test-id-3",
			providerId: "archiveToday",
			url: "https://example.com",
			targetUrl: "https://example.com",
			filePath: "notes/test.md",
			createdAt: Date.now(),
			checkCount: 0,
			maxWaitMs: 600000,
			status: "submitted",
		};
		requestUrlMock.mockRejectedValueOnce(new Error("network error"));
		const { data, service } = createPendingService("See [Example](https://example.com).", [
			entry,
		]);
		await (
			service as unknown as { runPendingQueueCycle: () => Promise<void> }
		).runPendingQueueCycle();
		expect(data.pendingArchives).toHaveLength(1);
		expect(data.pendingArchives![0].checkCount).toBe(1);
		expect(data.pendingArchives![0].status).toBe("submitted");
		expect(service["plugin"].saveSettings).toHaveBeenCalled();
	});

	it("runPendingQueueCycle recovers stale checking entries from persisted data", async () => {
		const entry: PendingArchiveEntry = {
			id: "stale-checking",
			providerId: "archiveToday",
			url: "https://example.com",
			targetUrl: "https://example.com",
			filePath: "notes/test.md",
			createdAt: Date.now(),
			checkCount: 0,
			maxWaitMs: 600000,
			status: "checking",
		} as unknown as PendingArchiveEntry;
		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			url: "https://archive.md/20260509000000/https://example.com",
			text: "",
		});
		const { data, service } = createPendingService("See https://example.com.", [entry]);
		await (
			service as unknown as { runPendingQueueCycle: () => Promise<void> }
		).runPendingQueueCycle();
		expect(data.pendingArchives).toHaveLength(0);
	});

	it("runPendingQueueCycle respects pollBatchSize", async () => {
		const entries: PendingArchiveEntry[] = Array.from({ length: 5 }, (_, i) => ({
			id: `id-${i}`,
			providerId: "archiveToday",
			url: `https://example.com/${i}`,
			targetUrl: `https://example.com/${i}`,
			filePath: "notes/test.md",
			createdAt: Date.now(),
			checkCount: 0,
			maxWaitMs: 600000,
			status: "submitted",
		}));
		requestUrlMock.mockResolvedValue({ status: 200, headers: {}, text: "no match" });
		const { service } = createPendingService("dummy content", entries, {
			archiveTodayPendingPollBatchSize: 2,
		});
		await (
			service as unknown as { runPendingQueueCycle: () => Promise<void> }
		).runPendingQueueCycle();
		expect(requestUrlMock).toHaveBeenCalledTimes(2);
	});

	it("runPendingQueueCycle is re-entrant-safe: second call returns early if first is in progress", async () => {
		let resolveFirst!: () => void;
		const firstResolved = new Promise<void>((resolve) => {
			resolveFirst = resolve;
		});
		requestUrlMock.mockImplementationOnce(() =>
			firstResolved.then(() => ({
				status: 200,
				url: "https://archive.md/snap/https://example.com",
				text: "",
			})),
		);
		const entry: PendingArchiveEntry = {
			id: "mutex-test",
			providerId: "archiveToday",
			url: "https://example.com",
			targetUrl: "https://example.com",
			filePath: "notes/test.md",
			createdAt: Date.now(),
			checkCount: 0,
			maxWaitMs: 600000,
			status: "submitted",
		};
		const { service } = createPendingService("See [Ex](https://example.com).", [entry]);
		const svc = service as unknown as { runPendingQueueCycle: () => Promise<void> };
		const first = svc.runPendingQueueCycle();
		const second = svc.runPendingQueueCycle();
		await second;
		resolveFirst();
		await first;
		expect(requestUrlMock).toHaveBeenCalledTimes(1);
	});

	it("runPendingQueueCycle: one candidate throwing does not stop batch", async () => {
		const entryA: PendingArchiveEntry = {
			id: "err-a",
			providerId: "archiveToday",
			url: "https://a.com",
			targetUrl: "https://a.com",
			filePath: "notes/test.md",
			createdAt: Date.now(),
			checkCount: 0,
			maxWaitMs: 600000,
			status: "submitted",
		};
		const entryB: PendingArchiveEntry = {
			id: "ok-b",
			providerId: "archiveToday",
			url: "https://b.com",
			targetUrl: "https://b.com",
			filePath: "notes/test.md",
			createdAt: Date.now(),
			checkCount: 0,
			maxWaitMs: 600000,
			status: "submitted",
		};
		requestUrlMock.mockRejectedValueOnce(new Error("network error")).mockResolvedValueOnce({
			status: 200,
			url: "https://archive.md/20260509000000/https://b.com",
			text: "",
		});
		const { data, getContent, service } = createPendingService(
			"See [A](https://a.com) and [B](https://b.com).",
			[entryA, entryB],
			{ archiveTodayPendingPollBatchSize: 2 },
		);
		await (
			service as unknown as { runPendingQueueCycle: () => Promise<void> }
		).runPendingQueueCycle();
		expect(data.pendingArchives).toHaveLength(1);
		expect(data.pendingArchives![0].id).toBe("err-a");
		expect(getContent()).toContain("archive.md/20260509000000/https://b.com");
	});

	it("runPendingQueueCycle does not double-insert if archive link already present", async () => {
		const entry: PendingArchiveEntry = {
			id: "dup-ins",
			providerId: "archiveToday",
			url: "https://example.com",
			targetUrl: "https://example.com",
			filePath: "notes/test.md",
			createdAt: Date.now(),
			checkCount: 0,
			maxWaitMs: 600000,
			status: "submitted",
		};
		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			url: "https://archive.md/20260509000000/https://example.com",
			text: "",
		});
		const { data, service } = createPendingService(
			"See [Ex](https://example.com) [archived](https://archive.md/20260509000000/https://example.com).",
			[entry],
		);
		await (
			service as unknown as { runPendingQueueCycle: () => Promise<void> }
		).runPendingQueueCycle();
		expect(data.pendingArchives).toHaveLength(0);
	});

	it("runPendingQueueCycle removes entry when original URL is gone from file", async () => {
		const entry: PendingArchiveEntry = {
			id: "test-id-5",
			providerId: "archiveToday",
			url: "https://example.com",
			targetUrl: "https://example.com",
			filePath: "notes/test.md",
			createdAt: Date.now(),
			checkCount: 0,
			maxWaitMs: 600000,
			status: "submitted",
		};
		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			url: "https://archive.md/20260509000000/https://example.com",
			text: "",
		});
		const { data, service } = createPendingService("This note has no links.", [entry]);
		await (
			service as unknown as { runPendingQueueCycle: () => Promise<void> }
		).runPendingQueueCycle();
		expect(data.pendingArchives).toHaveLength(0);
	});

	it("runPendingQueueCycle removes entry when target file no longer exists", async () => {
		const entry: PendingArchiveEntry = {
			id: "missing-file",
			providerId: "archiveToday",
			url: "https://example.com",
			targetUrl: "https://example.com",
			filePath: "notes/deleted.md",
			createdAt: Date.now(),
			checkCount: 0,
			maxWaitMs: 600000,
			status: "submitted",
		};

		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			url: "https://archive.md/20260509000000/https://example.com",
			text: "",
		});

		const { data, plugin, service } = createPendingService("See https://example.com.", [entry]);
		plugin.app.vault.getAbstractFileByPath = vi.fn(() => null);

		await (
			service as unknown as { runPendingQueueCycle: () => Promise<void> }
		).runPendingQueueCycle();

		expect(data.pendingArchives).toHaveLength(0);
	});

	it("resolveProviderSnapshot normalizes archive.today mirror response URLs", async () => {
		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			url: "https://archive.ph/20260509000000/https://example.com",
			text: "",
		});
		const { service } = createPendingService("", []);
		const result = await (
			service as unknown as {
				resolveProviderSnapshot: (
					providerId: "archiveToday",
					targetUrl: string,
				) => Promise<{ url: string | null }>;
			}
		).resolveProviderSnapshot("archiveToday", "https://example.com");
		expect(result.url).toBe("https://archive.md/20260509000000/https://example.com");
	});

	it("runPendingQueueCycle skips entries checked more recently than poll interval", async () => {
		const now = new Date("2026-05-09T00:00:00Z").getTime();
		vi.useFakeTimers();
		vi.setSystemTime(now);

		const entry: PendingArchiveEntry = {
			id: "recent",
			providerId: "archiveToday",
			url: "https://example.com",
			targetUrl: "https://example.com",
			filePath: "notes/test.md",
			createdAt: now - 1000,
			lastCheckedAt: now - 1000,
			checkCount: 1,
			maxWaitMs: 600000,
			status: "submitted",
		};

		const { data, service } = createPendingService("See https://example.com.", [entry], {
			archiveTodayPendingPollIntervalMs: 60000,
		});

		await (
			service as unknown as { runPendingQueueCycle: () => Promise<void> }
		).runPendingQueueCycle();

		expect(requestUrlMock).not.toHaveBeenCalled();
		expect(data.pendingArchives).toHaveLength(1);
		expect(data.pendingArchives![0].checkCount).toBe(1);
	});

	it("resolveProviderSnapshot extracts archive.today mirror URL from HTML text", async () => {
		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			headers: {},
			text: '<a href="https://archive.is/20260509000000/https://example.com">snapshot</a>',
		});
		const { service } = createPendingService("", []);
		const result = await (
			service as unknown as {
				resolveProviderSnapshot: (
					providerId: "archiveToday",
					targetUrl: string,
				) => Promise<{ url: string | null }>;
			}
		).resolveProviderSnapshot("archiveToday", "https://example.com");
		expect(result.url).toBe("https://archive.md/20260509000000/https://example.com");
	});

	it("resolveProviderSnapshot extracts protocol-relative archive.today URLs from HTML text", async () => {
		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			headers: {},
			text: '<a href="//archive.md/20260509000000/https://example.com">snapshot</a>',
		});
		const { service } = createPendingService("", []);
		const result = await (
			service as unknown as {
				resolveProviderSnapshot: (
					providerId: "archiveToday",
					targetUrl: string,
				) => Promise<{ url: string | null }>;
			}
		).resolveProviderSnapshot("archiveToday", "https://example.com");
		expect(result.url).toBe("https://archive.md/20260509000000/https://example.com");
	});

	it("resolveProviderSnapshot extracts relative archive.today snapshot paths from HTML text", async () => {
		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			headers: {},
			text: '<a href="/20260509000000/https://example.com">snapshot</a>',
		});
		const { service } = createPendingService("", []);
		const result = await (
			service as unknown as {
				resolveProviderSnapshot: (
					providerId: "archiveToday",
					targetUrl: string,
				) => Promise<{ url: string | null }>;
			}
		).resolveProviderSnapshot("archiveToday", "https://example.com");
		expect(result.url).toBe("https://archive.md/20260509000000/https://example.com");
	});

	it("resolveProviderSnapshot decodes HTML entities in extracted archive.today URLs", async () => {
		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			headers: {},
			text: '<a href="https://archive.md/20260509000000/https://example.com?a=1&amp;b=2">snapshot</a>',
		});
		const { service } = createPendingService("", []);
		const result = await (
			service as unknown as {
				resolveProviderSnapshot: (
					providerId: "archiveToday",
					targetUrl: string,
				) => Promise<{ url: string | null }>;
			}
		).resolveProviderSnapshot("archiveToday", "https://example.com?a=1&b=2");
		expect(result.url).toBe("https://archive.md/20260509000000/https://example.com?a=1&b=2");
	});

	it("resolveProviderSnapshot does not return unrelated archive.today snapshot URLs", async () => {
		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			headers: {},
			text: '<a href="https://archive.md/20260509000000/https://unrelated.com">snapshot</a>',
		});

		const { service } = createPendingService("", []);
		const result = await (
			service as unknown as {
				resolveProviderSnapshot: (
					providerId: "archiveToday",
					targetUrl: string,
				) => Promise<{ url: string | null }>;
			}
		).resolveProviderSnapshot("archiveToday", "https://example.com");

		expect(result.url).toBeNull();
	});
});

describe("ArchiverService file processing", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

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

	it("records workflow metadata for fallback failures", async () => {
		const setup = createFileService("Read https://x.com/example/status/1.");
		vi.spyOn(setup.service, "archiveUrl").mockResolvedValue({
			status: "failed",
			status_ext:
				"archive.today autosave submitted, but no snapshot was resolved before timeout",
			stage: "archive-today-autosave-timeout",
			manualProviderIds: ["archiveToday"],
		});

		await setup.processFile();

		expect(setup.data.failedArchives).toEqual([
			expect.objectContaining({
				url: "https://x.com/example/status/1",
				stage: "archive-today-autosave-timeout",
				manualProviderIds: ["archiveToday"],
				retryCount: 0,
			}),
		]);
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

describe("ArchiverService manual fallback saves", () => {
	beforeEach(() => {
		noticeMock.mockReset();
		vi.stubGlobal("open", vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const createManualSaveService = () => {
		const data: WaybackArchiverData = {
			activeProfileId: "default",
			profiles: { default: { ...DEFAULT_SETTINGS } },
			failedArchives: [
				{
					url: "https://a.example/",
					filePath: "a.md",
					timestamp: 1,
					error: "x",
					retryCount: 0,
				},
				{
					url: "https://b.example/",
					filePath: "b.md",
					timestamp: 2,
					error: "x",
					retryCount: 0,
				},
				{
					url: "https://c.example/",
					filePath: "c.md",
					timestamp: 3,
					error: "x",
					retryCount: 0,
				},
			],
			spnAccessKey: "access",
			spnSecretKey: "secret",
		};
		const plugin = {
			app: {},
			data,
			activeSettings: {
				...DEFAULT_SETTINGS,
				manualSaveBatchSize: 2,
				defaultArchiveProviders: ["wayback", "archiveToday", "megalodon"],
			},
			saveSettings: vi.fn(),
		};
		return new ArchiverService(
			plugin as unknown as ConstructorParameters<typeof ArchiverService>[0],
		);
	};

	it("opens only the next configured batch of archive.today save pages", () => {
		const service = createManualSaveService();

		service.openManualSavePagesForFailedArchives("archiveToday");

		expect(globalThis.open).toHaveBeenCalledTimes(2);
		expect(globalThis.open).toHaveBeenNthCalledWith(
			1,
			"https://archive.md/submit/?url=https%3A%2F%2Fa.example%2F",
			"_blank",
			"noopener",
		);
		expect(globalThis.open).toHaveBeenNthCalledWith(
			2,
			"https://archive.md/submit/?url=https%3A%2F%2Fb.example%2F",
			"_blank",
			"noopener",
		);
	});

	it("keeps manual-opened entries in the queue and prioritizes unopened provider-compatible entries", () => {
		const data: WaybackArchiverData = {
			activeProfileId: "default",
			profiles: { default: { ...DEFAULT_SETTINGS } },
			failedArchives: [
				{
					url: "https://already.example/",
					filePath: "already.md",
					timestamp: 1,
					error: "x",
					retryCount: 0,
					manualProviderIds: ["archiveToday"],
					manualOpenedAt: 10,
					manualOpenCount: 1,
				},
				{
					url: "https://unsupported.example/",
					filePath: "unsupported.md",
					timestamp: 2,
					error: "x",
					retryCount: 0,
					manualProviderIds: ["megalodon"],
				},
				{
					url: "https://fresh.example/",
					filePath: "fresh.md",
					timestamp: 3,
					error: "x",
					retryCount: 0,
					manualProviderIds: ["archiveToday"],
				},
			],
			spnAccessKey: "access",
			spnSecretKey: "secret",
		};
		const plugin = {
			app: {},
			data,
			activeSettings: { ...DEFAULT_SETTINGS, manualSaveBatchSize: 1 },
			saveSettings: vi.fn(),
		};
		const service = new ArchiverService(
			plugin as unknown as ConstructorParameters<typeof ArchiverService>[0],
		);

		service.openManualSavePagesForFailedArchives("archiveToday");

		expect(globalThis.open).toHaveBeenCalledTimes(1);
		expect(globalThis.open).toHaveBeenCalledWith(
			"https://archive.md/submit/?url=https%3A%2F%2Ffresh.example%2F",
			"_blank",
			"noopener",
		);
		expect(data.failedArchives?.[2]).toEqual(
			expect.objectContaining({
				manualOpenedAt: expect.any(Number),
				manualOpenCount: 1,
			}),
		);
		expect(data.failedArchives).toHaveLength(3);
		expect(plugin.saveSettings).toHaveBeenCalled();
	});

	it("opens Megalodon manual save pages with encoding the original URL path", () => {
		const service = createManualSaveService();

		service.openManualSavePagesForFailedArchives("megalodon");

		expect(globalThis.open).toHaveBeenNthCalledWith(
			1,
			"https://gyo.tc/https%3A%2F%2Fa.example%2F",
			"_blank",
			"noopener",
		);
	});
});

describe("Wayback Archiver Enhancements TDD", () => {
	beforeEach(() => {
		vi.stubGlobal("open", vi.fn());
		requestUrlMock.mockReset();
		noticeMock.mockReset();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	const createEnhancementService = (
		overrides: Partial<WaybackArchiverData> = {},
		settingsOverrides: Record<string, unknown> = {},
	) => {
		const data: WaybackArchiverData = {
			activeProfileId: "default",
			profiles: { default: { ...DEFAULT_SETTINGS } },
			failedArchives: [],
			spnAccessKey: "access",
			spnSecretKey: "secret",
			...overrides,
		};
		const plugin = {
			app: {
				vault: {
					adapter: {
						exists: vi.fn().mockResolvedValue(true),
						list: vi
							.fn()
							.mockResolvedValue({ files: ["wayback-archiver-failed-log-123.csv"] }),
						read: vi.fn(),
						write: vi.fn(),
						remove: vi.fn(),
					},
					process: vi.fn(),
					getAbstractFileByPath: vi.fn(),
				},
			},
			data,
			activeSettings: {
				...DEFAULT_SETTINGS,
				apiDelay: 0,
				maxRetries: 2,
				defaultArchiveProviders: ["wayback"],
				archiveTodayExperimentalSubmit: true,
				archiveTodaySubmitDelayMs: 0,
				archiveTodayPendingPollIntervalMs: 0,
				archiveTodayPendingPollBatchSize: 3,
				archiveTodayPendingMaxWaitMs: 600000,
				archiveTodayMaxPendingCount: 30,
				...settingsOverrides,
			},
			saveSettings: vi.fn(),
		};

		return new ArchiverService(
			plugin as unknown as ConstructorParameters<typeof ArchiverService>[0],
		);
	};

	it("routes Wayback job error to fallback with correct stage and error details", async () => {
		requestUrlMock
			.mockResolvedValueOnce({ status: 200, json: { job_id: "job-err" } })
			.mockResolvedValueOnce({
				status: 200,
				json: {
					status: "error",
					status_ext: "Wayback server overloaded",
				},
			})
			.mockResolvedValueOnce({
				status: 200,
				url: "https://archive.md/20260505164448/https://example.com/",
				text: "",
			});

		// Enable archiveToday fallback by adding it to defaultArchiveProviders
		const service = createEnhancementService(
			{},
			{
				defaultArchiveProviders: ["wayback", "archiveToday"],
				archiveTodayExperimentalSubmit: false, // Just latest resolver fallback, no autosave
			},
		);

		await expect(service.archiveUrl("https://example.com/")).resolves.toEqual({
			status: "success",
			url: "https://archive.md/20260505164448/https://example.com/",
		});

		expect(requestUrlMock).toHaveBeenCalledTimes(3);
	});

	it("preserves wayback failure stage if no fallbacks are tried", async () => {
		requestUrlMock
			.mockResolvedValueOnce({ status: 200, json: { job_id: "job-timeout" } })
			.mockResolvedValue({ status: 200, json: { status: "pending" } });

		const service = createEnhancementService(
			{},
			{
				defaultArchiveProviders: ["wayback"], // Only wayback
			},
		);

		await expect(service.archiveUrl("https://example.com/")).resolves.toEqual({
			status: "failed",
			status_ext: "Wayback job check timeout",
			stage: "wayback-timeout",
			manualProviderIds: undefined,
			targetUrl: "https://example.com/",
		});
	});

	it("logFailedArchive records correct targetUrl and typed stage", async () => {
		const service = createEnhancementService();
		const testMetadata = {
			stage: "fallback-not-found" as const,
			manualProviderIds: ["archiveToday" as const],
			targetUrl: "https://substituted.example.com/",
		};

		await (
			service as unknown as { logFailedArchive: (...args: unknown[]) => Promise<unknown> }
		).logFailedArchive(
			"https://original.example.com/",
			"notes/test.md",
			"Failed to archive",
			1,
			testMetadata,
		);

		expect(service["plugin"].data.failedArchives).toEqual([
			expect.objectContaining({
				url: "https://original.example.com/",
				targetUrl: "https://substituted.example.com/",
				filePath: "notes/test.md",
				error: "Failed to archive",
				retryCount: 1,
				stage: "fallback-not-found",
				manualProviderIds: ["archiveToday"],
				timestamp: expect.any(Number),
			}),
		]);
	});

	it("logFailedArchive coalesces recent duplicate failures with the same file, URL, and stage", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-09T00:00:00Z"));
		const service = createEnhancementService();
		const logFailedArchive = (
			service as unknown as { logFailedArchive: (...args: unknown[]) => Promise<unknown> }
		).logFailedArchive.bind(service);

		await logFailedArchive("https://example.com", "notes/test.md", "first failure", 0, {
			stage: "archive-today-autosave-failed",
			manualProviderIds: ["archiveToday"],
			targetUrl: "https://example.com",
		});
		vi.setSystemTime(new Date("2026-05-09T00:03:00Z"));
		await logFailedArchive("https://example.com", "notes/test.md", "second failure", 1, {
			stage: "archive-today-autosave-failed",
			manualProviderIds: ["archiveToday"],
			targetUrl: "https://example.com",
		});

		expect(service["plugin"].data.failedArchives).toHaveLength(1);
		expect(service["plugin"].data.failedArchives![0]).toMatchObject({
			url: "https://example.com",
			filePath: "notes/test.md",
			error: "second failure",
			retryCount: 1,
			stage: "archive-today-autosave-failed",
		});
	});

	it("logFailedArchive keeps separate entries when targetUrl differs", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-09T00:00:00Z"));
		const service = createEnhancementService();
		const logFailedArchive = (
			service as unknown as { logFailedArchive: (...args: unknown[]) => Promise<unknown> }
		).logFailedArchive.bind(service);

		await logFailedArchive("https://example.com", "notes/test.md", "first failure", 0, {
			stage: "archive-today-autosave-failed",
			manualProviderIds: ["archiveToday"],
			targetUrl: "https://target-a.example",
		});
		await logFailedArchive("https://example.com", "notes/test.md", "second failure", 1, {
			stage: "archive-today-autosave-failed",
			manualProviderIds: ["archiveToday"],
			targetUrl: "https://target-b.example",
		});

		expect(service["plugin"].data.failedArchives).toHaveLength(2);
		expect(service["plugin"].data.failedArchives!.map((entry) => entry.targetUrl)).toEqual([
			"https://target-a.example",
			"https://target-b.example",
		]);
	});

	it("appendFailedArchive coalesces pending timeout entries through the shared failed-log primitive", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-09T00:00:00Z"));
		const entry: PendingArchiveEntry = {
			id: "expired-1",
			providerId: "archiveToday",
			url: "https://example.com",
			targetUrl: "https://example.com",
			filePath: "notes/test.md",
			createdAt: Date.now() - 700000,
			checkCount: 5,
			maxWaitMs: 600000,
			status: "submitted",
		};
		const service = createEnhancementService({ pendingArchives: [entry] });
		const data = service["plugin"].data;

		await (
			service as unknown as { runPendingQueueCycle: () => Promise<void> }
		).runPendingQueueCycle();
		data.pendingArchives = [{ ...entry, id: "expired-2" }];
		vi.setSystemTime(new Date("2026-05-09T00:03:00Z"));
		await (
			service as unknown as { runPendingQueueCycle: () => Promise<void> }
		).runPendingQueueCycle();

		expect(data.failedArchives).toHaveLength(1);
		expect(data.failedArchives![0]).toMatchObject({
			url: "https://example.com",
			targetUrl: "https://example.com",
			stage: "archive-today-pending-timeout",
		});
	});

	it("parses new and legacy failed log CSV files seamlessly mapping by header", async () => {
		// 1. Legacy CSV with older column counts
		const legacyCsvContent =
			"url,filePath,timestamp,error,retryCount\nhttps://legacy.example/,notes/legacy.md,123456,Network error,2";

		const parsedLegacy = parseFailedArchiveEntriesFromCsv(legacyCsvContent);
		expect(parsedLegacy).toEqual([
			{
				url: "https://legacy.example/",
				filePath: "notes/legacy.md",
				timestamp: 123456,
				error: "Network error",
				retryCount: 2,
			},
		]);

		// 2. New CSV with extended, capitalized headers
		const newCsvContent =
			"URL,TargetURL,FilePath,Timestamp,Error,RetryCount,Stage,ManualProviderIds,ManualOpenedAt,ManualOpenCount\n" +
			'"https://new.example/","https://target.example/",notes/new.md,78910,Timeout error,3,fallback-not-found,archiveToday;megalodon,5555,1';

		const parsedNew = parseFailedArchiveEntriesFromCsv(newCsvContent);
		expect(parsedNew).toEqual([
			{
				url: "https://new.example/",
				targetUrl: "https://target.example/",
				filePath: "notes/new.md",
				timestamp: 78910,
				error: "Timeout error",
				retryCount: 3,
				stage: "fallback-not-found",
				manualProviderIds: ["archiveToday", "megalodon"],
				manualOpenedAt: 5555,
				manualOpenCount: 1,
			},
		]);
	});

	it("sorts manual open candidates by manualOpenedAt ascending and increments opened metadata", async () => {
		const service = createEnhancementService();
		service["plugin"].data.failedArchives = [
			{
				url: "https://c.example/",
				filePath: "c.md",
				timestamp: 3,
				error: "x",
				retryCount: 0,
				manualOpenedAt: 200,
				manualOpenCount: 1,
			},
			{
				url: "https://a.example/",
				filePath: "a.md",
				timestamp: 1,
				error: "x",
				retryCount: 0,
			},
			{
				url: "https://b.example/",
				filePath: "b.md",
				timestamp: 2,
				error: "x",
				retryCount: 0,
				manualOpenedAt: 100,
				manualOpenCount: 1,
			},
		];
		service["plugin"].activeSettings.manualSaveBatchSize = 2;
		service["plugin"].activeSettings.defaultArchiveProviders = ["wayback", "archiveToday"];

		await service.openManualSavePagesForFailedArchives("archiveToday");

		// Should open unopened first (https://a.example/), then older manualOpenedAt (https://b.example/)
		expect(globalThis.open).toHaveBeenCalledTimes(2);
		expect(globalThis.open).toHaveBeenNthCalledWith(
			1,
			"https://archive.md/submit/?url=https%3A%2F%2Fa.example%2F",
			"_blank",
			"noopener",
		);
		expect(globalThis.open).toHaveBeenNthCalledWith(
			2,
			"https://archive.md/submit/?url=https%3A%2F%2Fb.example%2F",
			"_blank",
			"noopener",
		);

		// Metadata for a.example should now be populated
		const aEntry = service["plugin"].data.failedArchives.find(
			(e) => e.url === "https://a.example/",
		);
		expect(aEntry?.manualOpenedAt).toBeGreaterThan(0);
		expect(aEntry?.manualOpenCount).toBe(1);

		// Metadata for b.example should be updated
		const bEntry = service["plugin"].data.failedArchives.find(
			(e) => e.url === "https://b.example/",
		);
		expect(bEntry?.manualOpenedAt).toBeGreaterThan(100);
		expect(bEntry?.manualOpenCount).toBe(2);
	});

	it("uses the actual plugin loadSettings to merge profiles and preserve user custom settings", async () => {
		const pluginData: WaybackArchiverData = {
			activeProfileId: "default",
			profiles: {
				default: {
					...DEFAULT_SETTINGS,
					ignorePatterns: ["my-custom-domain.com/"],
				},
			},
			failedArchives: [],
			spnAccessKey: "",
			spnSecretKey: "",
		};

		const plugin = new WaybackArchiverPlugin(
			{} as unknown as App,
			{} as unknown as PluginManifest,
		);
		vi.spyOn(plugin, "loadData").mockResolvedValue(pluginData);

		await plugin.loadSettings();

		// Check merged active profile
		const activeProfile = plugin.activeSettings;
		expect(activeProfile.ignorePatterns).toContain("my-custom-domain.com/");
		// Check standard fallback providers exist
		expect(activeProfile.defaultArchiveProviders).toEqual(["wayback"]);
	});
});

describe("Wayback Archiver Enhancements TDD Part 2", () => {
	beforeEach(() => {
		vi.stubGlobal("open", vi.fn());
		requestUrlMock.mockReset();
		noticeMock.mockReset();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	const createTddService = (
		overrides: Partial<WaybackArchiverData> = {},
		settingsOverrides: Record<string, unknown> = {},
	) => {
		const data: WaybackArchiverData = {
			activeProfileId: "default",
			profiles: { default: { ...DEFAULT_SETTINGS } },
			failedArchives: [],
			spnAccessKey: "access",
			spnSecretKey: "secret",
			...overrides,
		};
		const plugin = {
			app: {
				vault: {
					adapter: {
						exists: vi.fn().mockResolvedValue(true),
						list: vi.fn().mockResolvedValue({ files: [] }),
						read: vi.fn(),
						write: vi.fn(),
						remove: vi.fn(),
					},
					process: vi.fn(),
					getAbstractFileByPath: vi.fn(),
				},
			},
			data,
			activeSettings: {
				...DEFAULT_SETTINGS,
				apiDelay: 0,
				maxRetries: 1,
				defaultArchiveProviders: ["wayback", "archiveToday"],
				archiveTodayExperimentalSubmit: true,
				archiveTodaySubmitDelayMs: 0,
				archiveTodayPendingPollIntervalMs: 0,
				archiveTodayPendingPollBatchSize: 3,
				archiveTodayPendingMaxWaitMs: 600000,
				archiveTodayMaxPendingCount: 30,
				...settingsOverrides,
			},
			saveSettings: vi.fn(),
		};

		return new ArchiverService(
			plugin as unknown as ConstructorParameters<typeof ArchiverService>[0],
		);
	};

	it("logs targetUrl for selection-mode failures", async () => {
		const service = createTddService();
		vi.spyOn(
			service as unknown as { processSingleUrlArchival: () => Promise<unknown> },
			"processSingleUrlArchival",
		).mockResolvedValue({
			status: "archived_failed",
			error: "Some network failure",
			stage: "wayback-job-error",
			manualProviderIds: ["archiveToday"],
			targetUrl: "https://substituted.example/",
		});

		const selection = "[Google](https://google.com/)";
		const editor = {
			getSelection: () => selection,
			getValue: () => selection,
			getCursor: (fromTo?: string) => {
				if (fromTo === "from") return { line: 0, ch: 0 };
				return { line: 0, ch: selection.length };
			},
			posToOffset: (pos: { ch: number }) => pos.ch,
			replaceSelection: vi.fn(),
		};
		const file = { path: "notes/sample.md" };

		await service.archiveLinksAction(
			editor as unknown as Editor,
			{ file } as unknown as MarkdownView,
		);

		const failedList = service["plugin"].data.failedArchives ?? [];
		expect(failedList).toHaveLength(1);
		expect(failedList[0].url).toBe("https://google.com/");
		expect(failedList[0].targetUrl).toBe("https://substituted.example/");
	});

	it("logs targetUrl for force-selection-mode failures", async () => {
		const service = createTddService();
		vi.spyOn(
			service as unknown as { processSingleUrlArchival: () => Promise<unknown> },
			"processSingleUrlArchival",
		).mockResolvedValue({
			status: "archived_failed",
			error: "Some force network failure",
			stage: "wayback-timeout",
			manualProviderIds: ["megalodon"],
			targetUrl: "https://force-substituted.example/",
		});

		const selection = "[Google](https://google.com/)";
		const editor = {
			getSelection: () => selection,
			getValue: () => selection,
			getCursor: (fromTo?: string) => {
				if (fromTo === "from") return { line: 0, ch: 0 };
				return { line: 0, ch: selection.length };
			},
			posToOffset: (pos: { ch: number }) => pos.ch,
			replaceSelection: vi.fn(),
		};
		const file = { path: "notes/sample.md" };

		await service.forceReArchiveLinksAction(
			editor as unknown as Editor,
			{ file } as unknown as MarkdownView,
		);

		const failedList = service["plugin"].data.failedArchives ?? [];
		expect(failedList).toHaveLength(1);
		expect(failedList[0].url).toBe("https://google.com/");
		expect(failedList[0].targetUrl).toBe("https://force-substituted.example/");
	});

	it("returns failed when experimental archive.today submit request fails", async () => {
		const service = createTddService(
			{},
			{
				defaultArchiveProviders: ["archiveToday"],
				archiveTodayExperimentalSubmit: true,
			},
		);

		requestUrlMock.mockRejectedValueOnce(new Error("Submit endpoint error (429/500)"));

		const result = await service.archiveUrl("https://example.com");
		expect(result).toMatchObject({
			status: "failed",
			stage: "archive-today-autosave-failed",
			manualProviderIds: ["archiveToday"],
			targetUrl: "https://example.com",
		});
	});

	it("routes missing SPN credentials to fallback when fallback providers are configured", async () => {
		const service = createTddService(
			{ spnAccessKey: "", spnSecretKey: "" },
			{ defaultArchiveProviders: ["archiveToday"], archiveTodayExperimentalSubmit: false },
		);

		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			headers: { location: "https://archive.today/20260505121212/https://foo.bar" },
		});

		const result = await service.archiveUrl("https://foo.bar");
		expect(result.status).toBe("success");
		expect((result as { url?: string }).url).toBe(
			"https://archive.md/20260505121212/https://foo.bar",
		);
	});

	it("does not show SPN configuration error when fallback succeeds without SPN keys", async () => {
		const service = createTddService(
			{ spnAccessKey: "", spnSecretKey: "" },
			{ defaultArchiveProviders: ["archiveToday"], archiveTodayExperimentalSubmit: false },
		);

		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			headers: { location: "https://archive.today/20260505121212/https://foo.bar" },
		});

		await service.archiveUrl("https://foo.bar");
		expect(noticeMock).not.toHaveBeenCalledWith(
			expect.stringContaining("SPN API keys not configured"),
		);
	});

	it("uses the same CSV header for export and retry-log rewrite", async () => {
		const entries = [
			{
				url: "https://a.com/",
				targetUrl: "https://a.com/",
				filePath: "notes/a.md",
				timestamp: 1234567,
				error: "Timeout",
				retryCount: 1,
				stage: "wayback-timeout" as const,
				manualProviderIds: ["archiveToday" as const],
				manualOpenedAt: 9999,
				manualOpenCount: 2,
			},
		];

		const csv = serializeFailedArchiveEntriesToCsv(entries);
		const parsedHeaders = csv.split("\n")[0].split(",");

		expect(parsedHeaders).toEqual(Array.from(FAILED_LOG_CSV_HEADERS));
	});

	it("round-trips CSV fields containing commas, quotes, and newlines", async () => {
		const complexEntry = {
			url: 'https://complex.com/path?a="hello"&b=world',
			targetUrl: "https://complex.com/path",
			filePath: "notes, containing commas/note.md",
			timestamp: 1680000000000,
			error: 'Error: "Timeout"\nLine 2 of error\r\nLine 3 with carriage return',
			retryCount: 3,
			stage: "fallback-provider-error" as const,
			manualProviderIds: ["archiveToday" as const, "megalodon" as const],
			manualOpenedAt: 1680000010000,
			manualOpenCount: 1,
		};

		const csv = serializeFailedArchiveEntriesToCsv([complexEntry]);
		const parsed = parseFailedArchiveEntriesFromCsv(csv);

		expect(parsed).toHaveLength(1);
		expect(parsed[0].url).toBe(complexEntry.url);
		expect(parsed[0].targetUrl).toBe(complexEntry.targetUrl);
		expect(parsed[0].filePath).toBe(complexEntry.filePath);
		expect(parsed[0].timestamp).toBe(complexEntry.timestamp);
		expect(parsed[0].error).toBe(complexEntry.error);
		expect(parsed[0].retryCount).toBe(complexEntry.retryCount);
		expect(parsed[0].stage).toBe(complexEntry.stage);
		expect(parsed[0].manualProviderIds).toEqual(complexEntry.manualProviderIds);
		expect(parsed[0].manualOpenedAt).toBe(complexEntry.manualOpenedAt);
		expect(parsed[0].manualOpenCount).toBe(complexEntry.manualOpenCount);
	});

	it("parses old CSV headers without new metadata fields", async () => {
		const legacyCsv =
			"url,filePath,timestamp,error,retryCount\nhttps://legacy.example/,notes/legacy.md,123456,Network error,2";
		const parsed = parseFailedArchiveEntriesFromCsv(legacyCsv);

		expect(parsed).toHaveLength(1);
		expect(parsed[0].url).toBe("https://legacy.example/");
		expect(parsed[0].filePath).toBe("notes/legacy.md");
		expect(parsed[0].timestamp).toBe(123456);
		expect(parsed[0].error).toBe("Network error");
		expect(parsed[0].retryCount).toBe(2);
		expect(parsed[0].targetUrl).toBeUndefined();
		expect(parsed[0].stage).toBeUndefined();
		expect(parsed[0].manualProviderIds).toBeUndefined();
		expect(parsed[0].manualOpenedAt).toBeUndefined();
		expect(parsed[0].manualOpenCount).toBeUndefined();
	});

	it("does not insert archive.md/latest/... resolver URLs", async () => {
		const service = createTddService(
			{ spnAccessKey: "", spnSecretKey: "" },
			{ defaultArchiveProviders: ["archiveToday"] },
		);

		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			headers: { location: "https://archive.md/latest/https://example.com" },
			text: "No embedded snapshot here",
		});

		const result = await service.archiveUrl("https://example.com");
		expect(result.status).not.toBe("success");
		expect((result as { url?: string }).url).toBeUndefined();
	});

	it("accepts different archive.today domain alias as a valid fixed snapshot from latest resolver", async () => {
		const service = createTddService(
			{ spnAccessKey: "", spnSecretKey: "" },
			{ defaultArchiveProviders: ["archiveToday"], archiveTodayExperimentalSubmit: false },
		);

		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			headers: { location: "https://archive.is/20260505164448/https://example.com" },
		});

		const result = await service.archiveUrl("https://example.com");
		expect(result.status).toBe("success");
		expect((result as { url?: string }).url).toBe(
			"https://archive.md/20260505164448/https://example.com",
		);
	});

	it("does not re-archive archive.today and Megalodon archive links due to hard-coded archive domain skips", async () => {
		const service = createTddService();
		const aliases = [
			"archive.today",
			"archive.is",
			"archive.md",
			"archive.ph",
			"archive.vn",
			"archive.li",
			"archive.fo",
		];
		for (const alias of aliases) {
			expect(
				(service as unknown as { isUrlIgnored: (url: string) => boolean }).isUrlIgnored(
					`https://${alias}/12345678901234/https://google.com`,
				),
			).toBe(true);
		}
		expect(
			(service as unknown as { isUrlIgnored: (url: string) => boolean }).isUrlIgnored(
				"https://megalodon.jp/2026-05-08-1212-34/https://google.com",
			),
		).toBe(true);
	});
	it("isUrlIgnored allows target URLs with archive domains as query parameters", () => {
		const service = createTddService({}, { ignorePatterns: [] });
		const isIgnored = (service as unknown as { isUrlIgnored: (url: string) => boolean }).isUrlIgnored.bind(service);

		// Valid archive links should be ignored
		expect(isIgnored("https://web.archive.org/web/2026/https://google.com")).toBe(true);
		expect(isIgnored("https://archive.today/12345/https://google.com")).toBe(true);
		expect(isIgnored("HTTPS://WEB.ARCHIVE.ORG/web/2026/https://google.com")).toBe(true);

		// Target URLs containing archive subpaths as parameter or path should NOT be ignored
		expect(isIgnored("https://myblog.com/?redirect=https://web.archive.org/")).toBe(false);
		expect(isIgnored("https://example.com/search?q=archive.today")).toBe(false);
		expect(isIgnored("https://example.com/path/web.archive.org/")).toBe(false);
		expect(isIgnored("https://archive.today.example.com/foo")).toBe(false);
		expect(isIgnored("https://example.com/?q=https://archive.today/foo")).toBe(false);
	});

	it("skips CSV rows with invalid timestamp instead of using Date.now()", () => {
		const csv =
			"URL,FilePath,Timestamp,Error,RetryCount\n" +
			"https://bad.example/,notes/bad.md,not-a-number,error,0\n";

		expect(parseFailedArchiveEntriesFromCsv(csv)).toEqual([]);
	});

	it("archiveLinksInCurrentNoteToArchiveTodayAction queues selection links for archive.today", async () => {
		const service = createTddService();
		requestUrlMock.mockResolvedValueOnce({ status: 200 });

		const selection = "[Foo](https://foo.com/)";
		const editor = {
			getSelection: () => selection,
			getValue: () => selection,
			getCursor: (fromTo?: string) => {
				if (fromTo === "from") return { line: 0, ch: 0 };
				return { line: 0, ch: selection.length };
			},
			posToOffset: (pos: { ch: number }) => pos.ch,
			offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
			replaceRange: vi.fn(),
		};
		const file = { path: "notes/sample.md" };

		await service.archiveLinksInCurrentNoteToArchiveTodayAction(
			editor as unknown as Editor,
			{ file } as unknown as MarkdownView,
		);

		expect(editor.replaceRange).not.toHaveBeenCalled();
		expect(service["plugin"].data.pendingArchives).toHaveLength(1);
		expect(service["plugin"].data.pendingArchives![0]).toMatchObject({
			url: "https://foo.com/",
			filePath: "notes/sample.md",
			status: "submitted",
		});
	});

	it("archiveLinksInCurrentNoteToArchiveTodayAction queues entire note links for archive.today", async () => {
		const service = createTddService();
		requestUrlMock.mockResolvedValueOnce({ status: 200 });

		const docContent = "Check [Foo](https://foo.com/) now.";
		const editor = {
			getSelection: () => "", // Empty selection
			getValue: () => docContent,
			getCursor: () => ({ line: 0, ch: 0 }),
			posToOffset: () => 0,
			offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
			replaceRange: vi.fn(),
		};
		const file = { path: "notes/sample.md", basename: "sample" };

		await service.archiveLinksInCurrentNoteToArchiveTodayAction(
			editor as unknown as Editor,
			{ file } as unknown as MarkdownView,
		);

		expect(editor.replaceRange).not.toHaveBeenCalled();
		expect(service["plugin"].data.pendingArchives).toHaveLength(1);
		expect(service["plugin"].data.pendingArchives![0]).toMatchObject({
			url: "https://foo.com/",
			filePath: "notes/sample.md",
			status: "submitted",
		});
	});

	it("archiveLinksInCurrentNoteToArchiveTodayAction reports no new queue work when every link is duplicate", async () => {
		const service = createTddService({
			pendingArchives: [
				{
					id: "existing",
					providerId: "archiveToday",
					url: "https://foo.com/",
					targetUrl: "https://foo.com/",
					filePath: "notes/sample.md",
					approximateIndex: 6,
					createdAt: Date.now(),
					checkCount: 0,
					maxWaitMs: 600000,
					status: "submitted",
				},
			],
		});
		const docContent = "Check [Foo](https://foo.com/) now.";
		const editor = {
			getSelection: () => "",
			getValue: () => docContent,
			getCursor: () => ({ line: 0, ch: 0 }),
			posToOffset: () => 0,
			offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
			replaceRange: vi.fn(),
		};
		const file = { path: "notes/sample.md", basename: "sample" };

		await service.archiveLinksInCurrentNoteToArchiveTodayAction(
			editor as unknown as Editor,
			{ file } as unknown as MarkdownView,
		);

		expect(requestUrlMock).not.toHaveBeenCalled();
		expect(noticeMock).toHaveBeenLastCalledWith(
			"No new archive.today snapshots queued or inserted. Skipped duplicate: 1",
		);
	});

	it("archive.today command queues links and pending cycle later inserts a resolved snapshot", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-09T00:00:00Z"));

		requestUrlMock.mockResolvedValue({ status: 200, text: "" });

		const setup = createFileService("See [A](https://a.com) and [B](https://b.com).", {
			...DEFAULT_SETTINGS,
			archiveTodayExperimentalSubmit: true,
			archiveTodaySubmitDelayMs: 0,
			apiDelay: 0,
		});

		vi.spyOn(
			setup.service as unknown as {
				resolveProviderSnapshot: (
					providerId: string,
					targetUrl: string,
				) => Promise<{ url: string | null; retryableError?: boolean }>;
			},
			"resolveProviderSnapshot",
		)
			.mockResolvedValueOnce({ url: "https://archive.md/20260509000000/https://a.com" })
			.mockResolvedValueOnce({ url: null });

		const editor = {
			getSelection: () => "",
			getValue: () => "See [A](https://a.com) and [B](https://b.com).",
			getCursor: () => ({ line: 0, ch: 0 }),
			posToOffset: () => 0,
			offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
			replaceRange: vi.fn(),
		};

		await setup.service.archiveLinksInCurrentNoteToArchiveTodayAction(
			editor as unknown as Editor,
			{ file: setup.file } as unknown as MarkdownView,
		);

		expect(setup.data.pendingArchives).toHaveLength(2);

		await (
			setup.service as unknown as { runPendingQueueCycle: () => Promise<void> }
		).runPendingQueueCycle();

		expect(setup.data.pendingArchives).toHaveLength(1);
		expect(setup.data.pendingArchives![0].url).toBe("https://b.com");
		expect(setup.getContent()).toContain("archive.md/20260509000000/https://a.com");
	});

	it("insertLatestFallbackSnapshotAction resolves and inserts latest snapshot for selection", async () => {
		const service = createTddService();

		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			headers: { location: "https://megalodon.jp/2026-0508-1212-34/https://foo.com" },
		});

		const selection = "[Foo](https://foo.com/)";
		const editor = {
			getSelection: () => selection,
			getValue: () => selection,
			getCursor: (fromTo?: string) => {
				if (fromTo === "from") return { line: 0, ch: 0 };
				return { line: 0, ch: selection.length };
			},
			posToOffset: (pos: { ch: number }) => pos.ch,
			offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
			replaceRange: vi.fn(),
		};
		const file = { path: "notes/sample.md" };

		await service.insertLatestFallbackSnapshotAction(
			editor as unknown as Editor,
			{ file } as unknown as MarkdownView,
			"megalodon",
		);

		const now = new Date();
		const expectedDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
		expect(editor.replaceRange).toHaveBeenCalledWith(
			` [(Archived on ${expectedDate})](https://megalodon.jp/2026-0508-1212-34/https://foo.com)`,
			{ line: 0, ch: selection.length },
		);
	});

	it("insertLatestFallbackSnapshotAction processes entire note if selection is empty", async () => {
		const service = createTddService();

		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			headers: { location: "https://megalodon.jp/2026-0508-1212-34/https://foo.com" },
		});

		const content = "[Foo](https://foo.com/)";
		const editor = {
			getSelection: () => "",
			getValue: () => content,
			getCursor: (fromTo?: string) => ({ line: 0, ch: 0 }),
			posToOffset: (pos: { ch: number }) => pos.ch,
			offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
			replaceRange: vi.fn(),
		};
		const file = { path: "notes/sample.md" };

		await service.insertLatestFallbackSnapshotAction(
			editor as unknown as Editor,
			{ file } as unknown as MarkdownView,
			"megalodon",
		);

		const now = new Date();
		const expectedDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
		expect(editor.replaceRange).toHaveBeenCalledWith(
			` [(Archived on ${expectedDate})](https://megalodon.jp/2026-0508-1212-34/https://foo.com)`,
			{ line: 0, ch: content.length },
		);
	});

	it("processSingleUrlArchival registers submitted response to pendingArchives queue instead of failedArchives", async () => {
		const service = createTddService(
			{ failedArchives: [], pendingArchives: [] },
			{
				defaultArchiveProviders: ["archiveToday"],
				archiveTodayExperimentalSubmit: true,
			},
		);

		// Mock the snapshot check and submit requests to archive.today as successful
		requestUrlMock
			.mockResolvedValueOnce({
				status: 200,
				text: "No snapshot html",
			})
			.mockResolvedValueOnce({
				status: 200,
				text: "Submitted successfully",
			});

		const outcome = await (
			service as unknown as {
				processSingleUrlArchival: (
					url: string,
					isForce: boolean,
					filePath: string,
					index?: number,
				) => Promise<{ status: string }>;
			}
		).processSingleUrlArchival("https://example-test.com", false, "notes/sample.md", 42);

		expect(outcome.status).toBe("submitted");
		expect(service["plugin"].data.failedArchives).toHaveLength(0);
		expect(service["plugin"].data.pendingArchives).toHaveLength(1);
		expect(service["plugin"].data.pendingArchives![0]).toMatchObject({
			url: "https://example-test.com",
			targetUrl: "https://example-test.com",
			filePath: "notes/sample.md",
			approximateIndex: 42,
			status: "submitted",
		});
	});

	it("archiveToday with experimentalSubmit returns success immediately if a fresh snapshot already exists", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-17T00:00:00Z"));

		const service = createTddService(
			{},
			{
				defaultArchiveProviders: ["archiveToday"],
				archiveTodayExperimentalSubmit: true,
				archiveFreshnessDays: 2, // 2 days freshness window
			},
		);

		// Mock the check for an existing snapshot to return a fresh one (dated April 16, 2026)
		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			url: "https://archive.md/20260416000000/https://example.com/",
			text: "",
		});

		const result = await service.archiveUrl("https://example.com/");

		expect(result).toEqual({
			status: "success",
			url: "https://archive.md/20260416000000/https://example.com/",
		});

		// Ensure no submission/save request was fired (only 1 call to check existing snapshot)
		expect(requestUrlMock).toHaveBeenCalledTimes(1);
		expect(requestUrlMock).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "https://archive.md/latest/https%3A%2F%2Fexample.com%2F",
			}),
		);
	});

	it("archiveToday with experimentalSubmit triggers new submit if snapshot exists but is stale", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-17T00:00:00Z"));

		const service = createTddService(
			{},
			{
				defaultArchiveProviders: ["archiveToday"],
				archiveTodayExperimentalSubmit: true,
				archiveFreshnessDays: 2, // 2 days freshness window
			},
		);

		// 1st request: Returns a stale snapshot (dated April 10, 2026)
		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			url: "https://archive.md/20260410000000/https://example.com/",
			text: "",
		});

		// 2nd request: Mock the save request (submit trigger) to succeed
		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			text: "Submitted successfully",
		});

		const result = await service.archiveUrl("https://example.com/");

		expect(result).toEqual({
			status: "submitted",
			targetUrl: "https://example.com/",
			provider: "archiveToday",
		});

		// Expect two calls: 1 to resolve existing, and 1 to submit
		expect(requestUrlMock).toHaveBeenCalledTimes(2);
		expect(requestUrlMock).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				url: "https://archive.md/latest/https%3A%2F%2Fexample.com%2F",
			}),
		);
		expect(requestUrlMock).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				url: "https://archive.md/submit/?url=https%3A%2F%2Fexample.com%2F",
			}),
		);
	});

	it("archiveToday with experimentalSubmit triggers new submit if snapshot does not exist", async () => {
		const service = createTddService(
			{},
			{
				defaultArchiveProviders: ["archiveToday"],
				archiveTodayExperimentalSubmit: true,
			},
		);

		// 1st request: No existing snapshot (resolves to standard/fallback URL that is not a snapshot)
		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			url: "https://archive.md/https://example.com/",
			text: "",
		});

		// 2nd request: Mock the submit save request to succeed
		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			text: "Submitted successfully",
		});

		const result = await service.archiveUrl("https://example.com/");

		expect(result).toEqual({
			status: "submitted",
			targetUrl: "https://example.com/",
			provider: "archiveToday",
		});

		expect(requestUrlMock).toHaveBeenCalledTimes(2);
	});

	it("retry success inserts using central formatter", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-04-17T00:00:00Z"));

		const customSettings = {
			...DEFAULT_SETTINGS,
			archiveLinkText: "Retry snap: {date}",
			dateFormat: "yyyy-MM-dd",
		};
		const setup = createFileService("Check out https://example.com/.", customSettings);
		setup.plugin.app.vault.adapter = {
			write: vi.fn(),
			remove: vi.fn(),
		};

		vi.spyOn(setup.service, "archiveUrl").mockResolvedValue({
			status: "success",
			url: "https://web.archive.org/web/20260417000000/https://example.com/",
		});

		const entries: FailedArchiveEntry[] = [
			{
				url: "https://example.com/",
				filePath: "notes/example.md",
				timestamp: 12345,
				error: "timeout",
				retryCount: 0,
			},
		];

		await (
			setup.service as unknown as {
				executeRetryOfFailedArchives: (
					logFilePath: string,
					entries: FailedArchiveEntry[],
					totalRetries: number,
					forceReplace: boolean,
				) => Promise<void>;
			}
		).executeRetryOfFailedArchives("failed_log.json", entries, entries.length, false);

		expect(setup.getContent()).toBe(
			"Check out https://example.com/ [Retry snap: 2026-04-17](https://web.archive.org/web/20260417000000/https://example.com/).",
		);
	});

	it("standard retry does not replace adjacent archive link", async () => {
		const setup = createFileService(
			"Check out https://example.com/ [(Archived on 2026-04-10)](https://web.archive.org/web/20260410000000/https://example.com/).",
		);
		setup.plugin.app.vault.adapter = {
			write: vi.fn(),
			remove: vi.fn(),
		};

		const archiveUrlSpy = vi.spyOn(setup.service, "archiveUrl");

		const entries: FailedArchiveEntry[] = [
			{
				url: "https://example.com/",
				filePath: "notes/example.md",
				timestamp: 12345,
				error: "timeout",
				retryCount: 0,
			},
		];

		await (
			setup.service as unknown as {
				executeRetryOfFailedArchives: (
					logFilePath: string,
					entries: FailedArchiveEntry[],
					totalRetries: number,
					forceReplace: boolean,
				) => Promise<void>;
			}
		).executeRetryOfFailedArchives("failed_log.json", entries, entries.length, false);

		expect(archiveUrlSpy).not.toHaveBeenCalled();
		expect(setup.getContent()).toBe(
			"Check out https://example.com/ [(Archived on 2026-04-10)](https://web.archive.org/web/20260410000000/https://example.com/).",
		);
	});

	it("force retry replaces adjacent archive link", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-04-17T00:00:00Z"));

		const setup = createFileService(
			"Check out https://example.com/ [(Archived on 2026-04-10)](https://web.archive.org/web/20260410000000/https://example.com/).",
		);
		setup.plugin.app.vault.adapter = {
			write: vi.fn(),
			remove: vi.fn(),
		};

		vi.spyOn(setup.service, "archiveUrl").mockResolvedValue({
			status: "success",
			url: "https://web.archive.org/web/20260417000000/https://example.com/",
		});

		const entries: FailedArchiveEntry[] = [
			{
				url: "https://example.com/",
				filePath: "notes/example.md",
				timestamp: 12345,
				error: "timeout",
				retryCount: 0,
			},
		];

		await (
			setup.service as unknown as {
				executeRetryOfFailedArchives: (
					logFilePath: string,
					entries: FailedArchiveEntry[],
					totalRetries: number,
					forceReplace: boolean,
				) => Promise<void>;
			}
		).executeRetryOfFailedArchives("failed_log.json", entries, entries.length, true);

		expect(setup.getContent()).toBe(
			"Check out https://example.com/ [(Archived on 2026-04-17)](https://web.archive.org/web/20260417000000/https://example.com/).",
		);
	});

	it("retry preserves HTML link formatting", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-04-17T00:00:00Z"));

		const setup = createFileService('Check out <a href="https://example.com/">My Site</a>.');
		setup.plugin.app.vault.adapter = {
			write: vi.fn(),
			remove: vi.fn(),
		};

		vi.spyOn(setup.service, "archiveUrl").mockResolvedValue({
			status: "success",
			url: "https://web.archive.org/web/20260417000000/https://example.com/",
		});

		const entries: FailedArchiveEntry[] = [
			{
				url: "https://example.com/",
				filePath: "notes/example.md",
				timestamp: 12345,
				error: "timeout",
				retryCount: 0,
			},
		];

		await (
			setup.service as unknown as {
				executeRetryOfFailedArchives: (
					logFilePath: string,
					entries: FailedArchiveEntry[],
					totalRetries: number,
					forceReplace: boolean,
				) => Promise<void>;
			}
		).executeRetryOfFailedArchives("failed_log.json", entries, entries.length, false);

		expect(setup.getContent()).toBe(
			'Check out <a href="https://example.com/">My Site</a> <a href="https://web.archive.org/web/20260417000000/https://example.com/">(Archived on 2026-04-17)</a>.',
		);
	});

	it("runPendingQueueCycle replaces adjacent link when resolved snapshot is newer", async () => {
		const setup = createFileService(
			"See [A](https://a.com) [(Archived on 2026-05-01)](https://archive.today/20260501121212/https://a.com).",
		);

		setup.data.pendingArchives = [
			{
				id: "pending_a",
				providerId: "archiveToday" as const,
				url: "https://a.com",
				targetUrl: "https://a.com",
				filePath: "notes/example.md",
				createdAt: Date.now(),
				checkCount: 0,
				maxWaitMs: 600000,
				status: "submitted" as const,
			},
		];

		vi.spyOn(
			setup.service as unknown as {
				resolveProviderSnapshot: (
					providerId: string,
					targetUrl: string,
				) => Promise<{ url: string | null; retryableError?: boolean }>;
			},
			"resolveProviderSnapshot",
		).mockResolvedValueOnce({ url: "https://archive.today/20260509121212/https://a.com" });

		await (
			setup.service as unknown as { runPendingQueueCycle: () => Promise<void> }
		).runPendingQueueCycle();

		expect(setup.data.pendingArchives).toHaveLength(0);
		expect(setup.getContent()).toContain("archive.md/20260509121212");
	});

	it("runPendingQueueCycle does NOT replace adjacent link when resolved snapshot is older", async () => {
		const setup = createFileService(
			"See [A](https://a.com) [(Archived on 2026-05-09)](https://archive.today/20260509121212/https://a.com).",
		);

		setup.data.pendingArchives = [
			{
				id: "pending_a",
				providerId: "archiveToday" as const,
				url: "https://a.com",
				targetUrl: "https://a.com",
				filePath: "notes/example.md",
				createdAt: Date.now(),
				checkCount: 0,
				maxWaitMs: 600000,
				status: "submitted" as const,
			},
		];

		vi.spyOn(
			setup.service as unknown as {
				resolveProviderSnapshot: (
					providerId: string,
					targetUrl: string,
				) => Promise<{ url: string | null; retryableError?: boolean }>;
			},
			"resolveProviderSnapshot",
		).mockResolvedValueOnce({ url: "https://archive.today/20260501121212/https://a.com" });

		await (
			setup.service as unknown as { runPendingQueueCycle: () => Promise<void> }
		).runPendingQueueCycle();

		expect(setup.data.pendingArchives).toHaveLength(0);
		expect(setup.getContent()).toContain("archive.today/20260509121212"); // untouched
	});

	it("runPendingQueueCycle does NOT replace adjacent link when resolved snapshot is same timestamp", async () => {
		const setup = createFileService(
			"See [A](https://a.com) [(Archived on 2026-05-09)](https://archive.today/20260509121212/https://a.com).",
		);

		setup.data.pendingArchives = [
			{
				id: "pending_a",
				providerId: "archiveToday" as const,
				url: "https://a.com",
				targetUrl: "https://a.com",
				filePath: "notes/example.md",
				createdAt: Date.now(),
				checkCount: 0,
				maxWaitMs: 600000,
				status: "submitted" as const,
			},
		];

		vi.spyOn(
			setup.service as unknown as {
				resolveProviderSnapshot: (
					providerId: string,
					targetUrl: string,
				) => Promise<{ url: string | null; retryableError?: boolean }>;
			},
			"resolveProviderSnapshot",
		).mockResolvedValueOnce({ url: "https://archive.today/20260509121212/https://a.com" });

		await (
			setup.service as unknown as { runPendingQueueCycle: () => Promise<void> }
		).runPendingQueueCycle();

		expect(setup.data.pendingArchives).toHaveLength(0);
		expect(setup.getContent()).toContain("archive.today/20260509121212"); // untouched
	});

	it("runPendingQueueCycle preserves existing link and removes from queue if adjacent link lacks timestamp", async () => {
		const setup = createFileService(
			"See [A](https://a.com) [(Archived)](https://web.archive.org/web/*/https://a.com).",
		);

		setup.data.pendingArchives = [
			{
				id: "pending_a",
				providerId: "archiveToday" as const,
				url: "https://a.com",
				targetUrl: "https://a.com",
				filePath: "notes/example.md",
				createdAt: Date.now(),
				checkCount: 0,
				maxWaitMs: 600000,
				status: "submitted" as const,
			},
		];

		vi.spyOn(
			setup.service as unknown as {
				resolveProviderSnapshot: (
					providerId: string,
					targetUrl: string,
				) => Promise<{ url: string | null; retryableError?: boolean }>;
			},
			"resolveProviderSnapshot",
		).mockResolvedValueOnce({ url: "https://archive.today/20260509121212/https://a.com" });

		await (
			setup.service as unknown as { runPendingQueueCycle: () => Promise<void> }
		).runPendingQueueCycle();

		expect(setup.data.pendingArchives).toHaveLength(0);
		expect(setup.getContent()).toBe("See [A](https://a.com) [(Archived)](https://web.archive.org/web/*/https://a.com)."); // unmodified
	});

	it("runPendingQueueCycle preserves existing link and removes from queue if resolved snapshot lacks timestamp", async () => {
		const setup = createFileService(
			"See [A](https://a.com) [(Archived on 2026-05-09)](https://archive.today/20260509121212/https://a.com).",
		);

		setup.data.pendingArchives = [
			{
				id: "pending_a",
				providerId: "archiveToday" as const,
				url: "https://a.com",
				targetUrl: "https://a.com",
				filePath: "notes/example.md",
				createdAt: Date.now(),
				checkCount: 0,
				maxWaitMs: 600000,
				status: "submitted" as const,
			},
		];

		vi.spyOn(
			setup.service as unknown as {
				resolveProviderSnapshot: (
					providerId: string,
					targetUrl: string,
				) => Promise<{ url: string | null; retryableError?: boolean }>;
			},
			"resolveProviderSnapshot",
		).mockResolvedValueOnce({ url: "https://archive.today/latest/https://a.com" });

		await (
			setup.service as unknown as { runPendingQueueCycle: () => Promise<void> }
		).runPendingQueueCycle();

		expect(setup.data.pendingArchives).toHaveLength(0);
		expect(setup.getContent()).toBe("See [A](https://a.com) [(Archived on 2026-05-09)](https://archive.today/20260509121212/https://a.com)."); // unmodified
	});
});
