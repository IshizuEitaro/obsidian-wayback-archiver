import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeElement {
	textContent = "";
	children: FakeElement[] = [];
	listeners = new Map<string, () => void>();

	empty(): void {
		this.textContent = "";
		this.children = [];
	}

	createEl(_tag: string, options: { text?: string } = {}): FakeElement {
		const child = new FakeElement();
		child.textContent = options.text ?? "";
		this.children.push(child);
		return child;
	}

	createDiv(options: { text?: string } = {}): FakeElement {
		return this.createEl("div", options);
	}

	addEventListener(event: string, listener: () => void): void {
		this.listeners.set(event, listener);
	}

	findByText(text: string): FakeElement | undefined {
		if (this.textContent === text) return this;
		return this.children.map((child) => child.findByText(text)).find(Boolean);
	}

	findAllByText(text: string): FakeElement[] {
		return [
			...(this.textContent === text ? [this] : []),
			...this.children.flatMap((child) => child.findAllByText(text)),
		];
	}

	get allText(): string {
		return [this.textContent, ...this.children.map((child) => child.allText)].join(" ");
	}
}

vi.mock("obsidian", () => ({
	Modal: class Modal {
		contentEl = new FakeElement();
		constructor(_app: unknown) {}
		open() {
			(this as unknown as { onOpen(): void }).onOpen();
		}
		close() {
			(this as unknown as { onClose(): void }).onClose();
		}
	},
}));

import { BatchRunController } from "../core/batchRun";
import { ArchiveProgressModal } from "./ArchiveProgressModal";

describe("ArchiveProgressModal", () => {
	beforeEach(() => vi.clearAllMocks());

	it("opens directly into live URL details", () => {
		const run = new BatchRunController([
			{ id: "a", url: "https://a.example", filePath: "a.md" },
		]);
		const modal = new ArchiveProgressModal({} as never, { run });

		modal.open();
		run.updateItem("a", "success", "Captured");

		const content = modal.contentEl as unknown as FakeElement;
		expect(content.allText).toContain("Captured");
		expect(content.findByText("Start")).toBeUndefined();
	});

	it("keeps the shared run active when details close", () => {
		const run = new BatchRunController([
			{ id: "a", url: "https://a.example", filePath: "a.md" },
		]);
		const cancel = vi.spyOn(run, "cancel");
		const modal = new ArchiveProgressModal({} as never, { run });

		modal.open();
		modal.close();

		expect(cancel).not.toHaveBeenCalled();
	});

	it("cancels the shared run from the details action", () => {
		const run = new BatchRunController([
			{ id: "a", url: "https://a.example", filePath: "a.md" },
		]);
		const cancel = vi.spyOn(run, "cancel");
		const modal = new ArchiveProgressModal({} as never, { run });

		modal.open();
		(modal.contentEl as unknown as FakeElement)
			.findByText("Cancel")
			?.listeners.get("click")?.();

		expect(cancel).toHaveBeenCalledOnce();
	});

	it("shows Skip only for unfinished rows and cancels that item", () => {
		const run = new BatchRunController([
			{ id: "pending", url: "https://pending.example", filePath: "pending.md" },
			{ id: "done", url: "https://done.example", filePath: "done.md" },
		]);
		run.updateItem("done", "success", "Captured");
		const cancelItem = vi.spyOn(run, "cancelItem");
		const modal = new ArchiveProgressModal({} as never, { run });

		modal.open();
		const content = modal.contentEl as unknown as FakeElement;
		const skipButtons = content.findAllByText("Skip");
		skipButtons[0]?.listeners.get("click")?.();

		expect(skipButtons).toHaveLength(1);
		expect(cancelItem).toHaveBeenCalledWith("pending");
		expect(run.snapshot().items[0].status).toBe("canceled");
		expect(run.isCanceled()).toBe(false);
	});
});
