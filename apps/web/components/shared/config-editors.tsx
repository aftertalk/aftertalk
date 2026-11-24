'use client';

import {
  Check,
  ChevronRight,
  ClipboardList,
  CornerDownRight,
  FolderTree,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Power,
  PowerOff,
  Star,
  Trash2,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { EXAMPLE_TEMPLATES, SUGGESTED_CATEGORIES, SUGGESTED_ROLES } from '@/components/pages/onboarding/constants';
import { EmptyState } from '@/components/shared/empty-state';
import { InlineEditor, InlineEditorActions } from '@/components/shared/inline-editor';
import { SettingsSection } from '@/components/shared/settings-section';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmModal } from '@/components/ui/confirm-modal';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { i18n } from '@/i18n/constants';
import {
  activateAnalysisTemplate,
  createAnalysisTemplate,
  deactivateAnalysisTemplate,
  deleteAnalysisTemplate,
  getAnalysisTemplates,
} from '@/lib/action/analysis-templates';
import {
  createSpeakerPreset,
  deleteSpeakerPreset,
  getSpeakerPresets,
  setDefaultSpeakerPreset,
  updateSpeakerPreset,
} from '@/lib/action/speaker-presets';
import {
  clearTaxonomy,
  createCategory,
  deleteCategory,
  getTaxonomy,
  moveCategory,
  updateCategory,
} from '@/lib/action/taxonomy';
import type { AnalysisTemplate, SpeakerPreset } from '@/lib/types';
import { TaxonomyCategory } from '@/lib/types/classification';
import { backendMessage, unwrap } from '@/lib/utils/backend-error';
import { parsePresetSpeakers } from '@/lib/utils/channel-roles';
import { cn } from '@/lib/utils/cn';

// The three lists a project needs before uploads (categories, speaker roles, analysis templates).
// Each editor is one stacked <SettingsSection>, so callers place it inside <SettingsSections>.
// Small forms open inline (one at a time); a saved row flashes "Zapisano" instead of a toast.

/** The backend nests categories at most three levels deep (depth 0–2). */
const MAX_DEPTH = 2;

/** Puts focus back on whatever opened an inline editor, once it has re-rendered. */
const focusById = (id: string) => requestAnimationFrame(() => document.getElementById(id)?.focus());

/** The id of the row that just saved, cleared after 1.5s so its fill and "Zapisano" fade. */
function useSavedFlash() {
  const [savedId, setSavedId] = useState<string | null>(null);
  useEffect(() => {
    if (!savedId) return;
    const timer = setTimeout(() => setSavedId(null), 1500);
    return () => clearTimeout(timer);
  }, [savedId]);
  return [savedId, setSavedId] as const;
}

// ─── Category helpers ─────────────────────────────────────────────────────────

type FlatCategory = { id: string; name: string; depth: number };

function flattenCategories(categories: TaxonomyCategory[], depth = 0): FlatCategory[] {
  return categories.flatMap((cat) => [
    { id: cat.id, name: cat.name, depth },
    ...flattenCategories(cat.children ?? [], depth + 1),
  ]);
}

function containsId(cat: TaxonomyCategory, id: string): boolean {
  return cat.id === id || (cat.children?.some((child) => containsId(child, id)) ?? false);
}

/** Levels below this category: 0 for a leaf. */
function subtreeHeight(cat: TaxonomyCategory): number {
  return cat.children?.length ? 1 + Math.max(...cat.children.map(subtreeHeight)) : 0;
}

