/* Select a word or phrase → definition popover → save it as a vocabulary note. */
import { Notice, requestUrl, TFile } from 'obsidian';
import type { Doc } from './document';
import { core, type Token } from './lib/util.js';
import type { RewordView } from './view';
import { saveWord } from './vocab';

export interface Entry { pos: string; defs: string[] }
interface Result { entries: Entry[]; source: string }
type OnSelect = (term: string, rect: DOMRect, i0: number | null, i1: number | null) => void;

/** Report text selections made inside `box` (mouse and touch). Returns a cleanup function. */
export function selectionWatcher(box: HTMLElement, onSelect: OnSelect) {
	const doc = box.doc, win = box.win;
	let down = false, timer = 0, last = '';
	const wordIndex = (node: Node) => {
		const el = node.instanceOf(Element) ? node : node.parentElement;
		const w = el?.closest<HTMLElement>('[data-i]');
		return w ? Number(w.dataset.i) : null;
	};
	const check = () => {
		const sel = win.getSelection();
		if (!sel || sel.isCollapsed || !sel.rangeCount) { last = ''; return; }
		const range = sel.getRangeAt(0);
		if (!box.contains(range.commonAncestorContainer)) return;
		const term = core(sel.toString().replace(/\s+/g, ' ').trim());
		if (!term || term === last || term.length > 80 || term.split(' ').length > 8) return;
		last = term;
		onSelect(term, range.getBoundingClientRect(), wordIndex(range.startContainer), wordIndex(range.endContainer));
	};
	const later = (ms: number) => { win.clearTimeout(timer); timer = win.setTimeout(check, ms); };
	const onDown = () => { down = true; last = ''; };
	const onUp = () => { down = false; later(10); };
	const onChange = () => { if (!down) later(450); };
	box.addEventListener('mousedown', onDown);
	doc.addEventListener('mouseup', onUp);
	doc.addEventListener('selectionchange', onChange);
	return () => {
		win.clearTimeout(timer);
		box.removeEventListener('mousedown', onDown);
		doc.removeEventListener('mouseup', onUp);
		doc.removeEventListener('selectionchange', onChange);
	};
}

export async function getJSON<T>(url: string): Promise<T> {
	// requestUrl is not limited by CORS, so no proxy is needed
	return (await requestUrl({ url })).json as T;
}

export const htmlToPlain = (h: string) =>
	(new DOMParser().parseFromString(h, 'text/html').body.textContent ?? '').replace(/\s+/g, ' ').trim();

const POS_NAMES = /^(noun|proper noun|verb|adjective|adverb|pronoun|preposition|postposition|conjunction|interjection|numeral|particle|article|determiner|phrase|prefix|suffix|abbreviation|substantiv|adjektiv)/i;

/** Parse the plain-text version of a Wiktionary page. */
async function wiktExtract(host: string, v: string, b: string): Promise<Entry[]> {
	const d = await getJSON<{ query: { pages: { extract?: string }[] } }>(`https://${host}.wiktionary.org/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=wiki&redirects=1&titles=${encodeURIComponent(v)}&format=json&formatversion=2&origin=*`);
	const text = d.query.pages[0]?.extract;
	if (!text) return [];
	const secs = text.split(/^== ([^=].*?) ==\s*$/m); // [intro, "Swedish", body, "English", body, …]
	let want = '';
	try {
		const Names = (Intl as unknown as { DisplayNames: new (l: string[], o: object) => { of(c: string): string | undefined } }).DisplayNames;
		if (b && b !== 'und') want = (new Names(['en'], { type: 'language' }).of(b) ?? '').toLowerCase();
	} catch { /* unknown code */ }
	let body = '';
	for (let i = 1; i < secs.length; i += 2) {
		const match = secs[i]?.toLowerCase() === want;
		if (!body || match) body = secs[i + 1] ?? '';
		if (match) break;
	}
	const parts = body.split(/^=== (.+?) ===\s*$/m);
	const entries: Entry[] = [];
	for (let i = 1; i < parts.length; i += 2) {
		const pos = parts[i] ?? '';
		if (!POS_NAMES.test(pos)) continue;
		const defs = ((parts[i + 1] ?? '').split(/^====/m)[0] ?? '').split('\n').map((s) => s.trim())
			.filter((s) => s.length > 2 && !/^(Declension|Inflection|Conjugation|Böjning)/i.test(s)).slice(1, 4); // line 0 is the headword line
		if (defs.length) entries.push({ pos, defs });
	}
	return entries.slice(0, 4);
}

