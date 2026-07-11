import { App, Modal, Notice } from "obsidian";
import { runAsyncAction } from "../utils/async";

type ModalSubmit<T> = (result: T) => void | Promise<void>;

const submitModalResult = <T>(onSubmit: ModalSubmit<T>, result: T): void => {
	runAsyncAction(
		() => onSubmit(result),
		(error: unknown) => {
			console.error("Error handling modal submission:", error);
			new Notice("The requested action could not be completed.");
		},
	);
};

class ConfirmationModal extends Modal {
	onSubmit: ModalSubmit<boolean>;
	titleText: string;
	messageText: string;
	confirmButtonText: string;

	constructor(
		app: App,
		title: string,
		message: string,
		confirmText: string,
		onSubmit: ModalSubmit<boolean>,
	) {
		super(app);
		this.titleText = title;
		this.messageText = message;
		this.confirmButtonText = confirmText;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: this.titleText });
		contentEl.createEl("p", { text: this.messageText });
		contentEl.createEl("p", { text: "Do you want to proceed?" }); // Keep this generic question

		const buttonContainer = contentEl.createDiv({
			cls: "modal-button-container",
		});

		const confirmButton = buttonContainer.createEl("button", {
			text: this.confirmButtonText,
			cls: "mod-cta",
		});
		confirmButton.addEventListener("click", () => {
			this.close();
			submitModalResult(this.onSubmit, true);
		});

		const cancelButton = buttonContainer.createEl("button", {
			text: "Cancel",
		});
		cancelButton.addEventListener("click", () => {
			this.close();
			submitModalResult(this.onSubmit, false);
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class ProfileNameModal extends Modal {
	onSubmit: ModalSubmit<string | null>;
	initialValue?: string;

	constructor(app: App, onSubmit: ModalSubmit<string | null>, initialValue?: string) {
		super(app);
		this.onSubmit = onSubmit;
		this.initialValue = initialValue;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Enter profile name" });

		const inputEl = contentEl.createEl("input", {
			type: "text",
			placeholder: "Enter profile name",
			cls: "wa-inputEl",
		});
		if (this.initialValue) {
			inputEl.value = this.initialValue;
		}
		inputEl.focus();

		const buttonContainer = contentEl.createDiv({
			cls: "modal-button-container",
		});

		const okButton = buttonContainer.createEl("button", {
			text: "OK",
			cls: "mod-cta",
		});
		okButton.addEventListener("click", () => {
			const value = inputEl.value.trim();
			this.close();
			submitModalResult(this.onSubmit, value || null);
		});

		const cancelButton = buttonContainer.createEl("button", {
			text: "Cancel",
		});
		cancelButton.addEventListener("click", () => {
			this.close();
			submitModalResult(this.onSubmit, null);
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class ExportFormatModal extends Modal {
	onSubmit: ModalSubmit<"csv" | "json" | null>;

	constructor(app: App, onSubmit: ModalSubmit<"csv" | "json" | null>) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Choose export format" });
		contentEl.createEl("p", {
			text: "Select the format for the failed archive log:",
		});

		const buttonContainer = contentEl.createDiv({
			cls: "modal-button-container",
		});

		const jsonButton = buttonContainer.createEl("button", {
			text: "JSON",
			cls: "mod-cta",
		});
		jsonButton.addEventListener("click", () => {
			this.close();
			submitModalResult(this.onSubmit, "json");
		});

		const csvButton = buttonContainer.createEl("button", {
			text: "CSV",
			cls: "mod-cta",
		});
		csvButton.addEventListener("click", () => {
			this.close();
			submitModalResult(this.onSubmit, "csv");
		});

		const cancelButton = buttonContainer.createEl("button", {
			text: "Cancel",
		});
		cancelButton.addEventListener("click", () => {
			this.close();
			submitModalResult(this.onSubmit, null);
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class FileSelectModal extends Modal {
	fileList: string[];
	onSubmit: ModalSubmit<string | null>;

	constructor(app: App, fileList: string[], onSubmit: ModalSubmit<string | null>) {
		super(app);
		this.fileList = fileList;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Select failed log file" });
		contentEl.createEl("p", {
			text: "Choose a failed archive log file to retry:",
		});

		const buttonContainer = contentEl.createDiv({
			cls: "modal-button-container",
		});

		this.fileList.forEach((fileName) => {
			const fileNameOnly = fileName.split("/").pop() || fileName;
			const fileButton = buttonContainer.createEl("button", {
				text: fileNameOnly,
				cls: "mod-cta",
			});
			fileButton.addEventListener("click", () => {
				this.close();
				submitModalResult(this.onSubmit, fileName);
			});
		});

		const cancelButton = buttonContainer.createEl("button", {
			text: "Cancel",
		});
		cancelButton.addEventListener("click", () => {
			this.close();
			submitModalResult(this.onSubmit, null);
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

export { ConfirmationModal, ProfileNameModal, ExportFormatModal, FileSelectModal };
