import { App, ButtonComponent, PluginSettingTab, Notice, Setting } from 'obsidian';
import { ConfirmationModal, ProfileNameModal } from './modals';
import { WaybackArchiverPlugin } from '../main';
import { DEFAULT_SETTINGS } from '../core/settings';

class WaybackArchiverSettingTab extends PluginSettingTab {
	plugin: WaybackArchiverPlugin;

	constructor(app: App, plugin: WaybackArchiverPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		
		new Setting(containerEl).setName('Archive.org API keys (global)').setHeading();

		const apiDesc = containerEl.createEl('p');
		apiDesc.appendText('This is used globally across all profiles. ');
		apiDesc.createEl('a', {
			text: 'You can generate your API keys here.',
			href: 'https://archive.org/account/s3.php',
		});
		apiDesc.style.marginBottom = '10px'; 

		new Setting(containerEl)
			.setName('Archive.org SPN access key')
			.setDesc('Your S3-like Access Key for the SPN API v2.')
			.addText(text => text
				.setPlaceholder('Enter your access key')
				.setValue(this.plugin.data.spnAccessKey || '')
				.onChange(async (value) => {
					this.plugin.data.spnAccessKey = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Archive.org SPN secret key')
			.setDesc('Your S3-like Secret Key for the SPN API v2.')
			.addText(text => text
				.setPlaceholder('Enter your secret key')
				.setValue(this.plugin.data.spnSecretKey || '')
				.onChange(async (value) => {
					this.plugin.data.spnSecretKey = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl).setName('Profiles').setHeading();

		new Setting(containerEl)
			.setName('Active profile')
			.setDesc('Select the settings profile to use.')
			.addDropdown(dropdown => {
				for (const profileId in this.plugin.data.profiles) {
					dropdown.addOption(profileId, profileId);
				}
				dropdown.setValue(this.plugin.data.activeProfileId);
				dropdown.onChange(async (value) => {
					this.plugin.data.activeProfileId = value;
					await this.plugin.saveSettings();
					this.display(); 
				});
			});

		const profileButtonContainer = containerEl.createDiv({ cls: 'wayback-profile-buttons' });
		profileButtonContainer.style.marginBottom = '20px'; 

		new ButtonComponent(profileButtonContainer)
			.setButtonText('Create profile')
			.onClick(async () => {
				await this.handleCreateProfileClick();
			})
			.buttonEl.style.marginRight = '5px';

		new ButtonComponent(profileButtonContainer)
			.setButtonText('Rename profile')
			.onClick(async () => {
				await this.handleRenameProfileClick();
			})
			.buttonEl.style.marginRight = '5px';

		new ButtonComponent(profileButtonContainer)
			.setButtonText('Delete profile')
			.setWarning()
			.onClick(async () => {
				await this.handleDeleteProfileClick();
			})
			.buttonEl.style.marginRight = '5px';

		new Setting(containerEl).setName('Archive link format').setHeading();

		const activeSettings = this.plugin.activeSettings;

		new Setting(containerEl)
			.setName('Date format')
			.setDesc('Format for the {date} placeholder in the archive link text (using date-fns format).')
			.addText(text => text
				.setPlaceholder('yyyy-MM-dd')
				.setValue(activeSettings.dateFormat)
				.onChange(async (value) => {
					activeSettings.dateFormat = value || 'yyyy-MM-dd';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Archive link text')
			.setDesc('Text used for the inserted archive link. Use {date} as a placeholder.')
			.addText(text => text
				.setPlaceholder('(Archived on {date})')
				.setValue(activeSettings.archiveLinkText)
				.onChange(async (value) => {
					activeSettings.archiveLinkText = value || '(Archived on {date})';
					await this.plugin.saveSettings();
				}));
				
		new Setting(containerEl).setName('Filtering rules (optional)').setHeading();

		new Setting(containerEl)
			.setName('Ignore URL patterns')
			.setDesc('URLs matching these patterns (one per line, regex or simple text) will be ignored. Example: youtube\\.com or internal-wiki')
			.addTextArea(text => text
				.setPlaceholder('example\\.com\ninternal-server')
				.setValue(activeSettings.ignorePatterns.join('\n'))
				.onChange(async (value) => {
					activeSettings.ignorePatterns = value.split('\n').map(p => p.trim()).filter(p => p.length > 0);
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('p', { text: 'Define patterns to ONLY archive links within notes matching these criteria. If multiple filter types are used, the note/link must match ALL active filter types.' });

		new Setting(containerEl)
			.setName('Path patterns')
			.setDesc('Only archive links in notes whose file path matches these patterns (one per line, regex or simple text). Leave empty to ignore path.')
			.addTextArea(text => text
				.setPlaceholder('^Journal/.*\nProjects/MyProject/')
				.setValue(activeSettings.pathPatterns.join('\n'))
				.onChange(async (value) => {
					activeSettings.pathPatterns = value.split('\n').map(p => p.trim()).filter(p => p.length > 0);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('URL patterns')
			.setDesc('Only archive links whose URL matches these patterns (one per line, regex or simple text). Leave empty to ignore URL.')
			.addTextArea(text => text
				.setPlaceholder('^https://specific-domain\\.com/\nnews-site')
				.setValue(activeSettings.urlPatterns.join('\n'))
				.onChange(async (value) => {
					activeSettings.urlPatterns = value.split('\n').map(p => p.trim()).filter(p => p.length > 0);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Word/Phrase patterns')
			.setDesc('Only archive links in notes containing ANY of these words or phrases (one per line, simple text match). Leave empty to ignore content.')
			.addTextArea(text => text
				.setPlaceholder('Project Alpha\n#research-topic')
				.setValue(activeSettings.wordPatterns.join('\n'))
				.onChange(async (value) => {
					activeSettings.wordPatterns = value.split('\n').map(p => p.trim()).filter(p => p.length > 0);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl).setName('URL substitution rules').setHeading();
		containerEl.createEl('p', { text: 'Apply find/replace rules to URLs before archiving. Useful for removing tracking parameters or normalizing links.' });

		const substitutionDiv = containerEl.createDiv();
		substitutionDiv.id = 'wayback-substitution-rules';
		this.renderSubstitutionRules(substitutionDiv);

		new Setting(containerEl)
			.addButton(button => button
			.setButtonText('Add substitution rule')
			.onClick(async () => {
				activeSettings.substitutionRules.push({ find: '', replace: '', regex: false });
				await this.plugin.saveSettings();
				this.renderSubstitutionRules(substitutionDiv);
			}));

		new Setting(containerEl).setName('Advanced').setHeading();

		new Setting(containerEl)
			.setName('API request delay (ms)')
			.setDesc('Delay between API calls (initiate, status check, next link) in milliseconds.')
			.addSlider(slider => slider
				.setLimits(500, 10000, 100) // Min 0.5s, Max 10s, Step 0.1s
				.setValue(activeSettings.apiDelay)
				.setDynamicTooltip()
				.onChange(async (value) => {
					activeSettings.apiDelay = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Max status check retries')
			.setDesc('Maximum number of times to check the status of a pending archive job.')
			.addSlider(slider => slider
				.setLimits(1, 10, 1)
				.setValue(activeSettings.maxRetries)
				.setDynamicTooltip()
				.onChange(async (value) => {
					activeSettings.maxRetries = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Archive freshness (days)')
			.setDesc('Only archive if the URL has not been archived within this many days (0 = always archive if not present). Uses SPN API `if_not_archived_within`.')
			.addText(text => text
				.setPlaceholder('Enter number of days (e.g., 90)')
				.setValue(String(activeSettings.archiveFreshnessDays))
				.onChange(async (value) => {
					const numValue = parseInt(value, 10);
					activeSettings.archiveFreshnessDays = isNaN(numValue) || numValue < 0 ? 0 : numValue;
					await this.plugin.saveSettings();
					text.setValue(String(activeSettings.archiveFreshnessDays));
				}));
				
		new Setting(containerEl)
			.setName('Auto clear failed logs')
			.setDesc('Automatically clear failed logs after successful retries without confirmation.')
			.addToggle(toggle => {
				toggle
					.setValue(this.plugin.activeSettings.autoClearFailedLogs)
					.onChange(async (value) => {
						this.plugin.activeSettings.autoClearFailedLogs = value;
						await this.plugin.saveSettings();
					});
			});

		containerEl.createEl('h4', { text: 'SPN API v2 options' });

		const spnDesc = containerEl.createEl('p');
		spnDesc.appendText('These options correspond to parameters available in the Archive.org SPN API v2. ');
		spnDesc.createEl('a', {
			text: 'See documentation for details.',
			href: 'https://docs.google.com/document/d/1Nsv52MvSjbLb2PCpHlat0gkzw0EvtSgpKHu4mk0MnrA/edit',
		});
		spnDesc.style.marginBottom = '10px'; 

		new Setting(containerEl)
			.setName('Capture screenshot')
			.setDesc('Request a screenshot of the page during archiving (SPN option).')
			.addToggle(toggle => toggle
				.setValue(activeSettings.captureScreenshot)
				.onChange(async (value) => {
					activeSettings.captureScreenshot = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Capture all resources (capture_all=1)')
			.setDesc('Attempt to capture more resources like JS, CSS, embeds (SPN option). May increase capture time/failure rate.')
			.addToggle(toggle => toggle
				.setValue(activeSettings.captureAll)
				.onChange(async (value) => {
					activeSettings.captureAll = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('JS behavior timeout (ms)')
			.setDesc('Max time (milliseconds) to allow JS execution during capture (0 = default). (SPN option)')
			.addText(text => text
				.setPlaceholder('0')
				.setValue(String(activeSettings.jsBehaviorTimeout))
				.onChange(async (value) => {
					const numValue = parseInt(value, 10);
					activeSettings.jsBehaviorTimeout = isNaN(numValue) || numValue < 0 ? 0 : numValue;
					await this.plugin.saveSettings();
					text.setValue(String(activeSettings.jsBehaviorTimeout));
				}));


		new Setting(containerEl)
			.setName('Force GET request (force_get=1)')
			.setDesc('Force the archiver to use a GET request (SPN option).')
			.addToggle(toggle => toggle
				.setValue(activeSettings.forceGet)
				.onChange(async (value) => {
					activeSettings.forceGet = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Capture outlinks (capture_outlinks=1)')
			.setDesc('Attempt to capture pages linked from the main URL (SPN option). Use with caution, can be slow.')
			.addToggle(toggle => toggle
				.setValue(activeSettings.captureOutlinks)
				.onChange(async (value) => {
					activeSettings.captureOutlinks = value;
					await this.plugin.saveSettings();
				}));
	} 


	private renderSubstitutionRules(containerEl: HTMLElement): void {
		containerEl.empty(); 
		const activeSettings = this.plugin.activeSettings;

		if (!activeSettings.substitutionRules || activeSettings.substitutionRules.length === 0) {
			containerEl.createEl('p', { text: 'No substitution rules defined.' });
			return;
		}

		activeSettings.substitutionRules.forEach((rule, index) => {
			const ruleEl = containerEl.createDiv({ cls: 'wayback-substitution-rule' });
			ruleEl.style.display = 'flex';
			ruleEl.style.marginBottom = '10px';
			ruleEl.style.alignItems = 'center';

			const findInput = ruleEl.createEl('input', { type: 'text', placeholder: 'Find (text or regex)' });
			findInput.value = rule.find;
			findInput.style.flexGrow = '1';
			findInput.style.marginRight = '5px';
			findInput.addEventListener('change', async (e) => {
				rule.find = (e.target as HTMLInputElement).value;
				await this.plugin.saveSettings();
			});

			const replaceInput = ruleEl.createEl('input', { type: 'text', placeholder: 'Replace with' });
			replaceInput.value = rule.replace;
			replaceInput.style.flexGrow = '1';
			replaceInput.style.marginRight = '5px';
			replaceInput.addEventListener('change', async (e) => {
				rule.replace = (e.target as HTMLInputElement).value;
				await this.plugin.saveSettings();
			});

			const regexToggleLabel = ruleEl.createEl('label');
			regexToggleLabel.style.marginRight = '5px';
			regexToggleLabel.textContent = 'Regex?';
			const regexToggle = regexToggleLabel.createEl('input', { type: 'checkbox' });
			regexToggle.checked = rule.regex;
			regexToggle.addEventListener('change', async (e) => {
				rule.regex = (e.target as HTMLInputElement).checked;
				await this.plugin.saveSettings();
			});


			const removeButton = ruleEl.createEl('button', { text: 'Remove' });
			removeButton.addEventListener('click', async () => {
				activeSettings.substitutionRules.splice(index, 1);
				await this.plugin.saveSettings();
				this.renderSubstitutionRules(containerEl);
			});
		});
	}


	private async handleCreateProfileClick(): Promise<void> {
		const modal = new ProfileNameModal(this.app, async (newName: string | null) => {
			if (newName && !this.plugin.data.profiles[newName]) {
				this.plugin.data.profiles[newName] = { ...DEFAULT_SETTINGS };
				this.plugin.data.activeProfileId = newName; 
				await this.plugin.saveSettings();
				this.display(); 
				new Notice(`Profile "${newName}" created and activated.`);
			} else if (newName) {
				new Notice(`Profile "${newName}" already exists.`);
			} else {
				new Notice('Profile creation cancelled.');
			}
		});
		modal.open();
	}

	private async handleRenameProfileClick(): Promise<void> {
		const currentId = this.plugin.data.activeProfileId;
		if (currentId === 'default') {
			new Notice('Cannot rename the default profile.');
			return;
		}

		const modal = new ProfileNameModal(this.app, async (newName: string | null) => {
			if (newName && newName !== currentId && !this.plugin.data.profiles[newName]) {
				this.plugin.data.profiles[newName] = this.plugin.data.profiles[currentId];
				delete this.plugin.data.profiles[currentId];
				this.plugin.data.activeProfileId = newName;
				await this.plugin.saveSettings();
				this.display();
				new Notice(`Profile "${currentId}" renamed to "${newName}".`);
			} else if (newName === currentId) {
				new Notice('New name is the same as the current name.');
			} else if (newName) {
				new Notice(`Profile "${newName}" already exists.`);
			} else {
				new Notice('Profile rename cancelled.');
			}
		}, currentId); 
		modal.open();
	}

	private async handleDeleteProfileClick(): Promise<void> {
		const profileIdToDelete = this.plugin.data.activeProfileId;
		if (profileIdToDelete === 'default') {
			new Notice('Cannot delete the default profile.');
			return;
		}

		new ConfirmationModal(
			this.app,
			'Delete profile?',
			`Are you sure you want to delete the profile "${profileIdToDelete}"? This cannot be undone.`,
			'Yes, delete profile',
			async (confirmed: boolean) => {
				if (confirmed) {
					delete this.plugin.data.profiles[profileIdToDelete];
					this.plugin.data.activeProfileId = 'default'; 
					await this.plugin.saveSettings();
					this.display();
					new Notice(`Profile "${profileIdToDelete}" deleted.`);
				} else {
					new Notice('Profile deletion cancelled.');
				}
			}
		).open();
	}

}

export { WaybackArchiverSettingTab };