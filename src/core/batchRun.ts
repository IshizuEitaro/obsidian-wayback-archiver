export type BatchItemStatus =
	| "pending"
	| "capturing"
	| "throttled"
	| "fallback"
	| "success"
	| "failed"
	| "skipped"
	| "canceled";

export interface BatchItemState {
	id: string;
	url: string;
	filePath: string;
	status: BatchItemStatus;
	detail: string;
}

export interface BatchRunSnapshot {
	total: number;
	completed: number;
	succeeded: number;
	failed: number;
	canceled: boolean;
	finished: boolean;
	items: BatchItemState[];
}

export class BatchCanceledError extends Error {
	constructor() {
		super("Archive batch canceled");
		this.name = "BatchCanceledError";
	}
}

export class BatchRunController {
	private canceled = false;
	private finished = false;
	private readonly listeners = new Set<(snapshot: BatchRunSnapshot) => void>();
	private readonly items: BatchItemState[];

	constructor(items: Array<Pick<BatchItemState, "id" | "url" | "filePath">>) {
		this.items = items.map((item) => ({
			...item,
			status: "pending",
			detail: "Waiting",
		}));
	}

	assertActive(): void {
		if (this.canceled) throw new BatchCanceledError();
	}

	isCanceled(): boolean {
		return this.canceled;
	}

	updateItem(id: string, status: BatchItemStatus, detail: string): void {
		const item = this.items.find((candidate) => candidate.id === id);
		if (!item || (this.canceled && status !== "canceled")) return;
		item.status = status;
		item.detail = detail;
		this.emit();
	}

	cancel(): void {
		if (this.finished || this.canceled) return;
		this.canceled = true;
		for (const item of this.items) {
			if (
				item.status === "pending" ||
				item.status === "capturing" ||
				item.status === "throttled" ||
				item.status === "fallback"
			) {
				item.status = "canceled";
				item.detail = "Canceled";
			}
		}
		this.emit();
	}

	finish(): void {
		if (this.finished) return;
		this.finished = true;
		this.emit();
	}

	subscribe(listener: (snapshot: BatchRunSnapshot) => void): () => void {
		this.listeners.add(listener);
		listener(this.snapshot());
		return () => this.listeners.delete(listener);
	}

	snapshot(): BatchRunSnapshot {
		const completedStatuses = new Set<BatchItemStatus>([
			"success",
			"failed",
			"skipped",
			"canceled",
		]);
		return {
			total: this.items.length,
			completed: this.items.filter((item) => completedStatuses.has(item.status)).length,
			succeeded: this.items.filter((item) => item.status === "success").length,
			failed: this.items.filter((item) => item.status === "failed").length,
			canceled: this.canceled,
			finished: this.finished,
			items: this.items.map((item) => ({ ...item })),
		};
	}

	private emit(): void {
		const snapshot = this.snapshot();
		for (const listener of this.listeners) listener(snapshot);
	}
}

export async function waitForBatchDelay(
	ms: number,
	run: BatchRunController,
): Promise<void> {
	run.assertActive();
	await new Promise<void>((resolve, reject) => {
		let unsubscribe: () => void = () => undefined;
		const timer = globalThis.setTimeout(() => {
			unsubscribe();
			resolve();
		}, Math.max(0, ms));
		unsubscribe = run.subscribe((snapshot) => {
			if (!snapshot.canceled) return;
			globalThis.clearTimeout(timer);
			unsubscribe();
			reject(new BatchCanceledError());
		});
	});
}
