import type {
	SettingControl,
	SettingDefinition,
	SettingDefinitionItem,
	SettingDefinitionPage,
} from "obsidian";
import { SecretComponent } from "obsidian";
import type WaybackArchiverPlugin from "../../main";
import {
	DeclarativeSettingKey,
	validateDateFormat,
	validateIntegerRange,
	validateNonNegativeInteger,
} from "./bindings";
import {
	addSubstitutionRule,
	deleteSubstitutionRule,
	purgeStoredPlaintextCredentials,
	reorderSubstitutionRule,
	switchCredentialStorageMode,
	updateSubstitutionRule,
} from "./shared";

export interface SettingDefinitionContext {
	plugin: WaybackArchiverPlugin;
	refresh(structural: boolean): void;
	createProfile(): Promise<void>;
	renameProfile(): Promise<void>;
	deleteProfile(): Promise<void>;
}

const profileControl = (
	name: string,
	desc: string,
	control: SettingControl<DeclarativeSettingKey>,
	extra: Pick<SettingDefinition, "aliases" | "visible"> = {},
): SettingDefinition<DeclarativeSettingKey> => ({ name, desc, control, ...extra });

const textArea = (key: DeclarativeSettingKey): SettingControl<DeclarativeSettingKey> => ({
	type: "textarea",
	key,
	rows: 5,
});

function buildCredentialGroup(
	context: SettingDefinitionContext,
): SettingDefinitionItem<DeclarativeSettingKey> {
	const { plugin } = context;
	const isSecretMode = () => plugin.data.spnCredentialStorageMode === "secretStorage";
	return {
		type: "group",
		heading: "Archive.org API keys",
		items: [
			{
				name: "API key storage method",
				desc: "Choose SecretStorage or plaintext data.json storage.",
				render: (setting) => {
					setting.addDropdown((dropdown) => {
						dropdown
							.addOption("secretStorage", "SecretStorage")
							.addOption("plaintext", "Plaintext data.json")
							.setValue(plugin.data.spnCredentialStorageMode ?? "plaintext")
							.onChange(async (mode) => {
								await switchCredentialStorageMode(
									plugin,
									mode as "secretStorage" | "plaintext",
								);
								context.refresh(true);
							});
					});
				},
			},
			{
				name: "Archive.org SPN access key",
				desc: "Credential used by the SPN API v2.",
				render: (setting) => {
					if (isSecretMode()) {
						const name = plugin.data.spnAccessKeySecretName ?? "WaybackArchiver_spnAccessKey";
						new SecretComponent(plugin.app, setting.controlEl)
							.setValue(plugin.app.secretStorage.getSecret(name) ?? "")
							.onChange(async (value) => {
								plugin.app.secretStorage.setSecret(name, value);
								plugin.data.spnAccessKeySecretName = name;
								await plugin.saveSettings();
							});
					} else {
						setting.addText((text) => {
							text.inputEl.type = "password";
							text.setValue(plugin.data.spnAccessKey ?? "").onChange(async (value) => {
								plugin.data.spnAccessKey = value;
								await plugin.saveSettings();
							});
						});
					}
				},
			},
			{
				name: "Archive.org SPN secret key",
				desc: "Secret credential used by the SPN API v2.",
				render: (setting) => {
					if (isSecretMode()) {
						const name = plugin.data.spnSecretKeySecretName ?? "WaybackArchiver_spnSecretKey";
						new SecretComponent(plugin.app, setting.controlEl)
							.setValue(plugin.app.secretStorage.getSecret(name) ?? "")
							.onChange(async (value) => {
								plugin.app.secretStorage.setSecret(name, value);
								plugin.data.spnSecretKeySecretName = name;
								await plugin.saveSettings();
							});
					} else {
						setting.addText((text) => {
							text.inputEl.type = "password";
							text.setValue(plugin.data.spnSecretKey ?? "").onChange(async (value) => {
								plugin.data.spnSecretKey = value;
								await plugin.saveSettings();
							});
						});
					}
				},
			},
			{
				name: "Purge plaintext API keys",
				desc: "Remove legacy plaintext credentials after synced devices import them.",
				visible: () =>
					isSecretMode() && Boolean(plugin.data.spnAccessKey || plugin.data.spnSecretKey),
				render: (setting) => {
					setting.addButton((button) =>
						button.setButtonText("Purge plaintext keys").onClick(async () => {
							await purgeStoredPlaintextCredentials(plugin);
							context.refresh(true);
						}),
					);
				},
			},
		],
	};
}

