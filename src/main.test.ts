import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({
	layoutReadyCallback: null as null | (() => void),
	startScheduler: vi.fn(),
	stopScheduler: vi.fn(),
	registerCommands: vi.fn(),
	registerContextMenus: vi.fn(),
	modalOpen: vi.fn(),
	modalShowProgress: vi.fn(),
	modalClose: vi.fn(),
	chipOpen: vi.fn(),
	chipDestroy: vi.fn(),
	confirmationOpen: vi.fn(),
	confirmationOnStart: null as null | (() => void),
	archiveItemAction: vi.fn(),
}));

vi.mock("obsidian", () => ({
	Plugin: class Plugin {
		app = {
			workspace: {
				onLayoutReady: vi.fn((callback: () => void) => {
					lifecycle.layoutReadyCallback = callback;
				}),
			},
		};
		addStatusBarItem = vi.fn(() => ({
			setText: vi.fn(),
			addEventListener: vi.fn(),
			classList: { add: vi.fn() },
		}));
		addSettingTab = vi.fn();
		addCommand = vi.fn();
		loadData = vi.fn(async () => null);
		saveData = vi.fn(async () => undefined);
	},
	addIcon: vi.fn(),
	PluginSettingTab: class PluginSettingTab {},
	Notice: vi.fn(),
	requestUrl: vi.fn(),
	TFile: class TFile {},
}));

vi.mock("./core/archiver", () => ({
	ArchiverService: class ArchiverService {
		startPendingQueueScheduler = lifecycle.startScheduler;
		stopPendingQueueScheduler = lifecycle.stopScheduler;
		runPendingQueueCycle = vi.fn();
		scanVaultForArchiving = vi.fn();
		archiveScannedLinksAction = vi.fn();
		archiveScannedItemAction = lifecycle.archiveItemAction;
	},
}));

vi.mock("./core/commands", () => ({
	registerCommands: lifecycle.registerCommands,
}));

vi.mock("./core/contextMenus", () => ({
	registerContextMenus: lifecycle.registerContextMenus,
}));

vi.mock("./ui/SettingsTab", () => ({
	WaybackArchiverSettingTab: class WaybackArchiverSettingTab {},
}));

vi.mock("./ui/ArchiveProgressModal", () => ({
	ArchiveProgressModal: class ArchiveProgressModal {
		open = lifecycle.modalOpen;
		showProgress = lifecycle.modalShowProgress;
		close = lifecycle.modalClose;
	},
}));

vi.mock("./ui/ArchiveProgressChip", () => ({
	ArchiveProgressChip: class ArchiveProgressChip {
		open = lifecycle.chipOpen;
		destroy = lifecycle.chipDestroy;
	},
}));

vi.mock("./ui/ArchiveConfirmationModal", () => ({
	ArchiveConfirmationModal: class ArchiveConfirmationModal {
		constructor(_app: unknown, options: { onStart: () => void }) {
			lifecycle.confirmationOnStart = options.onStart;
		}
		open = lifecycle.confirmationOpen;
	},
}));

import WaybackArchiverPlugin from "./main";

const createManifest = () =>
	({
		id: "wayback-archiver",
		name: "Wayback Archiver",
		version: "2.1.1",
		minAppVersion: "1.8.10",
		description: "test",
		author: "ISHIZUE",
	}) as never;

const createArchiveSummary = (id: string, url = "https://example.com") => ({
	noteCount: 1,
	linkCount: 1,
	uniqueUrlCount: 1,
	items: [
		{
			id,
			filePath: "a.md",
			url,
			approximateIndex: 0,
			isForce: false,
		},
	],
});

