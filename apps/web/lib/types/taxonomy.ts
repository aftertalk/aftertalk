export interface CategoryTree {
  id: string;
  name: string;
  description?: string;
  callCount?: number;
}

export interface Category {
  id: string;
  taxonomyId: string;
  name: string;
  description?: string;
  parentId?: string;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
}
