import { App, Modal } from "obsidian";
import { BatchRunController, formatBatchProgressDetails } from "../core/batchRun";
import type { BatchItemState, BatchRunSnapshot } from "../core/batchRun";

const ITEM_CANCELABLE_STATUSES = new Set(["pending", "capturing", "throttled", "fallback"]);

interface ProgressRowElements {
	row: HTMLDivElement;
	url: HTMLDivElement;
	detail: HTMLDivElement;
	skipButton: HTMLButtonElement;
}

export interface ArchiveProgressModalOptions {
	run: BatchRunController;
}

export class ArchiveProgressModal extends Modal {
	private unsubscribe: (() => void) | null = null;
	private headingEl: HTMLHeadingElement | null = null;
	private summaryEl: HTMLParagraphElement | null = null;
	private listEl: HTMLDivElement | null = null;
	private actionButton: HTMLButtonElement | null = null;
	private readonly rows = new Map<string, ProgressRowElements>();

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
		this.headingEl = null;
		this.summaryEl = null;
		this.listEl = null;
		this.actionButton = null;
		this.rows.clear();
	}

	showProgress(): void {
		this.unsubscribe?.();
		this.unsubscribe = this.options.run.subscribe((snapshot) => this.renderProgress(snapshot));
	}

	private initializeProgressElements(): void {
		if (this.headingEl && this.summaryEl && this.listEl && this.actionButton) return;
		this.contentEl.empty();
		this.headingEl = this.contentEl.createEl("h2");
		this.summaryEl = this.contentEl.createEl("p");
		this.listEl = this.contentEl.createDiv({ cls: "wayback-progress-list" });
		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		this.actionButton = buttons.createEl("button");
		this.actionButton.addEventListener("click", () => {
			const current = this.options.run.snapshot();
			if (!current.finished && !current.canceled) this.options.run.cancel();
			else this.close();
		});
	}

	private createProgressRow(item: BatchItemState): ProgressRowElements {
		const row = this.listEl!.createDiv({ cls: "wayback-progress-row" });
		const content = row.createDiv({ cls: "wayback-progress-row-content" });
		const url = content.createDiv({ cls: "wayback-progress-url" });
		const detail = content.createDiv({ cls: "wayback-progress-detail" });
		const skipButton = row.createEl("button", {
			text: "Skip",
			cls: "wayback-progress-skip",
		});
		skipButton.type = "button";
		skipButton.addEventListener("click", () => this.options.run.cancelItem(item.id));
		const elements = { row, url, detail, skipButton };
		this.rows.set(item.id, elements);
		return elements;
	}

	private renderProgress(snapshot: BatchRunSnapshot): void {
		this.initializeProgressElements();
		const title = snapshot.finished ? "Archival complete" : "Archiving links";
		if (this.headingEl!.textContent !== title) this.headingEl!.textContent = title;
		const details = formatBatchProgressDetails(snapshot, { savedWord: "succeeded" });
		const summary = `${snapshot.completed}/${snapshot.total} complete · ${details}`;
		if (this.summaryEl!.textContent !== summary) this.summaryEl!.textContent = summary;
		for (const item of snapshot.items) {
			const elements = this.rows.get(item.id) ?? this.createProgressRow(item);
			if (elements.row.dataset.status !== item.status) {
				elements.row.dataset.status = item.status;
			}
			if (elements.url.textContent !== item.url) elements.url.textContent = item.url;
			const detail = `${item.filePath} · ${item.status} · ${item.detail}`;
			if (elements.detail.textContent !== detail) elements.detail.textContent = detail;
			const skipHidden = !ITEM_CANCELABLE_STATUSES.has(item.status);
			if (elements.skipButton.hidden !== skipHidden) {
				elements.skipButton.hidden = skipHidden;
			}
			const skipTitle =
				item.status === "pending"
					? "Skip this link"
					: "Stop processing this link. A request already sent to an archive service cannot be revoked.";
			if (elements.skipButton.title !== skipTitle) {
				elements.skipButton.title = skipTitle;
			}
		}
		const action = snapshot.finished || snapshot.canceled ? "Close" : "Cancel";
		if (this.actionButton!.textContent !== action) this.actionButton!.textContent = action;
	}
}
