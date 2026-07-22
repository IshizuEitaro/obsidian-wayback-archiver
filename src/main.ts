import { addIcon, Editor, MarkdownView, MarkdownFileInfo, Plugin } from "obsidian";
import { ArchiverService } from "./core/archiver";
import { registerCommands } from "./core/commands";
import { WaybackArchiverSettingTab } from "./ui/SettingsTab";
import {
	DEFAULT_SETTINGS,
	migrateSecretStorage,
	normalizeProfileSettings,
	WaybackArchiverData,
	WaybackArchiverSettings,
} from "./core/settings";
import { ArchiveScanSummary } from "./core/vaultScan";
import { BatchRunController } from "./core/batchRun";
import { ArchiveProgressModal } from "./ui/ArchiveProgressModal";
import { registerContextMenus } from "./core/contextMenus";
import { TFile } from "obsidian";

// Archive Box by b farias from <a href="https://thenounproject.com/browse/icons/term/archive-box/" target="_blank" title="Archive Box Icons">Noun Project</a> (CC BY 3.0)
const RIBBON_ICON = `<path d="M0,0v25h5v75h90V25h5V0H0z M90,95H10V25h80V95z M95,20H5V5h90V20z M80,55H20v35h60V55z M75,85H25V60h50V85z M70,70H30v-5h40V70z M70,80H30v-5h40V80z M32.5,45h35c4.141,0,7.5-3.357,7.5-7.5S71.641,30,67.5,30h-35c-4.141,0-7.5,3.357-7.5,7.5S28.359,45,32.5,45z M32.5,35h35c1.377,0,2.5,1.123,2.5,2.5S68.877,40,67.5,40h-35c-1.377,0-2.5-1.123-2.5-2.5S31.123,35,32.5,35z" style="fill:currentColor;fill-rule:nonzero"/>`;

export default class WaybackArchiverPlugin extends Plugin {
	// Action handlers will be assigned from ArchiverService
	archiveLinksAction!: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => Promise<void>;
	archiveAllLinksVaultAction!: () => Promise<void>;
	submitAllLinksVaultToArchiveTodayAction!: () => Promise<void>;
	insertLatestFallbackSnapshotsVaultAction!: (
		providerId: "archiveToday" | "megalodon",
		isForce: boolean,
	) => Promise<void>;
	forceReArchiveLinksAction!: (
		editor: Editor,
		ctx: MarkdownView | MarkdownFileInfo,
	) => Promise<void>;
	forceReArchiveAllLinksAction!: () => Promise<void>;
	retryFailedArchives!: (forceReplace: boolean) => Promise<void>;
	openManualSavePagesForFailedArchives!: ArchiverService["openManualSavePagesForFailedArchives"];
	archiveLinksInCurrentNoteToArchiveTodayAction!: (
		editor: Editor,
		ctx: MarkdownView | MarkdownFileInfo,
	) => Promise<void>;
	insertLatestFallbackSnapshotAction!: (
		editor: Editor,
		ctx: MarkdownView | MarkdownFileInfo,
		providerId: "archiveToday" | "megalodon",
		isForce: boolean,
	) => Promise<void>;
	runPendingQueueCycle!: () => Promise<void>;
	scanVaultForArchiving!: (isForce: boolean) => Promise<ArchiveScanSummary>;
	archiveScannedLinksAction!: (
		summary: ArchiveScanSummary,
		run: BatchRunController,
	) => Promise<void>;
	archiveFilesAction!: (files: TFile[], isForce: boolean) => Promise<void>;
	archiveUrlScopeAction!: (
		file: TFile,
		sourceUrl: string,
		isForce: boolean,
	) => Promise<void>;

	statusBarItem: HTMLElement | null = null;
	private archiverService!: ArchiverService;
	private isUnloaded = false;
	activeArchiveRun: BatchRunController | null = null;
	private activeArchiveProgressModal: ArchiveProgressModal | null = null;
	private activeRunUnsubscribe: (() => void) | null = null;

	data: WaybackArchiverData = {
		activeProfileId: "default",
		profiles: { default: { ...DEFAULT_SETTINGS } },
		failedArchives: [],
		pendingArchives: [],
		spnAccessKey: "",
		spnSecretKey: "",
	};

	get activeSettings(): WaybackArchiverSettings {
		return this.data.profiles[this.data.activeProfileId] ?? DEFAULT_SETTINGS;
	}

	async onload() {
		this.isUnloaded = false;
		// console.log("Wayback Archiver plugin loaded - version 1.0.0");

		addIcon("wayback-ribbon", RIBBON_ICON);
		await this.loadSettings();
		// console.log("Settings loaded successfully.");

		this.statusBarItem = this.addStatusBarItem();
		this.setStatusBarText("");
		this.statusBarItem.classList.add("wayback-status-clickable");
		this.statusBarItem.addEventListener("click", () => {
			if (!this.activeArchiveRun || !this.activeArchiveProgressModal) return;
			this.activeArchiveProgressModal.open();
			this.activeArchiveProgressModal.showProgress();
		});

		this.archiverService = new ArchiverService(this);
		this.bindArchiverActions();
		registerContextMenus(this);

		this.app.workspace.onLayoutReady(() => {
			if (this.isUnloaded) return;
			this.archiverService.startPendingQueueScheduler();
		});

		registerCommands(this);

		// console.log('Loading Wayback Archiver Plugin');

		this.addSettingTab(new WaybackArchiverSettingTab(this.app, this));
	}