describe("plugin startup lifecycle", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
		vi.stubGlobal("window", globalThis);
		lifecycle.layoutReadyCallback = null;
		lifecycle.confirmationOnStart = null;
		lifecycle.archiveItemAction.mockImplementation((_item, run, itemId) => {
			run.updateItem(itemId, "success", "Captured");
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("registers the plugin during onload but defers the pending scheduler", async () => {
		const plugin = new WaybackArchiverPlugin({} as never, createManifest());
		await plugin.onload();

		expect(plugin.addSettingTab).toHaveBeenCalledOnce();
		expect(lifecycle.registerCommands).toHaveBeenCalledOnce();
		expect(lifecycle.registerContextMenus).toHaveBeenCalledOnce();
		expect(plugin.app.workspace.onLayoutReady).toHaveBeenCalledOnce();
		expect(lifecycle.startScheduler).not.toHaveBeenCalled();

		lifecycle.layoutReadyCallback?.();
		expect(lifecycle.startScheduler).toHaveBeenCalledOnce();
	});

	it("does not start deferred work after unload", async () => {
		const plugin = new WaybackArchiverPlugin({} as never, createManifest());
		await plugin.onload();
		plugin.onunload();
		lifecycle.layoutReadyCallback?.();

		expect(lifecycle.startScheduler).not.toHaveBeenCalled();
		expect(lifecycle.stopScheduler).toHaveBeenCalledOnce();
	});

	it("starts a shared archive run only after confirmation", async () => {
		const plugin = new WaybackArchiverPlugin({} as never, createManifest());
		await plugin.onload();

		plugin.startArchiveRun(createArchiveSummary("a.md:0"), "Archive selected links?");

		expect(plugin.activeArchiveRun).toBeNull();
		expect(lifecycle.confirmationOpen).toHaveBeenCalledOnce();
		lifecycle.confirmationOnStart?.();
		expect(plugin.activeArchiveRun).not.toBeNull();
		expect(lifecycle.chipOpen).toHaveBeenCalledOnce();
		expect(lifecycle.modalOpen).not.toHaveBeenCalled();
	});

	it("appends later archive submissions to the same run", async () => {
		const plugin = new WaybackArchiverPlugin({} as never, createManifest());
		await plugin.onload();
		plugin.enqueueArchiveRun(createArchiveSummary("first"));
		await vi.waitFor(() => expect(plugin.activeArchiveRun?.snapshot().finished).toBe(true));
		const firstRun = plugin.activeArchiveRun;

		plugin.enqueueArchiveRun(createArchiveSummary("second"));
		await vi.waitFor(() => expect(plugin.activeArchiveRun?.snapshot().finished).toBe(true));

		expect(plugin.activeArchiveRun).toBe(firstRun);
		expect(plugin.activeArchiveRun?.snapshot().total).toBe(2);
		expect(lifecycle.chipOpen).toHaveBeenCalledOnce();
	});

	it("deduplicates only when both occurrence and URL match", async () => {
		const gate = new Promise<void>(() => undefined);
		lifecycle.archiveItemAction.mockImplementationOnce(() => gate);
		const plugin = new WaybackArchiverPlugin({} as never, createManifest());
		await plugin.onload();
		plugin.enqueueArchiveRun(createArchiveSummary("same", "https://a.example"));

		plugin.enqueueArchiveRun(createArchiveSummary("same", "https://a.example"));
		plugin.enqueueArchiveRun(createArchiveSummary("same", "https://b.example"));

		expect(plugin.activeArchiveRun?.snapshot().total).toBe(2);
	});

	it("cancels pending cleanup when more work arrives", async () => {
		vi.useFakeTimers();
		const plugin = new WaybackArchiverPlugin({} as never, createManifest());
		await plugin.onload();
		plugin.enqueueArchiveRun(createArchiveSummary("first"));
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(plugin.activeArchiveRun?.snapshot().finished).toBe(true);
		const firstRun = plugin.activeArchiveRun;
		vi.advanceTimersByTime(4_000);

		plugin.enqueueArchiveRun(createArchiveSummary("second"));
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(plugin.activeArchiveRun?.snapshot().finished).toBe(true);
		vi.advanceTimersByTime(1_000);

		expect(plugin.activeArchiveRun).toBe(firstRun);
		expect(lifecycle.chipDestroy).not.toHaveBeenCalled();
		vi.advanceTimersByTime(4_000);
		expect(plugin.activeArchiveRun).toBeNull();
		expect(lifecycle.chipDestroy).toHaveBeenCalledOnce();
	});

	it("starts a new session after the previous queue was canceled", async () => {
		const gate = new Promise<void>(() => undefined);
		lifecycle.archiveItemAction.mockImplementationOnce(() => gate);
		const plugin = new WaybackArchiverPlugin({} as never, createManifest());
		await plugin.onload();
		plugin.enqueueArchiveRun(createArchiveSummary("first"));
		const firstRun = plugin.activeArchiveRun;
		firstRun?.cancel();

		plugin.enqueueArchiveRun(createArchiveSummary("second"));

		expect(plugin.activeArchiveRun).not.toBe(firstRun);
		expect(lifecycle.chipDestroy).toHaveBeenCalledOnce();
		expect(lifecycle.chipOpen).toHaveBeenCalledTimes(2);
	});

	it("keeps active work running while Vault confirmation is open and appends on Start", async () => {
		const gate = new Promise<void>(() => undefined);
		lifecycle.archiveItemAction.mockImplementationOnce(() => gate);
		const plugin = new WaybackArchiverPlugin({} as never, createManifest());
		await plugin.onload();
		plugin.enqueueArchiveRun(createArchiveSummary("first"));
		const firstRun = plugin.activeArchiveRun;
		const cancel = vi.spyOn(firstRun!, "cancel");

		plugin.startArchiveRun(createArchiveSummary("second"), "Archive all links in vault?");

		expect(plugin.activeArchiveRun).toBe(firstRun);
		expect(cancel).not.toHaveBeenCalled();
		expect(firstRun?.snapshot().total).toBe(1);
		lifecycle.confirmationOnStart?.();
		expect(plugin.activeArchiveRun).toBe(firstRun);
		expect(firstRun?.snapshot().total).toBe(2);
	});

	it("cancels and destroys the shared queue on unload", async () => {
		const gate = new Promise<void>(() => undefined);
		lifecycle.archiveItemAction.mockImplementationOnce(() => gate);
		const plugin = new WaybackArchiverPlugin({} as never, createManifest());
		await plugin.onload();
		plugin.enqueueArchiveRun(createArchiveSummary("first"));
		const run = plugin.activeArchiveRun;
		const cancel = vi.spyOn(run!, "cancel");

		plugin.onunload();

		expect(cancel).toHaveBeenCalledOnce();
		expect(lifecycle.chipDestroy).toHaveBeenCalledOnce();
		expect(plugin.activeArchiveRun).toBeNull();
	});
});