function findParentId(categories: TaxonomyCategory[], targetId: string, parentId: string | null = null): string | null {
  for (const cat of categories) {
    if (cat.id === targetId) return parentId;
    const found = findParentId(cat.children ?? [], targetId, cat.id);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Where a category can move: under any other category that keeps the tree within three levels. Not to the
 * top level: the backend's move ignores an empty parent, so there is no way to send it there.
 */
function moveTargets(categories: TaxonomyCategory[], cat: TaxonomyCategory): FlatCategory[] {
  const currentParent = findParentId(categories, cat.id);
  const height = subtreeHeight(cat);
  return flattenCategories(categories).filter(
    (target) => target.id !== currentParent && !containsId(cat, target.id) && target.depth + 1 + height <= MAX_DEPTH
  );
}

type CategoryEditor = { kind: 'add'; parentId: string | null } | { kind: 'edit'; category: TaxonomyCategory };

// ─── Categories editor ─────────────────────────────────────────────────────────

export function CategoriesEditor({ projectId }: { projectId: string }) {
  const t = useTranslations();
  const [categories, setCategories] = useState<TaxonomyCategory[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [editor, setEditor] = useState<CategoryEditor | null>(null);
  const [returnFocusId, setReturnFocusId] = useState('');
  const [savedId, setSavedId] = useSavedFlash();
  const [deletingCategory, setDeletingCategory] = useState<TaxonomyCategory | null>(null);
  const [isDeletingCat, setIsDeletingCat] = useState(false);
  const [isResetDialogOpen, setIsResetDialogOpen] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getTaxonomy(projectId)
      .then((cats) => {
        if (!cancelled) setCategories(cats);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const refreshCategories = async () => setCategories(await getTaxonomy(projectId));

  const openEditor = (next: CategoryEditor, triggerId: string) => {
    setEditor(next);
    setReturnFocusId(triggerId);
  };

  const cancelEditor = () => {
    setEditor(null);
    focusById(returnFocusId);
  };

  const handleSaved = async (id: string) => {
    await refreshCategories();
    setEditor(null);
    setSavedId(id);
    focusById(`category-menu-${id}`);
  };

  const handleMove = async (cat: TaxonomyCategory, newParentId: string) => {
    try {
      unwrap(await moveCategory(projectId, { id: cat.id, newParentId }));
      await refreshCategories();
      setSavedId(cat.id);
    } catch (error) {
      const message = backendMessage(error) ?? '';
      toast.error(
        t(
          message.includes('depth')
            ? i18n.settings.taxonomy.moveCategoryModal.depthError
            : i18n.settings.taxonomy.moveCategoryModal.error
        )
      );
    }
  };

  const handleDeleteCat = async () => {
    if (!deletingCategory) return;
    setIsDeletingCat(true);
    try {
      unwrap(await deleteCategory(projectId, deletingCategory.id));
      setDeletingCategory(null);
      await refreshCategories();
    } catch {
      toast.error(t(i18n.settings.taxonomy.deleteCategoryModal.error));
    } finally {
      setIsDeletingCat(false);
    }
  };

  const handleResetTaxonomy = async () => {
    setIsResetting(true);
    try {
      await clearTaxonomy(projectId);
      setCategories(null);
      setIsResetDialogOpen(false);
    } catch {
      toast.error(t(i18n.settings.taxonomy.reset.error));
    } finally {
      setIsResetting(false);
    }
  };

  const catCount = categories?.length ?? 0;
  const isAddingRoot = editor?.kind === 'add' && editor.parentId === null;

  const suggestionItems = SUGGESTED_CATEGORIES.map((s) => {
    const name = t(s.nameKey);
    return {
      label: name,
      isAdded: categories?.some((c) => c.name.toLowerCase() === name.toLowerCase()) ?? false,
    };
  });
  const addSuggestion = async (idx: number) => {
    const s = SUGGESTED_CATEGORIES[idx];
    unwrap(await createCategory(projectId, { name: t(s.nameKey), description: t(s.descriptionKey) }));
    await refreshCategories();
  };

  const formFor = (depth: number, category?: TaxonomyCategory, parentId: string | null = null) => (
    <CategoryForm
      projectId={projectId}
      category={category}
      parentId={parentId}
      parentName={parentId ? findCategory(categories ?? [], parentId)?.name : undefined}
      depth={depth}
      onCancel={cancelEditor}
      onSaved={handleSaved}
    />
  );

  const addButton = (
    <Button id="category-add" onClick={() => openEditor({ kind: 'add', parentId: null }, 'category-add')}>
      <Plus />
      {t(i18n.settings.taxonomy.actions.addCategory)}
    </Button>
  );

  return (
    <>
      <SettingsSection
        layout="stacked"
        title={t(i18n.settings.taxonomy.categories.title)}
        description={t(i18n.settings.taxonomy.categories.description)}
        actions={
          catCount > 0 && (
            <>
              <Button variant="destructiveOutline" onClick={() => setIsResetDialogOpen(true)}>
                {t(i18n.settings.taxonomy.actions.resetTaxonomy)}
              </Button>
              {!editor && addButton}
            </>
          )
        }
      >
        {isLoading ? (
          <LoadingState />
        ) : catCount === 0 && !isAddingRoot ? (
          <EmptyState
            icon={FolderTree}
            title={t(i18n.settings.taxonomy.empty.title)}
            description={t(i18n.settings.taxonomy.empty.description)}
            action={addButton}
          />
        ) : (
          <div className="divide-foreground/[0.06] divide-y">
            {isAddingRoot && formFor(0)}
            {categories?.map((category) => (
              <CategoryRows
                key={category.id}
                category={category}
                depth={0}
                editor={editor}
                savedId={savedId}
                renderForm={formFor}
                moveTargetsFor={(cat) => moveTargets(categories, cat)}
                onAddChild={(cat) => openEditor({ kind: 'add', parentId: cat.id }, `category-menu-${cat.id}`)}
                onEdit={(cat) => openEditor({ kind: 'edit', category: cat }, `category-menu-${cat.id}`)}
                onMove={handleMove}
                onDelete={setDeletingCategory}
              />
            ))}
          </div>
        )}
        {!isLoading && !editor && <QuickAddRow items={suggestionItems} onAdd={addSuggestion} />}
      </SettingsSection>

      <ConfirmModal
        open={deletingCategory !== null}
        onOpenChange={(o: boolean) => !o && setDeletingCategory(null)}
        onConfirm={handleDeleteCat}
        title={t(i18n.settings.taxonomy.deleteCategoryModal.title)}
        description={t(i18n.settings.taxonomy.deleteCategoryModal.description)}
        confirmText={t(i18n.settings.taxonomy.deleteCategoryModal.confirm)}
        cancelText={t(i18n.common.cancel)}
        loadingText={t(i18n.settings.taxonomy.deleteCategoryModal.deleting)}
        variant="destructive"
        isLoading={isDeletingCat}
      >
        {deletingCategory?.callCount !== undefined && deletingCategory.callCount > 0 && (
          <Alert>
            <AlertDescription>
              {t(i18n.settings.taxonomy.deleteCategoryModal.callCountWarning, { count: deletingCategory.callCount })}
            </AlertDescription>
          </Alert>
        )}
      </ConfirmModal>

      <ConfirmModal
        open={isResetDialogOpen}
        onOpenChange={setIsResetDialogOpen}
        onConfirm={handleResetTaxonomy}
        title={t(i18n.settings.taxonomy.reset.title)}
        description={t(i18n.settings.taxonomy.reset.description)}
        confirmText={t(i18n.settings.taxonomy.reset.confirm)}
        cancelText={t(i18n.common.cancel)}
        loadingText={t(i18n.settings.taxonomy.reset.resetting)}
        variant="destructive"
        isLoading={isResetting}
      />
    </>
  );
}

function CategoryForm({
  projectId,
  category,
  parentId,
  parentName,
  depth,
  onCancel,
  onSaved,
}: {
  projectId: string;
  /** Present when editing. */
  category?: TaxonomyCategory;
  parentId: string | null;
  /** Named in the form, so it's clear which category a new subcategory goes under. */
  parentName?: string;
  depth: number;
  onCancel: () => void;
  onSaved: (id: string) => Promise<void>;
}) {
  const t = useTranslations();
  const [name, setName] = useState(category?.name ?? '');
  const [description, setDescription] = useState(category?.description ?? '');
  const [showErrors, setShowErrors] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const nameError = !name.trim();
  const descriptionError = !description.trim();
  const isEditing = !!category;

  const submit = async () => {
    if (nameError || descriptionError) {
      setShowErrors(true);
      return;
    }
    setIsSubmitting(true);
    setServerError(null);
    try {
      const saved = category
        ? unwrap(
            await updateCategory(projectId, { id: category.id, name: name.trim(), description: description.trim() })
          )
        : unwrap(await createCategory(projectId, { name: name.trim(), description: description.trim(), parentId }));
      await onSaved(saved.id);
    } catch (error) {
      const message = backendMessage(error) ?? '';
      setServerError(
        t(
          message.includes('depth')
            ? i18n.settings.taxonomy.moveCategoryModal.depthError
            : isEditing
              ? i18n.settings.taxonomy.editCategoryModal.error
              : i18n.settings.taxonomy.addCategoryModal.error
        )
      );
      setIsSubmitting(false);
    }
  };

  const idPrefix = category ? `category-${category.id}` : `category-new-${parentId ?? 'root'}`;

  return (
    <div style={{ paddingLeft: depth * 24 }}>
      <InlineEditor
        open
        onCancel={onCancel}
        onSubmit={submit}
        label={t(
          isEditing
            ? i18n.settings.taxonomy.editCategoryModal.title
            : parentId
              ? i18n.settings.taxonomy.actions.addSubcategory
              : i18n.settings.taxonomy.addCategoryModal.title
        )}
      >
        {!isEditing && parentName && (
          <p className="text-meta text-muted-foreground">
            {t(i18n.settings.taxonomy.subcategoryOf, { parent: parentName })}
          </p>
        )}
        <Field
          id={`${idPrefix}-name`}
          label={t(i18n.settings.taxonomy.addCategoryModal.name)}
          error={showErrors && nameError ? t(i18n.settings.taxonomy.errors.name) : undefined}
        >
          <Input
            id={`${idPrefix}-name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t(i18n.settings.taxonomy.addCategoryModal.namePlaceholder)}
            aria-invalid={showErrors && nameError}
          />
        </Field>
        <Field
          id={`${idPrefix}-description`}
          label={t(i18n.settings.taxonomy.addCategoryModal.categoryDescription)}
          hint={t(i18n.settings.taxonomy.addCategoryModal.descriptionRequiredHint)}
          error={showErrors && descriptionError ? t(i18n.settings.taxonomy.errors.description) : undefined}
        >
          <Textarea
            id={`${idPrefix}-description`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            // Enter submits the form, as in the other fields; Shift+Enter still breaks the line.
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={t(i18n.settings.taxonomy.addCategoryModal.descriptionPlaceholder)}
            rows={2}
            aria-invalid={showErrors && descriptionError}
          />
        </Field>
        <InlineEditorActions error={serverError}>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={isSubmitting}>
            {t(i18n.common.cancel)}
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {t(
              isEditing
                ? isSubmitting
                  ? i18n.settings.taxonomy.editCategoryModal.saving
                  : i18n.settings.taxonomy.editCategoryModal.save
                : isSubmitting
                  ? i18n.settings.taxonomy.addCategoryModal.creating
                  : i18n.settings.taxonomy.addCategoryModal.create
            )}
          </Button>
        </InlineEditorActions>
      </InlineEditor>
    </div>
  );
}

/** One category and, while expanded, its children as sibling rows, so the hairlines run unbroken. */
function CategoryRows({
  category,
  depth,
  editor,
  savedId,
  renderForm,
  moveTargetsFor,
  onAddChild,
  onEdit,
  onMove,
  onDelete,
}: {
  category: TaxonomyCategory;
  depth: number;
  editor: CategoryEditor | null;
  savedId: string | null;
  renderForm: (depth: number, category?: TaxonomyCategory, parentId?: string | null) => React.ReactNode;
  moveTargetsFor: (cat: TaxonomyCategory) => FlatCategory[];
  onAddChild: (cat: TaxonomyCategory) => void;
  onEdit: (cat: TaxonomyCategory) => void;
  onMove: (cat: TaxonomyCategory, newParentId: string) => void;
  onDelete: (cat: TaxonomyCategory) => void;
}) {
  const t = useTranslations();
  const [expanded, setExpanded] = useState(true);
  const children = category.children ?? [];
  const hasChildren = children.length > 0;
  const isEditing = editor?.kind === 'edit' && editor.category.id === category.id;
  const isAddingChild = editor?.kind === 'add' && editor.parentId === category.id;
  const targets = moveTargetsFor(category);
  const saved = savedId === category.id;

  return (
    <>
      {isEditing ? (
        renderForm(depth, category)
      ) : (
        <div
          className={cn(
            'flex items-center gap-2 px-5 py-3.5 transition-colors duration-500 md:px-6',
            saved && 'bg-foreground/[0.03]'
          )}
        >
          {depth > 0 && <span aria-hidden className="shrink-0" style={{ width: depth * 24 }} />}
          {hasChildren ? (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              aria-expanded={expanded}
              aria-label={category.name}
              className="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] flex size-6 shrink-0 items-center justify-center rounded-md transition-colors"
            >
              <ChevronRight className={cn('size-4 transition-transform duration-200', expanded && 'rotate-90')} />
            </button>
          ) : (
            <span aria-hidden className="w-6 shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-body text-foreground font-medium">{category.name}</p>
            {category.description && (
              <p className="text-meta text-muted-foreground line-clamp-1">{category.description}</p>
            )}
          </div>
          {saved ? (
            <span role="status" className="text-meta text-muted-foreground shrink-0">
              {t(i18n.projectConfig.saved)}
            </span>
          ) : (
            category.callCount !== undefined &&
            category.callCount > 0 && (
              <span className="text-meta text-muted-foreground hidden shrink-0 tabular-nums sm:inline">
                {t(i18n.settings.taxonomy.callCount, { count: category.callCount })}
              </span>
            )
          )}
          <RowMenu id={`category-menu-${category.id}`} label={t(i18n.settings.taxonomy.actions.more)}>
            <DropdownMenuItem onSelect={() => onEdit(category)} disabled={!!editor}>
              <Pencil />
              {t(i18n.settings.taxonomy.actions.edit)}
            </DropdownMenuItem>
            {depth < MAX_DEPTH && (
              <DropdownMenuItem onSelect={() => onAddChild(category)} disabled={!!editor}>
                <Plus />
                {t(i18n.settings.taxonomy.actions.addSubcategory)}
              </DropdownMenuItem>
            )}
            {targets.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="gap-2 [&>svg]:size-4">
                  <CornerDownRight />
                  {t(i18n.settings.taxonomy.actions.move)}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
                  {targets.map((target) => (
                    <DropdownMenuItem key={target.id} onSelect={() => onMove(category, target.id)}>
                      <span style={{ paddingLeft: target.depth * 12 }}>{target.name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            {/* A category with children can't be deleted; say why rather than offering a dead end. */}
            <DropdownMenuItem
              onSelect={() => onDelete(category)}
              disabled={hasChildren}
              className="text-negative focus:text-negative items-start"
            >
              <Trash2 className="mt-0.5" />
              <span>
                {t(i18n.settings.taxonomy.actions.delete)}
                {hasChildren && (
                  <span className="text-meta text-muted-foreground block">
                    {t(i18n.settings.taxonomy.deleteChildrenFirst)}
                  </span>
                )}
              </span>
            </DropdownMenuItem>
          </RowMenu>
        </div>
      )}
      {hasChildren &&
        (expanded || isAddingChild) &&
        children.map((child) => (
          <CategoryRows
            key={child.id}
            category={child}
            depth={depth + 1}
            editor={editor}
            savedId={savedId}
            renderForm={renderForm}
            moveTargetsFor={moveTargetsFor}
            onAddChild={onAddChild}
            onEdit={onEdit}
            onMove={onMove}
            onDelete={onDelete}
          />
        ))}
      {/* New subcategories land at the end of their parent's list, so the form opens there. */}
      {isAddingChild && renderForm(depth + 1, undefined, category.id)}
    </>
  );
}

// ─── Roles editor ──────────────────────────────────────────────────────────────

type PresetEditor = { kind: 'add' } | { kind: 'edit'; preset: SpeakerPreset };

export function RolesEditor({ projectId }: { projectId: string }) {
  const t = useTranslations();
  const [presets, setPresets] = useState<SpeakerPreset[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editor, setEditor] = useState<PresetEditor | null>(null);
  const [returnFocusId, setReturnFocusId] = useState('');
  const [savedId, setSavedId] = useSavedFlash();

  useEffect(() => {
    let cancelled = false;
    getSpeakerPresets(projectId)
      .then((data) => {
        if (!cancelled) setPresets(data);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const refreshPresets = async () => setPresets(await getSpeakerPresets(projectId));

  const openEditor = (next: PresetEditor, triggerId: string) => {
    setEditor(next);
    setReturnFocusId(triggerId);
  };

  const cancelEditor = () => {
    setEditor(null);
    focusById(returnFocusId);
  };

  const handleSaved = async (id: string) => {
    await refreshPresets();
    setEditor(null);
    setSavedId(id);
    focusById(`preset-menu-${id}`);
  };

  // Deleting is undoable instead of confirmed: the row goes at once and the delete is only sent once the
  // toast closes without "Cofnij".
  const handleDeletePreset = (preset: SpeakerPreset) => {
    const index = presets.findIndex((p) => p.id === preset.id);
    setPresets((prev) => prev.filter((p) => p.id !== preset.id));
    let settled = false;
    const commit = async () => {
      if (settled) return;
      settled = true;
      try {
        unwrap(await deleteSpeakerPreset(projectId, preset.id));
      } catch {
        toast.error(t(i18n.settings.speakerPresets.error.delete));
        await refreshPresets();
      }
    };
    toast(t(i18n.settings.speakerPresets.deletedToast, { name: preset.name }), {
      action: {
        label: t(i18n.settings.speakerPresets.undo),
        onClick: () => {
          settled = true;
          setPresets((prev) => [...prev.slice(0, index), preset, ...prev.slice(index)]);
        },
      },
      onAutoClose: commit,
      onDismiss: commit,
    });
  };

  const handleSetDefault = async (id: string) => {
    try {
      unwrap(await setDefaultSpeakerPreset(projectId, id));
      setPresets((prev) => prev.map((p) => ({ ...p, isDefault: p.id === id })));
      setSavedId(id);
    } catch {
      toast.error(t(i18n.settings.speakerPresets.error.update));
    }
  };

  const presetCount = presets.length;
  const isAdding = editor?.kind === 'add';

  const suggestionItems = SUGGESTED_ROLES.map((r) => {
    const name = t(r.nameKey);
    return { label: name, isAdded: presets.some((p) => p.name.toLowerCase() === name.toLowerCase()) };
  });
  const addSuggestion = async (idx: number) => {
    const r = SUGGESTED_ROLES[idx];
    try {
      unwrap(
        await createSpeakerPreset(projectId, { name: t(r.nameKey), speakers: r.speakerKeys.map((key) => t(key)) })
      );
    } catch (e) {
      toast.error(backendMessage(e) ?? t(i18n.settings.speakerPresets.error.create));
    }
    await refreshPresets();
  };

  const addButton = (
    <Button id="preset-add" onClick={() => openEditor({ kind: 'add' }, 'preset-add')}>
      <Plus />
      {t(i18n.settings.speakerPresets.addPreset)}
    </Button>
  );

  return (
    <SettingsSection
      layout="stacked"
      title={t(i18n.settings.speakerPresets.title)}
      description={t(i18n.settings.speakerPresets.description)}
      actions={presetCount > 0 && !editor && addButton}
    >
      {isLoading ? (
        <LoadingState />
      ) : presetCount === 0 && !isAdding ? (
        <EmptyState
          icon={Users}
          title={t(i18n.settings.speakerPresets.empty.title)}
          description={t(i18n.settings.speakerPresets.empty.description)}
          action={addButton}
        />
      ) : (
        <div className="divide-foreground/[0.06] divide-y">
          {isAdding && <PresetForm projectId={projectId} onCancel={cancelEditor} onSaved={handleSaved} />}
          {presets.map((preset) =>
            editor?.kind === 'edit' && editor.preset.id === preset.id ? (
              <PresetForm
                key={preset.id}
                projectId={projectId}
                preset={preset}
                onCancel={cancelEditor}
                onSaved={handleSaved}
              />
            ) : (
              <div
                key={preset.id}
                className={cn(
                  'flex items-start gap-3 px-5 py-4 transition-colors duration-500 md:px-6',
                  savedId === preset.id && 'bg-foreground/[0.03]'
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-body text-foreground font-medium">{preset.name}</p>
                    {preset.isDefault && <Chip>{t(i18n.settings.speakerPresets.isDefault)}</Chip>}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {parsePresetSpeakers(preset.speakers).map((speaker, index) => (
                      <span
                        key={index}
                        className="text-meta bg-foreground/[0.05] inline-flex items-center gap-1.5 rounded-md px-2 py-0.5"
                      >
                        <span className="text-foreground">{speaker.label}</span>
                        <span className="text-muted-foreground">
                          {t(i18n.settings.speakerPresets.channel, { channel: speaker.channel + 1 })}
                        </span>
                      </span>
                    ))}
                  </div>
                </div>
                {savedId === preset.id && (
                  <span role="status" className="text-meta text-muted-foreground shrink-0 self-center">
                    {t(i18n.projectConfig.saved)}
                  </span>
                )}
                <RowMenu id={`preset-menu-${preset.id}`} label={t(i18n.settings.taxonomy.actions.more)}>
                  <DropdownMenuItem
                    onSelect={() => openEditor({ kind: 'edit', preset }, `preset-menu-${preset.id}`)}
                    disabled={!!editor}
                  >
                    <Pencil />
                    {t(i18n.settings.speakerPresets.edit)}
                  </DropdownMenuItem>
                  {!preset.isDefault && (
                    <DropdownMenuItem onSelect={() => handleSetDefault(preset.id)}>
                      <Star />
                      {t(i18n.settings.speakerPresets.setAsDefault)}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    onSelect={() => handleDeletePreset(preset)}
                    className="text-negative focus:text-negative"
                  >
                    <Trash2 />
                    {t(i18n.settings.speakerPresets.delete)}
                  </DropdownMenuItem>
                </RowMenu>
              </div>
            )
          )}
        </div>
      )}
      {!isLoading && !editor && <QuickAddRow items={suggestionItems} onAdd={addSuggestion} />}
    </SettingsSection>
  );
}

function PresetForm({
  projectId,
  preset,
  onCancel,
  onSaved,
}: {
  projectId: string;
  /** Present when editing. */
  preset?: SpeakerPreset;
  onCancel: () => void;
  onSaved: (id: string) => Promise<void>;
}) {
  const t = useTranslations();
  const [name, setName] = useState(preset?.name ?? '');
  const [speakers, setSpeakers] = useState<string[]>(() =>
    preset ? parsePresetSpeakers(preset.speakers).map((s) => s.label) : ['', '']
  );
  const [showErrors, setShowErrors] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const nameError = !name.trim();
  const speakersError = speakers.filter((s) => s.trim()).length < 2;
  const channelLabels = [t(i18n.upload.queue.channel0), t(i18n.upload.queue.channel1)];
  const idPrefix = `preset-${preset?.id ?? 'new'}`;

  const submit = async () => {
    if (nameError || speakersError) {
      setShowErrors(true);
      return;
    }
    setIsSubmitting(true);
    setServerError(null);
    try {
      const input = { name: name.trim(), speakers: speakers.map((s) => s.trim()) };
      const saved = unwrap(
        preset
          ? await updateSpeakerPreset(projectId, { id: preset.id, ...input })
          : await createSpeakerPreset(projectId, input)
      );
      await onSaved(saved.id);
    } catch (e) {
      // The server's sentence when it refused the preset (a name already used, labels too long).
      setServerError(
        backendMessage(e) ??
          t(preset ? i18n.settings.speakerPresets.error.update : i18n.settings.speakerPresets.error.create)
      );
      setIsSubmitting(false);
    }
  };

  return (
    <InlineEditor
      open
      onCancel={onCancel}
      onSubmit={submit}
      label={t(preset ? i18n.settings.speakerPresets.edit : i18n.settings.speakerPresets.addPreset)}
    >
      <Field
        id={`${idPrefix}-name`}
        label={t(i18n.settings.speakerPresets.presetName)}
        error={showErrors && nameError ? t(i18n.settings.speakerPresets.errors.name) : undefined}
      >
        <Input
          id={`${idPrefix}-name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t(i18n.settings.speakerPresets.presetNamePlaceholder)}
          aria-invalid={showErrors && nameError}
        />
      </Field>
      <div className="space-y-2">
        <div className="grid gap-4 sm:grid-cols-2">
          {speakers.map((speaker, index) => (
            <Field
              key={index}
              id={`${idPrefix}-channel-${index}`}
              label={channelLabels[index] ?? t(i18n.upload.queue.speakerLabel, { index })}
            >
              <Input
                id={`${idPrefix}-channel-${index}`}
                value={speaker}
                onChange={(e) => setSpeakers((prev) => prev.map((s, i) => (i === index ? e.target.value : s)))}
                placeholder={t(i18n.settings.speakerPresets.speakerPlaceholder)}
                aria-invalid={showErrors && speakersError && !speaker.trim()}
              />
            </Field>
          ))}
        </div>
        {showErrors && speakersError && (
          <p className="text-meta text-negative">{t(i18n.settings.speakerPresets.errors.speakers)}</p>
        )}
      </div>
      <InlineEditorActions error={serverError}>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={isSubmitting}>
          {t(i18n.common.cancel)}
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {t(
            preset
              ? isSubmitting
                ? i18n.settings.speakerPresets.saving
                : i18n.settings.speakerPresets.save
              : isSubmitting
                ? i18n.settings.speakerPresets.creating
                : i18n.settings.speakerPresets.create
          )}
        </Button>
      </InlineEditorActions>
    </InlineEditor>
  );
}

// ─── Templates editor ───────────────────────────────────────────────────────────

interface TemplatesEditorProps {
  projectId: string;
  /** The template editor is its own page; this says where its "back" and "save" return to. */
  from?: 'upload';
}

export function TemplatesEditor({ projectId, from }: TemplatesEditorProps) {
  const t = useTranslations();
  const [templates, setTemplates] = useState<AnalysisTemplate[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [deletingTemplate, setDeletingTemplate] = useState<AnalysisTemplate | null>(null);
  const [isDeletingTpl, setIsDeletingTpl] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getAnalysisTemplates(projectId)
      .then((tpls) => {
        if (!cancelled) setTemplates(tpls);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const refreshTemplates = async () => setTemplates(await getAnalysisTemplates(projectId));

  // `tab` keeps the sidebar on "Szablony analizy" while the editor is open.
  const editorHref = (id: string) =>
    `/${projectId}/configure/templates/${id}?tab=templates${from ? `&from=${from}` : ''}`;

  const handleToggleTemplate = async (template: AnalysisTemplate) => {
    try {
      if (template.isActive) await deactivateAnalysisTemplate(projectId, template.id);
      else await activateAnalysisTemplate(projectId, template.id);
      await refreshTemplates();
    } catch {
      toast.error(t(template.isActive ? i18n.templates.error.deactivate : i18n.templates.error.activate));
    }
  };

  const handleDeleteTemplate = async () => {
    if (!deletingTemplate) return;
    setIsDeletingTpl(true);
    try {
      await deleteAnalysisTemplate(projectId, deletingTemplate.id);
      setDeletingTemplate(null);
      await refreshTemplates();
    } catch {
      toast.error(t(i18n.templates.error.delete));
    } finally {
      setIsDeletingTpl(false);
    }
  };

  const tplCount = templates?.length ?? 0;

  const suggestionItems = EXAMPLE_TEMPLATES.map((ex) => {
    const name = t(ex.nameKey);
    return {
      label: name,
      isAdded: templates?.some((tpl) => tpl.name.toLowerCase() === name.toLowerCase()) ?? false,
    };
  });
  const addSuggestion = async (idx: number) => {
    const ex = EXAMPLE_TEMPLATES[idx];
    unwrap(
      await createAnalysisTemplate(projectId, {
        name: t(ex.nameKey),
        fields: ex.fields.map((f) => ({
          label: t(f.labelKey),
          prompt: t(f.promptKey),
          answerType: f.answerType,
          options: f.optionKeys?.map((key) => t(key)),
          isRequired: false,
        })),
      })
    );
    await refreshTemplates();
  };

  const newTemplateButton = (
    <Button asChild>
      <Link href={editorHref('new')}>
        <Plus />
        {t(i18n.templates.newTemplate)}
      </Link>
    </Button>
  );

  return (
    <>
      <SettingsSection
        layout="stacked"
        title={t(i18n.templates.title)}
        description={t(i18n.templates.description)}
        actions={tplCount > 0 && newTemplateButton}
      >
        {isLoading ? (
          <LoadingState />
        ) : tplCount === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title={t(i18n.templates.empty.title)}
            description={t(i18n.templates.empty.description)}
            action={newTemplateButton}
          />
        ) : (
          <div className="divide-foreground/[0.06] divide-y">
            {templates!.map((template) => (
              <div key={template.id} className="flex items-center gap-3 px-5 py-4 md:px-6">
                <Link href={editorHref(template.id)} className="group min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-body text-foreground truncate font-medium group-hover:underline">
                      {template.name}
                    </span>
                    <Chip tone={template.isActive ? 'positive' : 'neutral'}>
                      {t(template.isActive ? i18n.templates.active : i18n.templates.inactive)}
                    </Chip>
                  </div>
                  <p className="text-meta text-muted-foreground mt-0.5 truncate">
                    {template.description && `${template.description} · `}
                    {t(i18n.templates.fieldCount, { count: template.fields.length })}
                  </p>
                </Link>
                <RowMenu label={t(i18n.settings.taxonomy.actions.more)}>
                  <DropdownMenuItem asChild>
                    <Link href={editorHref(template.id)}>
                      <Pencil />
                      {t(i18n.templates.form.edit)}
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => handleToggleTemplate(template)}>
                    {template.isActive ? <PowerOff /> : <Power />}
                    {t(template.isActive ? i18n.templates.deactivate : i18n.templates.activate)}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => setDeletingTemplate(template)}
                    className="text-negative focus:text-negative"
                  >
                    <Trash2 />
                    {t(i18n.templates.deleteConfirm.confirm)}
                  </DropdownMenuItem>
                </RowMenu>
              </div>
            ))}
          </div>
        )}
        {!isLoading && <QuickAddRow items={suggestionItems} onAdd={addSuggestion} />}
      </SettingsSection>

      <ConfirmModal
        open={deletingTemplate !== null}
        onOpenChange={(o) => !o && setDeletingTemplate(null)}
        onConfirm={handleDeleteTemplate}
        title={t(i18n.templates.deleteConfirm.title)}
        description={t(i18n.templates.deleteConfirm.description)}
        confirmText={t(i18n.templates.deleteConfirm.confirm)}
        cancelText={t(i18n.common.cancel)}
        loadingText={t(i18n.templates.deleteConfirm.deleting)}
        variant="destructive"
        isLoading={isDeletingTpl}
      />
    </>
  );
}

// ─── Shared sub-components ──────────────────────────────────────────────────────

function LoadingState() {
  return (
    <div className="flex items-center justify-center py-16">
      <Loader2 className="text-muted-foreground size-5 animate-spin" aria-hidden />
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-body text-foreground block font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-meta text-negative">{error}</p>
      ) : (
        hint && <p className="text-meta text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

const CHIP_TONES = {
  neutral: 'bg-foreground/[0.06] text-foreground/70',
  positive: 'bg-foreground/[0.08] text-foreground',
} as const;

function Chip({ tone = 'neutral', children }: { tone?: keyof typeof CHIP_TONES; children: React.ReactNode }) {
  return (
    <span className={cn('text-meta shrink-0 rounded-full px-2 py-px font-medium', CHIP_TONES[tone])}>{children}</span>
  );
}

/** Always-visible row actions: one 32px ⋯ button instead of hover-only icons. */
function RowMenu({ id, label, children }: { id?: string; label: string; children: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          id={id}
          variant="ghost"
          size="icon"
          className="text-muted-foreground size-8 shrink-0"
          aria-label={label}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

function QuickAddRow({
  items,
  onAdd,
}: {
  items: { label: string; isAdded: boolean }[];
  onAdd: (index: number) => Promise<void>;
}) {
  const t = useTranslations();
  const [loadingIdx, setLoadingIdx] = useState<number | null>(null);

  const handleAdd = async (idx: number) => {
    if (items[idx].isAdded || loadingIdx !== null) return;
    setLoadingIdx(idx);
    try {
      await onAdd(idx);
    } catch {
      toast.error(t(i18n.settings.taxonomy.quickAddError));
    } finally {
      setLoadingIdx(null);
    }
  };

  if (!items.some((i) => !i.isAdded)) return null;

  return (
    <div className="border-foreground/[0.06] border-t px-5 py-4 md:px-6">
      <p className="text-meta text-muted-foreground mb-2.5">{t(i18n.settings.taxonomy.quickAdd)}</p>
      <div className="flex flex-wrap gap-2">
        {items.map((item, idx) => (
          <button
            key={item.label}
            type="button"
            onClick={() => handleAdd(idx)}
            disabled={item.isAdded || loadingIdx !== null}
            className={cn(
              'text-meta inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 transition-colors',
              item.isAdded
                ? 'bg-foreground/[0.08] text-foreground cursor-default'
                : 'bg-foreground/[0.05] text-foreground/80 hover:bg-foreground/[0.09] hover:text-foreground disabled:cursor-wait'
            )}
          >
            {item.isAdded ? (
              <Check className="size-3.5" />
            ) : loadingIdx === idx ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Plus className="size-3.5" />
            )}
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function findCategory(categories: TaxonomyCategory[], id: string): TaxonomyCategory | undefined {
  for (const c of categories) {
    if (c.id === id) return c;
    const found = findCategory(c.children ?? [], id);
    if (found) return found;
  }
  return undefined;
}
