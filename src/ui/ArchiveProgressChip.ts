import { BatchRunController, BatchRunSnapshot, formatBatchProgressDetails } from "../core/batchRun";

export class ArchiveProgressChip {
	private root: HTMLDivElement | null = null;
	private detailsButton: HTMLButtonElement | null = null;
	private cancelButton: HTMLButtonElement | null = null;
	private unsubscribe: (() => void) | null = null;

	constructor(
		private readonly run: BatchRunController,
		private readonly onOpenDetails: () => void,
	) {}

	open(parent: HTMLElement = activeDocument.body): void {
		if (this.root) return;
		const root = parent.createDiv({ cls: "wayback-progress-chip" });
		const detailsButton = root.createEl("button", {
			cls: "wayback-progress-chip-details",
			attr: { type: "button" },
		});
		detailsButton.addEventListener("click", this.onOpenDetails);
		const cancelButton = root.createEl("button", {
			text: "Cancel",
			cls: "wayback-progress-chip-cancel",
			attr: { type: "button" },
		});
		cancelButton.addEventListener("click", () => this.run.cancel());
		this.root = root;
		this.detailsButton = detailsButton;
		this.cancelButton = cancelButton;
		this.unsubscribe = this.run.subscribe((snapshot) => this.render(snapshot));
	}

	destroy(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.root?.remove();
		this.root = null;
		this.detailsButton = null;
		this.cancelButton = null;
	}

	private render(snapshot: BatchRunSnapshot): void {
		if (!this.detailsButton || !this.cancelButton) return;
		const state = snapshot.canceled ? "Canceled" : snapshot.finished ? "Complete" : "Archiving";
		const details = formatBatchProgressDetails(snapshot, { savedWord: "saved" });
		this.detailsButton.textContent = `${state} ${snapshot.completed}/${snapshot.total} · ${details}`;
		this.cancelButton.hidden = snapshot.finished || snapshot.canceled;
	}
}
