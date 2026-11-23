'use client';

import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { BackLink } from '@/components/shared/back-link';
import { PageContainer } from '@/components/shared/page-container';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Surface } from '@/components/ui/surface';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { i18n } from '@/i18n/constants';
import { createAnalysisTemplate, updateAnalysisTemplate } from '@/lib/action/analysis-templates';
import type { AnalysisTemplate, CreateFieldRequest } from '@/lib/types';
import { AnalysisTemplateFieldAnswerType } from '@/lib/types';
import { backendMessage, unwrap } from '@/lib/utils/backend-error';
import { cn } from '@/lib/utils/cn';

// The backend's limits for a template.
const MAX_FIELDS = 20;
const MAX_OPTIONS = 50;
const MAX_NAME = 200;
const MAX_PROMPT = 2000;

const DETAILS = 'details';

type FieldFormState = {
  key: string;
  label: string;
  prompt: string;
  answerType: AnalysisTemplateFieldAnswerType;
  isRequired: boolean;
  options: string[];
};

type FieldErrors = { label?: string; prompt?: string; options?: string };

const ANSWER_TYPE_LABELS: Record<AnalysisTemplateFieldAnswerType, string> = {
  [AnalysisTemplateFieldAnswerType.TEXT]: i18n.templates.form.answerTypes.text,
  [AnalysisTemplateFieldAnswerType.BOOLEAN]: i18n.templates.form.answerTypes.boolean,
  [AnalysisTemplateFieldAnswerType.CHOICE]: i18n.templates.form.answerTypes.choice,
  [AnalysisTemplateFieldAnswerType.NUMERIC]: i18n.templates.form.answerTypes.numeric,
};

function toFieldFormStates(template: AnalysisTemplate | undefined): FieldFormState[] {
  if (!template) return [];
  return [...template.fields]
    .sort((a, b) => a.displayOrder - b.displayOrder)
    .map((f) => ({
      key: crypto.randomUUID(),
      label: f.label,
      prompt: f.prompt,
      answerType: f.answerType,
      isRequired: f.isRequired,
      options: f.options ?? [],
    }));
}

/** What the form would send, so "unsaved changes" ignores the client-only field keys. */
const snapshot = (name: string, description: string, fields: FieldFormState[]) =>
  JSON.stringify([name, description, fields.map((f) => [f.label, f.prompt, f.answerType, f.isRequired, f.options])]);

function fieldErrors(field: FieldFormState): FieldErrors {
  const errors: FieldErrors = {};
  if (!field.label.trim()) errors.label = i18n.templates.form.errors.label;
  if (!field.prompt.trim()) errors.prompt = i18n.templates.form.errors.prompt;
  if (field.answerType === AnalysisTemplateFieldAnswerType.CHOICE && !field.options.some((o) => o.trim()))
    errors.options = i18n.templates.form.errors.options;
  return errors;
}

interface TemplateEditorProps {
  projectId: string;
  /** Absent when creating a new template. */
  template?: AnalysisTemplate;
  /** The templates list this editor was opened from (Configure, or the upload setup). */
  backHref: string;
}

