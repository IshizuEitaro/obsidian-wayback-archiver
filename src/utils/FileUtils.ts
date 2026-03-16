import { Notice, TFile, Vault } from "obsidian";
import { FailedArchiveEntry } from "../core/settings";
import type WaybackArchiverPlugin from "../main";

export async function safeReadFile(vault: Vault, file: TFile): Promise<string> {
	try {
		return await vault.read(file);
	} catch (err) {
		new Notice(`Error reading file: ${file.path}`);
		console.error(`Error reading file ${file.path}:`, err);
		return "";
	}
}

export async function safeWriteFile(vault: Vault, file: TFile, content: string): Promise<void> {
	try {
		await vault.modify(file, content);
	} catch (err) {
		new Notice(`Error saving file: ${file.path}`);
		console.error(`Error saving file ${file.path}:`, err);
	}
}

export async function logFailedArchive(
	plugin: WaybackArchiverPlugin,
	entry: FailedArchiveEntry,
	save: boolean = true,
) {
	if (!plugin.data.failedArchives) plugin.data.failedArchives = [];
	plugin.data.failedArchives.push(entry);
	if (save && typeof plugin.saveSettings === "function") {
		await plugin.saveSettings();
	}
}

export function showAndLogError(message: string, error?: unknown) {
	new Notice(message);
	if (error) {
		console.error(message, error);
	} else {
		console.error(message);
	}
}
