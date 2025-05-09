import { App, Editor, MarkdownView, MarkdownFileInfo, Notice, Plugin } from 'obsidian';
import { ConfirmationModal, ExportFormatModal } from '../ui/modals';
import { format } from 'date-fns';
import { WaybackArchiverData, WaybackArchiverSettings } from './settings';

export function registerCommands(plugin: WaybackArchiverPlugin) {
    // This creates an icon in the left ribbon.
    const ribbonIconEl = plugin.addRibbonIcon('ribbon-icon', 'Archive links in curretn note', async () => {
        const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (view) {
            await plugin.archiveLinksAction(view.editor, view);
        } else {
            new Notice('Please open a markdown file first.');
        }
    });

    plugin.addCommand({
        id: 'archive-links-current-note',
        name: 'Archive links in current note',
        editorCallback: plugin.archiveLinksAction.bind(plugin)
    });

    plugin.addCommand({
            id: 'archive-links-vault',
            name: 'Archive all links in vault',
            callback: async () => { 
                new ConfirmationModal(
                    plugin.app,
                    'Archive all links?',
                    'This will scan all markdown notes in your vault and attempt to archive external links via Archive.org. Links that already have an archive link immediately following them will be skipped. This may take a while depending on the number of notes and links.',
                    'Yes, archive all',
                    async (confirmed: boolean) => {
                        if (confirmed) {
                            await plugin.archiveAllLinksVaultAction();
                        } else {
                            new Notice('Vault-wide archiving cancelled.');
                        }
                    }
                ).open();
            }
    });


    plugin.addCommand({
        id: 'force-rearchive-links',
        name: 'Force re-archive links in current note',
        editorCallback: plugin.forceReArchiveLinksAction.bind(plugin)
    });

    plugin.addCommand({
        id: 'force-rearchive-links-vault',
        name: 'Force re-archive all links in vault',
        callback: async () => {
            new ConfirmationModal(
                plugin.app,
                'Force re-archive all links?',
                'This will scan all markdown notes in your vault and attempt to archive external links via Archive.org, *overwriting* any existing archive links immediately following them. This may take a while.',
                'Yes, force re-archive all',
                async (confirmed: boolean) => {
                    if (!confirmed) {
                        new Notice('Vault-wide force re-archiving cancelled.');
                        return;
                    }
                    await plugin.forceReArchiveAllLinksAction();

                }).open();

        }
    });

    plugin.addCommand({
        id: 'export-failed-log',
        name: 'Export failed archive log',
        callback: async () => {
            if (!plugin.data.failedArchives || plugin.data.failedArchives.length === 0) {
                new Notice('No failed archives to export.');
                return;
            }

            new ExportFormatModal(plugin.app, async (formatChoice) => {
                if (!formatChoice) {
                    new Notice('Export cancelled.');
                    return; 
                }

                const timestamp = format(new Date(), 'yyyyMMddHHmmss'); 
                let content = '';
                let filename = '';

                try {
                    const failedArchives = plugin.data.failedArchives || [];

                    if (formatChoice === 'json') {
                        content = JSON.stringify(failedArchives, null, 2);
                        filename = `wayback-archiver-failed-log-${timestamp}.json`;
                    } else { 
                        const header = 'URL,FilePath,Timestamp,Error,RetryCount';
                        const escapeCsvField = (field: string | number | undefined): string => {
                            const str = String(field ?? ''); // Handle null/undefined
                            if (str.includes(',') || str.includes('"') || str.includes('\n')) {
                                return `"${str.replace(/"/g, '""')}"`;
                            }
                            return str;
                        };

                        const rows = failedArchives.map(e => {
                            return [
                                escapeCsvField(e.url),
                                escapeCsvField(e.filePath),
                                escapeCsvField(e.timestamp),
                                escapeCsvField(e.error),
                                escapeCsvField(e.retryCount ?? 0)
                            ].join(',');
                        });
                        content = [header, ...rows].join('\n');
                        filename = `wayback-archiver-failed-log-${timestamp}.csv`;
                    }

                    const folderPath = plugin.app.vault.configDir + '/plugins/wayback-archiver/failed_logs';
                    try {
                        await plugin.app.vault.createFolder(folderPath);
                    } catch (e) {
                        if (!(e instanceof Error) || !e.message.includes('Folder already exists')) {
                            console.error('Error creating failed_logs folder:', e);
                        }
                    }
                    const fullPath = `${folderPath}/${filename}`;
                    await plugin.app.vault.create(fullPath, content);
                    new Notice(`Failed archive log exported successfully to ${fullPath}`);
                    // console.log(`Exported failed log to ${filename}`);

                    new ConfirmationModal(
                        plugin.app,
                        "Export successful",
                        "Export successful. Clear failed log list now?",
                        "Clear list",
                        async (confirmed: boolean) => {
                            if (confirmed) {
                                plugin.data.failedArchives = [];
                                await plugin.saveSettings();
                                new Notice("Failed archive log cleared.");
                            }
                        }
                    ).open();

                } catch (error: any) {
                    console.error("Error exporting failed archive log:", error);
                    new Notice(`Error exporting failed log: ${error?.message || 'Unknown error'}`);
                }
            }).open();
        }
    });

    plugin.addCommand({
        id: 'retry-failed-archives',
        name: 'Retry failed archive attempts',
        callback: async () => {
            await plugin.retryFailedArchives(false);
        }
    });
    
    plugin.addCommand({
        id: 'force-retry-failed-archives',
        name: 'Retry failed archive attempts (force replace)',
        callback: async () => {
            await plugin.retryFailedArchives(true);
        }
    });

    plugin.addCommand({
        id: 'clear-failed-archives',
        name: 'Clear failed archive log',
        callback: async () => {
            if (!plugin.data.failedArchives || plugin.data.failedArchives.length === 0) {
                new Notice('Failed archive log is already empty.');
                return;
            }
            new ConfirmationModal(
                plugin.app,
                "Clear failed archive log",
                "Are you sure you want to clear the failed archive log?",
                "Clear log",
                async (confirmed: boolean) => {
                    if (confirmed) {
                        plugin.data.failedArchives = [];
                        await plugin.saveSettings();
                        new Notice("Failed archive log cleared.");
                    }
                }
            ).open();
        }
    });
}

interface WaybackArchiverPlugin extends Plugin {
    archiveLinksAction: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => Promise<void>;
    archiveAllLinksVaultAction: () => Promise<void>;
    forceReArchiveLinksAction: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => Promise<void>;
    forceReArchiveAllLinksAction: () => Promise<void>;
    retryFailedArchives: (forceReplace: boolean) => Promise<void>;
    saveSettings: () => Promise<void>;
    loadSettings: () => Promise<void>;
    data: WaybackArchiverData;
    activeSettings: WaybackArchiverSettings;
    app: App;
}