/* One extractor per file type. Ported from app.js; the CDN libraries are replaced by bundled/built-in ones. */
import { App, getFrontMatterInfo, loadPdfJs, parseYaml, TFile } from 'obsidian';
import JSZip from 'jszip';
import { stripGutenberg } from './lib/util.js';
import type { Heading } from './lib/structure.js';
import type { Extracted } from './document';

export const EXTENSIONS = ['md', 'txt', 'html', 'htm', 'xhtml', 'epub', 'docx', 'pdf'];
export const canRead = (file: TFile) => EXTENSIONS.includes(file.extension.toLowerCase());

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const parseXml = (s: string, type: DOMParserSupportedType = 'application/xml') => new DOMParser().parseFromString(s, type);

export async function extractFile(app: App, file: TFile): Promise<Extracted> {
	const ext = file.extension.toLowerCase();
	if (ext === 'epub') return fromEpub(await app.vault.readBinary(file));
	if (ext === 'docx') return fromDocx(await app.vault.readBinary(file));
	if (ext === 'pdf') return fromPdf(await app.vault.readBinary(file));
	const text = await app.vault.cachedRead(file);
	if (ext === 'md') return fromMarkdown(text);
	if (ext === 'txt') return { content: stripGutenberg(text) };
	return fromHtml(text);
}

