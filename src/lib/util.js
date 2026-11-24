'use strict';
/* Pure helpers: no DOM access, so they can be unit-tested in Node. */
(function (root) {
  const RTL = ['ar', 'he', 'fa', 'ur', 'ps', 'yi', 'ckb', 'sd'];
  const NO_SPACE = ['zh', 'ja', 'th', 'km', 'lo', 'my'];
  const base = l => (l || '').toLowerCase().split('-')[0];
  const isRTL = l => RTL.includes(base(l));

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Strip everything that is not a letter, number or combining mark from both ends of a token.
  const EDGE = /^[^\p{L}\p{N}\p{M}]+|[^\p{L}\p{N}\p{M}]+$/gu;
  const core = t => t.replace(EDGE, '');

  /**
   * Split text into tokens: { t: "word,", after: " " }.
   * `t` is the word with attached punctuation, `after` is the whitespace that follows it
   * (so paragraph/line breaks are preserved). Works for space-separated scripts
   * (Latin, Arabic, Cyrillic...) and, via Intl.Segmenter, for Chinese/Japanese/Thai etc.
   */
  function tokenize(text, lang) {
    const out = [];
    let lead = '';
    const add = (t, after) => {
      if (core(t)) { out.push({ t: lead + t, after }); lead = ''; }
      else if (out.length) out[out.length - 1].after += t + after;   // pure punctuation: glue to previous word
      else lead += t + after;
    };
    if (NO_SPACE.includes(base(lang)) && typeof Intl !== 'undefined' && Intl.Segmenter) {
      const seg = new Intl.Segmenter(lang, { granularity: 'word' });
      let cur = null, trail = '';
      for (const s of seg.segment(text)) {
        if (s.isWordLike) { if (cur !== null) { add(cur, trail); trail = ''; } cur = s.segment; }
        else if (cur === null) lead += s.segment;
        else trail += s.segment;
      }
      if (cur !== null) add(cur, trail);
    } else {
      const re = /(\S+)(\s*)/gu;
      let m;
      while ((m = re.exec(text))) add(m[1], m[2]);
    }
    return out;
  }

  /** Clean raw text. Unless `preserve` is true (poems), hard-wrapped lines are re-flowed into paragraphs. */
  function normalizeText(raw, preserve) {
    let s = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n');
    if (!preserve) s = s.replace(/([^\n])\n(?!\n)/g, '$1 ').replace(/ {2,}/g, ' ');
    return s.replace(/\n{3,}/g, '\n\n').trim();
  }

  /** Remove the Project Gutenberg licence header and footer. */
  function stripGutenberg(raw) {
    const a = /\*\*\* ?START OF[^\n]*\n/i.exec(raw);
    let s = a ? raw.slice(a.index + a[0].length) : raw;
    const b = /\*\*\* ?END OF/i.exec(s);
    if (b) s = s.slice(0, b.index);
    return s;
  }

  /** Rough language guess: by script first, then by common stop-words for Latin-script languages. */
  function detectLang(text) {
    const s = text.slice(0, 4000);
    const cnt = re => (s.match(re) || []).length;
    const letters = cnt(/\p{L}/gu) || 1;
    const scripts = {
      ja: cnt(/[\u3040-\u30FF]/g), ko: cnt(/[\uAC00-\uD7AF]/g), ar: cnt(/[\u0600-\u06FF]/g),
      he: cnt(/[\u0590-\u05FF]/g), ru: cnt(/[\u0400-\u04FF]/g), el: cnt(/[\u0370-\u03FF]/g), zh: cnt(/[\u4E00-\u9FFF]/g),
    };
    if (scripts.ja / letters > 0.05) return 'ja';
    for (const [k, v] of Object.entries(scripts).sort((a, b) => b[1] - a[1])) if (v / letters > 0.3) return k;
    const words = ' ' + s.toLowerCase().replace(/[^\p{L}]+/gu, ' ') + ' ';
    const hints = {
      en: ['the', 'and', 'of', 'to', 'was'], sv: ['och', 'att', 'det', 'som', 'är', 'inte'],
      de: ['der', 'die', 'und', 'das', 'nicht', 'ist'], fr: ['le', 'les', 'et', 'des', 'est', 'une'],
      es: ['el', 'los', 'las', 'que', 'y', 'una'], it: ['il', 'che', 'di', 'non', 'una', 'è'],
      pt: ['os', 'que', 'não', 'uma', 'de', 'um'], nl: ['de', 'het', 'een', 'en', 'niet', 'van'],
    };
    let best = 'und', top = 2;
    for (const [l, ws] of Object.entries(hints)) {
      let n = 0;
      for (const w of ws) n += words.split(' ' + w + ' ').length - 1;
      if (n > top) { top = n; best = l; }
    }
    return best;
  }

  /** How long a word stays highlighted, relative to the base interval (natural pauses). */
  function pauseFactor(tk) {
    let f = 1;
    if (/\n\s*\n/.test(tk.after)) f = 2.2;
    else if (/[.!?…。！？؟]["'”’»)\]]*$/u.test(tk.t)) f = 1.9;
    else if (/[,;:،؛、，]["'”’»)\]]*$/u.test(tk.t)) f = 1.4;
    else if (/\n/.test(tk.after)) f = 1.3;
    if (core(tk.t).length > 11) f *= 1.15;
    return f;
  }

  /** Comparison function for zen typing. */
  function makeNorm({ ignoreCase, relax, lang }) {
    return s => {
      let r = s.normalize('NFC');
      if (relax) r = r.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC');   // é=e, å=a, Arabic tashkeel optional
      if (ignoreCase) {
        try { r = r.toLocaleLowerCase(lang && lang !== 'und' ? lang : undefined); } catch { r = r.toLowerCase(); }
      }
      return r;
    };
  }

  const fmtTime = sec => {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}h ${m}m` : m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
  };

  const api = { isRTL, esc, core, tokenize, normalizeText, stripGutenberg, detectLang, pauseFactor, makeNorm, fmtTime };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
