// 24 x 14 character CDU display buffer with a tiny color/size markup.
//
// Markup inside strings:  {g} green  {w} white  {c} cyan  {m} magenta  {a} amber
// {y} yellow  {r} red  {s} small  {l} large  {/} reset to the segment default.

export const COLS = 24;
export const ROWS = 14;

export type Color = 'w' | 'g' | 'c' | 'm' | 'a' | 'y' | 'r';

export interface Cell {
  ch: string;
  color: Color;
  small: boolean;
  inv?: boolean;
}

export interface Style {
  color?: Color;
  small?: boolean;
}

interface Run {
  text: string;
  color: Color;
  small: boolean;
}

export function parseMarkup(text: string, def: Required<Style>): Run[] {
  const runs: Run[] = [];
  let color = def.color;
  let small = def.small;
  let buf = '';
  const flush = () => {
    if (buf) runs.push({ text: buf, color, small });
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') {
      const j = text.indexOf('}', i);
      if (j > i) {
        const code = text.slice(i + 1, j);
        if (/^[wgcmayr]$/.test(code) || code === 's' || code === 'l' || code === '/') {
          flush();
          if (code === 's') small = true;
          else if (code === 'l') small = false;
          else if (code === '/') { color = def.color; small = def.small; }
          else color = code as Color;
          i = j;
          continue;
        }
      }
    }
    buf += c;
  }
  flush();
  return runs;
}

export const visibleLength = (text: string): number => parseMarkup(text, { color: 'w', small: false }).reduce((n, r) => n + r.text.length, 0);

export class Screen {
  cells: Cell[][] = [];

  constructor() {
    this.clear();
  }

  clear() {
    this.cells = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => ({ ch: ' ', color: 'w' as Color, small: false })));
  }

  put(row: number, col: number, text: string, style: Style = {}) {
    if (row < 0 || row >= ROWS) return;
    const runs = parseMarkup(text, { color: style.color ?? 'w', small: style.small ?? false });
    let c = col;
    for (const r of runs) {
      for (const ch of r.text) {
        if (c >= 0 && c < COLS) this.cells[row][c] = { ch, color: r.color, small: r.small };
        c++;
      }
    }
  }

  /** Left aligned text. */
  left(row: number, text: string, style: Style = {}) {
    this.put(row, 0, text, style);
  }
  /** Right aligned text. */
  right(row: number, text: string, style: Style = {}) {
    this.put(row, COLS - visibleLength(text), text, style);
  }
  center(row: number, text: string, style: Style = {}) {
    this.put(row, Math.floor((COLS - visibleLength(text)) / 2), text, style);
  }

  /** Page title (row 0) with optional page number "n/m". */
  title(text: string, page?: number, pages?: number) {
    const pg = page && pages ? `${page}/${pages}` : '';
    const room = COLS - (pg ? pg.length + 1 : 0);
    const len = visibleLength(text);
    const col = Math.max(0, Math.floor((room - len) / 2) + (pg ? 1 : 0));
    this.put(0, Math.min(col, room - len), text, { color: 'w' });
    if (pg) this.put(0, COLS - pg.length, pg, { color: 'w', small: true });
  }

  /** Small label line above LSK n (1..6). */
  label(n: number, left: string, right = '', center = '') {
    const row = n * 2 - 1;
    if (left) this.left(row, left, { color: 'w', small: true });
    if (center) this.center(row, center, { color: 'w', small: true });
    if (right) this.right(row, right, { color: 'w', small: true });
  }

  /** Data line next to LSK n (1..6), default large green. */
  line(n: number, left: string, right = '', style: Style = {}) {
    const row = n * 2;
    const st = { color: style.color ?? 'g', small: style.small ?? false };
    if (left) this.left(row, left, st);
    if (right) this.right(row, right, st);
  }

  centerLine(n: number, text: string, style: Style = {}) {
    this.center(n * 2, text, { color: style.color ?? 'g', small: style.small ?? false });
  }

  /** Scratchpad row. */
  scratch(text: string, color: Color = 'w') {
    this.put(13, 0, text.slice(0, COLS), { color });
  }
}

export const boxes = (n: number) => '□'.repeat(n);
export const dashes = (n: number) => '-'.repeat(n);