// A scorecard can hold 20 fields, each with its own instruction, so it gets a page: the field list on
// the left, the selected field on the right, and one sticky bar that saves the whole template. Unlike
// the rest of Configure it doesn't save as you go: the template is replaced as a whole, and a field
// still being written would fail validation.
export function TemplateEditor({ projectId, template, backHref }: TemplateEditorProps) {
  const t = useTranslations();
  const router = useRouter();
  const isEditing = !!template;

  const [initial, setInitial] = useState(() => ({
    name: template?.name ?? '',
    description: template?.description ?? '',
    fields: toFieldFormStates(template),
  }));
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [fields, setFields] = useState<FieldFormState[]>(initial.fields);
  const [selected, setSelected] = useState<string>(DETAILS);
  const [showErrors, setShowErrors] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);

  const isDirty = snapshot(name, description, fields) !== snapshot(initial.name, initial.description, initial.fields);

  // Leaving the page drops every unsaved field, which the old modal guarded against by ignoring
  // outside clicks; a full page needs the browser's own prompt instead.
  useEffect(() => {
    if (!isDirty || isSubmitting) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [isDirty, isSubmitting]);

  const errorsByKey = useMemo(() => new Map(fields.map((f) => [f.key, fieldErrors(f)])), [fields]);
  const nameError = name.trim() ? undefined : i18n.templates.form.errors.name;
  const firstInvalid = nameError
    ? DETAILS
    : fields.find((f) => Object.keys(errorsByKey.get(f.key) ?? {}).length > 0)?.key;

  const select = (key: string) => {
    setSelected(key);
    // Stacked on small screens: bring the editor into view instead of leaving it below the list.
    if (window.matchMedia('(max-width: 1023px)').matches)
      editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const addField = () => {
    if (fields.length >= MAX_FIELDS) return;
    const key = crypto.randomUUID();
    setFields((prev) => [
      ...prev,
      { key, label: '', prompt: '', answerType: AnalysisTemplateFieldAnswerType.TEXT, isRequired: false, options: [] },
    ]);
    select(key);
  };

  const updateField = (key: string, updates: Partial<FieldFormState>) =>
    setFields((prev) => prev.map((f) => (f.key === key ? { ...f, ...updates } : f)));

  const removeField = (key: string) => {
    const index = fields.findIndex((f) => f.key === key);
    const next = fields.filter((f) => f.key !== key);
    setFields(next);
    setSelected(next[Math.min(index, next.length - 1)]?.key ?? DETAILS);
  };

  const moveField = (index: number, offset: -1 | 1) =>
    setFields((prev) => {
      const target = index + offset;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  const discard = () => {
    setName(initial.name);
    setDescription(initial.description);
    setFields(initial.fields);
    setShowErrors(false);
    if (selected !== DETAILS && !initial.fields.some((f) => f.key === selected)) setSelected(DETAILS);
  };

  const handleSubmit = async () => {
    if (firstInvalid) {
      setShowErrors(true);
      select(firstInvalid);
      return;
    }
    setIsSubmitting(true);

    const fieldPayloads: CreateFieldRequest[] = fields.map((f) => ({
      label: f.label.trim(),
      prompt: f.prompt.trim(),
      answerType: f.answerType,
      isRequired: f.isRequired,
      ...(f.answerType === AnalysisTemplateFieldAnswerType.CHOICE
        ? { options: f.options.map((o) => o.trim()).filter(Boolean) }
        : {}),
    }));

    try {
      if (template) {
        unwrap(
          await updateAnalysisTemplate(projectId, template.id, {
            name: name.trim(),
            // Send the trimmed value (possibly empty) rather than undefined so clearing the description
            // actually persists — undefined is dropped from the JSON body and the backend keeps the old value.
            description: description.trim(),
            fields: fieldPayloads,
          })
        );
        toast.success(t(i18n.templates.form.success.updated));
      } else {
        unwrap(
          await createAnalysisTemplate(projectId, {
            name: name.trim(),
            description: description.trim() || undefined,
            fields: fieldPayloads,
          })
        );
        toast.success(t(i18n.templates.form.success.created));
      }
      // Saved: nothing is unsaved any more, so the leave-page guard must not fire on the way back.
      setInitial({ name, description, fields });
      router.push(backHref);
      router.refresh();
    } catch (error) {
      const message = backendMessage(error) ?? '';
      toast.error(
        t(
          message.includes('already exists') || message.includes('409')
            ? i18n.templates.form.error.duplicate
            : isEditing
              ? i18n.templates.form.error.update
              : i18n.templates.form.error.create
        )
      );
      setIsSubmitting(false);
    }
  };

  const selectedIndex = fields.findIndex((f) => f.key === selected);
  const selectedField = selectedIndex >= 0 ? fields[selectedIndex] : null;

  return (
    <PageContainer>
      <BackLink href={backHref}>{t(i18n.templates.title)}</BackLink>
      <PageHeader
        title={template ? template.name : t(i18n.templates.form.createTitle)}
        description={t(i18n.templates.form.createDescription)}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)] lg:gap-8">
        {/* Left: the template's settings and its fields, in order. */}
        <div className="space-y-3 lg:sticky lg:top-24 lg:self-start">
          <Surface pad="none" className="p-1.5">
            <ListItem active={selected === DETAILS} invalid={showErrors && !!nameError} onClick={() => select(DETAILS)}>
              <span className="text-body text-foreground block truncate font-medium">
                {name.trim() || t(i18n.templates.form.untitled)}
              </span>
              <span className="text-meta text-muted-foreground block">{t(i18n.templates.form.details)}</span>
            </ListItem>
          </Surface>

          <div className="flex items-center justify-between gap-3 px-1 pt-2">
            <p className="text-meta text-muted-foreground">
              {t(i18n.templates.form.fieldsCount, { count: fields.length, max: MAX_FIELDS })}
            </p>
            <Button variant="ghost" size="sm" onClick={addField} disabled={fields.length >= MAX_FIELDS}>
              <Plus />
              {t(i18n.templates.form.addField)}
            </Button>
          </div>

          {fields.length > 0 ? (
            <Surface pad="none" className="space-y-0.5 p-1.5">
              {fields.map((field, index) => (
                <ListItem
                  key={field.key}
                  active={selected === field.key}
                  invalid={showErrors && Object.keys(errorsByKey.get(field.key) ?? {}).length > 0}
                  onClick={() => select(field.key)}
                >
                  <span className="flex items-baseline gap-2.5">
                    <span className="text-meta text-muted-foreground w-5 shrink-0 text-right tabular-nums">
                      {index + 1}.
                    </span>
                    <span className="min-w-0">
                      <span
                        className={cn(
                          'text-body block truncate',
                          field.label.trim() ? 'text-foreground' : 'text-muted-foreground'
                        )}
                      >
                        {field.label.trim() || t(i18n.templates.form.untitledField)}
                      </span>
                      <span className="text-meta text-muted-foreground block">
                        {t(ANSWER_TYPE_LABELS[field.answerType])}
                        {field.isRequired && ` · ${t(i18n.templates.form.fieldRequired).toLowerCase()}`}
                      </span>
                    </span>
                  </span>
                </ListItem>
              ))}
            </Surface>
          ) : (
            <Surface tone="muted" className="text-center">
              <p className="text-body text-foreground">{t(i18n.templates.form.noFields)}</p>
              <p className="text-meta text-muted-foreground mt-1">{t(i18n.templates.form.noFieldsDescription)}</p>
            </Surface>
          )}
        </div>

        {/* Right: whatever is selected on the left. */}
        <div ref={editorRef} className="scroll-mt-24">
          <Surface pad="lg">
            {selectedField ? (
              <FieldEditor
                key={selectedField.key}
                field={selectedField}
                index={selectedIndex}
                total={fields.length}
                errors={showErrors ? (errorsByKey.get(selectedField.key) ?? {}) : {}}
                onUpdate={(updates) => updateField(selectedField.key, updates)}
                onMove={(offset) => moveField(selectedIndex, offset)}
                onRemove={() => removeField(selectedField.key)}
              />
            ) : (
              <div className="space-y-6">
                <h2 className="text-title text-foreground font-medium">{t(i18n.templates.form.details)}</h2>
                <FormField id="template-name" label={t(i18n.templates.name)} error={showErrors ? nameError : undefined}>
                  <Input
                    id="template-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t(i18n.templates.form.namePlaceholder)}
                    maxLength={MAX_NAME}
                    aria-invalid={showErrors && !!nameError}
                  />
                </FormField>
                <FormField id="template-description" label={t(i18n.templates.templateDescription)}>
                  <Textarea
                    id="template-description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={t(i18n.templates.form.descriptionPlaceholder)}
                    rows={3}
                  />
                </FormField>
              </div>
            )}
          </Surface>
        </div>
      </div>

      {/* New templates always show the bar (it's the only way to create one); edits show it once changed. */}
      {(isDirty || !isEditing) && (
        <div className="sticky bottom-4 z-20">
          <div className="bg-muted/90 flex flex-wrap items-center gap-3 rounded-2xl px-5 py-3 backdrop-blur-md">
            <p className="text-meta text-muted-foreground mr-auto">{isDirty && t(i18n.templates.form.unsaved)}</p>
            {isEditing ? (
              <Button variant="ghost" onClick={discard} disabled={isSubmitting}>
                {t(i18n.templates.form.discard)}
              </Button>
            ) : (
              <Button variant="ghost" asChild>
                <Link href={backHref}>{t(i18n.common.cancel)}</Link>
              </Button>
            )}
            <Button onClick={handleSubmit} disabled={isSubmitting}>
              {isEditing
                ? t(isSubmitting ? i18n.templates.form.saving : i18n.templates.form.save)
                : t(isSubmitting ? i18n.templates.form.creating : i18n.templates.form.create)}
            </Button>
          </div>
        </div>
      )}
    </PageContainer>
  );
}

function ListItem({
  active,
  invalid,
  onClick,
  children,
}: {
  active: boolean;
  invalid: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active || undefined}
      className={cn(
        'relative flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left transition-colors',
        active ? 'bg-foreground/[0.07]' : 'hover:bg-foreground/[0.04]'
      )}
    >
      <span className="min-w-0 flex-1">{children}</span>
      {invalid && <span aria-hidden className="bg-negative size-2 shrink-0 rounded-full" />}
    </button>
  );
}

