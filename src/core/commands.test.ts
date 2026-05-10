import { describe, expect, it, vi } from "vitest";

// Mock the external obsidian dependency comprehensively before importing any files that depend on it
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
	Notice: vi.fn(),
	requestUrl: vi.fn(),
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
	Editor: class Editor {},
	MarkdownView: class MarkdownView {},
}));

vi.mock("../ui/modals", () => ({
	ConfirmationModal: class ConfirmationModal {
		callback: (confirmed: boolean) => void;
		constructor(
			_app: unknown,
			_title: string,
			_message: string,
			_buttonText: string,
			callback: (confirmed: boolean) => void,
		) {
			this.callback = callback;
		}
		open() {
			this.callback(true);
		}
	},
	ExportFormatModal: class ExportFormatModal {},
}));

import { registerCommands } from "./commands";
import { DEFAULT_SETTINGS, FailedArchiveEntry } from "./settings";
import { Command, Editor, MarkdownFileInfo } from "obsidian";
import WaybackArchiverPlugin from "../main";

describe("registerCommands - Conditional Visibility", () => {
	const createMockPlugin = (settingsOverrides = {}) => {
		const commands: Command[] = [];
		const activeSettings = {
			...DEFAULT_SETTINGS,
			...settingsOverrides,
		};
		const plugin = {
			addRibbonIcon: vi.fn(),
			addCommand: vi.fn((cmd: Command) => {
				commands.push(cmd);
			}),
			activeSettings,
			archiveLinksAction: { bind: vi.fn(() => vi.fn()) },
			archiveAllLinksVaultAction: vi.fn(),
			submitAllLinksVaultToArchiveTodayAction: vi.fn(),
			insertLatestFallbackSnapshotsVaultAction: vi.fn(),
			archiveLinksInCurrentNoteToArchiveTodayAction: vi.fn(),
			insertLatestFallbackSnapshotAction: vi.fn(),
			runPendingQueueCycle: vi.fn(),
			forceReArchiveLinksAction: { bind: vi.fn(() => vi.fn()) },
			forceReArchiveAllLinksAction: vi.fn(),
			openManualSavePagesForFailedArchives: vi.fn(),
			retryFailedArchives: vi.fn(),
			data: {
				failedArchives: [] as FailedArchiveEntry[],
				pendingArchives: [],
			},
			saveSettings: vi.fn(),
			app: {
				workspace: {
					getActiveViewOfType: vi.fn(),
				},
				vault: {
					configDir: ".obsidian",
					createFolder: vi.fn(),
					create: vi.fn(),
				},
			},
		};
		return { plugin, commands };
	};

	it("registers all commands", () => {
		const { plugin, commands } = createMockPlugin();
		registerCommands(plugin as unknown as WaybackArchiverPlugin);
		expect(commands.length).toBeGreaterThan(0);
	});

	it("shows/hides archive.today experimental submit command based on setting", () => {
		// Test when setting is FALSE
		const { plugin: pluginFalse, commands: cmdsFalse } = createMockPlugin({
			archiveTodayExperimentalSubmit: false,
		});
		registerCommands(pluginFalse as unknown as WaybackArchiverPlugin);
		const submitCmdFalse = cmdsFalse.find(
			(c) => c.id === "submit-current-note-links-to-archive-today",
		);
		expect(submitCmdFalse).toBeDefined();
		expect(
			submitCmdFalse?.editorCheckCallback?.(
				true,
				{} as unknown as Editor,
				{} as unknown as MarkdownFileInfo,
			),
		).toBe(false);

		// Test when setting is TRUE
		const { plugin: pluginTrue, commands: cmdsTrue } = createMockPlugin({
			archiveTodayExperimentalSubmit: true,
		});
		registerCommands(pluginTrue as unknown as WaybackArchiverPlugin);
		const submitCmdTrue = cmdsTrue.find(
			(c) => c.id === "submit-current-note-links-to-archive-today",
		);
		expect(submitCmdTrue).toBeDefined();
		expect(
			submitCmdTrue?.editorCheckCallback?.(
				true,
				{} as unknown as Editor,
				{} as unknown as MarkdownFileInfo,
			),
		).toBe(true);

		// Executing when checking is false triggers the underlying action
		submitCmdTrue?.editorCheckCallback?.(
			false,
			"editor" as unknown as Editor,
			"ctx" as unknown as MarkdownFileInfo,
		);
		expect(pluginTrue.archiveLinksInCurrentNoteToArchiveTodayAction).toHaveBeenCalledWith(
			"editor",
			"ctx",
		);
	});

	it("shows/hides check-pending-archive-today-now based on setting", () => {
		const { plugin: pluginFalse, commands: cmdsFalse } = createMockPlugin({
			archiveTodayExperimentalSubmit: false,
		});
		registerCommands(pluginFalse as unknown as WaybackArchiverPlugin);
		const checkCmdFalse = cmdsFalse.find((c) => c.id === "check-pending-archive-today-now");
		expect(checkCmdFalse?.checkCallback?.(true)).toBe(false);

		const { plugin: pluginTrue, commands: cmdsTrue } = createMockPlugin({
			archiveTodayExperimentalSubmit: true,
		});
		registerCommands(pluginTrue as unknown as WaybackArchiverPlugin);
		const checkCmdTrue = cmdsTrue.find((c) => c.id === "check-pending-archive-today-now");
		expect(checkCmdTrue?.checkCallback?.(true)).toBe(true);

		checkCmdTrue?.checkCallback?.(false);
		expect(pluginTrue.runPendingQueueCycle).toHaveBeenCalled();
	});

	it("shows/hides archiveToday snapshot retrieval commands based on enabled fallback", () => {
		// When archiveToday is not enabled
		const { plugin: pluginFalse, commands: cmdsFalse } = createMockPlugin({
			defaultArchiveProviders: ["wayback"],
		});
		registerCommands(pluginFalse as unknown as WaybackArchiverPlugin);
		const insertCmdFalse = cmdsFalse.find(
			(c) => c.id === "insert-latest-archive-today-snapshot",
		);
		const openFailedCmdFalse = cmdsFalse.find(
			(c) => c.id === "open-failed-archive-today-save-pages",
		);
		expect(
			insertCmdFalse?.editorCheckCallback?.(
				true,
				{} as unknown as Editor,
				{} as unknown as MarkdownFileInfo,
			),
		).toBe(false);
		expect(openFailedCmdFalse?.checkCallback?.(true)).toBe(false);

		// When archiveToday is enabled
		const { plugin: pluginTrue, commands: cmdsTrue } = createMockPlugin({
			defaultArchiveProviders: ["wayback", "archiveToday"],
		});
		// Seed mock data with failed items to pass early return guards
		pluginTrue.data.failedArchives = [
			{ url: "https://example.com" },
		] as unknown as FailedArchiveEntry[];

		registerCommands(pluginTrue as unknown as WaybackArchiverPlugin);
		const insertCmdTrue = cmdsTrue.find((c) => c.id === "insert-latest-archive-today-snapshot");
		const openFailedCmdTrue = cmdsTrue.find(
			(c) => c.id === "open-failed-archive-today-save-pages",
		);
		expect(
			insertCmdTrue?.editorCheckCallback?.(
				true,
				{} as unknown as Editor,
				{} as unknown as MarkdownFileInfo,
			),
		).toBe(true);
		expect(openFailedCmdTrue?.checkCallback?.(true)).toBe(true);

		insertCmdTrue?.editorCheckCallback?.(
			false,
			"editor" as unknown as Editor,
			"ctx" as unknown as MarkdownFileInfo,
		);
		expect(pluginTrue.insertLatestFallbackSnapshotAction).toHaveBeenCalledWith(
			"editor",
			"ctx",
			"archiveToday",
		);

		openFailedCmdTrue?.checkCallback?.(false);
		expect(pluginTrue.openManualSavePagesForFailedArchives).toHaveBeenCalledWith(
			"archiveToday",
		);
	});

	it("shows/hides megalodon snapshot retrieval commands based on enabled fallback", () => {
		// When megalodon is not enabled
		const { plugin: pluginFalse, commands: cmdsFalse } = createMockPlugin({
			defaultArchiveProviders: ["wayback"],
		});
		registerCommands(pluginFalse as unknown as WaybackArchiverPlugin);
		const insertCmdFalse = cmdsFalse.find((c) => c.id === "insert-latest-megalodon-snapshot");
		const openFailedCmdFalse = cmdsFalse.find(
			(c) => c.id === "open-failed-megalodon-save-pages",
		);
		expect(
			insertCmdFalse?.editorCheckCallback?.(
				true,
				{} as unknown as Editor,
				{} as unknown as MarkdownFileInfo,
			),
		).toBe(false);
		expect(openFailedCmdFalse?.checkCallback?.(true)).toBe(false);

		// When megalodon is enabled
		const { plugin: pluginTrue, commands: cmdsTrue } = createMockPlugin({
			defaultArchiveProviders: ["wayback", "megalodon"],
		});
		// Seed mock data with failed items to pass early return guards
		pluginTrue.data.failedArchives = [
			{ url: "https://example.org" },
		] as unknown as FailedArchiveEntry[];

		registerCommands(pluginTrue as unknown as WaybackArchiverPlugin);
		const insertCmdTrue = cmdsTrue.find((c) => c.id === "insert-latest-megalodon-snapshot");
		const openFailedCmdTrue = cmdsTrue.find((c) => c.id === "open-failed-megalodon-save-pages");
		expect(
			insertCmdTrue?.editorCheckCallback?.(
				true,
				{} as unknown as Editor,
				{} as unknown as MarkdownFileInfo,
			),
		).toBe(true);
		expect(openFailedCmdTrue?.checkCallback?.(true)).toBe(true);

		insertCmdTrue?.editorCheckCallback?.(
			false,
			"editor" as unknown as Editor,
			"ctx" as unknown as MarkdownFileInfo,
		);
		expect(pluginTrue.insertLatestFallbackSnapshotAction).toHaveBeenCalledWith(
			"editor",
			"ctx",
			"megalodon",
		);

		openFailedCmdTrue?.checkCallback?.(false);
		expect(pluginTrue.openManualSavePagesForFailedArchives).toHaveBeenCalledWith("megalodon");
	});

	it("shows/hides submit-links-vault-to-archive-today based on setting", () => {
		const { plugin: pluginFalse, commands: cmdsFalse } = createMockPlugin({
			archiveTodayExperimentalSubmit: false,
		});
		registerCommands(pluginFalse as unknown as WaybackArchiverPlugin);
		const vaultSubmitCmdFalse = cmdsFalse.find(
			(c) => c.id === "submit-links-vault-to-archive-today",
		);
		expect(vaultSubmitCmdFalse?.checkCallback?.(true)).toBe(false);

		const { plugin: pluginTrue, commands: cmdsTrue } = createMockPlugin({
			archiveTodayExperimentalSubmit: true,
		});
		registerCommands(pluginTrue as unknown as WaybackArchiverPlugin);
		const vaultSubmitCmdTrue = cmdsTrue.find(
			(c) => c.id === "submit-links-vault-to-archive-today",
		);
		expect(vaultSubmitCmdTrue?.checkCallback?.(true)).toBe(true);

		vaultSubmitCmdTrue?.checkCallback?.(false);
		expect(pluginTrue.submitAllLinksVaultToArchiveTodayAction).toHaveBeenCalled();
	});

	it("shows/hides insert-latest-archive-today-snapshots-vault based on provider settings", () => {
		const { plugin: pluginFalse, commands: cmdsFalse } = createMockPlugin({
			defaultArchiveProviders: ["wayback"],
		});
		registerCommands(pluginFalse as unknown as WaybackArchiverPlugin);
		const vaultInsertCmdFalse = cmdsFalse.find(
			(c) => c.id === "insert-latest-archive-today-snapshots-vault",
		);
		expect(vaultInsertCmdFalse?.checkCallback?.(true)).toBe(false);

		const { plugin: pluginTrue, commands: cmdsTrue } = createMockPlugin({
			defaultArchiveProviders: ["wayback", "archiveToday"],
		});
		registerCommands(pluginTrue as unknown as WaybackArchiverPlugin);
		const vaultInsertCmdTrue = cmdsTrue.find(
			(c) => c.id === "insert-latest-archive-today-snapshots-vault",
		);
		expect(vaultInsertCmdTrue?.checkCallback?.(true)).toBe(true);

		vaultInsertCmdTrue?.checkCallback?.(false);
		expect(pluginTrue.insertLatestFallbackSnapshotsVaultAction).toHaveBeenCalledWith(
			"archiveToday",
			false,
		);

		const vaultForceReplaceCmdTrue = cmdsTrue.find(
			(c) => c.id === "force-replace-archive-links-vault-with-archive-today",
		);
		expect(vaultForceReplaceCmdTrue?.checkCallback?.(true)).toBe(true);
		vaultForceReplaceCmdTrue?.checkCallback?.(false);
		expect(pluginTrue.insertLatestFallbackSnapshotsVaultAction).toHaveBeenCalledWith(
			"archiveToday",
			true,
		);
	});

	it("shows/hides insert-latest-megalodon-snapshots-vault based on provider settings", () => {
		const { plugin: pluginFalse, commands: cmdsFalse } = createMockPlugin({
			defaultArchiveProviders: ["wayback"],
		});
		registerCommands(pluginFalse as unknown as WaybackArchiverPlugin);
		const vaultInsertCmdFalse = cmdsFalse.find(
			(c) => c.id === "insert-latest-megalodon-snapshots-vault",
		);
		expect(vaultInsertCmdFalse?.checkCallback?.(true)).toBe(false);

		const { plugin: pluginTrue, commands: cmdsTrue } = createMockPlugin({
			defaultArchiveProviders: ["wayback", "megalodon"],
		});
		registerCommands(pluginTrue as unknown as WaybackArchiverPlugin);
		const vaultInsertCmdTrue = cmdsTrue.find(
			(c) => c.id === "insert-latest-megalodon-snapshots-vault",
		);
		expect(vaultInsertCmdTrue?.checkCallback?.(true)).toBe(true);

		vaultInsertCmdTrue?.checkCallback?.(false);
		expect(pluginTrue.insertLatestFallbackSnapshotsVaultAction).toHaveBeenCalledWith(
			"megalodon",
			false,
		);

		const vaultForceReplaceCmdTrue = cmdsTrue.find(
			(c) => c.id === "force-replace-archive-links-vault-with-megalodon",
		);
		expect(vaultForceReplaceCmdTrue?.checkCallback?.(true)).toBe(true);
		vaultForceReplaceCmdTrue?.checkCallback?.(false);
		expect(pluginTrue.insertLatestFallbackSnapshotsVaultAction).toHaveBeenCalledWith(
			"megalodon",
			true,
		);
	});
});
