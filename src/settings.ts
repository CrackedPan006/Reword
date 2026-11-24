import { App, PluginSettingTab, Setting } from 'obsidian';
import type Rplugin from './main';

export interface RewordSettings {
	wpm: number;
	smart: boolean;
	size: number;
	ignoreCase: boolean;
	/** null = automatic (on for right-to-left languages) */
	relax: boolean | null;
	typePunct: boolean;
	libraryFolder: string;
	vocabFolder: string;
}

export const DEFAULT_SETTINGS: RewordSettings = {
	wpm: 300, smart: true, size: 22, ignoreCase: true, relax: null, typePunct: true,
	libraryFolder: 'Reword/Library', vocabFolder: 'Reword/Vocabulary',
};

export class RewordSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: Rplugin) {
		super(app, plugin);
	}

	display() {
		const { containerEl, plugin } = this;
		const s = plugin.data.settings;
		containerEl.empty();

		new Setting(containerEl).setName('Reading text size').setDesc('Applies the next time a text is opened.').addSlider((c) =>
			c.setLimits(14, 40, 1).setValue(s.size).onChange(async (v) => {
				s.size = v;
				await plugin.persist();
			}));

		const folder = (name: string, key: 'libraryFolder' | 'vocabFolder') =>
			new Setting(containerEl).setName(name).addText((c) =>
				c.setValue(s[key]).onChange(async (v) => {
					s[key] = v.trim().replace(/^\/+|\/+$/g, '') || DEFAULT_SETTINGS[key];
					await plugin.persist();
				}));
		folder('Folder for downloaded texts', 'libraryFolder');
		folder('Folder for vocabulary notes', 'vocabFolder');
	}
}
