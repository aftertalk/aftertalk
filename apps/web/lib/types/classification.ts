import type { CategoryTree } from '@/lib/types/taxonomy';

export type TaxonomyCategory = CategoryTree & { children?: TaxonomyCategory[] };
