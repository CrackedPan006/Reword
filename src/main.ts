import { Notice, Plugin, TAbstractFile, TFile } from 'obsidian';
import { canRead } from './extract';
import { LibraryModal } from './library';
import { DEFAULT_SETTINGS, RewordSettings, RewordSettingTab } from './settings';
import { Mode, RewordView, VIEW_TYPE } from './view';
import { importVocabulary } from './vocab';

export interface Progress { read?: number; zen?: number }
interface Data { settings: RewordSettings; progress: Record<string, Progress> }

export default class Rplugin extends Plugin {
	data: Data = { settings: { ...DEFAULT_SETTINGS }, progress: {} };
	private saveTimer: number | undefined;

	async onload() {
		const saved = (await this.loadData()) as Partial<Data> | null;
		this.data = { settings: { ...DEFAULT_SETTINGS, ...saved?.settings }, progress: saved?.progress ?? {} };

		this.registerView(VIEW_TYPE, (leaf) => new RewordView(leaf, this));
		this.addSettingTab(new RewordSettingTab(this.app, this));

		// File types Obsidian cannot open by itself now open in Reword.
		for (const ext of ['epub', 'docx', 'html', 'htm', 'xhtml', 'txt']) {
			try { this.registerExtensions([ext], VIEW_TYPE); }
			catch { console.warn(`Reword: .${ext} is already handled by something else`); }
		}

		// Notes and PDFs keep their normal viewer; Reword is offered on top.
		const modes: [Mode, string, string][] = [['read', 'Speed-read', 'book-open'], ['zen', 'Zen type', 'keyboard']];
		for (const [mode, label, icon] of modes) {
			this.addCommand({
				id: mode,
				name: `${label} current file`,
				checkCallback: (checking) => {
					const file = this.app.workspace.getActiveFile();
					if (!file || !canRead(file)) return false;
					if (!checking) void this.openFile(file, mode);
					return true;
				},
			});
			this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
				if (!(file instanceof TFile) || !canRead(file)) return;
				menu.addItem((item) => item.setTitle(`Reword: ${label.toLowerCase()}`).setIcon(icon)
					.onClick(() => void this.openFile(file, mode)));
			}));
		}

		this.addRibbonIcon('library', 'Reword library', () => new LibraryModal(this).open());
		this.addCommand({ id: 'library', name: 'Find a book, article or poem', callback: () => new LibraryModal(this).open() });
		this.addCommand({ id: 'import-vocabulary', name: 'Import vocabulary from the website (JSON)', callback: () => importVocabulary(this) });

		// keep reading positions attached to files that move
		this.registerEvent(this.app.vault.on('rename', (file: TAbstractFile, old: string) => {
			for (const path of Object.keys(this.data.progress)) {
				if (path !== old && !path.startsWith(old + '/')) continue;
				const entry = this.data.progress[path];
				if (entry) this.data.progress[file.path + path.slice(old.length)] = entry;
				delete this.data.progress[path];
				this.queueSave();
			}
		}));
		this.registerEvent(this.app.vault.on('delete', (file) => {
			if (this.data.progress[file.path]) { delete this.data.progress[file.path]; this.queueSave(); }
		}));
	}

	onunload() {
		window.clearTimeout(this.saveTimer);
		void this.persist();
	}

	async openFile(file: TFile, mode: Mode) {
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path, mode }, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	persist() {
		return this.saveData(this.data).catch((e: Error) => { new Notice(`Reword could not save: ${e.message}`); });
	}

	/** Save soon (progress changes on every word, so writes are batched). */
	queueSave() {
		if (this.saveTimer !== undefined) return;
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = undefined;
			void this.persist();
		}, 1500);
	}

	setProgress(path: string, mode: Mode, tok: number) {
		const entry = (this.data.progress[path] ??= {});
		if (entry[mode] === tok) return;
		entry[mode] = tok;
		this.queueSave();
	}
}
