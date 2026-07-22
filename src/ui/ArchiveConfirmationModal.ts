import { App, Modal } from "obsidian";
import { ArchiveScanSummary } from "../core/vaultScan";

export interface ArchiveConfirmationModalOptions {
	summary: ArchiveScanSummary;
	onStart: () => void;
	title?: string;
	additionalCounts?: Array<{ label: string; value: number }>;
}

export class ArchiveConfirmationModal extends Modal {
	constructor(
		app: App,
		private readonly options: ArchiveConfirmationModalOptions,
	) {
		super(app);
	}

	onOpen(): void {
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
				this.close();
				this.options.onStart();
			});
		buttons
			.createEl("button", { text: "Cancel" })
			.addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
