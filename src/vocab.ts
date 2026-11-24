/* Vocabulary lives in ordinary notes: searchable, linkable and synced like everything else. */
import { Notice, normalizePath, stringifyYaml, TFile } from 'obsidian';
import type { Entry } from './define';
import type Rplugin from './main';
import { ensureFolder, fileAt, safeName } from './vault';

interface Word {
	term: string;
	lang: string;
	defs: Entry[];
	note: string;
	context: string;
	/** file the word came from, or just its title for imported words */
	source: TFile | string;
	added?: number;
}

export async function saveWord(plugin: Rplugin, w: Word) {
	const { app } = plugin;
	const folder = `${plugin.data.settings.vocabFolder}/${safeName(w.lang || 'und')}`;
	// lower case, because Windows treats "Word.md" and "word.md" as the same file
	const path = normalizePath(`${folder}/${safeName(w.term.toLocaleLowerCase())}.md`);
	await ensureFolder(app, folder);
	const link = w.source instanceof TFile ? app.fileManager.generateMarkdownLink(w.source, path) : w.source;
	const seen = [w.context && `> ${w.context}`, link && `From ${link}`].filter(Boolean).join('\n\n');
	const extra = [w.note && `**Note:** ${w.note}`, seen].filter(Boolean).join('\n\n');

	const existing = fileAt(app, path);
	if (existing) {
		// add the new note and sentence; never overwrite what you have written
		await app.vault.process(existing, (text) => {
			const fresh = [w.note && !text.includes(w.note) ? `**Note:** ${w.note}` : '', w.context && !text.includes(w.context) ? seen : '']
				.filter(Boolean).join('\n\n');
			return fresh ? `${text.trimEnd()}\n\n${fresh}\n` : text;
		});
		return existing;
	}
	const props = stringifyYaml({ term: w.term, lang: w.lang, added: new Date(w.added ?? Date.now()).toISOString().slice(0, 10), tags: ['vocabulary'] });
	const defs = w.defs.map((d) => `${d.pos ? `*${d.pos}*\n` : ''}${d.defs.map((x) => `- ${x}`).join('\n')}`).join('\n\n');
	return app.vault.create(path, `---\n${props}---\n\n${[defs, extra].filter(Boolean).join('\n\n')}\n`);
}

/** Bring over words exported with "Export JSON" on the website. */
export function importVocabulary(plugin: Rplugin) {
	const input = activeDocument.createEl('input');
	input.type = 'file';
	input.accept = '.json';
	input.addEventListener('change', () => {
		void (async () => {
			try {
				const file = input.files?.[0];
				if (!file) return;
				type Old = { term?: string; lang?: string; defs?: Entry[]; note?: string; context?: string; textTitle?: string; added?: number };
				const list = JSON.parse(await file.text()) as Old[];
				if (!Array.isArray(list)) throw new Error('expected a list of words');
				let n = 0;
				for (const v of list) {
					if (!v?.term) continue;
					await saveWord(plugin, { term: v.term, lang: v.lang ?? 'und', defs: v.defs ?? [], note: v.note ?? '', context: v.context ?? '', source: v.textTitle ?? '', added: v.added });
					n++;
				}
				new Notice(`Imported ${n} words.`);
			} catch (e) {
				new Notice(`Import failed: ${(e as Error).message}`);
			}
		})();
	});
	input.click();
}
