import { App, normalizePath, TFile, TFolder } from 'obsidian';

export const safeName = (s: string) =>
	s.replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').replace(/^\.+/, '').trim().slice(0, 100) || 'Untitled';

export async function ensureFolder(app: App, folder: string) {
	let path = '';
	for (const part of normalizePath(folder).split('/')) {
		path = path ? `${path}/${part}` : part;
		const found = app.vault.getAbstractFileByPath(path);
		if (found instanceof TFolder) continue;
		try { await app.vault.createFolder(path); }
		catch (e) { if (!(await app.vault.adapter.exists(path))) throw e; }
	}
}

export function fileAt(app: App, path: string) {
	const f = app.vault.getAbstractFileByPath(normalizePath(path));
	return f instanceof TFile ? f : null;
}
