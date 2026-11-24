/* Zen typing: type straight into the text; correct characters brighten, mistakes turn red. */
import { Notice } from 'obsidian';
import { selectionWatcher } from './define';
import type { Doc } from './document';
import { core, isRTL, makeNorm } from './lib/util.js';
import { PAGE, RewordView, Session } from './view';

const isWs = (ch: string | undefined) => ch !== undefined && /\s/.test(ch);
const isPunct = (ch: string) => !/[\p{L}\p{N}\p{M}\s]/u.test(ch);

export class ZenTyping implements Session {
	idx = 0;
	private chars: string[];
	private offs: number[] = [];
	private lens: number[] = [];
	private st: Uint8Array;
	private bad = new Map<number, string>();
	private pos = 0;
	private page = -1;
	private base = 0;
	private spans: HTMLElement[] = [];
	private extra = '';
	private extraEl: HTMLElement | null = null;
	private keys = 0;
	private errs = 0;
	private good = 0;
	private active = 0;
	private lastT = 0;
	private composedAt = 0;
	private norm: (s: string) => string = (s) => s;
	private box: HTMLElement;
	private input: HTMLInputElement;
	private slider: HTMLInputElement;
	private info: HTMLElement;
	private stopWatching: () => void;

	constructor(private view: RewordView, root: HTMLElement, private doc: Doc) {
		const s = view.plugin.data.settings;
		const rtl = isRTL(doc.lang);
		this.chars = Array.from(doc.tokens.map((k) => k.t + k.after).join(''));
		let o = 0;
		for (const k of doc.tokens) {
			const len = Array.from(k.t).length;
			this.offs.push(o);
			this.lens.push(len);
			o += len + Array.from(k.after).length;
		}
		this.offs.push(o);
		this.st = new Uint8Array(this.chars.length);

		const controls = root.createDiv({ cls: 'reword-row' });
		view.button(controls, 'Skip word (Tab)', () => this.skip(1));
		view.button(controls, 'Restart', () => this.reset(0));
		const option = (label: string, value: boolean, set: (v: boolean) => void) => {
			const el = controls.createEl('label');
			const check = el.createEl('input', { type: 'checkbox' });
			check.checked = value;
			el.appendText(' ' + label);
			check.addEventListener('change', () => {
				set(check.checked);
				view.plugin.queueSave();
				this.updateNorm();
				this.autoSkip();
				this.refresh(this.pos);
				this.focus();
			});
		};
		option('Ignore case', s.ignoreCase, (v) => { s.ignoreCase = v; });
		option('Accents optional', s.relax ?? rtl, (v) => { s.relax = v; });
		option('Type punctuation', s.typePunct, (v) => { s.typePunct = v; });

		this.slider = root.createEl('input', { type: 'range', cls: 'reword-slider', attr: { min: 0, max: doc.tokens.length } });
		this.slider.addEventListener('input', () => this.setPos(this.offs[Number(this.slider.value)] ?? 0));
		this.slider.addEventListener('change', () => this.focus());

		const dir = doc.lang === 'und' ? 'auto' : rtl ? 'rtl' : 'ltr';
		this.box = root.createDiv({ cls: 'reword-text reword-zen', attr: { lang: doc.lang, dir } });
		this.box.style.fontSize = `${s.size}px`;
		this.input = root.createEl('input', {
			type: 'text', cls: 'reword-input',
			attr: { dir, lang: doc.lang, placeholder: 'Type here. Ctrl/Cmd + Enter defines the current word.', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' },
		});
		this.info = root.createDiv({ cls: 'reword-muted' });
		this.bindInput();
		this.box.addEventListener('mouseup', () => { if (!this.box.win.getSelection()?.toString().trim()) this.focus(); });
		this.stopWatching = selectionWatcher(this.box, (term, rect, i0, i1) => view.define(term, rect, i0, i1));

		this.updateNorm();
		this.reset(Math.max(0, Math.min(view.startToken(), doc.tokens.length)));
	}

	focus() { this.input.focus({ preventScroll: true }); }
	destroy() { this.stopWatching(); }
	jump(tok: number) { this.setPos(this.offs[Math.max(0, Math.min(tok, this.doc.tokens.length - 1))] ?? 0); }

	private bindInput() {
		const inp = this.input;
		inp.addEventListener('keydown', (e) => {
			if (e.isComposing || ['Process', 'Dead', 'Unidentified'].includes(e.key)) return; // IME / dead keys: input events
			const altGr = e.getModifierState('AltGraph');
			const mod = (e.ctrlKey || e.metaKey) && !altGr;
			const handled = () => { e.preventDefault(); e.stopPropagation(); };
			if (e.key === 'Enter' && mod) { handled(); this.defineCurrent(); return; }
			if (e.key === 'Tab') { handled(); this.skip(e.shiftKey ? -1 : 1); return; }
			if (e.key === 'Backspace') { handled(); this.back(); return; }
			if (mod || (e.altKey && !altGr)) return;
			if (e.key === 'Enter') { handled(); this.type('\n'); }
			else if (Array.from(e.key).length === 1) { handled(); this.type(e.key); }
		});
		const feed = (s: string) => { for (const ch of s) this.type(ch); };
		inp.addEventListener('input', (e) => {
			const ev = e as InputEvent;
			if (ev.isComposing) return;
			if (performance.now() - this.composedAt > 40) feed(ev.data || inp.value); // ignore the duplicate after compositionend
			inp.value = '';
		});
		inp.addEventListener('compositionend', (e) => { this.composedAt = performance.now(); feed(e.data); inp.value = ''; });
		inp.addEventListener('paste', (e) => e.preventDefault());
	}

	private defineCurrent() {
		const tk = this.doc.tokens[this.idx];
		const w = this.box.querySelector(`.reword-word[data-i="${this.idx}"]`);
		if (tk && w) this.view.define(core(tk.t), w.getBoundingClientRect(), this.idx, this.idx);
	}

	private updateNorm() {
		const s = this.view.plugin.data.settings;
		this.norm = makeNorm({ ignoreCase: s.ignoreCase, relax: s.relax ?? isRTL(this.doc.lang), lang: this.doc.lang });
	}

	/** Characters the typist does not have to type. */
	private auto(ch: string | undefined) {
		if (ch === undefined) return false;
		const s = this.view.plugin.data.settings;
		return (!s.typePunct && isPunct(ch)) || ((s.relax ?? isRTL(this.doc.lang)) && /\p{M}/u.test(ch));
	}

	private reset(tok: number) {
		this.st = new Uint8Array(this.chars.length);
		this.bad.clear();
		this.extra = '';
		this.keys = this.errs = this.good = this.active = this.lastT = 0;
		this.page = -1;
		this.pos = this.offs[tok] ?? 0;
		this.st.fill(1, 0, this.pos); // resuming: everything before is "done"
		this.autoSkip();
		this.refresh(this.pos);
	}

	private autoSkip() {
		while (this.pos < this.chars.length && this.auto(this.chars[this.pos])) this.st[this.pos++] = 1;
	}

	private tokAt(p: number) {
		let lo = 0, hi = this.doc.tokens.length - 1;
		while (lo < hi) {
			const m = (lo + hi + 1) >> 1;
			if ((this.offs[m] ?? 0) <= p) lo = m;
			else hi = m - 1;
		}
		return lo;
	}

	private cls(i: number) {
		const state = this.st[i] === 1 ? ' ok' : this.st[i] === 2 ? ' bad' + (this.bad.get(i) === ' ' ? ' sp' : '') : '';
		return 'c' + state + (i === this.pos ? ' cur' : '');
	}

	private glyph(i: number) {
		const typed = this.bad.get(i);
		return (this.st[i] === 2 && typed !== ' ' ? typed : this.chars[i]) ?? '';
	}

	private renderPage(page: number) {
		const n = this.doc.tokens.length, a = page * PAGE, b = Math.min(n, a + PAGE);
		this.box.empty();
		this.spans = [];
		this.extraEl = null;
		const add = (parent: HTMLElement, i: number) => this.spans.push(parent.createSpan({ cls: this.cls(i), text: this.glyph(i) }));
		for (let k = a; k < b; k++) {
			const start = this.offs[k] ?? 0, wordEnd = start + (this.lens[k] ?? 0), end = this.offs[k + 1] ?? wordEnd;
			const word = this.box.createSpan({ cls: 'reword-word', attr: { 'data-i': k } });
			for (let i = start; i < wordEnd; i++) add(word, i);
			for (let i = wordEnd; i < end; i++) {
				add(this.box, i);
				this.spans[this.spans.length - 1]?.setAttribute('data-i', String(k));
			}
		}
		this.page = page;
		this.base = this.offs[a] ?? 0;
		this.box.scrollTop = 0;
	}

	private paint(i: number) {
		const s = this.spans[i - this.base];
		if (!s) return;
		s.className = this.cls(i);
		const g = this.glyph(i);
		if (s.textContent !== g) s.textContent = g;
	}

	private showExtra() {
		this.extraEl?.remove();
		this.extraEl = null;
		const cur = this.spans[this.pos - this.base];
		if (this.extra && cur) {
			this.extraEl = createSpan({ cls: 'ex', text: this.extra });
			cur.before(this.extraEl);
		}
	}

	private stats() {
		const n = this.doc.tokens.length;
		const wpm = this.active > 2000 ? Math.round(this.good / 5 / (this.active / 60000)) : 0;
		const acc = this.keys ? Math.round((100 * (this.keys - this.errs)) / this.keys) : 100;
		this.info.setText(this.idx >= n ? `Finished · ${wpm || '–'} wpm · ${acc}% accuracy`
			: `${this.idx + 1} / ${n} words · ${wpm || '–'} wpm · ${acc}% accuracy`);
		this.slider.value = String(this.idx);
	}

	/** Redraw after the caret moved from `old` to this.pos. */
	private refresh(old: number) {
		const n = this.doc.tokens.length, done = this.pos >= this.chars.length;
		this.idx = done ? n : this.tokAt(this.pos);
		const page = Math.floor(Math.min(this.idx, n - 1) / PAGE);
		if (page !== this.page) this.renderPage(page);
		else for (let i = Math.min(old, this.pos); i <= Math.max(old, this.pos); i++) this.paint(i);
		this.showExtra();
		const cur = this.spans[this.pos - this.base];
		if (cur) {
			const top = cur.offsetTop, h = this.box.clientHeight;
			if (top < this.box.scrollTop + h * 0.12 || top > this.box.scrollTop + h * 0.62) this.box.scrollTop = Math.max(0, top - h * 0.3);
		}
		this.stats();
		this.view.moved(this.idx);
		this.input.disabled = done;
		if (done && old < this.chars.length) new Notice('Finished the whole text.');
	}

	/** Jump the caret: forward marks passed text as done, backward clears it. */
	private setPos(np: number) {
		const old = this.pos;
		np = Math.max(0, Math.min(np, this.chars.length));
		if (np < old) for (let i = np; i < old; i++) { this.st[i] = 0; this.bad.delete(i); }
		else for (let i = old; i < np; i++) if (!this.st[i]) this.st[i] = 1;
		this.pos = np;
		this.extra = '';
		this.autoSkip();
		this.refresh(old);
	}

	private skip(dir: number) {
		const tok = this.tokAt(this.pos), start = this.offs[tok] ?? 0;
		if (dir > 0) this.setPos(this.offs[tok + 1] ?? this.chars.length);
		else this.setPos(this.pos > start ? start : this.offs[Math.max(0, tok - 1)] ?? 0);
	}

	private type(c: string) {
		if (this.pos >= this.chars.length) return;
		const now = performance.now();
		if (this.lastT) this.active += Math.min(now - this.lastT, 5000);
		this.lastT = now;
		this.keys++;
		const exp = this.chars[this.pos] ?? '', old = this.pos;
		if (isWs(exp)) {
			if (isWs(c)) { // space/Enter: step over the whole whitespace run
				this.good++;
				while (this.pos < this.chars.length && isWs(this.chars[this.pos])) this.st[this.pos++] = 1;
				this.extra = '';
				this.autoSkip();
				this.refresh(old);
			} else { // a letter where a space belongs: shown as an extra red character
				this.errs++;
				this.extra = (this.extra + c).slice(0, 12);
				this.showExtra();
				this.stats();
			}
			return;
		}
		if (isWs(c)) { this.errs++; this.st[this.pos] = 2; this.bad.set(this.pos, ' '); } // space too early
		else if (this.norm(c) === this.norm(exp)) { this.good++; this.st[this.pos] = 1; }
		else { this.errs++; this.st[this.pos] = 2; this.bad.set(this.pos, c); }
		this.pos++;
		this.autoSkip();
		this.refresh(old);
	}

	private back() {
		if (this.extra) { this.extra = this.extra.slice(0, -1); this.showExtra(); return; }
		if (this.pos <= 0) return;
		let p = this.pos - 1;
		if (isWs(this.chars[p])) while (p > 0 && isWs(this.chars[p - 1])) p--;
		while (p > 0 && this.auto(this.chars[p])) p--;
		this.setPos(p);
	}
}
