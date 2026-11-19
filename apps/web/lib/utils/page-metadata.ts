import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

const BRAND = 'Aftertalk';

type PageMetadataOptions = {
  /** When true, returns only the translated title without appending the brand. */
  titleOnly?: boolean;
};

export async function localizedPageMetadata(titleKey: string, options?: PageMetadataOptions): Promise<Metadata> {
  const t = await getTranslations();
  return { title: options?.titleOnly ? t(titleKey) : `${t(titleKey)} - ${BRAND}` };
}
