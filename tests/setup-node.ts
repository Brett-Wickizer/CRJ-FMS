// Node test setup: serve navdata from disk and stub localStorage.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', 'public');
(globalThis as any).fetch = async (url: string) => {
  const p = path.join(root, String(url).replace(/^\.\//, ''));
  if (!fs.existsSync(p)) return { ok: false, json: async () => null };
  const text = fs.readFileSync(p, 'utf8');
  return { ok: true, json: async () => JSON.parse(text) };
};
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => store.set(k, v),
  removeItem: (k: string) => store.delete(k),
};
