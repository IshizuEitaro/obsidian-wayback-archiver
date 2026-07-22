import {
	App,
	Editor,
	EventRef,
	MarkdownFileInfo,
	MarkdownView,
	Menu,
	Notice,
	TAbstractFile,
	TFile,
} from "obsidian";
import { runAsyncAction } from "../utils/async";

interface ContextMenuPlugin {
	app: App;
	registerEvent(eventRef: EventRef): void;
	archiveLinksAction(editor: Editor, context: MarkdownView | MarkdownFileInfo): Promise<void>;
	forceReArchiveLinksAction(
		editor: Editor,
		context: MarkdownView | MarkdownFileInfo,
	): Promise<void>;
	archiveFilesAction(files: TFile[], isForce: boolean): Promise<void>;
	archiveUrlScopeAction(file: TFile, sourceUrl: string, isForce: boolean): Promise<void>;
}

function runMenuAction(action: () => void | Promise<void>): void {
	runAsyncAction(action, (error) => {
		console.error("Error running Wayback Archiver context menu action:", error);
		new Notice("Wayback Archiver could not complete that action. See the console for details.");
	});
}

function isMarkdownFile(file: TAbstractFile | null | undefined): file is TFile {
	return file instanceof TFile && file.extension.toLowerCase() === "md";
}

function addArchiveItems(
	menu: Menu,
	labels: { normal: string; force: string },
	run: (isForce: boolean) => void | Promise<void>,
): void {
	menu.addItem((item) =>
		item
			.setTitle(labels.normal)
			.setIcon("archive")
			.onClick(() => runMenuAction(() => run(false))),
	);
	menu.addItem((item) =>
		item
			.setTitle(labels.force)
			.setIcon("refresh-cw")
			.onClick(() => runMenuAction(() => run(true))),
	);
}

export function registerContextMenus(plugin: ContextMenuPlugin): void {
	plugin.registerEvent(
		plugin.app.workspace.on("editor-menu", (menu, editor, context) => {
			const scope = editor.somethingSelected() ? "selection" : "current note";
			addArchiveItems(
				menu,
				{
					normal: `Archive links in ${scope}`,
					force: `Force re-archive links in ${scope}`,
				},
				(isForce) =>
					isForce
						? plugin.forceReArchiveLinksAction(editor, context)
						: plugin.archiveLinksAction(editor, context),
			);
		}),
	);

	plugin.registerEvent(
		plugin.app.workspace.on("file-menu", (menu, file) => {
			if (!isMarkdownFile(file)) return;
			addArchiveItems(
				menu,
				{
					normal: "Archive links in this note",
					force: "Force re-archive links in this note",
				},
				(isForce) => plugin.archiveFilesAction([file], isForce),
			);
		}),
	);

	plugin.registerEvent(
		plugin.app.workspace.on("url-menu", (menu, url) => {
			addArchiveItems(
				menu,
				{
					normal: "Archive all occurrences of this URL",
					force: "Force re-archive all occurrences of this URL",
				},
				(isForce) => {
					const file = plugin.app.workspace.getActiveFile();
					if (!isMarkdownFile(file)) {
						new Notice("Open a Markdown note before archiving this URL.");
						return;
					}
					return plugin.archiveUrlScopeAction(file, url, isForce);
				},
			);
		}),
	);

	plugin.registerEvent(
		plugin.app.workspace.on("files-menu", (menu, files) => {
			const markdownFiles = Array.from(
				new Map(
					files.filter(isMarkdownFile).map((file) => [file.path, file]),
				).values(),
			);
			if (markdownFiles.length === 0) return;
			addArchiveItems(
				menu,
				{
					normal: "Archive links in selected notes",
					force: "Force re-archive links in selected notes",
				},
				(isForce) => plugin.archiveFilesAction(markdownFiles, isForce),
			);
		}),
	);
}
