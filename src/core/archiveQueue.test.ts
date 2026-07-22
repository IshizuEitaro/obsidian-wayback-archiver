import { describe, expect, it, vi } from "vitest";
import { ArchiveQueueController, type ArchiveQueueItem } from "./archiveQueue";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function item(dedupeKey: string, execute: ArchiveQueueItem["execute"]): ArchiveQueueItem {
	return {
		dedupeKey,
		url: `https://${dedupeKey}.example`,
		filePath: `${dedupeKey}.md`,
		execute,
	};
}

describe("ArchiveQueueController", () => {
	it("processes queued work sequentially", async () => {
		const queue = new ArchiveQueueController();
		const first = deferred();
		const second = deferred();
		const order: string[] = [];
		let active = 0;
		let maximumActive = 0;
		const execute = (name: string, gate: ReturnType<typeof deferred>) =>
			item(name, async (run, itemId) => {
				active++;
				maximumActive = Math.max(maximumActive, active);
				order.push(name);
				await gate.promise;
				active--;
				run.updateItem(itemId, "success", "Captured");
			});

		queue.enqueue([execute("first", first), execute("second", second)]);
		await vi.waitFor(() => expect(order).toEqual(["first"]));
		first.resolve();
		await vi.waitFor(() => expect(order).toEqual(["first", "second"]));
		second.resolve();
		await vi.waitFor(() => expect(queue.run.snapshot().finished).toBe(true));

		expect(maximumActive).toBe(1);
	});

	it("appends new work behind an active item", async () => {
		const queue = new ArchiveQueueController();
		const first = deferred();
		const calls: string[] = [];
		queue.enqueue([
			item("first", async (run, itemId) => {
				calls.push("first");
				await first.promise;
				run.updateItem(itemId, "success", "Captured");
			}),
		]);
		await vi.waitFor(() => expect(calls).toEqual(["first"]));

		const added = queue.enqueue([
			item("second", async (run, itemId) => {
				calls.push("second");
				run.updateItem(itemId, "success", "Captured");
			}),
		]);
		first.resolve();
		await vi.waitFor(() => expect(queue.run.snapshot().finished).toBe(true));

		expect(added).toBe(1);
		expect(calls).toEqual(["first", "second"]);
	});

	it("deduplicates active work but accepts different occurrences", async () => {
		const queue = new ArchiveQueueController();
		const gate = deferred();
		const execute = async () => gate.promise;

		const firstAdded = queue.enqueue([item("same", execute)]);
		const nextAdded = queue.enqueue([item("same", execute), item("other", execute)]);

		expect(firstAdded).toBe(1);
		expect(nextAdded).toBe(1);
		expect(queue.run.snapshot().total).toBe(2);
		gate.resolve();
	});

	it("cancels active and pending work as one queue", async () => {
		const queue = new ArchiveQueueController();
		const gate = deferred();
		const second = vi.fn();
		queue.enqueue([item("first", async () => gate.promise), item("second", second)]);
		await vi.waitFor(() => expect(queue.run.snapshot().items[0].status).toBe("capturing"));

		queue.cancel();
		gate.resolve();
		await vi.waitFor(() => expect(queue.run.snapshot().finished).toBe(true));

		expect(second).not.toHaveBeenCalled();
		expect(queue.run.snapshot().items.map(({ status }) => status)).toEqual([
			"canceled",
			"canceled",
		]);
	});

	it("restarts the same run when work arrives after idle", async () => {
		const queue = new ArchiveQueueController();
		queue.enqueue([
			item("same", async (run, itemId) => run.updateItem(itemId, "success", "Captured")),
		]);
		await vi.waitFor(() => expect(queue.run.snapshot().finished).toBe(true));
		const gate = deferred();

		const added = queue.enqueue([
			item("same", async (run, itemId) => {
				await gate.promise;
				run.updateItem(itemId, "success", "Captured again");
			}),
		]);

		expect(added).toBe(1);
		expect(queue.run.snapshot()).toMatchObject({ total: 2, finished: false });
		gate.resolve();
		await vi.waitFor(() => expect(queue.run.snapshot().finished).toBe(true));
	});

	it("marks unexpected failures and continues with the next item", async () => {
		const queue = new ArchiveQueueController();
		const next: ArchiveQueueItem["execute"] = vi.fn((run, itemId) => {
			run.updateItem(itemId, "success", "Captured");
		});
		queue.enqueue([
			item("broken", async () => {
				throw new Error("network exploded");
			}),
			item("next", next),
		]);

		await vi.waitFor(() => expect(queue.run.snapshot().finished).toBe(true));

		expect(queue.run.snapshot().items[0]).toMatchObject({
			status: "failed",
			detail: "network exploded",
		});
		expect(next).toHaveBeenCalledOnce();
	});
});
