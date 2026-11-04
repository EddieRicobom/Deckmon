/**
 * Hand-written effect blocks for cards the pattern parser cannot read. Keyed by card id. An entry replaces the parse
 * of every text field of that card, so list all of its blocks here. `text` is the printed line, for the log.
 */
import type { Action, EffectField, EffectTiming } from './ast';

export interface OverrideBlock {
  field: EffectField;
  timing: EffectTiming;
  optional: boolean;
  oncePerTurn: boolean;
  actions: Action[];
  text: string;
}

export const OVERRIDES: Record<string, OverrideBlock[]> = {};
