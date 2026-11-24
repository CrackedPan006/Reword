export interface Token { t: string; after: string }
export function isRTL(lang: string): boolean;
export function core(token: string): string;
export function tokenize(text: string, lang?: string): Token[];
export function normalizeText(raw: string, preserve?: boolean): string;
export function stripGutenberg(raw: string): string;
export function detectLang(text: string): string;
export function pauseFactor(token: Token): number;
export function makeNorm(o: { ignoreCase: boolean; relax: boolean; lang?: string }): (s: string) => string;
export function fmtTime(sec: number): string;
