import type {
	App,
	BaseComponent,
	ButtonComponent,
	PluginSettingTab,
	SliderComponent,
} from "obsidian";
import * as Obsidian from "obsidian";

interface DeclarativeSettingsHost {
	update(): void;
	refreshDomState?(): void;
}

interface DestructiveButton {
	setDestructive?(): unknown;
	setWarning?(): unknown;
}

interface LegacyTooltipSlider {
	setDynamicTooltip?(): unknown;
}

export interface SecretSelector extends BaseComponent {
	setValue(value: string): SecretSelector;
	onChange(callback: (value: string) => unknown): SecretSelector;
}

export type SecretSelectorConstructor = new (app: App, containerEl: HTMLElement) => SecretSelector;

export function getDeclarativeSettingsHost(
	tab: PluginSettingTab,
): DeclarativeSettingsHost | undefined {
	const update = Reflect.get(tab, "update");
	if (typeof update !== "function") return undefined;
	const refreshDomState = Reflect.get(tab, "refreshDomState");

	return {
		update: () => Reflect.apply(update, tab, []),
		refreshDomState:
			typeof refreshDomState === "function"
				? () => Reflect.apply(refreshDomState, tab, [])
				: undefined,
	};
}

export function getSecretSelectorConstructor(): SecretSelectorConstructor | undefined {
	const constructor = Reflect.get(Obsidian, "SecretComponent");
	return typeof constructor === "function" ? constructor : undefined;
}

export function markButtonDestructive(button: ButtonComponent): ButtonComponent {
	const compatibleButton: DestructiveButton = button;
	if (typeof compatibleButton.setDestructive === "function") {
		compatibleButton.setDestructive();
	} else {
		compatibleButton.setWarning?.();
	}
	return button;
}

export function preserveLegacySliderValue(slider: SliderComponent): SliderComponent {
	if (!Obsidian.requireApiVersion("1.13.0")) {
		const compatibleSlider: LegacyTooltipSlider = slider;
		compatibleSlider.setDynamicTooltip?.();
	}
	return slider;
}
