import { App, Modal } from "obsidian";
import { BatchRunController, BatchRunSnapshot } from "../core/batchRun";
import { ArchiveScanSummary } from "../core/vaultScan";

export interface ArchiveProgressModalOptions {
	summary: ArchiveScanSummary;
	run: BatchRunController;
	onStart: () => Promise<void>;
	title?: string;
	additionalCounts?: Array<{ label: string; value: number }>;
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
		this.renderConfirmation();
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

	private renderConfirmation(): void {
		this.contentEl.empty();
		this.contentEl.createEl("h2", { text: this.options.title ?? "Archive links?" });
		const { noteCount, linkCount, uniqueUrlCount } = this.options.summary;
		this.contentEl.createEl("p", {
			text: `${noteCount} note${noteCount === 1 ? "" : "s"}, ${linkCount} link${linkCount === 1 ? "" : "s"}, ${uniqueUrlCount} unique URL${uniqueUrlCount === 1 ? "" : "s"} will be processed.`,
		});
		for (const count of this.options.additionalCounts ?? []) {
			this.contentEl.createEl("p", { text: `${count.label}: ${count.value}` });
		}
		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		buttons
			.createEl("button", { text: "Start", cls: "mod-cta" })
			.addEventListener("click", () => {
				this.showProgress();
				void this.options.onStart();
			});
		buttons
			.createEl("button", { text: "Cancel" })
			.addEventListener("click", () => this.close());
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
