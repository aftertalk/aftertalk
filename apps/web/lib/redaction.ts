// The only place in web where redacted text is produced (item 36, #4): each personal-data range is
// replaced by the token the engine stored with it. Used by the call queries, the search text and the
// export. Every page loads 'redacted' for every role; 'original' is only for the "Show original" action.

export type TextWord = { w: string };
export type TextRange = { startWord: number; endWord: number; token: string };
export type RenderMode = 'redacted' | 'original';

// Only punctuation, never letters, digits or signs such as "+" or "@", so nothing of the hidden
// value can show.
const LEADING = /^[("'„“‘«[]+/;
const TRAILING = /[.,!?;:…)"'”’»\]]+$/;

/** Ranges sorted by start, so one pass over the words is enough. */
export function sortRanges<T extends TextRange>(ranges: readonly T[]): T[] {
  return [...ranges].sort((a, b) => a.startWord - b.startWord);
}

/**
 * The text of words `from`..`to` (inclusive, 0-based; default all). `sortedRanges` must come from
 * {@link sortRanges}. A range that starts before `from` or ends after `to` still hides its words
 * inside the window, so a quote or a turn can never show part of a redacted span.
 */
export function renderText(
  words: readonly TextWord[],
  sortedRanges: readonly TextRange[],
  mode: RenderMode,
  from = 0,
  to = words.length - 1
): string {
  const start = Math.max(0, from);
  const end = Math.min(words.length - 1, to);
  if (end < start) return '';
  const out: string[] = [];
  if (mode === 'original') {
    for (let i = start; i <= end; i++) out.push(words[i].w);
    return out.join(' ');
  }
  let r = 0;
  let i = start;
  while (i <= end) {
    while (r < sortedRanges.length && sortedRanges[r].endWord < i) r++;
    const range = sortedRanges[r];
    if (range && range.startWord <= i) {
      // Speech providers attach punctuation to words ("Clarke."), so a range ends on "Clarke." and
      // the full stop would go with the name. Keep an opening bracket or quote of its first word and
      // the closing punctuation of its last word, when those words are inside the window.
      const lead = range.startWord >= start ? (LEADING.exec(words[range.startWord].w)?.[0] ?? '') : '';
      const trail = range.endWord <= end ? (TRAILING.exec(words[range.endWord].w)?.[0] ?? '') : '';
      out.push(lead + range.token + trail);
      i = range.endWord + 1;
    } else {
      out.push(words[i].w);
      i++;
    }
  }
  return out.join(' ');
}