function buildProfileGroup(
	context: SettingDefinitionContext,
): SettingDefinitionItem<DeclarativeSettingKey> {
	const { plugin } = context;
	return {
		type: "group",
		heading: "Profiles",
		items: [
			{
				name: "Active profile",
				desc: "Choose which settings profile is active.",
				render: (setting) => {
					setting.addDropdown((dropdown) => {
						for (const profileId of Object.keys(plugin.data.profiles)) {
							dropdown.addOption(profileId, profileId);
						}
						dropdown.setValue(plugin.data.activeProfileId).onChange(async (value) => {
							plugin.data.activeProfileId = value;
							await plugin.saveSettings();
							context.refresh(true);
						});
					});
				},
			},
			{
				name: "Profile actions",
				desc: "Create, rename, or delete profiles.",
				render: (setting) => {
					setting.addButton((button) =>
						button.setButtonText("Create").onClick(() => void context.createProfile()),
					);
					setting.addButton((button) =>
						button
							.setButtonText("Rename")
							.setDisabled(plugin.data.activeProfileId === "default")
							.onClick(() => void context.renameProfile()),
					);
					setting.addButton((button) =>
						button
							.setButtonText("Delete")
							.setDisabled(plugin.data.activeProfileId === "default")
							.onClick(() => void context.deleteProfile()),
					);
				},
			},
		],
	};
}

function buildSubstitutionList(
	context: SettingDefinitionContext,
): SettingDefinitionItem<DeclarativeSettingKey> {
	const { plugin } = context;
	return {
		type: "list",
		heading: "URL substitution rules",
		emptyState: "No substitution rules defined.",
		items: plugin.activeSettings.substitutionRules.map((rule) => ({
			name: rule.find || "New substitution rule",
			desc: rule.regex ? "Regular expression" : "Plain text",
			render: (setting) => {
				setting.addText((text) =>
					text.setPlaceholder("Find").setValue(rule.find).onChange((value) =>
						updateSubstitutionRule(plugin, rule, { find: value }),
					),
				);
				setting.addText((text) =>
					text.setPlaceholder("Replace").setValue(rule.replace).onChange((value) =>
						updateSubstitutionRule(plugin, rule, { replace: value }),
					),
				);
				setting.addToggle((toggle) =>
					toggle.setValue(rule.regex).onChange((value) =>
						updateSubstitutionRule(plugin, rule, { regex: value }),
					),
				);
			},
		})),
		addItem: {
			name: "Add substitution rule",
			action: () => void addSubstitutionRule(plugin).then(() => context.refresh(true)),
		},
		onDelete: (index) =>
			void deleteSubstitutionRule(plugin, index).then(() => context.refresh(true)),
		onReorder: (oldIndex, newIndex) =>
			void reorderSubstitutionRule(plugin, oldIndex, newIndex).then(() =>
				context.refresh(true),
			),
	};
}

function buildFilteringPage(): SettingDefinitionPage<DeclarativeSettingKey> {
	return {
		type: "page",
		name: "Filtering rules",
		items: [
			profileControl(
				"Legacy ignore URL patterns",
				"Regular expressions or text patterns, one per line.",
				textArea("profile.ignorePatternsText"),
			),
			profileControl(
				"Ignored domains",
				"Exact domains and their subdomains, separated by commas or new lines.",
				textArea("profile.ignoredDomainsText"),
			),
			profileControl(
				"Archive bare URLs",
				"Archive pasted URLs that are not wrapped in Markdown or HTML links.",
				{ type: "toggle", key: "profile.archiveBareUrls" },
			),
			profileControl("Path patterns", "Eligible note paths.", textArea("profile.pathPatternsText")),
			profileControl("URL patterns", "Eligible link URLs.", textArea("profile.urlPatternsText")),
			profileControl(
				"Word/phrase patterns",
				"Required note content.",
				textArea("profile.wordPatternsText"),
			),
		],
	};
}

function buildAdvancedPage(): SettingDefinitionPage<DeclarativeSettingKey> {
	return {
		type: "page",
		name: "Advanced",
		items: [
			profileControl(
				"API request delay",
				"Delay between requests in milliseconds.",
				{ type: "slider", key: "profile.apiDelay", min: 500, max: 10_000, step: 100 },
				{ aliases: ["request interval"] },
			),
			profileControl("Max status check retries", "Maximum status checks.", {
				type: "slider",
				key: "profile.maxRetries",
				min: 1,
				max: 10,
				step: 1,
			}),
			profileControl("Archive freshness", "Freshness window in days.", {
				type: "number",
				key: "profile.archiveFreshnessDays",
				min: 0,
				max: 36_500,
				step: 1,
				validate: validateIntegerRange(0, 36_500),
			}),
			profileControl("Maximum wait for fresh captures", "Maximum wait in seconds.", {
				type: "number",
				key: "profile.maxFreshCaptureWaitSeconds",
				min: 1,
				step: 1,
				validate: validateIntegerRange(1, 86_400),
			}),
			profileControl("Throttle retry delay", "Delay between throttle retries in ms.", {
				type: "number",
				key: "profile.throttleRetryDelayMs",
				min: 0,
				step: 1,
				validate: validateNonNegativeInteger,
			}),
			profileControl("Maximum throttle retries", "Maximum throttle retries.", {
				type: "number",
				key: "profile.maxThrottleRetries",
				min: 0,
				step: 1,
				validate: validateNonNegativeInteger,
			}),
			profileControl("Auto clear failed logs", "Clear successful retries.", {
				type: "toggle",
				key: "profile.autoClearFailedLogs",
			}),
		],
	};
}

