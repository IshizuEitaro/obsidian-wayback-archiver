import { FAILED_ARCHIVE_STAGE_VALUES, ARCHIVE_PROVIDER_ID_VALUES } from "./settings";
import type { FailedArchiveEntry, FailedArchiveStage, ArchiveProviderId } from "./settings";

const FAILED_ARCHIVE_STAGE_SET = new Set<string>(FAILED_ARCHIVE_STAGE_VALUES);
const ARCHIVE_PROVIDER_ID_SET = new Set<string>(ARCHIVE_PROVIDER_ID_VALUES);

function parseStage(value: string | undefined): FailedArchiveStage | undefined {
	return value && FAILED_ARCHIVE_STAGE_SET.has(value) ? (value as FailedArchiveStage) : undefined;
}

function parseManualProviderIds(value: string | undefined): ArchiveProviderId[] | undefined {
	const ids = (value ?? "")
		.split(";")
		.map((v) => v.trim())
		.filter((v): v is ArchiveProviderId => ARCHIVE_PROVIDER_ID_SET.has(v));

	return ids.length ? ids : undefined;
}

function parseIntegerOrUndefined(value: string | undefined): number | undefined {
	if (!value) return undefined;
	if (!/^\d+$/.test(value.trim())) return undefined;

	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export const FAILED_LOG_CSV_HEADERS = [
	"URL",
	"TargetURL",
	"FilePath",
	"Timestamp",
	"Error",
	"RetryCount",
	"Stage",
	"ManualProviderIds",
	"ManualOpenedAt",
	"ManualOpenCount",
] as const;

export function serializeFailedArchiveEntriesToCsv(entries: FailedArchiveEntry[]): string {
	const escapeField = (field: string | number | undefined): string => {
		const str = String(field ?? "");
		// Escape commas, quotes, newlines, and carriage returns
		if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
			return `"${str.replace(/"/g, '""')}"`;
		}
		return str;
	};

	const header = FAILED_LOG_CSV_HEADERS.join(",");
	const rows = entries.map((e) =>
		[
			escapeField(e.url),
			escapeField(e.targetUrl ?? ""),
			escapeField(e.filePath),
			escapeField(e.timestamp),
			escapeField(e.error),
			escapeField(e.retryCount ?? 0),
			escapeField(e.stage ?? ""),
			escapeField(e.manualProviderIds?.join(";") ?? ""),
			escapeField(e.manualOpenedAt ?? ""),
			escapeField(e.manualOpenCount ?? ""),
		].join(","),
	);

	return [header, ...rows].join("\n");
}

/**
 * Parses raw CSV string to 2D array of string fields.
 * Handles quoted fields containing commas, double quotes, and newlines.
 * Unclosed quotes are parsed using best-effort recovery.
 * This is intentionally a small local parser rather than a general-purpose CSV
 * implementation. It supports the cases produced by
 * serializeFailedArchiveEntriesToCsv(): quoted fields, escaped quotes, commas,
 * CR/LF record separators, and quoted newlines.
 */
export function parseCsvContent(csvContent: string): string[][] {
	const records: string[][] = [];
	let currentRecord: string[] = [];
	let currentField = "";
	let inQuotes = false;
	let i = 0;

	while (i < csvContent.length) {
		const char = csvContent[i];
		const nextChar = csvContent[i + 1];

		if (char === '"') {
			if (inQuotes && nextChar === '"') {
				// Escaped quote inside quoted field
				currentField += '"';
				i += 2;
			} else {
				// Toggle quote context
				inQuotes = !inQuotes;
				i++;
			}
		} else if (char === "," && !inQuotes) {
			// Field separator
			currentRecord.push(currentField);
			currentField = "";
			i++;
		} else if ((char === "\r" || char === "\n") && !inQuotes) {
			// Record separator
			currentRecord.push(currentField);
			if (currentRecord.length > 1 || currentRecord[0] !== "") {
				records.push(currentRecord);
			}
			currentRecord = [];
			currentField = "";
			if (char === "\r" && nextChar === "\n") {
				i += 2;
			} else {
				i++;
			}
		} else {
			currentField += char;
			i++;
		}
	}

	// Flush the final field and record (Best-effort handling of unclosed quotes)
	if (currentField !== "" || currentRecord.length > 0) {
		currentRecord.push(currentField);
		if (currentRecord.length > 1 || currentRecord[0] !== "") {
			records.push(currentRecord);
		}
	}

	return records;
}

export function parseFailedArchiveEntriesFromCsv(csvContent: string): FailedArchiveEntry[] {
	const records = parseCsvContent(csvContent);
	if (records.length === 0) return [];

	const headerLine = records[0];
	const headers = headerLine.map((h) => h.trim().toLowerCase());

	const entries: FailedArchiveEntry[] = [];
	for (let i = 1; i < records.length; i++) {
		const values = records[i];
		if (values.length === 0 || (values.length === 1 && values[0] === "")) {
			continue;
		}

		const entryMap: Record<string, string> = {};
		headers.forEach((header, index) => {
			entryMap[header] = values[index] ?? "";
		});

		const url = entryMap["url"] || "";
		if (!url) continue;

		const stageVal = parseStage(entryMap["stage"]);
		const manualProviderIdsVal = parseManualProviderIds(entryMap["manualproviderids"]);

		const timestamp = parseIntegerOrUndefined(entryMap["timestamp"]);
		if (timestamp === undefined) {
			console.warn(`Skipping entry with missing timestamp: ${url}`);
			continue;
		}
		const retryCount = parseIntegerOrUndefined(entryMap["retrycount"]) ?? 0;
		const manualOpenedAt = parseIntegerOrUndefined(entryMap["manualopenedat"]);
		const manualOpenCount = parseIntegerOrUndefined(entryMap["manualopencount"]);

		// Distinguish optional/non-optional field string parsing:
		// - targetUrl is optional (string | undefined), so empty string is converted to undefined.
		// - filePath and error are non-optional (string), so empty string fallback is preserved.
		entries.push({
			url,
			targetUrl: entryMap["targeturl"] || undefined,
			filePath: entryMap["filepath"] || "",
			timestamp,
			error: entryMap["error"] || "",
			retryCount,
			stage: stageVal,
			manualProviderIds: manualProviderIdsVal,
			manualOpenedAt,
			manualOpenCount,
		});
	}

	return entries;
}
