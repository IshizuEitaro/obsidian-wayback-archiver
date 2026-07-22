import { afterEach, describe, expect, it, vi } from "vitest";
import { BatchCanceledError, BatchRunController, waitForBatchDelay } from "./batchRun";

describe("BatchRunController", () => {
	afterEach(() => vi.useRealTimers());

	it("keeps completed items and cancels remaining work", async () => {
		const run = new BatchRunController([
			{ id: "a", url: "https://a.example", filePath: "a.md" },
			{ id: "b", url: "https://b.example", filePath: "b.md" },
		]);
		run.updateItem("a", "success", "Captured");
		run.cancel();

		expect(run.snapshot().items[0].status).toBe("success");
		expect(run.snapshot().items[1].status).toBe("canceled");
		expect(run.snapshot().canceled).toBe(true);
		await expect(waitForBatchDelay(10_000, run)).rejects.toBeInstanceOf(BatchCanceledError);
	});

	it("notifies subscribers with immutable snapshots", () => {
		const run = new BatchRunController([
			{ id: "a", url: "https://a.example", filePath: "a.md" },
		]);
		const snapshots = vi.fn();
		const unsubscribe = run.subscribe(snapshots);
		run.updateItem("a", "capturing", "Capturing");
		unsubscribe();
		run.updateItem("a", "success", "Captured");

		expect(snapshots).toHaveBeenCalledTimes(2);
		expect(snapshots.mock.calls[0][0].items[0].status).toBe("pending");
	});

	it("interrupts an active delay when canceled", async () => {
		vi.useFakeTimers();
		const run = new BatchRunController([
			{ id: "a", url: "https://a.example", filePath: "a.md" },
		]);
		const waiting = waitForBatchDelay(10_000, run);
		run.cancel();

		await expect(waiting).rejects.toBeInstanceOf(BatchCanceledError);
		expect(vi.getTimerCount()).toBe(0);
	});
});
