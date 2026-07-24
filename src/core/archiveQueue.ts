import { BatchRunController } from "./batchRun";

export interface ArchiveQueueItem {
	dedupeKey: string;
	url: string;
	filePath: string;
	execute: (run: BatchRunController, itemId: string) => Promise<void> | void;
}

interface PendingArchiveQueueItem extends ArchiveQueueItem {
	itemId: string;
}

export class ArchiveQueueController {
	readonly run = new BatchRunController([]);
	private readonly activeKeys = new Set<string>();
	private readonly pending: PendingArchiveQueueItem[] = [];
	private processing = false;
	private nextItemId = 0;

	enqueue(items: ArchiveQueueItem[]): number {
		if (this.run.isCanceled()) return 0;
		const accepted: PendingArchiveQueueItem[] = [];
		for (const item of items) {
			if (this.activeKeys.has(item.dedupeKey)) continue;
			this.activeKeys.add(item.dedupeKey);
			accepted.push({ ...item, itemId: `archive-queue-${this.nextItemId++}` });
		}
		if (accepted.length === 0) return 0;
		this.pending.push(...accepted);
		this.run.addItems(accepted.map(({ itemId: id, url, filePath }) => ({ id, url, filePath })));
		void this.processPending();
		return accepted.length;
	}

	cancel(): void {
		this.run.cancel();
		this.pending.length = 0;
		this.activeKeys.clear();
		if (!this.processing) this.run.finish();
	}

	private async processPending(): Promise<void> {
		if (this.processing) return;
		this.processing = true;
		try {
			while (!this.run.isCanceled()) {
				const item = this.pending.shift();
				if (!item) break;
				if (this.run.isItemCanceled(item.itemId)) {
					this.activeKeys.delete(item.dedupeKey);
					continue;
				}
				this.run.updateItem(item.itemId, "capturing", "Processing");
				try {
					await item.execute(this.run, item.itemId);
				} catch (error) {
					if (!this.run.isCanceled()) {
						this.run.updateItem(
							item.itemId,
							"failed",
							error instanceof Error ? error.message : String(error),
						);
					}
				} finally {
					this.activeKeys.delete(item.dedupeKey);
				}
			}
		} finally {
			this.processing = false;
			this.run.finish();
		}
	}
}
