import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

/** The translated page title. The root layout's title template adds "· Aftertalk". */
export async function localizedPageMetadata(titleKey: string): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t(titleKey) };
}
