import { beforeEach, describe, expect, it, vi } from "vitest";

const noticeMock = vi.hoisted(() => vi.fn());

vi.mock("obsidian", () => ({
	Notice: noticeMock,
	TFile: class TFile {},
}));

import { TFile } from "obsidian";
import { registerContextMenus } from "./contextMenus";

class TestMenuItem {
	title = "";
	callback: (() => void) | null = null;
	setTitle(title: string) {
		this.title = title;
		return this;
	}
	setIcon() {
		return this;
	}
	onClick(callback: () => void) {
		this.callback = callback;
		return this;
	}
}

class TestMenu {
	items: TestMenuItem[] = [];
	addItem(configure: (item: TestMenuItem) => void) {
		const item = new TestMenuItem();
		configure(item);
		this.items.push(item);
		return this;
	}
}

const createPlugin = () => {
	const listeners = new Map<string, (...args: unknown[]) => void>();
	const plugin = {
		app: {
			workspace: {
				on: vi.fn((name: string, callback: (...args: unknown[]) => void) => {
					listeners.set(name, callback);
					return { name };
				}),
				getActiveFile: vi.fn(),
			},
		},
		registerEvent: vi.fn(),
		archiveLinksAction: vi.fn(),
		forceReArchiveLinksAction: vi.fn(),
		archiveFilesAction: vi.fn(),
		archiveUrlScopeAction: vi.fn(),
	};
	registerContextMenus(plugin as never);
	return { listeners, plugin };
};

const markdownFile = (path = "note.md") =>
	Object.assign(Object.create(TFile.prototype), {
		path,
		extension: "md",
		basename: path.replace(/\.md$/u, ""),
	});

describe("context menus", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("adds editor actions with selection-aware labels", () => {
		const { listeners, plugin } = createPlugin();
		const menu = new TestMenu();
		const editor = { somethingSelected: () => true };
		const context = {};

		listeners.get("editor-menu")?.(menu, editor, context);

		expect(menu.items.map((item) => item.title)).toEqual([
			"Archive links in selection",
			"Force re-archive links in selection",
		]);
		menu.items[0].callback?.();
		expect(plugin.archiveLinksAction).toHaveBeenCalledWith(editor, context);
	});

	it("uses current-note labels when the editor has no selection", () => {
		const { listeners } = createPlugin();
		const menu = new TestMenu();

		listeners.get("editor-menu")?.(menu, { somethingSelected: () => false }, {});

		expect(menu.items[0].title).toBe("Archive links in current note");
	});

	it("adds normal and force actions only for a Markdown file", () => {
		const { listeners, plugin } = createPlugin();
		const menu = new TestMenu();
		const file = markdownFile();

		listeners.get("file-menu")?.(menu, file, "file-explorer");

		expect(menu.items.map((item) => item.title)).toEqual([
			"Archive links in this note",
			"Force re-archive links in this note",
		]);
		menu.items[1].callback?.();
		expect(plugin.archiveFilesAction).toHaveBeenCalledWith([file], true);

		const nonMarkdownMenu = new TestMenu();
		listeners.get("file-menu")?.(
			nonMarkdownMenu,
			Object.assign(Object.create(TFile.prototype), { path: "image.png", extension: "png" }),
			"file-explorer",
		);
		expect(nonMarkdownMenu.items).toHaveLength(0);
	});

	it("registers every listener through the plugin lifecycle", () => {
		const { plugin } = createPlugin();
		expect(plugin.registerEvent).toHaveBeenCalledTimes(4);
	});

	it("defers URL work until click and uses the active Markdown note", async () => {
		const { listeners, plugin } = createPlugin();
		const menu = new TestMenu();
		const file = markdownFile("active.md");
		plugin.app.workspace.getActiveFile.mockReturnValue(file);

		listeners.get("url-menu")?.(menu, "https://example.com");

		expect(menu.items.map((item) => item.title)).toEqual([
			"Archive all occurrences of this URL",
			"Force re-archive all occurrences of this URL",
		]);
		expect(plugin.app.workspace.getActiveFile).not.toHaveBeenCalled();
		expect(plugin.archiveUrlScopeAction).not.toHaveBeenCalled();

		menu.items[0].callback?.();
		await Promise.resolve();
		expect(plugin.archiveUrlScopeAction).toHaveBeenCalledWith(
			file,
			"https://example.com",
			false,
		);
	});

	it("notifies after URL click when there is no active Markdown note", async () => {
		const { listeners } = createPlugin();
		const menu = new TestMenu();
		listeners.get("url-menu")?.(menu, "https://example.com");

		menu.items[0].callback?.();
		await Promise.resolve();

		expect(noticeMock).toHaveBeenCalledWith(
			"Open a Markdown note before archiving this URL.",
		);
	});

	it("deduplicates selected Markdown notes without doing archival work on open", async () => {
		const { listeners, plugin } = createPlugin();
		const menu = new TestMenu();
		const first = markdownFile("one.md");
		const duplicate = markdownFile("one.md");
		const second = markdownFile("two.md");
		const png = Object.assign(Object.create(TFile.prototype), {
			path: "image.png",
			extension: "png",
		});

		listeners.get("files-menu")?.(menu, [first, duplicate, png, second]);

		expect(plugin.archiveFilesAction).not.toHaveBeenCalled();
		expect(menu.items.map((item) => item.title)).toEqual([
			"Archive links in selected notes",
			"Force re-archive links in selected notes",
		]);
		menu.items[1].callback?.();
		await Promise.resolve();
		expect(plugin.archiveFilesAction).toHaveBeenCalledWith([duplicate, second], true);
	});

	it("hides the selected-notes actions when no Markdown file is selected", () => {
		const { listeners } = createPlugin();
		const menu = new TestMenu();
		listeners.get("files-menu")?.(menu, [
			Object.assign(Object.create(TFile.prototype), {
				path: "image.png",
				extension: "png",
			}),
		]);
		expect(menu.items).toHaveLength(0);
	});
});
