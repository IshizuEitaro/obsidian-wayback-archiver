import { describe, expect, it, vi } from "vitest";

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

import { ArchiveConfirmationModal } from "./ArchiveConfirmationModal";

const summary = {
	noteCount: 2,
	linkCount: 3,
	uniqueUrlCount: 2,
	items: [],
};

describe("ArchiveConfirmationModal", () => {
	it("shows Vault-wide counts and starts only after closing", () => {
		const events: string[] = [];
		const modal = new ArchiveConfirmationModal({} as never, {
			summary,
			title: "Archive all links in vault?",
			onStart: () => events.push("start"),
		});
		vi.spyOn(modal, "close").mockImplementation(() => {
			events.push("close");
			modal.onClose();
		});

		modal.open();
		const content = modal.contentEl as unknown as FakeElement;
		expect(content.allText).toContain("2 notes");
		expect(content.allText).toContain("3 links");
		content.findByText("Start")?.listeners.get("click")?.();

		expect(events).toEqual(["close", "start"]);
	});

	it("dismisses without starting or canceling unrelated work", () => {
		const onStart = vi.fn();
		const modal = new ArchiveConfirmationModal({} as never, { summary, onStart });
		modal.open();

		(modal.contentEl as unknown as FakeElement)
			.findByText("Cancel")
			?.listeners.get("click")?.();

		expect(onStart).not.toHaveBeenCalled();
		expect((modal.contentEl as unknown as FakeElement).allText.trim()).toBe("");
	});
});
