// The one colour source for charts and status. Coral is the brand and the single primary action;
// it does not mean "bad". Sentiment uses teal / grey / red everywhere (charts, badges, the hero ribbon).
// The same sentiment values exist as Tailwind colours (bg-positive, text-negative, …) in globals.css.

export const BRAND_CORAL = '#F3553C';
export const BRAND_TEAL = '#6EAD98';

export const SENTIMENT = {
  positive: '#6EAD98',
  neutral: '#9AA0A9',
  negative: '#E5484D',
  unknown: '#6B7079',
} as const;

/** Categorical series (categories, templates, custom dimensions): calm and distinct, no sentiment colours. */
export const CATEGORICAL = ['#8FA3BF', '#C9A36B', '#9B8BC4', '#6FA8A8', '#C98A9B', '#A3A86B', '#7F8FA6', '#B58E7A'];
