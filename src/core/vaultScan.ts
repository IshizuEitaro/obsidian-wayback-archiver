export interface ArchiveWorkItem {
	id: string;
	filePath: string;
	url: string;
	approximateIndex: number;
	isForce: boolean;
}

export interface ArchiveScanSummary {
	noteCount: number;
	linkCount: number;
	uniqueUrlCount: number;
	items: ArchiveWorkItem[];
}

export function summarizeArchiveWork(items: ArchiveWorkItem[]): ArchiveScanSummary {
	return {
		noteCount: new Set(items.map((item) => item.filePath)).size,
		linkCount: items.length,
		uniqueUrlCount: new Set(items.map((item) => item.url)).size,
		items,
	};
}
