/* Search Project Gutenberg, Wikipedia, Wikisource and PoetryDB; chosen texts are saved as notes. */
import { Modal, normalizePath, Notice, requestUrl, Setting, stringifyYaml } from 'obsidian';
import { getJSON, htmlToPlain } from './define';
import { normalizeText, stripGutenberg } from './lib/util.js';
import type Rplugin from './main';
import { ensureFolder, fileAt, safeName } from './vault';
import type { Mode } from './view';

interface Download { title: string; author: string; lang: string; source: string; content: string }
interface Item { title: string; meta: string; load: () => Promise<Download> }
interface Page { items: Item[]; next?: string }
type Source = 'gutenberg' | 'wikipedia' | 'wikisource' | 'poetry';

const LANGS: Record<string, string> = {
	en: 'English', sv: 'Svenska', ar: 'العربية', es: 'Español', fr: 'Français', de: 'Deutsch', it: 'Italiano', pt: 'Português',
	nl: 'Nederlands', ru: 'Русский', fa: 'فارسی', tr: 'Türkçe', he: 'עברית', zh: '中文', ja: '日本語', ko: '한국어', la: 'Latina',
	fi: 'Suomi', da: 'Dansk', no: 'Norsk', pl: 'Polski', el: 'Ελληνικά',
};
const enc = encodeURIComponent;

/* ── sources ── */
interface GutBook { id: number; title: string; authors: { name: string }[]; languages?: string[]; formats?: Record<string, string> }

async function gutenberg(url: string): Promise<Page> {
	const data = await getJSON<{ next?: string; results: GutBook[] }>(url);
	return {
		next: data.next?.replace(/^http:/, 'https:'),
		items: data.results.map((b) => ({
			title: b.title,
			meta: [b.authors.map((a) => a.name).join('; '), b.languages?.join(', ')].filter(Boolean).join(' · '),
			load: async () => {
				const direct = Object.entries(b.formats ?? {}).filter(([k]) => k.startsWith('text/plain')).map(([, u]) => u);
				const urls = new Set([...direct, `https://www.gutenberg.org/cache/epub/${b.id}/pg${b.id}.txt`, `https://www.gutenberg.org/files/${b.id}/${b.id}-0.txt`]);
				for (const u of urls) {
					try {
						const raw = (await requestUrl({ url: u })).text;
						return {
							title: b.title, author: b.authors[0]?.name ?? '', lang: b.languages?.[0] ?? 'en',
							source: `https://www.gutenberg.org/ebooks/${b.id}`, content: normalizeText(stripGutenberg(raw.replace(/\r\n?/g, '\n'))),
						};
					} catch { /* try the next address */ }
				}
				throw new Error('could not download the plain text of this book');
			},
		})),
	};
}

