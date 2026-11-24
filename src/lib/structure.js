'use strict';
/* Document structure analysis (pure functions, no DOM; unit-testable in Node).
 *
 * analyzeStructure(text, { headings, lang }) → { sections, startOffset, confidence, dominant }
 *   text      cleaned text where blank lines separate paragraphs (single line breaks still present)
 *   headings  optional hints from the file format: [{ text, level }]  (PDF font sizes, HTML <h1>…, Word styles)
 *   sections  [{ id, title, kind: 'front'|'main'|'back'|'other', level, start, uncertain? }]  (start = character offset)
 * Nothing is ever removed: sections only describe ranges of the same text.
 */
(function (root) {
  const NUMW = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
    fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
    ett: 1, två: 2, tre: 3, fyra: 4, fem: 5, sex: 6, sju: 7, åtta: 8, nio: 9, tio: 10, första: 1, andra: 2, tredje: 3, fjärde: 4, femte: 5,
    uno: 1, dos: 2, tres: 3, un: 1, deux: 2, trois: 3, eins: 1, zwei: 2, drei: 3,
  };
  const ROMAN_OK = /^m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/i;
  const romanToInt = s => {
    const v = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
    s = s.toUpperCase(); let n = 0;
    for (let i = 0; i < s.length; i++) { const a = v[s[i]], b = v[s[i + 1]] || 0; n += a < b ? -a : a; }
    return n;
  };
  const toNum = s => {
    s = s.toLowerCase();
    if (/^\d+$/.test(s)) return +s;
    if (NUMW[s] != null) return NUMW[s];
    if (/^[ivxlcdm]+$/.test(s) && ROMAN_OK.test(s)) return romanToInt(s);
    return null;
  };
  const cnDigits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const cnToInt = s => {
    if (/^[0-9０-９]+$/.test(s)) return +s.replace(/[０-９]/g, c => c.charCodeAt(0) - 0xFF10);
    let n = 0, cur = 0;
    for (const ch of s) {
      if (ch in cnDigits) cur = cnDigits[ch];
      else if (ch === '十') { n += (cur || 1) * 10; cur = 0; }
      else if (ch === '百') { n += (cur || 1) * 100; cur = 0; }
    }
    return n + cur || null;
  };

  const FAM_OF = {
    chapter: 'chapter', chap: 'chapter', kapitel: 'chapter', 'capítulo': 'chapter', capitulo: 'chapter', chapitre: 'chapter', capitolo: 'chapter', hoofdstuk: 'chapter', 'глава': 'chapter',
    part: 'part', parte: 'part', partie: 'part', teil: 'part', del: 'part', 'часть': 'part',
    book: 'book', libro: 'book', livre: 'book', buch: 'book', bok: 'book',
    volume: 'volume', vol: 'volume',
    unit: 'unit', module: 'unit', enhet: 'unit',
    lesson: 'lesson', 'lección': 'lesson', leccion: 'lesson', 'leçon': 'lesson', lecon: 'lesson', lektion: 'lesson', 'урок': 'lesson',
    section: 'section', 'sección': 'section', seccion: 'section', abschnitt: 'section', avsnitt: 'section', 'раздел': 'section',
    act: 'act', scene: 'scene', canto: 'canto', stave: 'stave', episode: 'episode', week: 'week', day: 'day', topic: 'topic', story: 'story', letter: 'letter',
  };
  const RANK = { volume: 0, book: 0, part: 0, act: 0, unit: 1, chapter: 1, canto: 1, stave: 1, episode: 1, story: 1, letter: 1, week: 1, day: 1, lesson: 2, section: 2, scene: 2, topic: 2 };
  const KW_RE = new RegExp('^(' + Object.keys(FAM_OF).join('|') + ')\\.?\\s+(\\d{1,4}|[ivxlcdm]{1,8}|' + Object.keys(NUMW).join('|') + ')(?![\\p{L}\\p{N}])(.*)$', 'iu');
  const AR_RE = /^(الفصل|الباب|الجزء|القسم|الوحدة|الدرس|الكتاب)\s+(\S+)(.*)$/u;
  const AR_FAM = { 'الفصل': 'chapter', 'الباب': 'chapter', 'الجزء': 'part', 'القسم': 'section', 'الوحدة': 'unit', 'الدرس': 'lesson', 'الكتاب': 'book' };
  const CJK_RE = /^第\s*([0-9０-９一二三四五六七八九十百千零〇两]+)\s*(章|节|節|回|卷|部|篇|课|課|单元|單元)(.*)$/u;
  const CJK_FAM = { '章': 'chapter', '回': 'chapter', '卷': 'part', '部': 'part', '篇': 'part', '节': 'section', '節': 'section', '课': 'lesson', '課': 'lesson', '单元': 'unit', '單元': 'unit' };

  // Named sections: what each heading means.
  const NAMED = {};
  const reg = (kind, list) => list.forEach(n => { NAMED[n] = kind; });
  reg('toc', ['contents', 'table of contents', 'list of figures', 'list of tables', 'list of illustrations', 'innehåll', 'innehållsförteckning', 'sommaire',
    'table des matières', 'inhalt', 'inhaltsverzeichnis', 'المحتويات', 'الفهرس', 'índice general']);
  reg('front', ['preface', 'foreword', 'dedication', 'epigraph', 'title page', 'copyright', 'copyright page', 'praise for', 'also by', 'about this book',
    'note to the reader', 'a note on the text', 'list of abbreviations', 'abbreviations', 'förord', 'tillägnan', 'préface', 'avant-propos', 'vorwort',
    'الإهداء', 'تقديم']);
  reg('back', ['appendix', 'appendices', 'glossary', 'bibliography', 'references', 'works cited', 'reference list', 'index', 'endnotes', 'notes', 'footnotes',
    'further reading', 'about the author', 'about the authors', 'colophon', 'credits', 'answers', 'answer key', 'solutions', 'sources', 'afterword',
    'bilaga', 'bilagor', 'ordlista', 'litteraturförteckning', 'referenser', 'källor', 'register', 'efterord', 'noter', 'om författaren',
    'annexe', 'annexes', 'glossaire', 'bibliographie', 'postface', 'anhang', 'glossar', 'literaturverzeichnis', 'nachwort', 'quellen',
    'apéndice', 'glosario', 'bibliografía', 'المراجع', 'المصادر', 'قائمة المراجع', 'ملحق', 'الملاحق', 'الحواشي', 'عن المؤلف', 'المسرد']);
  reg('pos', ['acknowledgments', 'acknowledgements', 'acknowledgment', 'acknowledgement', 'author\'s note', 'author’s note', 'tack', 'danksagung',
    'remerciements', 'agradecimientos', 'شكر وتقدير', 'شكر']);
  reg('main', ['introduction', 'prologue', 'epilogue', 'conclusion', 'conclusions', 'abstract', 'summary', 'overview', 'inledning', 'prolog', 'epilog',
    'avslutning', 'sammanfattning', 'einleitung', 'introducción', 'introduccion', 'مقدمة', 'المقدمة', 'خاتمة', 'الخاتمة']);
  const PREFIXABLE = ['appendix', 'bilaga', 'annexe', 'anhang', 'apéndice', 'ملحق'];
  const FURN_RE = /^page headers, footers/i;

  const clean = s => s.replace(/\s+/g, ' ').trim();
  const hKey = s => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const nameKey = s => s.toLowerCase().replace(/^#+\s*/, '').replace(/^(\d+(\.\d+)*|[ivxlc]+)[.)]?\s+/i, '')
    .replace(/[:.—–-]+$/, '').replace(/\s+/g, ' ').trim();
  function namedKind(h) {
    if (FURN_RE.test(h)) return 'furn';
    const k = nameKey(h);
    if (NAMED[k]) return NAMED[k];
    for (const p of PREFIXABLE) if (k.startsWith(p + ' ') && k.length <= p.length + 40) return 'back';
    return null;
  }

  function kwMatch(h) {
    if (h.length > 140) return null;
    let fam, tok, rest, val = null, m;
    if ((m = KW_RE.exec(h))) {
      fam = FAM_OF[m[1].toLowerCase()]; tok = m[2]; rest = m[3];
      val = toNum(tok); if (val == null) return null;
    } else if ((m = AR_RE.exec(h))) {
      fam = AR_FAM[m[1]]; tok = m[2]; rest = m[3];
      val = parseInt(tok.replace(/[٠-٩]/g, c => c.charCodeAt(0) - 0x0660), 10); if (isNaN(val)) val = null;
    } else if ((m = CJK_RE.exec(h))) {
      fam = CJK_FAM[m[2]]; val = cnToInt(m[1]); rest = m[3];
    } else return null;
    const r = rest.replace(/^[\s.:\-–—)]+/, '');
    if (/^\p{Ll}/u.test(r)) return null;                    // "Chapter 3 describes…" is a sentence, not a heading
    const keys = val != null ? [fam + ':' + val].concat(fam === 'chapter' ? ['n:' + val] : []) : [hKey(h)];
    return { type: 'kw', score: 10, fam, value: val, rest: r, title: clean(h), keys };
  }
  const mdMatch = h => {
    const m = /^(#{1,6})\s+(.+)$/.exec(h);
    return m ? { type: 'md', score: 10, level: m[1].length, title: clean(m[2]), keys: [hKey(m[2])] } : null;
  };
  const seqRatio = vals => {
    const v = vals.filter(x => x != null);
    if (v.length < 2) return 0;
    let ok = 0;
    for (let i = 1; i < v.length; i++) if (v[i] === v[i - 1] + 1) ok++;
    return ok / (v.length - 1);
  };

  function analyzeStructure(text, opts) {
    opts = opts || {};
    const len = text.length;
    const hints = new Map();
    for (const h of opts.headings || []) { const k = hKey(h.text); if (k) hints.set(k, h.level || 1); }

    /* 1 ── blocks (paragraphs) with offsets */
    const blocks = [];
    const addBlock = (a, b) => {
      const raw = text.slice(a, b), t = raw.trim();
      if (!t) return;
      const lead = raw.length - raw.trimStart().length;
      blocks.push({ start: a + lead, end: a + lead + t.length, text: t, lines: t.split('\n').map(l => l.trim()).filter(Boolean) });
    };
    const re = /\n[ \t]*\n/g;
    let last = 0, m;
    while ((m = re.exec(text))) { addBlock(last, m.index); last = m.index + m[0].length; }
    addBlock(last, len);

    /* 2 ── heading candidates */
    function testHeading(h, single, bi) {
      let r = mdMatch(h);
      if (r) return r;
      const hk = hKey(h);
      if ((r = kwMatch(h))) return r;
      if (hints.has(hk)) return { type: 'hint', score: 8, level: hints.get(hk), title: clean(h), keys: [hk] };
      if (h.length <= 70) {
        const nk = namedKind(h);
        if (nk) return { type: 'named', named: nk, score: 9, level: 1, title: clean(h), keys: [hk] };
      }
      if (!single) return null;
      let mm;
      if ((mm = /^(\d{1,3}(?:\.\d{1,3}){0,3})[.)]?\s+(\S.{0,88})$/.exec(h)) && !/[.,;:!?]$/.test(h) && /^[\p{Lu}\p{Lo}\d"“'‘(]/u.test(mm[2]) && h.split(' ').length <= 13) {
        return { type: 'num', score: 6, level: mm[1].split('.').length, value: +mm[1].split('.')[0], dotted: mm[1].includes('.'), title: clean(h), keys: ['n:' + mm[1]] };
      }
      if ((mm = /^([IVXLCDM]{1,7})[.)]\s+(\S.{0,78})$/.exec(h)) && ROMAN_OK.test(mm[1]) && !/[.,;:!?]$/.test(h) && /^[\p{Lu}\p{Lo}"“'‘(]/u.test(mm[2])) {
        const v = romanToInt(mm[1]);
        return { type: 'roman', score: 5, level: 1, value: v, title: clean(h), keys: ['n:' + v] };
      }
      if ((mm = /^(?:(\d{1,3})|([IVXLCDM]{1,7}))\.?$/.exec(h)) && (mm[1] || ROMAN_OK.test(mm[2]))) {
        const v = mm[1] ? +mm[1] : romanToInt(mm[2]);
        return { type: 'bare', score: 5, level: 1, value: v, title: clean(h), keys: ['n:' + v] };
      }
      const letters = h.match(/\p{L}/gu) || [], upper = h.match(/\p{Lu}/gu) || [];
      if (letters.length >= 3 && upper.length / letters.length >= 0.8 && h.length <= 70 && h.split(' ').length <= 10 && !/[.,;]$/.test(h)) {
        return { type: 'caps', score: 4, level: 2, title: clean(h), keys: [hk] };
      }
      if (h.split(' ').length <= 8 && h.length >= 3 && !/[.,;:!?"”]$/.test(h) && /^\p{Lu}/u.test(h)) {
        const prev = blocks[bi - 1], next = blocks[bi + 1];
        if (prev && next && prev.text.length > 120 && next.text.length > 120) return { type: 'title', score: 2, level: 2, title: clean(h), keys: [hk] };
      }
      return null;
    }

    let cands = [];
    blocks.forEach((b, bi) => {
      const joined = clean(b.lines.join(' '));
      let r = null, glued = false;
      const kws = b.lines.length >= 2 && b.lines.length <= 40 && b.lines.every(l => l.length <= 90) ? b.lines.map(l => kwMatch(l)) : [];
      const allKw = kws.length && kws.every(Boolean);
      if (allKw && (b.lines.length >= 3 || new Set(kws.map(k => k.fam)).size > 1)) {
        // several heading lines in one block: either a contents-style list (≥3, dropped later unless real) or "PART ONE / Chapter 1"
        let pos = 0;
        b.lines.forEach((l, k) => {
          const at = b.text.indexOf(l, pos);
          pos = at + l.length;
          cands.push(Object.assign(kws[k], { bi, start: b.start + at, end: b.start + at + l.length, glued: false, listy: b.lines.length >= 3 }));
        });
        return;
      }
      if (b.lines.length <= 3 && joined.length <= 140) r = testHeading(joined, b.lines.length === 1, bi);
      if (!r && b.lines.length > 1 && b.lines[0].length <= 80) { r = kwMatch(b.lines[0]) || mdMatch(b.lines[0]); glued = !!r; }
      if (!r) return;
      r.bi = bi; r.start = b.start; r.glued = glued;
      r.end = glued ? b.start + b.lines[0].length : b.end;
      cands.push(r);
    });

    /* title on the next line: "CHAPTER 1" ⏎ "The Beginning" */
    const byBi = new Map(cands.map(c => [c.bi, c]));
    for (const c of cands) {
      if (c.glued || !((c.type === 'kw' && !c.rest) || c.type === 'bare')) continue;
      const nb = blocks[c.bi + 1], nc = byBi.get(c.bi + 1);
      if (nb && nb.lines.length === 1 && nb.text.length <= 80 && !/[.!?]$/.test(nb.text) && (!nc || nc.score < 5 || (nc.type === 'hint' && c.type === 'kw'))) {
        c.title = c.title + ' — ' + clean(nb.text); c.end = nb.end;
        if (nc) nc.drop = true;
      }
    }
    cands = cands.filter(c => !c.drop);

    /* weak candidates only when there is little else; numeral-only types need a sequence */
    const strong = cands.filter(c => c.score >= 5).length;
    cands = cands.filter(c => c.score >= 5 || (c.type === 'caps' && strong < 3) || (c.type === 'title' && strong === 0));
    const dropType = (pred, minCount, minSeq) => {
      const grp = cands.filter(pred);
      if (grp.length && (grp.length < minCount || seqRatio(grp.map(c => c.value)) < minSeq)) cands = cands.filter(c => !pred(c));
    };
    dropType(c => c.type === 'bare', 3, 0.6);
    dropType(c => c.type === 'roman', 3, 0.6);
    dropType(c => c.type === 'num' && !c.dotted, 2, 0.5);
    if (cands.filter(c => c.type === 'title').length < 3) cands = cands.filter(c => c.type !== 'title');

    /* 3 ── table of contents entries are not real sections */
    const dropped = new Set(), synth = [];
    const gapNext = i => (cands[i + 1] ? cands[i + 1].start - cands[i].end : Infinity);
    const tocIdx = cands.findIndex(c => c.named === 'toc' && c.start < len * 0.3);
    if (tocIdx >= 0) {
      const seen = new Set();
      let rep = -1;
      for (let j = tocIdx + 1; j < cands.length && j < tocIdx + 500; j++) {
        if (cands[j].keys.some(k => seen.has(k))) { rep = j; break; }
        cands[j].keys.forEach(k => seen.add(k));
      }
      for (let k = tocIdx + 1; k < cands.length && k < tocIdx + 500; k++) {
        if (rep >= 0 && k >= rep) break;
        if (gapNext(k) < 200) dropped.add(k); else break;
      }
    } else {
      for (let i = 0; i < cands.length && cands[i].start < len * 0.25;) {
        let e = i;
        while (e < cands.length - 1 && gapNext(e) < 200) e++;
        if (e - i + 1 >= 4) {
          const later = new Set(); cands.slice(e + 1).forEach(c => c.keys.forEach(k => later.add(k)));
          const hit = cands.slice(i, e + 1).filter(c => c.keys.some(k => later.has(k))).length;
          if (hit / (e - i + 1) >= 0.6) {
            for (let k = i; k <= e; k++) dropped.add(k);
            synth.push({ title: 'Table of contents', named: 'toc', start: cands[i].start, type: 'named', level: 1, synthetic: true });
          }
        }
        i = e + 1;
      }
    }
    cands = cands.filter((c, i) => !dropped.has(i) && !c.listy).concat(synth).sort((a, b) => a.start - b.start);

    /* 4 ── no structure found: the whole text is one main section */
    if (!cands.length) {
      return { sections: [{ id: 's0', title: 'Full text', kind: 'main', level: 1, start: 0 }], startOffset: 0, confidence: 'none', dominant: '' };
    }

    /* 5 ── dominant heading family, confidence */
    const grpOf = c => (c.type === 'named' ? null : c.type === 'kw' ? 'kw:' + c.fam : c.type);
    const counts = {};
    cands.forEach(c => { const g = grpOf(c); if (g) counts[g] = (counts[g] || 0) + 1; });
    const PRI = { kw: 5, hint: 4, md: 4, num: 3, roman: 2, bare: 2, caps: 1, title: 0 };
    const D = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || PRI[b.split(':')[0]] - PRI[a.split(':')[0]])[0] || null;
    let confidence = 'low';
    if (D) {
      const members = cands.filter(c => grpOf(c) === D), dn = members.length, dtype = D.split(':')[0];
      const numeric = ['kw', 'num', 'roman', 'bare'].includes(dtype);
      const seq = numeric ? seqRatio(members.map(c => c.value)) : 1;
      if (dn >= 3 && ['kw', 'hint', 'md', 'num'].includes(dtype) && seq >= 0.7) confidence = 'high';
      else if (dn >= 3 && dtype !== 'title') confidence = 'medium';
    }

    /* 6 ── classify: front / main / back / other */
    const firstUnnamed = cands.findIndex(c => c.type !== 'named');
    const mainStartPos = firstUnnamed >= 0 ? cands[firstUnnamed].start : len;
    let backSeen = false;
    const rankSet = [...new Set(cands.filter(c => c.type === 'kw').map(c => RANK[c.fam] != null ? RANK[c.fam] : 1))].sort((a, b) => a - b);
    const hasKw = rankSet.length > 0;
    const secs = cands.map(c => {
      let kind = 'main', uncertain = false, level = c.level || 1;
      if (c.type === 'named') {
        const n = c.named;
        if (n === 'furn') kind = 'other';
        else if (n === 'toc') kind = 'front';
        else if (n === 'front') { kind = c.start > len * 0.3 ? 'main' : 'front'; uncertain = kind === 'main'; }
        else if (n === 'pos') kind = c.start < mainStartPos ? 'front' : 'back';
        else if (n === 'back') {
          if (c.start < len * 0.5) { kind = 'main'; uncertain = true; } else { kind = 'back'; backSeen = true; }
        } else kind = 'main';
      } else if (backSeen) {
        kind = (c.type === 'kw' && grpOf(c) === D) ? 'main' : 'back';
        if (kind === 'main') backSeen = false;
      }
      if (c.type === 'kw') { const r = RANK[c.fam] != null ? RANK[c.fam] : 1; level = rankSet.indexOf(r) + 1; }
      else if (c.type === 'num') level = c.level + (hasKw ? 1 : 0);
      else if (hasKw && c.type !== 'named') level = Math.max(level, 2);
      return { title: c.title, kind, level: Math.min(level, 3), start: c.start, uncertain };
    });

    /* text before the first heading */
    if (secs[0].start > 0) {
      const lead = text.slice(0, secs[0].start);
      const markers = /©|copyright|all rights reserved|isbn|published by|printed in|first (published|edition)|translated by|project gutenberg|cover design|library of congress/i.test(lead);
      const firstMain = secs.find(s => s.kind === 'main');
      let kind = 'main', title = 'Opening', uncertain = false;
      if (markers || (lead.trim().length < 1500 && firstMain && confidence !== 'low')) { kind = 'front'; title = 'Title page & front matter'; }
      else if (lead.trim().length < 1500) uncertain = true;
      secs.unshift({ title, kind, level: 1, start: 0, uncertain });
    }
    secs.forEach((s, i) => { s.id = 's' + i; });

    const firstMain = secs.find(s => s.kind === 'main');
    const startOffset = confidence === 'low' || !firstMain ? 0 : firstMain.start;   // uncertain: never skip anything
    return { sections: secs, startOffset, confidence, dominant: D || '' };
  }

  const api = { analyzeStructure };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
