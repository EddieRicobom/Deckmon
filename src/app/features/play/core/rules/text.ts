/**
 * Parsers for card text: keywords (＜Blocker＞) and timing tags ([On Play]).
 * Keywords count only when they open a line of effect text. A keyword inside a sentence ("gains ＜Security A. +1＞
 * for every 3 colours") is conditional and is not applied as a static keyword.
 */

/** Keywords the rules layer enforces. Other keywords are parsed but only shown in reminders. */
export const ENFORCED_KEYWORDS = ['Blocker', 'Rush', 'Piercing', 'Jamming', 'Retaliation', 'Reboot'] as const;

/** Timing tags that trigger a reminder. */
export const TIMING_TAGS = [
  'On Play',
  'When Digivolving',
  'When Attacking',
  'On Deletion',
  'Start of Your Turn',
  'End of Your Turn',
  'Start of Your Main Phase',
  'Security',
  'Main',
] as const;

const LINE_KEYWORDS = /^((?:＜[^＞]+＞\s*)+)/;
const KEYWORD = /＜([^＞]+)＞/g;

/** Keyword names opening any line of `text`, e.g. "Security A. +1", "Blocker", "Draw 1". */
export function keywordsIn(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const lead = LINE_KEYWORDS.exec(line);
    if (!lead) continue;
    for (const m of lead[1].matchAll(KEYWORD)) out.push(m[1].trim());
  }
  return out;
}

/** Security Attack modifier from a "Security A. +N" / "Security A. -N" keyword list. */
export function securityAttackMod(keywords: Iterable<string>): number {
  let total = 0;
  for (const k of keywords) {
    const m = /^Security A\. ([+-]\d+)$/.exec(k);
    if (m) total += parseInt(m[1], 10);
  }
  return total;
}

/** Every [Tag] appearing in a line of text. */
export function tagsIn(line: string): string[] {
  return [...line.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].trim());
}

/**
 * The lines of `text` that carry the given timing tag, trimmed. A reminder shows these lines. Empty when the timing
 * does not occur.
 */
export function linesWithTiming(text: string, timing: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => tagsIn(l).includes(timing));
}

/** Timing tags present in `text`, restricted to the ones the reminder system knows. */
export function timingsIn(text: string): string[] {
  const found = new Set<string>();
  for (const line of text.split('\n')) for (const tag of tagsIn(line)) found.add(tag);
  return TIMING_TAGS.filter((t) => found.has(t));
}