	private bindArchiverActions(): void {
		this.archiveLinksAction = this.archiverService.archiveLinksAction;
		this.archiveAllLinksVaultAction = this.archiverService.archiveAllLinksVaultAction;
		this.submitAllLinksVaultToArchiveTodayAction =
			this.archiverService.submitAllLinksVaultToArchiveTodayAction;
		this.insertLatestFallbackSnapshotsVaultAction =
			this.archiverService.insertLatestFallbackSnapshotsVaultAction;
		this.forceReArchiveLinksAction = this.archiverService.forceReArchiveLinksAction;
		this.forceReArchiveAllLinksAction = this.archiverService.forceReArchiveAllLinksAction;
		this.retryFailedArchives = this.archiverService.retryFailedArchives;
		this.openManualSavePagesForFailedArchives =
			this.archiverService.openManualSavePagesForFailedArchives;
		this.archiveLinksInCurrentNoteToArchiveTodayAction =
			this.archiverService.archiveLinksInCurrentNoteToArchiveTodayAction;
		this.insertLatestFallbackSnapshotAction =
			this.archiverService.insertLatestFallbackSnapshotAction;
		this.runPendingQueueCycle = () => this.archiverService.runPendingQueueCycle();
		this.scanVaultForArchiving = (isForce) =>
			this.archiverService.scanVaultForArchiving(isForce);
		this.archiveScannedLinksAction = (summary, run) =>
			this.archiverService.archiveScannedLinksAction(summary, run);
		this.archiveFilesAction = (files, isForce) =>
			this.archiverService.archiveFilesAction(files, isForce);
		this.archiveUrlScopeAction = (file, sourceUrl, isForce) =>
			this.archiverService.archiveUrlScopeAction(file, sourceUrl, isForce);
	}

	startArchiveRun(
		summary: ArchiveScanSummary,
		title: string,
		additionalCounts: Array<{ label: string; value: number }> = [],
	): void {
		this.activeRunUnsubscribe?.();
		const run = new BatchRunController(
			summary.items.map(({ id, url, filePath }) => ({ id, url, filePath })),
		);
		const modal = new ArchiveProgressModal(this.app, {
			summary,
			run,
			title,
			additionalCounts,
			onStart: () => this.archiveScannedLinksAction(summary, run),
		});
		this.activeArchiveRun = run;
		this.activeArchiveProgressModal = modal;
		this.activeRunUnsubscribe = run.subscribe((snapshot) => {
			if (snapshot.canceled) {
				this.setStatusBarText(
					`Canceled · ${snapshot.completed}/${snapshot.total} complete`,
				);
			} else {
				this.setStatusBarText(
					`⌛ ${snapshot.completed}/${snapshot.total} · ${snapshot.succeeded} saved · ${snapshot.failed} failed`,
				);
			}
			if (snapshot.finished) {
				window.setTimeout(() => {
					if (this.activeArchiveRun !== run) return;
					this.activeRunUnsubscribe?.();
					this.activeRunUnsubscribe = null;
					this.activeArchiveRun = null;
					this.activeArchiveProgressModal = null;
					this.setStatusBarText("");
				}, 5000);
			}
		});
		modal.open();
	}

	setStatusBarText(text: string) {
		if (this.statusBarItem) {
			this.statusBarItem.setText(text);
		}
	}

	onunload() {
		// console.log('Unloading Wayback Archiver Plugin');
		this.isUnloaded = true;
		this.activeArchiveRun?.cancel();
		this.activeRunUnsubscribe?.();
		this.archiverService?.stopPendingQueueScheduler();
	}

	async loadSettings() {
		const loadedData = await this.loadData();
		if (loadedData) {
			this.data = loadedData;
			if (!this.data.profiles) {
				this.data.profiles = { default: normalizeProfileSettings(undefined) };
			}

			if (!this.data.activeProfileId || !this.data.profiles[this.data.activeProfileId]) {
				this.data.activeProfileId = "default";
				if (!this.data.profiles.default) {
					this.data.profiles.default = normalizeProfileSettings(undefined);
				}
			}

			for (const profileId of Object.keys(this.data.profiles)) {
				this.data.profiles[profileId] = normalizeProfileSettings(
					this.data.profiles[profileId],
				);
			}
			if (!this.data.failedArchives) this.data.failedArchives = [];
			if (!this.data.pendingArchives) this.data.pendingArchives = [];
		} else {
			this.data = {
				activeProfileId: "default",
				profiles: { default: normalizeProfileSettings(undefined) },
				failedArchives: [],
				pendingArchives: [],
				spnAccessKey: "",
				spnSecretKey: "",
			};
		}

		const migrated = await migrateSecretStorage(this.app, this.data);
		if (migrated) {
			await this.saveSettings();
		}
	}

	async saveSettings() {
		await this.saveData(this.data);
	}
}

export { WaybackArchiverPlugin };
