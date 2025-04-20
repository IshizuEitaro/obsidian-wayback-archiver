export interface WaybackArchiverSettings {
	dateFormat: string;
	archiveLinkText: string;
	ignorePatterns: string[];
	substitutionRules: { find: string; replace: string; regex: boolean }[];
	apiDelay: number;
	maxRetries: number;
	archiveFreshnessDays: number;
	pathPatterns: string[];
	urlPatterns: string[];
	wordPatterns: string[];
	// SPN2 API options
	captureScreenshot: boolean;
	captureAll: boolean;
	jsBehaviorTimeout: number;
	forceGet: boolean;
	captureOutlinks: boolean;
	//
	autoClearFailedLogs: boolean;
}

export const DEFAULT_SETTINGS: WaybackArchiverSettings = {
	dateFormat: 'yyyy-MM-dd',
	archiveLinkText: '(Archived on {date})',
	ignorePatterns: ['web.archive.org/'],
	substitutionRules: [],
	apiDelay: 2000, // Default 2 seconds delay
	maxRetries: 3,
	archiveFreshnessDays: 0, // 0 means always archive if not present
	pathPatterns: [],
	urlPatterns: [],
	wordPatterns: [],
	// SPN2 API options defaults
	captureScreenshot: false,
	captureAll: false,
	jsBehaviorTimeout: 0,
	forceGet: false,
	captureOutlinks: false,
	//
	autoClearFailedLogs: false
}

export interface FailedArchiveEntry {
	url: string;
	filePath: string;
	timestamp: number;
	error: string;
	retryCount: number;
}

export interface WaybackArchiverData {
	activeProfileId: string;
	profiles: Record<string, WaybackArchiverSettings>;
	failedArchives?: FailedArchiveEntry[];
	spnAccessKey: string;
	spnSecretKey: string;
}