function buildFallbackPage(
	context: SettingDefinitionContext,
): SettingDefinitionPage<DeclarativeSettingKey> {
	const visible = () => context.plugin.activeSettings.archiveTodayExperimentalSubmit;
	return {
		type: "page",
		name: "Fallback archive providers",
		items: [
			profileControl(
				"Fall back to latest existing snapshot",
				"Use only fresh fixed-timestamp snapshots after capture failure.",
				{ type: "toggle", key: "profile.fallbackToLatestSnapshot" },
			),
			profileControl("Use archive.today fallback", "Resolve archive.today snapshots.", {
				type: "toggle",
				key: "profile.provider.archiveToday",
			}),
			profileControl("Use Web Gyotaku fallback", "Resolve Web Gyotaku snapshots.", {
				type: "toggle",
				key: "profile.provider.megalodon",
			}),
			profileControl("Background archive.today auto-submit", "Submit unresolved URLs.", {
				type: "toggle",
				key: "profile.archiveTodayExperimentalSubmit",
			}),
			profileControl("archive.today submit delay", "Delay between submissions.", {
				type: "slider",
				key: "profile.archiveTodaySubmitDelayMs",
				min: 1_000,
				max: 10_000,
				step: 500,
			}, { visible }),
			profileControl("archive.today pending poll interval", "Pending poll interval.", {
				type: "slider",
				key: "profile.archiveTodayPendingPollIntervalMs",
				min: 15_000,
				max: 300_000,
				step: 5_000,
			}, { visible }),
			profileControl("archive.today pending poll batch size", "Pending poll batch size.", {
				type: "slider",
				key: "profile.archiveTodayPendingPollBatchSize",
				min: 1,
				max: 10,
				step: 1,
			}, { visible }),
			profileControl("archive.today pending queue capacity", "Maximum pending entries.", {
				type: "slider",
				key: "profile.archiveTodayMaxPendingCount",
				min: 1,
				max: 100,
				step: 1,
			}, { visible }),
			profileControl("archive.today pending max wait", "Maximum pending time.", {
				type: "slider",
				key: "profile.archiveTodayPendingMaxWaitMs",
				min: 60_000,
				max: 1_200_000,
				step: 60_000,
			}, { visible }),
			profileControl("Manual save batch size", "URLs opened per manual batch.", {
				type: "slider",
				key: "profile.manualSaveBatchSize",
				min: 1,
				max: 5,
				step: 1,
			}),
			profileControl("Per-URL archive policies", "One policy per line.", textArea("profile.archivePoliciesText")),
		],
	};
}

function buildSpnPage(): SettingDefinitionPage<DeclarativeSettingKey> {
	return {
		type: "page",
		name: "SPN API v2 options",
		items: [
			profileControl("Capture screenshot", "Capture a screenshot.", {
				type: "toggle",
				key: "profile.captureScreenshot",
			}),
			profileControl("Capture all resources", "Capture all page resources.", {
				type: "toggle",
				key: "profile.captureAll",
			}),
			profileControl("JS behavior timeout", "JavaScript behavior timeout.", {
				type: "number",
				key: "profile.jsBehaviorTimeout",
				min: 0,
				step: 1,
				validate: validateNonNegativeInteger,
			}),
			profileControl("Force GET request", "Use GET while capturing.", {
				type: "toggle",
				key: "profile.forceGet",
			}),
			profileControl("Capture outlinks", "Capture linked pages.", {
				type: "toggle",
				key: "profile.captureOutlinks",
			}),
		],
	};
}

export function buildSettingDefinitions(
	context: SettingDefinitionContext,
): SettingDefinitionItem<DeclarativeSettingKey>[] {
	return [
		buildCredentialGroup(context),
		buildProfileGroup(context),
		{
			type: "page",
			name: "Archive link format",
			items: [
				profileControl("Date format", "date-fns format used for {date}.", {
					type: "text",
					key: "profile.dateFormat",
					placeholder: "yyyy-MM-dd",
					validate: validateDateFormat,
				}),
				profileControl("Archive link text", "Use {date} and {provider} placeholders.", {
					type: "text",
					key: "profile.archiveLinkText",
					placeholder: "(Archived on {date})",
				}),
			],
		},
		buildFilteringPage(),
		buildSubstitutionList(context),
		buildAdvancedPage(),
		buildFallbackPage(context),
		buildSpnPage(),
	];
}