async function lookup(term: string, lang: string): Promise<Result | null> {
	const b = lang.toLowerCase().split('-')[0] ?? '';
	const hosts = ['en'];
	if (b && b !== 'en' && b !== 'und') hosts.push(b);
	const lower = term.toLocaleLowerCase();
	const variants = lower !== term ? [term, lower] : [term];
	for (const host of hosts) for (const v of variants) {
		try {
			type Rest = Record<string, { partOfSpeech?: string; definitions?: { definition?: string }[] }[]>;
			const data = await getJSON<Rest>(`https://${host}.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(v)}`);
			const chosen = data[b] ? [b] : Object.keys(data).slice(0, 2); // prefer the text's own language
			const entries: Entry[] = [];
			for (const k of chosen) for (const e of data[k] ?? []) {
				const defs = (e.definitions ?? []).slice(0, 3).map((d) => htmlToPlain(d.definition ?? '')).filter(Boolean);
				if (defs.length) entries.push({ pos: e.partOfSpeech ?? '', defs });
			}
			if (entries.length) return { entries: entries.slice(0, 4), source: `${host}.wiktionary.org` };
		} catch { /* not found on this wiki: try the next */ }
	}
	if (!b || b === 'en' || b === 'und') {
		try {
			type Dict = { meanings?: { partOfSpeech: string; definitions: { definition: string }[] }[] }[];
			const d = await getJSON<Dict>(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(lower)}`);
			const entries = d.flatMap((x) => x.meanings ?? []).slice(0, 4)
				.map((m) => ({ pos: m.partOfSpeech, defs: m.definitions.slice(0, 3).map((x) => x.definition) }));
			if (entries.length) return { entries, source: 'dictionaryapi.dev' };
		} catch { /* not found */ }
	}
	for (const host of hosts) for (const v of variants) {
		try {
			const entries = await wiktExtract(host, v, b);
			if (entries.length) return { entries, source: `${host}.wiktionary.org` };
		} catch { /* keep going */ }
	}
	// names, phrases, concepts: the Wikipedia summary
	try {
		const w = b && b !== 'und' ? b : 'en';
		const s = await getJSON<{ extract?: string; type?: string }>(`https://${w}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(term.replace(/ /g, '_'))}`);
		if (s.extract && s.type !== 'disambiguation') return { entries: [{ pos: 'Wikipedia', defs: [s.extract.slice(0, 400)] }], source: `${w}.wikipedia.org` };
	} catch { /* nothing */ }
	return null;
}

function sentenceAround(tokens: Token[], i0: number | null, i1: number | null) {
	if (i0 == null) return '';
	const end = /[.!?…。！？؟]["'”’»)\]]*$/u;
	let a = i0, b = i1 ?? i0;
	const last = b;
	while (a > 0 && i0 - a < 60 && !end.test(tokens[a - 1]?.t ?? '')) a--;
	while (b < tokens.length - 1 && b - last < 60 && !end.test(tokens[b]?.t ?? '')) b++;
	return tokens.slice(a, b + 1).map((t) => t.t).join(' ').trim();
}

export class DefinePopover {
	private el: HTMLElement | null = null;
	private ticket = 0;
	private onOutside = (e: MouseEvent) => {
		if (this.el && !this.el.contains(e.target as Node)) this.close();
	};

	constructor(private view: RewordView, private file: TFile, private doc: Doc) {
		view.contentEl.doc.addEventListener('mousedown', this.onOutside);
	}

	close() {
		this.ticket++;
		if (!this.el) return;
		this.el.remove();
		this.el = null;
		this.view.contentEl.win.getSelection()?.removeAllRanges();
	}

	destroy() {
		this.view.contentEl.doc.removeEventListener('mousedown', this.onOutside);
		this.ticket++;
		this.el?.remove();
		this.el = null;
	}

	/** An empty term just closes the popover. */
	async open(term: string, rect: DOMRect, i0: number | null, i1: number | null) {
		this.ticket++;
		this.el?.remove();
		this.el = null;
		if (!term) return;
		const mine = this.ticket;
		const { lang } = this.doc;
		const context = sentenceAround(this.doc.tokens, i0, i1);

		const el = (this.el = this.view.contentEl.createDiv({ cls: 'reword-pop' }));
		const head = el.createDiv({ cls: 'reword-row' });
		head.createEl('strong', { text: term, attr: { dir: 'auto' } });
		head.createEl('button', { text: 'Pronounce' }).addEventListener('click', () => {
			const u = new SpeechSynthesisUtterance(term);
			if (lang !== 'und') u.lang = lang;
			speechSynthesis.cancel();
			speechSynthesis.speak(u);
		});
		head.createEl('button', { text: 'Close' }).addEventListener('click', () => this.close());
		const body = el.createDiv({ cls: 'reword-pop-body', text: 'Looking up…' });
		const note = el.createEl('input', { type: 'text', attr: { placeholder: 'Your note (optional)', dir: 'auto' } });
		const add = el.createEl('button', { text: 'Add to vocabulary', cls: 'mod-cta' });
		add.disabled = true;
		this.place(rect);

		const res = await lookup(term, lang).catch(() => null);
		if (mine !== this.ticket) return;
		body.empty();
		if (res) {
			for (const e of res.entries) {
				if (e.pos) body.createEl('em', { text: e.pos });
				const ol = body.createEl('ol');
				e.defs.forEach((d) => ol.createEl('li', { text: d }));
			}
			body.createEl('p', { cls: 'reword-muted', text: `Source: ${res.source}` });
		} else {
			body.createEl('p', { cls: 'reword-muted', text: 'No definition found. You can still save it with your own note.' });
			body.createEl('a', { text: 'Translate', href: `https://translate.google.com/?sl=auto&tl=en&text=${encodeURIComponent(term)}&op=translate` });
		}
		if (context) body.createEl('p', { cls: 'reword-context', text: context, attr: { dir: 'auto' } });
		add.disabled = false;
		this.place(rect);

		const save = async () => {
			try {
				await saveWord(this.view.plugin, { term, lang, defs: res?.entries ?? [], note: note.value.trim(), context, source: this.file });
				add.setText('Saved');
			} catch (e) {
				new Notice(`Could not save: ${(e as Error).message}`);
			}
		};
		add.addEventListener('click', () => void save());
		note.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add.click(); } });
	}

	/** Place next to the selected word, inside the view. */
	private place(rect: DOMRect) {
		const el = this.el;
		if (!el) return;
		const host = this.view.contentEl.getBoundingClientRect();
		const left = Math.max(8, Math.min(rect.left - host.left, host.width - el.offsetWidth - 8));
		let top = rect.bottom - host.top + 8;
		if (top + el.offsetHeight > host.height - 8) top = Math.max(8, rect.top - host.top - el.offsetHeight - 8);
		el.style.left = `${left}px`;
		el.style.top = `${top}px`;
	}
}
