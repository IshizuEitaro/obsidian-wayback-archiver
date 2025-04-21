import { App, Modal } from 'obsidian';

class ConfirmationModal extends Modal {
	onSubmit: (result: boolean) => void;
	titleText: string;
	messageText: string;
	confirmButtonText: string;

	constructor(app: App, title: string, message: string, confirmText: string, onSubmit: (result: boolean) => void) {
		super(app);
		this.titleText = title;
		this.messageText = message;
		this.confirmButtonText = confirmText;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: this.titleText });
		contentEl.createEl('p', { text: this.messageText });
		contentEl.createEl('p', { text: 'Do you want to proceed?' }); // Keep this generic question

		const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

		const confirmButton = buttonContainer.createEl('button', { text: this.confirmButtonText, cls: 'mod-cta' });
		confirmButton.addEventListener('click', () => {
			this.close();
			this.onSubmit(true);
		});

		const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
		cancelButton.addEventListener('click', () => {
			this.close();
			this.onSubmit(false);
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class ProfileNameModal extends Modal {
    onSubmit: (name: string | null) => void;
    initialValue?: string;

    constructor(app: App, onSubmit: (name: string | null) => void, initialValue?: string) {
        super(app);
        this.onSubmit = onSubmit;
        this.initialValue = initialValue;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Enter Profile Name' });

        const inputEl = contentEl.createEl('input', { type: 'text', placeholder: 'Enter profile name' });
        inputEl.classList.add('inputEl');
        if (this.initialValue) {
            inputEl.value = this.initialValue;
        }
        inputEl.focus();

        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

        const okButton = buttonContainer.createEl('button', { text: 'OK', cls: 'mod-cta' });
        okButton.addEventListener('click', () => {
            const value = inputEl.value.trim();
            this.close();
            this.onSubmit(value || null);
        });

        const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelButton.addEventListener('click', () => {
            this.close();
            this.onSubmit(null);
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class ExportFormatModal extends Modal {
	onSubmit: (format: 'csv' | 'json' | null) => void;

	constructor(app: App, onSubmit: (format: 'csv' | 'json' | null) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'Choose Export Format' });
		contentEl.createEl('p', { text: 'Select the format for the failed archive log:' });

		const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

        const jsonButton = buttonContainer.createEl('button', { text: 'JSON', cls: 'mod-cta' });
		jsonButton.addEventListener('click', () => {
			this.close();
			this.onSubmit('json');
		});

		const csvButton = buttonContainer.createEl('button', { text: 'CSV', cls: 'mod-cta' });
		csvButton.addEventListener('click', () => {
			this.close();
			this.onSubmit('csv');
		});

		const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
		cancelButton.addEventListener('click', () => {
			this.close();
			this.onSubmit(null);
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class FileSelectModal extends Modal {
    fileList: string[];
    onSubmit: (selectedFileName: string | null) => void;

    constructor(app: App, fileList: string[], onSubmit: (selectedFileName: string | null) => void) {
        super(app);
        this.fileList = fileList;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Select Failed Log File' });
        contentEl.createEl('p', { text: 'Choose a failed archive log file to retry:' });

        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

        this.fileList.forEach(fileName => {
            const fileNameOnly = fileName.split('/').pop() || fileName;
            const fileButton = buttonContainer.createEl('button', { text: fileNameOnly, cls: 'mod-cta' });
            fileButton.addEventListener('click', () => {
                this.close();
                this.onSubmit(fileName);
            });
        });

        const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelButton.addEventListener('click', () => {
            this.close();
            this.onSubmit(null);
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

export { ConfirmationModal, ProfileNameModal, ExportFormatModal, FileSelectModal };