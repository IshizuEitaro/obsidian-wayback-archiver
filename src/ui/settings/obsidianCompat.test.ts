import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireApiVersion } = vi.hoisted(() => ({
	requireApiVersion: vi.fn(),
}));

vi.mock("obsidian", () => ({
	requireApiVersion,
	SecretComponent: class SecretComponent {},
}));

import {
	getDeclarativeSettingsHost,
	getSecretSelectorConstructor,
	markButtonDestructive,
	preserveLegacySliderValue,
} from "./obsidianCompat";

describe("Obsidian API compatibility helpers", () => {
	beforeEach(() => {
		requireApiVersion.mockReset();
	});

	it("binds declarative refresh methods to their setting tab", () => {
		const tab = {
			value: 0,
			update() {
				this.value += 1;
			},
			refreshDomState() {
				this.value += 10;
			},
		};
		const host = getDeclarativeSettingsHost(tab as never);

		host?.update();
		host?.refreshDomState?.();

		expect(tab.value).toBe(11);
	});

	it("resolves SecretComponent only when the host exports it", () => {
		expect(getSecretSelectorConstructor()).toBeTypeOf("function");
	});

	it("uses the current destructive style and falls back on older hosts", () => {
		const modern = { setDestructive: vi.fn(), setWarning: vi.fn() };
		const legacy = { setWarning: vi.fn() };

		markButtonDestructive(modern as never);
		markButtonDestructive(legacy as never);

		expect(modern.setDestructive).toHaveBeenCalledOnce();
		expect(modern.setWarning).not.toHaveBeenCalled();
		expect(legacy.setWarning).toHaveBeenCalledOnce();
	});

	it("keeps slider values visible only on pre-1.13 hosts", () => {
		const legacySlider = { setDynamicTooltip: vi.fn() };
		const currentSlider = { setDynamicTooltip: vi.fn() };
		requireApiVersion.mockReturnValueOnce(false).mockReturnValueOnce(true);

		preserveLegacySliderValue(legacySlider as never);
		preserveLegacySliderValue(currentSlider as never);

		expect(legacySlider.setDynamicTooltip).toHaveBeenCalledOnce();
		expect(currentSlider.setDynamicTooltip).not.toHaveBeenCalled();
	});
});
