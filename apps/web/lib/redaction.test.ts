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

test('an empty or reversed window is empty text', () => {
  expect(renderText(words, ranges, 'redacted', 5, 4)).toBe('');
  expect(renderText([], [], 'redacted')).toBe('');
});
