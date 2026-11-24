/* Speed reader: a thin cursor glides letter by letter, spending 60/wpm seconds on each word. */
import { Notice } from 'obsidian';
import { selectionWatcher } from './define';
import type { Doc } from './document';
import { core, fmtTime, isRTL, pauseFactor } from './lib/util.js';
import { PAGE, RewordView, Session } from './view';

const graphemeStarts = (t: string): number[] => {
	const Seg = (Intl as unknown as { Segmenter: new (l: undefined, o: object) => { segment(s: string): Iterable<{ index: number }> } }).Segmenter;
	return Array.from(new Seg(undefined, { granularity: 'grapheme' }).segment(t), (s) => s.index);
};

export class SpeedReader implements Session {
	idx = 0;
	private page = -1;
	private cur: HTMLElement | null = null;
	private words: HTMLElement[] = [];
	private playing = false;
	private timer = 0;
	private wordAt = 0;
	private ch = 0;
	private offs: number[] = [0];
	private box: HTMLElement;
	private caret: HTMLElement;
	private playButton: HTMLButtonElement;
	private slider: HTMLInputElement;
	private wpmInput: HTMLInputElement;
	private info: HTMLElement;
	private observer: ResizeObserver;
	private stopWatching: () => void;

	constructor(private view: RewordView, root: HTMLElement, private doc: Doc) {
		const s = view.plugin.data.settings;
		const controls = root.createDiv({ cls: 'reword-row' });
		this.playButton = view.button(controls, 'Start', () => this.toggle());
		this.playButton.addClass('mod-cta');
		view.button(controls, '−10', () => this.show(this.idx - 10));
		view.button(controls, '+10', () => this.show(this.idx + 10));
		view.button(controls, 'Restart', () => { this.pause(); this.show(0); });
		const wpm = controls.createEl('label', { text: 'Words per minute ' });
		this.wpmInput = wpm.createEl('input', { type: 'number', cls: 'reword-wpm', attr: { min: 30, max: 2000, step: 25 } });
		this.wpmInput.value = String(s.wpm);
		this.wpmInput.addEventListener('change', () => { this.setWpm(Number(this.wpmInput.value)); this.focus(); });
		const smart = controls.createEl('label');
		const check = smart.createEl('input', { type: 'checkbox' });
		check.checked = s.smart;
		smart.appendText(' Natural pauses');
		check.addEventListener('change', () => { s.smart = check.checked; view.plugin.queueSave(); this.focus(); });

		this.slider = root.createEl('input', { type: 'range', cls: 'reword-slider', attr: { min: 0, max: doc.tokens.length - 1 } });
		this.slider.addEventListener('input', () => this.show(Number(this.slider.value)));
		this.slider.addEventListener('change', () => this.focus());

		this.box = root.createDiv({ cls: 'reword-text', attr: { tabindex: 0, lang: doc.lang, dir: doc.lang === 'und' ? 'auto' : isRTL(doc.lang) ? 'rtl' : 'ltr' } });
		this.box.style.fontSize = `${s.size}px`;
		this.caret = createSpan({ cls: 'reword-caret' });
		this.info = root.createDiv({ cls: 'reword-muted' });

		this.box.addEventListener('click', (e) => {
			if (this.box.win.getSelection()?.toString().trim()) return; // selecting = defining, not moving
			const w = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
			if (w) this.show(Number(w.dataset.i), false);
		});
		this.stopWatching = selectionWatcher(this.box, (term, rect, i0, i1) => { this.pause(); view.define(term, rect, i0, i1); });
		view.contentEl.addEventListener('keydown', this.onKey);
		this.observer = new ResizeObserver(() => this.moveCaret());
		this.observer.observe(this.box);

		this.show(view.startToken());
	}

	focus() { this.box.focus({ preventScroll: true }); }

	destroy() {
		this.pause();
		this.observer.disconnect();
		this.stopWatching();
		this.view.contentEl.removeEventListener('keydown', this.onKey);
	}

	jump(tok: number) { this.pause(); this.show(tok); }

	private onKey = (e: KeyboardEvent) => {
		const tag = (e.target as HTMLElement).tagName;
		if (/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(tag) || e.ctrlKey || e.metaKey || e.altKey) return;
		const wpm = this.view.plugin.data.settings.wpm;
		const actions: Record<string, () => void> = {
			' ': () => this.toggle(),
			ArrowLeft: () => this.show(this.idx - 10),
			ArrowRight: () => this.show(this.idx + 10),
			ArrowUp: () => this.setWpm(wpm + 25),
			ArrowDown: () => this.setWpm(wpm - 25),
			d: () => {
				const tk = this.doc.tokens[this.idx];
				if (tk && this.cur) { this.pause(); this.view.define(core(tk.t), this.cur.getBoundingClientRect(), this.idx, this.idx); }
			},
		};
		const run = actions[e.key.length === 1 ? e.key.toLowerCase() : e.key];
		if (run) { e.preventDefault(); run(); }
	};

