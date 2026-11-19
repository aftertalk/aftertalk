import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// The app type scale (text-display/metric/title/body/meta, globals.css) are font sizes. Without this,
// tailwind-merge reads them as colours and drops them next to text-foreground.
const twMerge = extendTailwindMerge({
  extend: { classGroups: { 'font-size': [{ text: ['display', 'metric', 'title', 'body', 'meta'] }] } },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
