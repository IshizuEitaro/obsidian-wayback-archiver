import { App, Modal } from "obsidian";
import { BatchRunController, BatchRunSnapshot } from "../core/batchRun";

const ITEM_CANCELABLE_STATUSES = new Set(["pending", "capturing", "throttled", "fallback"]);

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
			const content = row.createDiv({ cls: "wayback-progress-row-content" });
			content.createDiv({ text: item.url, cls: "wayback-progress-url" });
			content.createDiv({
				text: `${item.filePath} · ${item.status} · ${item.detail}`,
				cls: "wayback-progress-detail",
			});
			if (ITEM_CANCELABLE_STATUSES.has(item.status)) {
				const skipButton = row.createEl("button", {
					text: "Skip",
					cls: "wayback-progress-skip",
				});
				skipButton.type = "button";
				skipButton.title =
					item.status === "pending"
						? "Skip this link"
						: "Stop processing this link. A request already sent to an archive service cannot be revoked.";
				skipButton.addEventListener("click", () => this.options.run.cancelItem(item.id));
			}
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