/** Recognise pasted Wikipedia / Wikisource links. */
function parseWikiUrl(q: string) {
	let u: URL;
	try { u = new URL(q.trim().replace(/^(?=(?:[a-z-]+\.)?(?:m\.)?wiki(?:pedia|source)\.org)/i, 'https://')); } catch { return null; }
	const m = /^([a-z-]+)(?:\.m)?\.(wikipedia|wikisource)\.org$/i.exec(u.hostname);
	if (!m?.[1] || !m[2]) return null;
	let title = '';
	try {
		if (u.pathname.startsWith('/wiki/')) title = decodeURIComponent(u.pathname.slice(6));
		else if (u.searchParams.get('title')) title = u.searchParams.get('title') ?? '';
		else if (/^\/w\/index\.php\/./.test(u.pathname)) title = decodeURIComponent(u.pathname.replace(/^\/w\/index\.php\//, ''));
	} catch { return null; }
	title = title.replace(/_/g, ' ').trim();
	return title ? { lang: m[1].toLowerCase(), project: m[2].toLowerCase(), title } : null;
}

function wikiItem(title: string, project: string, lang: string, snippet = ''): Item {
	return {
		title,
		meta: [`${lang}.${project}.org`, snippet].filter(Boolean).join(' · '),
		load: async () => {
			const d = await getJSON<{ query: { pages: { title: string; extract?: string }[] } }>(`https://${lang}.${project}.org/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=plain&redirects=1&titles=${enc(title)}&format=json&formatversion=2&origin=*`);
			const page = d.query.pages[0];
			if (!page?.extract) throw new Error('this page has no readable text');
			return {
				title: page.title, author: project === 'wikipedia' ? 'Wikipedia' : 'Wikisource', lang: lang === 'simple' ? 'en' : lang,
				source: `https://${lang}.${project}.org/wiki/${enc(title.replace(/ /g, '_'))}`, content: page.extract.replace(/\n+/g, '\n\n'),
			};
		},
	};
}

async function wiki(q: string, project: string, lang: string): Promise<Page> {
	const pasted = parseWikiUrl(q);
	if (pasted) return { items: [wikiItem(pasted.title, pasted.project, pasted.lang)] };
	const api = `https://${lang}.${project}.org/w/api.php?action=query&format=json&origin=*`;
	if (!q) {
		const d = await getJSON<{ query: { random: { title: string }[] } }>(`${api}&list=random&rnnamespace=0&rnlimit=12`);
		return { items: d.query.random.map((r) => wikiItem(r.title, project, lang)) };
	}
	const d = await getJSON<{ query: { search: { title: string; snippet: string }[] } }>(`${api}&list=search&srsearch=${enc(q)}&srlimit=20`);
	return { items: d.query.search.map((r) => wikiItem(r.title, project, lang, htmlToPlain(r.snippet))) };
}

async function poetry(q: string, by: string): Promise<Page> {
	const d = await getJSON<unknown>(`https://poetrydb.org/${by}/${enc(q)}`);
	const poems = (Array.isArray(d) ? d : []) as { title: string; author: string; lines: string[] }[];
	return {
		items: poems.slice(0, 60).map((p) => ({
			title: p.title,
			meta: `${p.author} · ${p.lines.length} lines`,
			load: async () => ({ title: p.title, author: p.author, lang: 'en', source: 'https://poetrydb.org', content: p.lines.join('\n') }),
		})),
	};
}

/* ── window ── */
export class LibraryModal extends Modal {
	private source: Source = 'gutenberg';
	private lang = 'en';
	private by = 'title';
	private query = '';
	private results!: HTMLElement;
	private searchId = 0;

	constructor(private plugin: Rplugin) {
		super(plugin.app);
	}

	onOpen() {
		this.setTitle('Reword library');
		const form = this.contentEl.createDiv();
		this.results = this.contentEl.createDiv({ cls: 'reword-results' });
		const draw = () => {
			form.empty();
			new Setting(form).setName('Source').addDropdown((d) => d
				.addOptions({ gutenberg: 'Books (Project Gutenberg)', wikipedia: 'Wikipedia', wikisource: 'Wikisource', poetry: 'Poetry (English)' })
				.setValue(this.source)
				.onChange((v) => { this.source = v as Source; this.searchId++; this.results.empty(); draw(); }));
			if (this.source === 'poetry') {
				new Setting(form).setName('Search by').addDropdown((d) => d.addOptions({ title: 'Title', author: 'Author' }).setValue(this.by).onChange((v) => { this.by = v; }));
			} else {
				new Setting(form).setName('Language').addDropdown((d) => d.addOptions(LANGS).setValue(this.lang).onChange((v) => { this.lang = v; }));
			}
			const wikiHint = this.source.startsWith('wiki') ? 'Search, paste a link, or leave empty for random' : 'Search';
			new Setting(form)
				.addText((t) => {
					t.setPlaceholder(wikiHint).setValue(this.query).onChange((v) => { this.query = v; });
					t.inputEl.addClass('reword-search');
					t.inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) void this.search(); });
				})
				.addButton((b) => b.setButtonText('Search').setCta().onClick(() => void this.search()));
		};
		draw();
	}

	onClose() {
		this.searchId++;
		this.contentEl.empty();
	}

	private async search(nextUrl?: string) {
		const mine = ++this.searchId;
		const q = this.query.trim();
		if (!nextUrl) this.results.empty();
		const status = this.results.createEl('p', { cls: 'reword-muted', text: 'Searching…' });
		try {
			if (this.source === 'poetry' && !q) throw new Error('type a title or an author first');
			const page = this.source === 'gutenberg'
				? await gutenberg(nextUrl ?? `https://gutendex.com/books/?search=${enc(q)}&languages=${this.lang}`)
				: this.source === 'poetry' ? await poetry(q, this.by) : await wiki(q, this.source, this.lang);
			if (mine !== this.searchId) return;
			status.remove();
			if (!page.items.length) this.results.createEl('p', { cls: 'reword-muted', text: 'No results.' });
			for (const item of page.items) {
				new Setting(this.results).setName(item.title).setDesc(item.meta)
					.addButton((b) => b.setButtonText('Speed-read').setCta().onClick(() => void this.openItem(item, 'read')))
					.addButton((b) => b.setButtonText('Zen type').onClick(() => void this.openItem(item, 'zen')));
			}
			const next = page.next;
			if (next) {
				const more = this.results.createEl('button', { text: 'Load more' });
				more.addEventListener('click', () => { more.remove(); void this.search(next); });
			}
		} catch (e) {
			if (mine === this.searchId) status.setText(`Search failed: ${(e as Error).message}`);
		}
	}

	private async openItem(item: Item, mode: Mode) {
		const loading = new Notice(`Downloading “${item.title}”…`, 0);
		try {
			const d = await item.load();
			const folder = this.plugin.data.settings.libraryFolder;
			await ensureFolder(this.app, folder);
			const name = safeName(d.author ? `${d.title} - ${d.author}` : d.title);
			const path = normalizePath(`${folder}/${name}.md`);
			// downloading the same text again opens the saved note (and your place in it)
			const file = fileAt(this.app, path) ?? (await this.app.vault.create(path,
				`---\n${stringifyYaml({ title: d.title, author: d.author, lang: d.lang, source: d.source })}---\n\n${d.content}\n`));
			this.close();
			await this.plugin.openFile(file, mode);
		} catch (e) {
			new Notice(`Could not load that text: ${(e as Error).message}`, 7000);
		} finally {
			loading.hide();
		}
	}
}
