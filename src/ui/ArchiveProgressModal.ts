import { App, Modal } from "obsidian";
import { BatchRunController, BatchRunSnapshot } from "../core/batchRun";

export interface ArchiveProgressModalOptions {
	run: BatchRunController;
}

export class ArchiveProgressModal extends Modal {
	private unsubscribe: (() => void) | null = null;

	constructor(
		app: App,
		private readonly options: ArchiveProgressModalOptions,
	) {
		super(app);
	}

	onOpen(): void {
		this.showProgress();
	}

	onClose(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.contentEl.empty();
	}

	showProgress(): void {
		this.unsubscribe?.();
		this.unsubscribe = this.options.run.subscribe((snapshot) => this.renderProgress(snapshot));
	}

	private renderProgress(snapshot: BatchRunSnapshot): void {
		this.contentEl.empty();
		this.contentEl.createEl("h2", {
			text: snapshot.finished ? "Archival complete" : "Archiving links",
		});
		this.contentEl.createEl("p", {
			text: `${snapshot.completed}/${snapshot.total} complete · ${snapshot.succeeded} succeeded · ${snapshot.failed} failed`,
		});
		const list = this.contentEl.createDiv({ cls: "wayback-progress-list" });
		for (const item of snapshot.items) {
			const row = list.createDiv({ cls: "wayback-progress-row" });
			row.createDiv({ text: item.url, cls: "wayback-progress-url" });
			row.createDiv({
				text: `${item.filePath} · ${item.status} · ${item.detail}`,
				cls: "wayback-progress-detail",
			});
		}
		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		const button = buttons.createEl("button", {
			text: snapshot.finished || snapshot.canceled ? "Close" : "Cancel",
		});
		button.addEventListener("click", () => {
			if (!snapshot.finished && !snapshot.canceled) this.options.run.cancel();
			else this.close();
		});
	}
}
