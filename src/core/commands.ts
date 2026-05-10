import { App, Editor, MarkdownView, MarkdownFileInfo, Notice, Plugin } from "obsidian";
import { ConfirmationModal, ExportFormatModal } from "../ui/modals";
import { format } from "date-fns";
import { WaybackArchiverData, WaybackArchiverSettings } from "./settings";
import { serializeFailedArchiveEntriesToCsv } from "./failedArchiveLog";

export function registerCommands(plugin: WaybackArchiverPlugin) {
	// This creates an icon in the left ribbon.
	plugin.addRibbonIcon("wayback-ribbon", "Archive links in current note", async () => {
		const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if (view) {
			await plugin.archiveLinksAction(view.editor, view);
		} else {
			new Notice("Please open a markdown file first.");
		}
	});

	plugin.addCommand({
		id: "archive-links-current-note",
		name: "Archive links in current note",
		editorCallback: plugin.archiveLinksAction.bind(plugin),
	});

	plugin.addCommand({
		id: "archive-links-vault",
		name: "Archive all links in vault",
		callback: async () => {
			new ConfirmationModal(
				plugin.app,
				"Archive all links?",
				"This will scan all markdown notes in your vault and attempt to archive external links via Archive.org. Links that already have an archive link immediately following them will be skipped. This may take a while depending on the number of notes and links.",
				"Yes, archive all",
				async (confirmed: boolean) => {
					if (confirmed) {
						await plugin.archiveAllLinksVaultAction();
					} else {
						new Notice("Vault-wide archiving cancelled.");
					}
				},
			).open();
		},
	});

	plugin.addCommand({
		id: "submit-current-note-links-to-archive-today",
		name: "Submit current note links to archive.today",
		editorCheckCallback: (checking, editor, ctx) => {
			if (plugin.activeSettings.archiveTodayExperimentalSubmit) {
				if (!checking) {
					plugin.archiveLinksInCurrentNoteToArchiveTodayAction(editor, ctx);
				}
				return true;
			}
			return false;
		},
	});

	plugin.addCommand({
		id: "insert-latest-archive-today-snapshot",
		name: "Insert latest archive.today snapshot in current note",
		editorCheckCallback: (checking, editor, ctx) => {
			if (plugin.activeSettings.defaultArchiveProviders.includes("archiveToday")) {
				if (!checking) {
					plugin.insertLatestFallbackSnapshotAction(editor, ctx, "archiveToday");
				}
				return true;
			}
			return false;
		},
	});

	plugin.addCommand({
		id: "check-pending-archive-today-now",
		name: "Check pending archive.today snapshots now",
		checkCallback: (checking) => {
			if (plugin.activeSettings.archiveTodayExperimentalSubmit) {
				if (!checking) {
					plugin.runPendingQueueCycle();
				}
				return true;
			}
			return false;
		},
	});

	plugin.addCommand({
		id: "insert-latest-megalodon-snapshot",
		name: "Insert latest Web Gyotaku snapshot in current note",
		editorCheckCallback: (checking, editor, ctx) => {
			if (plugin.activeSettings.defaultArchiveProviders.includes("megalodon")) {
				if (!checking) {
					plugin.insertLatestFallbackSnapshotAction(editor, ctx, "megalodon");
				}
				return true;
			}
			return false;
		},
	});

	plugin.addCommand({
		id: "force-rearchive-links",
		name: "Force re-archive links in current note",
		editorCallback: plugin.forceReArchiveLinksAction.bind(plugin),
	});

	plugin.addCommand({
		id: "force-rearchive-links-vault",
		name: "Force re-archive all links in vault",
		callback: async () => {
			new ConfirmationModal(
				plugin.app,
				"Force re-archive all links?",
				"This will scan all markdown notes in your vault and attempt to archive external links via Archive.org, *overwriting* any existing archive links immediately following them. This may take a while.",
				"Yes, force re-archive all",
				async (confirmed: boolean) => {
					if (!confirmed) {
						new Notice("Vault-wide force re-archiving cancelled.");
						return;
					}
					await plugin.forceReArchiveAllLinksAction();
				},
			).open();
		},
	});

	plugin.addCommand({
		id: "export-failed-log",
		name: "Export failed archive log",
		callback: async () => {
			if (!plugin.data.failedArchives || plugin.data.failedArchives.length === 0) {
				new Notice("No failed archives to export.");
				return;
			}

			new ExportFormatModal(plugin.app, async (formatChoice) => {
				if (!formatChoice) {
					new Notice("Export cancelled.");
					return;
				}

				const timestamp = format(new Date(), "yyyyMMddHHmmss");
				let content = "";
				let filename = "";

				try {
					const failedArchives = plugin.data.failedArchives || [];

					if (formatChoice === "json") {
						content = JSON.stringify(failedArchives, null, 2);
						filename = `wayback-archiver-failed-log-${timestamp}.json`;
					} else {
						content = serializeFailedArchiveEntriesToCsv(failedArchives);
						filename = `wayback-archiver-failed-log-${timestamp}.csv`;
					}

					const folderPath =
						plugin.app.vault.configDir + "/plugins/wayback-archiver/failed_logs";
					try {
						await plugin.app.vault.createFolder(folderPath);
					} catch (e) {
						if (!(e instanceof Error) || !e.message.includes("Folder already exists")) {
							console.error("Error creating failed_logs folder:", e);
						}
					}
					const fullPath = `${folderPath}/${filename}`;
					await plugin.app.vault.create(fullPath, content);
					new Notice(`Failed archive log exported successfully to ${fullPath}`);
					// console.log(`Exported failed log to ${filename}`);

					new ConfirmationModal(
						plugin.app,
						"Export successful",
						"Export successful. Clear failed log list now?",
						"Clear list",
						async (confirmed: boolean) => {
							if (confirmed) {
								plugin.data.failedArchives = [];
								await plugin.saveSettings();
								new Notice("Failed archive log cleared.");
							}
						},
					).open();
				} catch (error: unknown) {
					console.error("Error exporting failed archive log:", error);
					new Notice(
						`Error exporting failed log: ${error instanceof Error ? error.message : "Unknown error"}`,
					);
				}
			}).open();
		},
	});

	plugin.addCommand({
		id: "retry-failed-archives",
		name: "Retry failed archive attempts",
		callback: async () => {
			await plugin.retryFailedArchives(false);
		},
	});

	plugin.addCommand({
		id: "force-retry-failed-archives",
		name: "Retry failed archive attempts (force replace)",
		callback: async () => {
			await plugin.retryFailedArchives(true);
		},
	});

	plugin.addCommand({
		id: "open-failed-archive-today-save-pages",
		name: "Open next failed URLs in archive.today",
		checkCallback: (checking) => {
			if (plugin.activeSettings.defaultArchiveProviders.includes("archiveToday")) {
				if (!checking) {
					if (!plugin.data.failedArchives || plugin.data.failedArchives.length === 0) {
						new Notice("No failed archives to process.");
						return;
					}
					plugin.openManualSavePagesForFailedArchives("archiveToday");
				}
				return true;
			}
			return false;
		},
	});

	plugin.addCommand({
		id: "open-failed-megalodon-save-pages",
		name: "Open next failed URLs in Web Gyotaku",
		checkCallback: (checking) => {
			if (plugin.activeSettings.defaultArchiveProviders.includes("megalodon")) {
				if (!checking) {
					if (!plugin.data.failedArchives || plugin.data.failedArchives.length === 0) {
						new Notice("No failed archives to process.");
						return;
					}
					plugin.openManualSavePagesForFailedArchives("megalodon");
				}
				return true;
			}
			return false;
		},
	});

	plugin.addCommand({
		id: "clear-failed-archives",
		name: "Clear failed archive log",
		callback: async () => {
			if (!plugin.data.failedArchives || plugin.data.failedArchives.length === 0) {
				new Notice("Failed archive log is already empty.");
				return;
			}
			new ConfirmationModal(
				plugin.app,
				"Clear failed archive log",
				"Are you sure you want to clear the failed archive log?",
				"Clear log",
				async (confirmed: boolean) => {
					if (confirmed) {
						plugin.data.failedArchives = [];
						await plugin.saveSettings();
						new Notice("Failed archive log cleared.");
					}
				},
			).open();
		},
	});
}

interface WaybackArchiverPlugin extends Plugin {
	archiveLinksAction: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => Promise<void>;
	archiveAllLinksVaultAction: () => Promise<void>;
	forceReArchiveLinksAction: (
		editor: Editor,
		ctx: MarkdownView | MarkdownFileInfo,
	) => Promise<void>;
	forceReArchiveAllLinksAction: () => Promise<void>;
	retryFailedArchives: (forceReplace: boolean) => Promise<void>;
	openManualSavePagesForFailedArchives: (
		providerId: "archiveToday" | "megalodon",
	) => Promise<void>;
	archiveLinksInCurrentNoteToArchiveTodayAction: (
		editor: Editor,
		ctx: MarkdownView | MarkdownFileInfo,
	) => Promise<void>;
	insertLatestFallbackSnapshotAction: (
		editor: Editor,
		ctx: MarkdownView | MarkdownFileInfo,
		providerId: "archiveToday" | "megalodon",
	) => Promise<void>;
	runPendingQueueCycle: () => Promise<void>;
	saveSettings: () => Promise<void>;
	loadSettings: () => Promise<void>;
	data: WaybackArchiverData;
	activeSettings: WaybackArchiverSettings;
	app: App;
}