/** Strip Markdown syntax so you read (and type) the words, not the markup. */
export function fromMarkdown(source: string): Extracted {
	const info = getFrontMatterInfo(source);
	let props: { lang?: unknown; title?: unknown } = {};
	if (info.exists) {
		try { props = (parseYaml(info.frontmatter) as typeof props | null) ?? {}; } catch { /* invalid properties */ }
	}
	const headings: Heading[] = [];
	const content = source
		.slice(info.exists ? info.contentStart : 0)
		.replace(/\r\n?/g, '\n')
		.replace(/%%[\s\S]*?%%|<!--[\s\S]*?-->/g, '')                      // comments
		.replace(/^[ \t]*(```|~~~).*$/gm, '')                              // code fences (code itself is kept)
		.replace(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/g, '')              // embeds and images
		.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')                  // [[wikilinks|alias]]
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')                           // [links](url)
		.replace(/^[ \t]*\|?[ \t]*:?-{3,}[-:| \t]*$/gm, '')                // rules and table dividers
		.replace(/^[ \t]*(?:>[ \t]*)+(?:\[![^\]]*\][+-]?[ \t]*)?/gm, '')   // quotes and callouts
		.replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+(?:\[.\][ \t]+)?/gm, '')     // lists and tasks
		.replace(/\*\*|__|~~|==|`/g, '')
		.replace(/(^|[^\p{L}\p{N}*])[*_]([^*_\n]+)[*_](?![\p{L}\p{N}])/gmu, '$1$2')
		.replace(/^(#{1,6})[ \t]+(.+)$/gm, (_m, hashes: string, text: string) => {
			headings.push({ text: clean(text), level: Math.min(3, hashes.length) });
			return `\n${text}\n`;
		});
	return {
		content,
		headings,
		preserve: true,
		lang: typeof props.lang === 'string' ? props.lang : undefined,
		title: typeof props.title === 'string' ? props.title : undefined,
	};
}

export function fromHtml(html: string): Extracted {
	const doc = parseXml(html, 'text/html');
	const title = clean(doc.querySelector('title')?.textContent ?? '');
	doc.querySelectorAll('script,style,nav,head').forEach((n) => n.remove());
	const headings = Array.from(doc.querySelectorAll('h1,h2,h3,h4'))
		.map((h) => ({ text: clean(h.textContent ?? ''), level: Math.min(3, Number(h.tagName[1])) }))
		.filter((h) => h.text);
	doc.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
	doc.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,tr,section,article,div').forEach((n) => n.append('\n\n'));
	return { content: doc.body?.textContent ?? '', headings, title };
}

async function fromEpub(buf: ArrayBuffer): Promise<Extracted> {
	const zip = await JSZip.loadAsync(buf);
	const read = async (path: string) => {
		const f = zip.file(path);
		if (!f) throw new Error('this does not look like a valid EPUB');
		return parseXml(await f.async('string'));
	};
	const opfPath = (await read('META-INF/container.xml')).querySelector('rootfile')?.getAttribute('full-path') ?? '';
	const opf = await read(opfPath);
	const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
	const manifest = new Map(Array.from(opf.querySelectorAll('manifest > item'), (i) => [i.getAttribute('id'), i.getAttribute('href')]));
	const meta = (name: string) => opf.getElementsByTagNameNS('*', name)[0]?.textContent ?? '';
	const resolve = (href: string) => {
		const out: string[] = [];
		for (const p of (dir + (href.split('#')[0] ?? '')).split('/')) {
			if (p === '..') out.pop();
			else if (p && p !== '.') out.push(p);
		}
		return decodeURIComponent(out.join('/'));
	};
	const parts: string[] = [];
	const headings: Heading[] = [];
	for (const ref of Array.from(opf.querySelectorAll('spine > itemref'))) {
		const href = manifest.get(ref.getAttribute('idref'));
		const f = href ? zip.file(resolve(href)) : null;
		if (!f) continue;
		const x = fromHtml(await f.async('string'));
		parts.push(x.content);
		headings.push(...(x.headings ?? []));
	}
	return { title: meta('title'), lang: meta('language').split('-')[0], content: parts.join('\n\n'), headings };
}

async function fromDocx(buf: ArrayBuffer): Promise<Extracted> {
	const zip = await JSZip.loadAsync(buf);
	const main = zip.file('word/document.xml');
	if (!main) throw new Error('this does not look like a .docx file');
	const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
	const doc = parseXml(await main.async('string'));
	const paras: string[] = [];
	const headings: Heading[] = [];
	for (const p of Array.from(doc.getElementsByTagNameNS(W, 'p'))) {
		let t = '';
		for (const n of Array.from(p.getElementsByTagNameNS('*', '*'))) {
			if (n.localName === 't') t += n.textContent ?? '';
			else if (n.localName === 'tab') t += ' ';
			else if (n.localName === 'br') t += '\n';
		}
		t = t.trim();
		if (!t) continue;
		const st = p.getElementsByTagNameNS(W, 'pStyle')[0];
		const id = st?.getAttributeNS(W, 'val') || st?.getAttribute('w:val') || '';
		const m = /^(?:heading|rubrik|überschrift|titre|encabezado|título)\s*(\d)/i.exec(id);
		if (m) headings.push({ text: clean(t), level: Math.min(3, Number(m[1])) });
		else if (/^(title|titel|titre|título)$/i.test(id)) headings.push({ text: clean(t), level: 1 });
		paras.push(t);
	}
	return { content: paras.join('\n\n'), headings };
}

interface PdfItem { str?: string; width?: number; height?: number; transform: number[] }
interface PdfPage { getTextContent(): Promise<{ items: PdfItem[] }> }
interface Pdf { numPages: number; getPage(n: number): Promise<PdfPage>; destroy(): Promise<void> }
interface PdfJs { getDocument(src: { data: Uint8Array }): { promise: Promise<Pdf> } }
interface Line { text: string; y: number; size: number; minX: number; maxX: number; furn?: boolean }

async function fromPdf(buf: ArrayBuffer): Promise<Extracted> {
	const pdfjs = (await loadPdfJs()) as PdfJs;
	const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;

	/* 1 ── lines with position and font size */
	const pages: Line[][] = [];
	for (let p = 1; p <= pdf.numPages; p++) {
		const tc = await (await pdf.getPage(p)).getTextContent();
		const lines: Line[] = [];
		let cur: Line | null = null;
		for (const it of tc.items) {
			if (!it.str) continue;
			const x = it.transform[4] ?? 0, y = it.transform[5] ?? 0, w = it.width || 0;
			const size = Math.abs(it.transform[3] ?? 0) || it.height || 10;
			if (cur && Math.abs(y - cur.y) <= Math.max(2, cur.size * 0.5)) {
				const tol = Math.max(cur.size, size) * 0.15;
				const touching = Math.abs(x - cur.maxX) <= tol || Math.abs(x + w - cur.minX) <= tol; // LTR or RTL
				cur.text += (touching || /\s$/.test(cur.text) || /^\s/.test(it.str) ? '' : ' ') + it.str;
				cur.minX = Math.min(cur.minX, x);
				cur.maxX = Math.max(cur.maxX, x + w);
				cur.size = Math.max(cur.size, size);
			} else {
				if (cur) lines.push(cur);
				cur = { text: it.str, y, size, minX: x, maxX: x + w };
			}
		}
		if (cur) lines.push(cur);
		lines.forEach((l) => { l.text = clean(l.text); });
		pages.push(lines.filter((l) => l.text));
	}
	await pdf.destroy();

	/* 2 ── body font size = most common (by characters) */
	const freq = new Map<number, number>();
	pages.forEach((pg) => pg.forEach((l) => {
		const k = Math.round(l.size * 2) / 2;
		freq.set(k, (freq.get(k) || 0) + l.text.length);
	}));
	const bodySize = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;

	/* 3 ── running headers/footers and page numbers: moved to a section at the end */
	const norm = (t: string) => t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
	const numOnly = /^[-–—\s]*(\d{1,4}|[ivxlc]{1,6})[-–—\s]*$/i;
	const edgeLines = (pg: Line[]) => new Set([pg[0], pg[pg.length - 1]].filter((l): l is Line => !!l));
	const edge = new Map<string, number>();
	pages.forEach((pg) => new Set([...edgeLines(pg)].map((l) => norm(l.text))).forEach((k) => edge.set(k, (edge.get(k) || 0) + 1)));
	const furn: string[] = [];
	pages.forEach((pg, pi) => edgeLines(pg).forEach((l) => {
		const isNum = numOnly.test(l.text) && l.size <= bodySize * 1.1;
		const repeated = pages.length >= 4 && (edge.get(norm(l.text)) ?? 0) >= Math.max(3, pages.length * 0.3);
		if (isNum || repeated) { l.furn = true; furn.push(`p.${pi + 1}: ${l.text}`); }
	}));

	/* 4 ── paragraphs (line gaps), big-font lines become their own heading blocks */
	interface Block { text: string; size?: number; hint?: Heading }
	const out: Block[] = [];
	const found: { hint: Heading; size: number }[] = [];
	let para = '', lastTerminal = false;
	const flush = () => { if (para) out.push({ text: para }); para = ''; };
	pages.forEach((pg) => {
		const lines = pg.filter((l) => !l.furn);
		const gaps: number[] = [];
		lines.forEach((l, i) => {
			const g = (lines[i - 1]?.y ?? l.y) - l.y;
			if (g > 0 && g < l.size * 3) gaps.push(g);
		});
		gaps.sort((a, b) => a - b);
		const med = gaps[gaps.length >> 1] ?? bodySize * 1.3;
		lines.forEach((l, i) => {
			if (l.size >= bodySize * 1.18 && l.text.length <= 120) {
				const prev = !para ? out[out.length - 1] : undefined;
				if (prev?.hint && Math.abs((prev.size ?? 0) - l.size) < 0.6) {
					prev.text += '\n' + l.text;
					prev.hint.text += ' ' + l.text;
					return;
				}
				flush();
				const hint = { text: l.text, level: 1 };
				out.push({ text: l.text, size: l.size, hint });
				found.push({ hint, size: Math.round(l.size * 2) / 2 });
				lastTerminal = true;
				return;
			}
			const gap = i > 0 ? (lines[i - 1]?.y ?? l.y) - l.y : 0;
			const newPara = !para || (i > 0 && gap > med * 1.45) || (i === 0 && lastTerminal && /^\p{Lu}/u.test(l.text));
			if (newPara) { flush(); para = l.text; }
			else if (/\p{L}-$/u.test(para) && /^\p{Ll}/u.test(l.text)) para = para.slice(0, -1) + l.text; // re-join hyphenation
			else para += ' ' + l.text;
			lastTerminal = /[.!?:;"”’»)]$/.test(l.text);
		});
	});
	flush();
	const sizes = [...new Set(found.map((f) => f.size))].sort((a, b) => b - a);
	found.forEach((f) => { f.hint.level = Math.min(3, sizes.indexOf(f.size) + 1); });
	let content = out.map((b) => b.text).join('\n\n');
	if (furn.length) content += '\n\nPage headers, footers & page numbers\n\n' + furn.join('\n');
	if (content.replace(/\s/g, '').length < 20) throw new Error('this PDF has no selectable text (it may be a scanned image)');
	return { content, headings: found.map((f) => f.hint) };
}
