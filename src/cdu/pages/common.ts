import type { Screen } from '../screen';
import { fms } from '../../fms/fms';
import type { Cdu } from '../cdu';

/** "ACT FPLN" / "MOD FPLN" */
export const actMod = (base: string, mod = !!fms.mod): string => (mod ? `MOD ${base}` : `ACT ${base}`);
export const actModPerf = (base: string): string => (fms.modPerf ? `MOD ${base}` : `ACT ${base}`);

/** Bottom-left CANCEL MOD prompt when a modification exists. Returns true if shown. */
export function cancelModPrompt(s: Screen): boolean {
  if (!fms.isMod) return false;
  s.line(6, '{w}<CANCEL MOD');
  return true;
}

export function handleCancelMod(cdu: Cdu): boolean {
  if (!fms.isMod) return false;
  fms.cancelMod();
  cdu.render();
  return true;
}

export const prompt = (text: string, side: 'L' | 'R'): string => (side === 'L' ? `{w}<${text}` : `{w}${text}>`);

/** Toggle display like ON/OFF with the active option large green. */
export function toggle(a: string, b: string, first: boolean): string {
  return first ? `{g}{l}${a}{w}{s}/${b}{/}` : `{w}{s}${a}/{g}{l}${b}{/}`;
}

export const ref = () => fms.ac.pos;
