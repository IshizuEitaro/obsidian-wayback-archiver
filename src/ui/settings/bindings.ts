import { format } from "date-fns";
import type WaybackArchiverPlugin from "../../main";
import { ArchivePolicyRule, ArchiveServiceId, WaybackArchiverSettings } from "../../core/settings";
import { parseIgnoredDomains } from "../../utils/LinkUtils";

export type DeclarativeSettingKey =
	| "profile.dateFormat"
	| "profile.archiveLinkText"
	| "profile.ignorePatternsText"
	| "profile.ignoredDomainsText"
	| "profile.archiveBareUrls"
	| "profile.pathPatternsText"
	| "profile.urlPatternsText"
	| "profile.wordPatternsText"
	| "profile.apiDelay"
	| "profile.maxRetries"
	| "profile.archiveFreshnessDays"
	| "profile.maxFreshCaptureWaitSeconds"
	| "profile.throttleRetryDelayMs"
	| "profile.maxThrottleRetries"
	| "profile.fallbackToLatestSnapshot"
	| "profile.autoClearFailedLogs"
	| "profile.provider.archiveToday"
	| "profile.provider.megalodon"
	| "profile.archiveTodayExperimentalSubmit"
	| "profile.archiveTodaySubmitDelayMs"
	| "profile.archiveTodayPendingPollIntervalMs"
	| "profile.archiveTodayPendingPollBatchSize"
	| "profile.archiveTodayMaxPendingCount"
	| "profile.archiveTodayPendingMaxWaitMs"
	| "profile.manualSaveBatchSize"
	| "profile.archivePoliciesText"
	| "profile.captureScreenshot"
	| "profile.captureAll"
	| "profile.jsBehaviorTimeout"
	| "profile.forceGet"
	| "profile.captureOutlinks";

const TEXT_ARRAY_KEYS = {
	"profile.ignorePatternsText": "ignorePatterns",
	"profile.pathPatternsText": "pathPatterns",
	"profile.urlPatternsText": "urlPatterns",
	"profile.wordPatternsText": "wordPatterns",
} as const satisfies Partial<Record<DeclarativeSettingKey, keyof WaybackArchiverSettings>>;

export function serializeArchivePolicies(rules: ArchivePolicyRule[]): string {
	return (rules ?? [])
		.map((rule) => {
			const providers = rule.providers.map((provider) =>
				provider === "archiveToday" && rule.archiveTodayExperimentalSubmit
					? "archiveToday:auto"
					: provider,
			);
			return `${rule.pattern} => ${providers.join(", ")}`;
		})
		.join("\n");
}

export function parseArchivePolicies(value: string): ArchivePolicyRule[] {
	const validProviders = new Set<ArchiveServiceId>(["wayback", "archiveToday", "megalodon"]);
	return value
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [patternPart, providerPart = ""] = line.split("=>");
			const rawProviders = providerPart
				.split(",")
				.map((provider) => provider.trim())
				.filter(Boolean);
			const archiveTodayExperimentalSubmit = rawProviders.includes("archiveToday:auto");
			const providers = rawProviders
				.map((provider) => (provider === "archiveToday:auto" ? "archiveToday" : provider))
				.filter((provider): provider is ArchiveServiceId =>
					validProviders.has(provider as ArchiveServiceId),
				);
			return {
				pattern: patternPart.trim(),
				providers: providers.length ? providers : (["wayback"] as ArchiveServiceId[]),
				archiveTodayExperimentalSubmit,
			};
		})
		.filter((rule) => rule.pattern.length > 0);
}

export function getDeclarativeSettingValue(
	plugin: WaybackArchiverPlugin,
	key: DeclarativeSettingKey,
): unknown {
	if (key in TEXT_ARRAY_KEYS) {
		const profileKey = TEXT_ARRAY_KEYS[key as keyof typeof TEXT_ARRAY_KEYS];
		return plugin.activeSettings[profileKey].join("\n");
	}
	if (key === "profile.ignoredDomainsText") {
		return plugin.activeSettings.ignoredDomains.join("\n");
	}
	if (key === "profile.provider.archiveToday") {
		return plugin.activeSettings.defaultArchiveProviders.includes("archiveToday");
	}
	if (key === "profile.provider.megalodon") {
		return plugin.activeSettings.defaultArchiveProviders.includes("megalodon");
	}
	if (key === "profile.archivePoliciesText") {
		return serializeArchivePolicies(plugin.activeSettings.archivePolicies);
	}
	const profileKey = key.slice("profile.".length) as keyof WaybackArchiverSettings;
	return plugin.activeSettings[profileKey];
}

export type BindingEffect = "none" | "visibility" | "structure";

export async function setDeclarativeSettingValue(
	plugin: WaybackArchiverPlugin,
	key: DeclarativeSettingKey,
	value: unknown,
): Promise<BindingEffect> {
	if (key === "profile.ignoredDomainsText") {
		plugin.activeSettings.ignoredDomains = parseIgnoredDomains(String(value));
	} else if (key in TEXT_ARRAY_KEYS) {
		const profileKey = TEXT_ARRAY_KEYS[key as keyof typeof TEXT_ARRAY_KEYS];
		Object.assign(plugin.activeSettings, {
			[profileKey]: String(value)
				.split("\n")
				.map((item) => item.trim())
				.filter(Boolean),
		});
	} else if (key === "profile.provider.archiveToday" || key === "profile.provider.megalodon") {
		const provider = key.endsWith("archiveToday") ? "archiveToday" : "megalodon";
		const providers = new Set(plugin.activeSettings.defaultArchiveProviders);
		if (value) providers.add(provider);
		else providers.delete(provider);
		plugin.activeSettings.defaultArchiveProviders = Array.from(providers);
	} else if (key === "profile.archivePoliciesText") {
		plugin.activeSettings.archivePolicies = parseArchivePolicies(String(value));
	} else {
		const profileKey = key.slice("profile.".length) as keyof WaybackArchiverSettings;
		Object.assign(plugin.activeSettings, { [profileKey]: value });
	}
	await plugin.saveSettings();
	return key === "profile.archiveTodayExperimentalSubmit" ? "visibility" : "none";
}

export const validateNonNegativeInteger = (value: number): string | undefined =>
	Number.isInteger(value) && value >= 0 ? undefined : "Enter a whole number of 0 or greater.";

export const validateIntegerRange =
	(min: number, max: number) =>
	(value: number): string | undefined =>
		Number.isInteger(value) && value >= min && value <= max
			? undefined
			: `Enter a whole number from ${min} to ${max}.`;

export const validateDateFormat = (value: string): string | undefined => {
	try {
		format(new Date(2000, 0, 2), value);
		return undefined;
	} catch {
		return "Enter a valid date-fns format.";
	}
};
