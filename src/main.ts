import { addIcon, Editor, MarkdownView, MarkdownFileInfo, Plugin } from 'obsidian';
import { ArchiverService } from './core/archiver';
import { registerCommands } from './core/commands';
import { WaybackArchiverSettingTab } from './ui/SettingsTab';
import { DEFAULT_SETTINGS, WaybackArchiverData, WaybackArchiverSettings } from './core/settings';

// Archive Box by b farias from <a href="https://thenounproject.com/browse/icons/term/archive-box/" target="_blank" title="Archive Box Icons">Noun Project</a> (CC BY 3.0)
const RIBBON_ICON = `<path d="M0,0v25h5v75h90V25h5V0H0z M90,95H10V25h80V95z M95,20H5V5h90V20z M80,55H20v35h60V55z M75,85H25V60h50V85z M70,70H30v-5h40V70z M70,80H30v-5h40V80z M32.5,45h35c4.141,0,7.5-3.357,7.5-7.5S71.641,30,67.5,30h-35c-4.141,0-7.5,3.357-7.5,7.5S28.359,45,32.5,45z M32.5,35h35c1.377,0,2.5,1.123,2.5,2.5S68.877,40,67.5,40h-35c-1.377,0-2.5-1.123-2.5-2.5S31.123,35,32.5,35z" style="fill:currentColor;fill-rule:nonzero"/>`;

export default class WaybackArchiverPlugin extends Plugin {
	// Action handlers will be assigned from ArchiverService
	archiveLinksAction!: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => Promise<void>;
	archiveAllLinksVaultAction!: () => Promise<void>;
	forceReArchiveLinksAction!: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => Promise<void>;
	forceReArchiveAllLinksAction!: () => Promise<void>;
	retryFailedArchives!: (forceReplace: boolean) => Promise<void>;

	private archiverService!: ArchiverService;

	data: WaybackArchiverData = {
		activeProfileId: 'default',
		profiles: { default: { ...DEFAULT_SETTINGS } }, 
		failedArchives: [],
		spnAccessKey: '', 
		spnSecretKey: '' 
	};

	get activeSettings(): WaybackArchiverSettings {
		return this.data.profiles[this.data.activeProfileId] ?? DEFAULT_SETTINGS;
	}

	async onload() {
		// console.log("Wayback Archiver plugin loaded - version 1.0.0");

		addIcon('wayback-ribbon', RIBBON_ICON);
		await this.loadSettings();
		// console.log("Settings loaded successfully.");

		this.archiverService = new ArchiverService(this);

		// Assign action handlers from the service
		// These assignments ensure the methods are called with the correct 'this' context (the archiverService instance)
		this.archiveLinksAction = this.archiverService.archiveLinksAction;
		this.archiveAllLinksVaultAction = this.archiverService.archiveAllLinksVaultAction;
		this.forceReArchiveLinksAction = this.archiverService.forceReArchiveLinksAction;
		this.forceReArchiveAllLinksAction = this.archiverService.forceReArchiveAllLinksAction; 
		this.retryFailedArchives = this.archiverService.retryFailedArchives;

		registerCommands(this);

		// console.log('Loading Wayback Archiver Plugin');


		this.addSettingTab(new WaybackArchiverSettingTab(this.app, this));

	} 

	onunload() {
		// console.log('Unloading Wayback Archiver Plugin');
	}

	async loadSettings() {
		const loadedData = await this.loadData();
		if (loadedData) {
			this.data = loadedData;
			if (!this.data.profiles) this.data.profiles = { default: { ...DEFAULT_SETTINGS } };
			if (!this.data.activeProfileId || !this.data.profiles[this.data.activeProfileId]) {
				this.data.activeProfileId = 'default'; // Fallback to default if active is missing
				if (!this.data.profiles.default) { // Ensure default exists if needed
					this.data.profiles.default = { ...DEFAULT_SETTINGS };
				}
			}
			if (!this.data.failedArchives) this.data.failedArchives = [];
		} else {
			this.data = {
				activeProfileId: 'default',
				profiles: { default: { ...DEFAULT_SETTINGS } },
				failedArchives: [],
				spnAccessKey: '',
				spnSecretKey: ''
			};
		}
	}

	async saveSettings() {
		await this.saveData(this.data);
	}

} 

export { WaybackArchiverPlugin };