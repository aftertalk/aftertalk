import { renderText, sortRanges } from './redaction';

const words = 'my name is Daniel Reed and my number is 07700 900123 thanks'.split(' ').map((w) => ({ w }));
const ranges = sortRanges([
  { startWord: 9, endWord: 10, token: '[PHONE_1]' },
  { startWord: 3, endWord: 4, token: '[PERSON_1]' },
]);

test('redacted text puts the stored token in place of each range', () => {
  expect(renderText(words, ranges, 'redacted')).toBe('my name is [PERSON_1] and my number is [PHONE_1] thanks');
});

test('original text is the words as they are', () => {
  expect(renderText(words, ranges, 'original')).toBe(words.map((w) => w.w).join(' '));
});

test('a window that starts or ends inside a range still hides the whole range', () => {
  // Starts on "Reed", the second word of the name.
  expect(renderText(words, ranges, 'redacted', 4, 6)).toBe('[PERSON_1] and my');
  // Ends on "07700", the first word of the number.
  expect(renderText(words, ranges, 'redacted', 7, 9)).toBe('number is [PHONE_1]');
  // Wholly inside a range.
  expect(renderText(words, ranges, 'redacted', 10, 10)).toBe('[PHONE_1]');
});

test('ranges that start before the window (shifted quote slices) are handled', () => {
  const slice = words.slice(4, 7); // Reed and my
  const shifted = sortRanges([{ startWord: -1, endWord: 0, token: '[PERSON_1]' }]);
  expect(renderText(slice, shifted, 'redacted')).toBe('[PERSON_1] and my');
});

test('punctuation attached to a redacted word stays, and nothing else of the word does', () => {
  const said = 'this is (Emma Clarke). Call „Jan”, on +48 600-100-200, please'.split(' ').map((w) => ({ w }));
  const marked = sortRanges([
    { startWord: 2, endWord: 3, token: '[PERSON_1]' },
    { startWord: 5, endWord: 5, token: '[PERSON_2]' },
    { startWord: 7, endWord: 8, token: '[PHONE_1]' },
  ]);
  // "+" is not punctuation: it stays hidden with the number.
  expect(renderText(said, marked, 'redacted')).toBe('this is ([PERSON_1]). Call „[PERSON_2]”, on [PHONE_1], please');
  // A window that ends inside a range does not take the closing punctuation of a word outside it…
  expect(renderText(said, marked, 'redacted', 0, 2)).toBe('this is ([PERSON_1]');
  // …and one that starts inside it does not take the opening bracket.
  expect(renderText(said, marked, 'redacted', 3, 4)).toBe('[PERSON_1]). Call');
});

test('an empty or reversed window is empty text', () => {
  expect(renderText(words, ranges, 'redacted', 5, 4)).toBe('');
  expect(renderText([], [], 'redacted')).toBe('');
});
