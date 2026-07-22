import { beforeEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({
	layoutReadyCallback: null as null | (() => void),
	startScheduler: vi.fn(),
	stopScheduler: vi.fn(),
	registerCommands: vi.fn(),
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
		addStatusBarItem = vi.fn(() => ({ setText: vi.fn() }));
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
	},
}));

vi.mock("./core/commands", () => ({
	registerCommands: lifecycle.registerCommands,
}));

vi.mock("./ui/SettingsTab", () => ({
	WaybackArchiverSettingTab: class WaybackArchiverSettingTab {},
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

describe("plugin startup lifecycle", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		lifecycle.layoutReadyCallback = null;
	});

	it("registers the plugin during onload but defers the pending scheduler", async () => {
		const plugin = new WaybackArchiverPlugin({} as never, createManifest());
		await plugin.onload();

		expect(plugin.addSettingTab).toHaveBeenCalledOnce();
		expect(lifecycle.registerCommands).toHaveBeenCalledOnce();
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
});
