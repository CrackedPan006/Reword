/* The Reword tab: loads a vault file and hosts either the speed reader or zen typing. */
import { FuzzySuggestModal, ItemView, Notice, TFile, ViewStateResult, WorkspaceLeaf } from 'obsidian';
import { DefinePopover } from './define';
import { Doc, KIND_LABEL, prepareDoc, Section, sectionAt } from './document';
import { extractFile } from './extract';
import type Rplugin from './main';
import { SpeedReader } from './speed';
import { ZenTyping } from './zen';

export const VIEW_TYPE = 'reword-view';
export const PAGE = 250; // words rendered at once (keeps huge books fast)
export type Mode = 'read' | 'zen';

export interface Session {
	/** current word */
	readonly idx: number;
	jump(tok: number): void;
	focus(): void;
	destroy(): void;
}

export class RewordView extends ItemView {
	navigation = true;
	private path = '';
	private mode: Mode = 'read';
	private doc: Doc | null = null;
	private session: Session | null = null;
	private popover: DefinePopover | null = null;
	private sectionEl: HTMLElement | null = null;
	private loadId = 0;

	constructor(leaf: WorkspaceLeaf, readonly plugin: Rplugin) {
		super(leaf);
	}

	getViewType() { return VIEW_TYPE; }
	getIcon() { return this.mode === 'zen' ? 'keyboard' : 'book-open'; }
	getDisplayText() {
		return this.path.split('/').pop()?.replace(/\.[^.]+$/, '') || 'Reword';
	}
	getState(): Record<string, unknown> {
		return { file: this.path, mode: this.mode };
	}

	async setState(state: unknown, result: ViewStateResult) {
		const s = (state ?? {}) as { file?: string; mode?: Mode };
		this.path = s.file ?? this.path;
		this.mode = s.mode ?? 'read';
		result.history = true;
		await super.setState(state, result);
		void this.openDocument(); // not awaited, so the tab appears at once even for a large book
	}

	async onOpen() {
		this.contentEl.addClass('reword');
		this.contentEl.tabIndex = -1;
		this.registerEvent(this.app.vault.on('rename', (file, old) => { if (old === this.path) this.path = file.path; }));
		this.registerDomEvent(this.contentEl, 'keydown', (e) => {
			if (e.key === 'Escape') this.popover?.close();
		});
	}

	async onClose() {
		this.loadId++;
		this.teardown();
	}

	private teardown() {
		this.session?.destroy();
		this.session = null;
		this.popover?.destroy();
		this.popover = null;
		this.contentEl.empty();
	}

	private async openDocument() {
		const mine = ++this.loadId;
		this.teardown();
		this.doc = null;
		const file = this.app.vault.getAbstractFileByPath(this.path);
		if (!(file instanceof TFile)) {
			this.contentEl.createEl('p', { text: 'Choose a file, then run a Reword command.' });
			return;
		}
		const loading = this.contentEl.createEl('p', { text: 'Opening…' });
		try {
			const doc = prepareDoc(await extractFile(this.app, file), file.basename);
			if (mine !== this.loadId) return;
			this.doc = doc;
			this.show(file, doc);
		} catch (e) {
			if (mine === this.loadId) loading.setText(`Choose a file, then run a Reword command.: ${(e as Error).message}`);
		}
	}

	private show(file: TFile, doc: Doc) {
		this.contentEl.empty();
		const head = this.contentEl.createDiv({ cls: 'reword-head' });
		const title = head.createDiv();
		title.createEl('strong', { text: doc.title, attr: { dir: 'auto' } });
		this.sectionEl = title.createDiv({ cls: 'reword-muted' });
		const tools = head.createDiv({ cls: 'reword-row' });
		this.button(tools, 'Previous part', () => this.jumpSection(-1));
		this.button(tools, 'Parts', () => new PartsModal(this, doc.sections).open());
		this.button(tools, 'Next part', () => this.jumpSection(1));
		this.button(tools, this.mode === 'read' ? 'Switch to zen typing' : 'Switch to speed reading', () => {
			const next: Mode = this.mode === 'read' ? 'zen' : 'read';
			void this.leaf.setViewState({ type: VIEW_TYPE, state: { file: this.path, mode: next }, active: true });
		});

		const body = this.contentEl.createDiv({ cls: 'reword-body' });
		this.popover = new DefinePopover(this, file, doc);
		this.session = this.mode === 'read' ? new SpeedReader(this, body, doc) : new ZenTyping(this, body, doc);
		this.session.focus();
	}

	/** A toolbar button that does not steal keyboard focus from the text. */
	button(parent: HTMLElement, text: string, onClick: () => void) {
		const b = parent.createEl('button', { text });
		b.addEventListener('mousedown', (e) => e.preventDefault());
		b.addEventListener('click', () => { onClick(); });
		return b;
	}

	/** Called by the sessions on every move. */
	moved(tok: number) {
		if (!this.doc) return;
		this.plugin.setProgress(this.path, this.mode, tok);
		const sections = this.doc.sections;
		const s = sections[sectionAt(sections, Math.min(tok, this.doc.tokens.length - 1))];
		if (s) this.sectionEl?.setText(sections.length > 1 ? `${KIND_LABEL[s.kind]} · ${s.title.slice(0, 80)}` : '');
	}

	/** Saved position, or the first main section for a new text. */
	startToken() {
		return this.plugin.data.progress[this.path]?.[this.mode] || this.doc?.startTok || 0;
	}

	define(term: string, rect: DOMRect, i0: number | null, i1: number | null) {
		void this.popover?.open(term, rect, i0, i1);
	}

	jump(tok: number) {
		this.session?.jump(tok);
		this.session?.focus();
	}

	private jumpSection(dir: number) {
		if (!this.doc || !this.session) return;
		const secs = this.doc.sections, idx = this.session.idx;
		const i = sectionAt(secs, idx), here = secs[i];
		// "previous" first goes to the start of this part
		const target = dir < 0 && here && idx > here.tok + 2 ? here : secs[i + dir];
		if (target) this.jump(target.tok);
	}
}

class PartsModal extends FuzzySuggestModal<Section> {
	constructor(private view: RewordView, private sections: Section[]) {
		super(view.app);
		this.setPlaceholder('Jump to a part of this text');
		if (sections.length < 2) new Notice('No separate parts were detected in this text.');
	}
	getItems() { return this.sections; }
	getItemText(s: Section) { return `${'  '.repeat(s.level - 1)}${s.title.slice(0, 90)} — ${KIND_LABEL[s.kind]}`; }
	onChooseItem(s: Section) {
		// wait for the modal to close, or it takes the focus back
		window.setTimeout(() => this.view.jump(s.tok), 50);
	}
}
