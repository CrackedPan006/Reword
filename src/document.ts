/* Turns raw text into what the reader and typing views work on (ported from prepareText in app.js). */
import { detectLang, normalizeText, tokenize, type Token } from './lib/util.js';
import { analyzeStructure, type Heading, type Kind } from './lib/structure.js';

export interface Extracted {
	content: string;
	headings?: Heading[];
	title?: string;
	lang?: string;
	/** keep single line breaks (notes, poems) */
	preserve?: boolean;
}
export interface Section { title: string; kind: Kind; level: number; tok: number }
export interface Doc {
	title: string;
	lang: string;
	tokens: Token[];
	sections: Section[];
	/** where a first-time reader starts: skips front matter when the structure is clear */
	startTok: number;
}

export const KIND_LABEL: Record<Kind, string> = { front: 'Front matter', main: 'Main content', back: 'Back matter', other: 'Other' };

/** Character offset → token index. */
function tokIndexer(tokens: Token[]) {
	let o = 0;
	const ends = tokens.map((t) => (o += t.t.length + t.after.length));
	return (off: number) => {
		let lo = 0, hi = tokens.length - 1;
		while (lo < hi) {
			const m = (lo + hi) >> 1;
			if ((ends[m] ?? 0) > off) hi = m;
			else lo = m + 1;
		}
		return lo;
	};
}

export function prepareDoc(source: Extracted, fallbackTitle: string): Doc {
	const raw = source.content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
	if (!raw) throw new Error('This text is empty.');
	const lang = !source.lang || source.lang === 'auto' ? detectLang(raw) : source.lang;
	const an = analyzeStructure(raw, { headings: source.headings, lang });

	// tidy whitespace section by section (nothing is removed)
	let content = '';
	const starts = an.sections.map((s, i) => {
		const a = i === 0 ? 0 : s.start;
		const b = an.sections[i + 1]?.start ?? raw.length;
		const piece = normalizeText(raw.slice(a, b), source.preserve);
		if (content && piece) content += '\n\n';
		const at = content.length;
		content += piece;
		return at;
	});
	const tokens = tokenize(content, lang);
	if (!tokens.length) throw new Error('There are no words in this text.');
	const idx = tokIndexer(tokens);
	const sections = an.sections.map((s, i) => ({ title: s.title, kind: s.kind, level: s.level, tok: idx(starts[i] ?? 0) }));
	const si = an.startOffset > 0 ? an.sections.findIndex((s) => s.start === an.startOffset) : -1;
	return { title: source.title || fallbackTitle, lang, tokens, sections, startTok: sections[si]?.tok ?? 0 };
}

/** Index of the section containing token `tok`. */
export function sectionAt(sections: Section[], tok: number) {
	let r = 0;
	sections.forEach((s, i) => { if (s.tok <= tok) r = i; });
	return r;
}
