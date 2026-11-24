export type Kind = 'front' | 'main' | 'back' | 'other';
export interface Heading { text: string; level: number }
export interface RawSection { id: string; title: string; kind: Kind; level: number; start: number; uncertain?: boolean }
export function analyzeStructure(
	text: string,
	opts?: { headings?: Heading[]; lang?: string },
): { sections: RawSection[]; startOffset: number; confidence: 'high' | 'medium' | 'low' | 'none'; dominant: string };
