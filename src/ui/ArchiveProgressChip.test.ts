import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BatchRunController } from "../core/batchRun";
import { ArchiveProgressChip } from "./ArchiveProgressChip";

class FakeElement {
	className = "";
	textContent = "";
	hidden = false;
	type = "";
	children: FakeElement[] = [];
	listeners = new Map<string, () => void>();
	removed = false;

	append(...children: FakeElement[]): void {
		this.children.push(...children);
	}

	addEventListener(event: string, listener: () => void): void {
		this.listeners.set(event, listener);
	}

	click(): void {
		this.listeners.get("click")?.();
	}

	remove(): void {
		this.removed = true;
	}

	findByClass(className: string): FakeElement | undefined {
		if (this.className === className) return this;
		return this.children.map((child) => child.findByClass(className)).find(Boolean);
	}
}

describe("ArchiveProgressChip", () => {
	beforeEach(() => {
		vi.stubGlobal("document", {
			body: new FakeElement(),
			createElement: vi.fn(() => new FakeElement()),
		});
	});

	afterEach(() => vi.unstubAllGlobals());

	it("shows live archive counts in a compact control", () => {
		const run = new BatchRunController([
			{ id: "a", url: "https://a.example", filePath: "a.md" },
		]);
		const chip = new ArchiveProgressChip(run, vi.fn());

		chip.open();
		run.updateItem("a", "success", "Captured");
		run.finish();

		const details = (document.body as unknown as FakeElement).findByClass(
			"wayback-progress-chip-details",
		);
		expect(details?.textContent).toContain("Complete 1/1");
		expect(details?.textContent).toContain("1 saved");
		expect(details?.textContent).toContain("0 failed");
	});

	it("opens archive details from the progress control", () => {
		const run = new BatchRunController([
			{ id: "a", url: "https://a.example", filePath: "a.md" },
		]);
		const openDetails = vi.fn();
		const chip = new ArchiveProgressChip(run, openDetails);
		chip.open();

		(document.body as unknown as FakeElement)
			.findByClass("wayback-progress-chip-details")
			?.click();

		expect(openDetails).toHaveBeenCalledOnce();
	});

	it("cancels the shared run from the compact control", () => {
		const run = new BatchRunController([
			{ id: "a", url: "https://a.example", filePath: "a.md" },
		]);
		const cancel = vi.spyOn(run, "cancel");
		const chip = new ArchiveProgressChip(run, vi.fn());
		chip.open();

		(document.body as unknown as FakeElement)
			.findByClass("wayback-progress-chip-cancel")
			?.click();

		expect(cancel).toHaveBeenCalledOnce();
		expect(
			(document.body as unknown as FakeElement).findByClass(
				"wayback-progress-chip-cancel",
			)?.hidden,
		).toBe(true);
	});

	it("removes the control and unsubscribes on destroy", () => {
		const run = new BatchRunController([
			{ id: "a", url: "https://a.example", filePath: "a.md" },
		]);
		const chip = new ArchiveProgressChip(run, vi.fn());
		chip.open();
		const root = (document.body as unknown as FakeElement).findByClass(
			"wayback-progress-chip",
		);
		const details = root?.findByClass("wayback-progress-chip-details");

		chip.destroy();
		const previousText = details?.textContent;
		run.updateItem("a", "success", "Captured");

		expect(root?.removed).toBe(true);
		expect(details?.textContent).toBe(previousText);
	});
});