function FormField({
  id,
  label,
  hint,
  error,
  children,
}: {
  id?: string;
  label: string;
  hint?: React.ReactNode;
  error?: string;
  children: React.ReactNode;
}) {
  const t = useTranslations();
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-body text-foreground block font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-meta text-negative">{t(error)}</p>
      ) : (
        hint && <p className="text-meta text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

function FieldEditor({
  field,
  index,
  total,
  errors,
  onUpdate,
  onMove,
  onRemove,
}: {
  field: FieldFormState;
  index: number;
  total: number;
  errors: FieldErrors;
  onUpdate: (updates: Partial<FieldFormState>) => void;
  onMove: (offset: -1 | 1) => void;
  onRemove: () => void;
}) {
  const t = useTranslations();
  const isChoice = field.answerType === AnalysisTemplateFieldAnswerType.CHOICE;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-title text-foreground font-medium">
          {t(i18n.templates.form.fieldNumber, { number: index + 1 })}
        </h2>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={() => onMove(-1)}
            disabled={index === 0}
            aria-label={t(i18n.templates.form.moveUp)}
          >
            <ArrowUp />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={() => onMove(1)}
            disabled={index === total - 1}
            aria-label={t(i18n.templates.form.moveDown)}
          >
            <ArrowDown />
          </Button>
          <Button variant="ghost" size="sm" className="text-negative hover:text-negative h-8" onClick={onRemove}>
            <Trash2 />
            {t(i18n.templates.form.removeField)}
          </Button>
        </div>
      </div>

      <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_200px]">
        <FormField id={`label-${field.key}`} label={t(i18n.templates.form.fieldLabel)} error={errors.label}>
          <Input
            id={`label-${field.key}`}
            value={field.label}
            onChange={(e) => onUpdate({ label: e.target.value })}
            placeholder={t(i18n.templates.form.fieldLabelPlaceholder)}
            maxLength={MAX_NAME}
            aria-invalid={!!errors.label}
          />
        </FormField>
        <FormField id={`type-${field.key}`} label={t(i18n.templates.form.fieldAnswerType)}>
          <Select
            value={field.answerType}
            onValueChange={(value) => onUpdate({ answerType: value as AnalysisTemplateFieldAnswerType })}
          >
            <SelectTrigger id={`type-${field.key}`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.values(AnalysisTemplateFieldAnswerType).map((type) => (
                <SelectItem key={type} value={type}>
                  {t(ANSWER_TYPE_LABELS[type])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      </div>

      <FormField
        id={`prompt-${field.key}`}
        label={t(i18n.templates.form.fieldPrompt)}
        error={errors.prompt}
        hint={t(i18n.templates.form.promptLength, { count: field.prompt.length, max: MAX_PROMPT })}
      >
        <Textarea
          id={`prompt-${field.key}`}
          value={field.prompt}
          onChange={(e) => onUpdate({ prompt: e.target.value })}
          placeholder={t(i18n.templates.form.fieldPromptPlaceholder)}
          maxLength={MAX_PROMPT}
          rows={6}
          className="min-h-36"
          aria-invalid={!!errors.prompt}
        />
      </FormField>

      {isChoice && (
        <div className="space-y-2">
          <p className="text-body text-foreground font-medium">{t(i18n.templates.form.fieldOptions)}</p>
          {field.options.map((option, optIdx) => (
            <div key={optIdx} className="flex items-center gap-2">
              <Input
                value={option}
                onChange={(e) =>
                  onUpdate({ options: field.options.map((o, i) => (i === optIdx ? e.target.value : o)) })
                }
                placeholder={t(i18n.templates.form.optionPlaceholder)}
                aria-label={t(i18n.templates.form.optionPlaceholder)}
              />
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground size-8 shrink-0"
                onClick={() => onUpdate({ options: field.options.filter((_, i) => i !== optIdx) })}
                aria-label={t(i18n.templates.form.removeOption)}
              >
                <X />
              </Button>
            </div>
          ))}
          {errors.options && <p className="text-meta text-negative">{t(errors.options)}</p>}
          <Button
            variant="outline"
            size="sm"
            onClick={() => onUpdate({ options: [...field.options, ''] })}
            disabled={field.options.length >= MAX_OPTIONS}
          >
            <Plus />
            {t(i18n.templates.form.addOption)}
          </Button>
        </div>
      )}

      <div className="border-foreground/[0.06] flex items-center justify-between gap-6 border-t pt-5">
        <label htmlFor={`required-${field.key}`} className="text-body text-foreground font-medium">
          {t(i18n.templates.form.fieldRequired)}
        </label>
        <Switch
          id={`required-${field.key}`}
          checked={field.isRequired}
          onCheckedChange={(checked) => onUpdate({ isRequired: checked })}
        />
      </div>
    </div>
  );
}
