import { BatchRunController, BatchRunSnapshot } from "../core/batchRun";

export class ArchiveProgressChip {
	private root: HTMLDivElement | null = null;
	private detailsButton: HTMLButtonElement | null = null;
	private cancelButton: HTMLButtonElement | null = null;
	private unsubscribe: (() => void) | null = null;

	constructor(
		private readonly run: BatchRunController,
		private readonly onOpenDetails: () => void,
	) {}

	open(parent: HTMLElement = document.body): void {
		if (this.root) return;
		const root = document.createElement("div");
		root.className = "wayback-progress-chip";
		const detailsButton = document.createElement("button");
		detailsButton.type = "button";
		detailsButton.className = "wayback-progress-chip-details";
		detailsButton.addEventListener("click", this.onOpenDetails);
		const cancelButton = document.createElement("button");
		cancelButton.type = "button";
		cancelButton.className = "wayback-progress-chip-cancel";
		cancelButton.textContent = "Cancel";
		cancelButton.addEventListener("click", () => this.run.cancel());
		root.append(detailsButton, cancelButton);
		parent.append(root);
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
		const state = snapshot.canceled
			? "Canceled"
			: snapshot.finished
				? "Complete"
				: "Archiving";
		this.detailsButton.textContent = `${state} ${snapshot.completed}/${snapshot.total} · ${snapshot.succeeded} saved · ${snapshot.failed} failed`;
		this.cancelButton.hidden = snapshot.finished || snapshot.canceled;
	}
}