	private show(i: number, scroll = true) {
		const n = this.doc.tokens.length;
		i = Math.max(0, Math.min(n - 1, i));
		const page = Math.floor(i / PAGE);
		if (page !== this.page) this.renderPage(page);
		this.cur?.removeClass('cur');
		// mark everything before the cursor as read
		this.words.forEach((w, k) => w.toggleClass('done', page * PAGE + k < i));
		this.cur = this.words[i - page * PAGE] ?? null;
		this.cur?.addClass('cur');
		this.idx = i;
		if (scroll) this.keepVisible();
		this.offs = graphemeStarts(this.doc.tokens[i]?.t ?? '');
		this.ch = 0;
		this.moveCaret();
		this.slider.value = String(i);
		const wpm = this.view.plugin.data.settings.wpm;
		this.info.setText(`${(i + 1).toLocaleString()} / ${n.toLocaleString()} · ${Math.round(((i + 1) / n) * 100)}% · ${fmtTime(((n - 1 - i) / wpm) * 60)} left at ${wpm} wpm`);
		this.label();
		this.view.moved(i);
	}

	private renderPage(page: number) {
		this.box.empty();
		this.words = this.doc.tokens.slice(page * PAGE, (page + 1) * PAGE).map((tk, k) => {
			const span = this.box.createSpan({ cls: 'reword-word', text: tk.t, attr: { 'data-i': page * PAGE + k } });
			this.box.appendText(tk.after);
			return span;
		});
		this.box.appendChild(this.caret);
		this.box.scrollTop = 0;
		this.page = page;
	}

	private keepVisible() {
		if (!this.cur) return;
		const top = this.cur.offsetTop, h = this.box.clientHeight;
		if (top < this.box.scrollTop + h * 0.12 || top > this.box.scrollTop + h * 0.62) {
			this.box.scrollTo({ top: Math.max(0, top - h * 0.3), behavior: 'smooth' });
		}
	}

	private moveCaret() {
		const text = this.cur?.firstChild as Text | null | undefined;
		if (!this.cur || !text) return;
		const a = Math.min(this.offs[this.ch] ?? 0, text.length);
		const b = Math.min(this.offs[this.ch + 1] ?? text.length, text.length);
		const range = this.box.doc.createRange();
		range.setStart(text, a);
		range.setEnd(text, Math.max(a, b));
		let r = range.getBoundingClientRect();
		if (!r.width && !r.height) r = this.cur.getBoundingClientRect();
		const bx = this.box.getBoundingClientRect();
		const rtl = this.box.win.getComputedStyle(this.box).direction === 'rtl';
		const s = this.caret.style;
		s.left = `${(rtl ? r.right : r.left) - bx.left - this.box.clientLeft + this.box.scrollLeft - 1.5}px`;
		s.top = `${r.top - bx.top - this.box.clientTop + this.box.scrollTop + r.height * 0.1}px`;
		s.height = `${r.height * 0.8}px`;
	}

	private setWpm(v: number) {
		const s = this.view.plugin.data.settings;
		s.wpm = Math.max(30, Math.min(2000, Math.round(v) || 300));
		this.wpmInput.value = String(s.wpm);
		this.view.plugin.queueSave();
		if (!this.playing) this.show(this.idx, false);
	}

	private label() {
		this.playButton.setText(this.playing ? 'Pause' : this.idx > 0 ? 'Resume' : 'Start');
	}

	private toggle() {
		if (this.playing) { this.pause(); return; }
		this.view.define('', new DOMRect(), null, null); // closes an open definition
		if (this.idx >= this.doc.tokens.length - 1) this.show(0);
		this.playing = true;
		this.wordAt = performance.now() - (this.base() * this.ch) / Math.max(1, this.offs.length);
		this.label();
		this.schedule();
	}

	private pause() {
		this.box.win.clearTimeout(this.timer);
		this.playing = false;
		this.label();
	}

	private base() { return 60000 / this.view.plugin.data.settings.wpm; }

	private total() {
		const tk = this.doc.tokens[this.idx];
		return this.base() * (tk && this.view.plugin.data.settings.smart ? pauseFactor(tk) : 1);
	}

	private schedule() {
		const len = Math.max(1, this.offs.length);
		// letters share the word's time; pauses are held on the last letter
		const at = this.ch + 1 < len ? this.wordAt + (this.base() * (this.ch + 1)) / len : this.wordAt + this.total();
		this.timer = this.box.win.setTimeout(() => this.tick(), Math.max(0, at - performance.now()));
	}

	private tick() {
		if (!this.playing) return;
		if (this.ch + 1 < this.offs.length) {
			this.ch++;
			this.moveCaret();
		} else {
			if (this.idx >= this.doc.tokens.length - 1) { this.pause(); new Notice('You reached the end.'); return; }
			this.wordAt += this.total();
			const now = performance.now();
			if (this.wordAt < now - 400) this.wordAt = now; // window was throttled: don't rush to catch up
			this.show(this.idx + 1);
		}
		this.schedule();
	}
}
