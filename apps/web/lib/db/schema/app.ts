// Every core table, in the `app` schema (item 21). The "Data ownership and schema" section of the
// spec is the authority for columns, constraints and indexes. Rules: uuid keys with
// gen_random_uuid(), timestamptz, fixed value sets as text + CHECK (no enum types), user references
// as text to auth.user.id, deleting an organisation or project cascades to everything under it.
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { user } from './auth';

export const appSchema = pgSchema('app');

const tz = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => tz('created_at').notNull().defaultNow();
const updatedAt = () =>
  tz('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const id = () => uuid('id').primaryKey().defaultRandom();
const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

/** `CHECK (column IN (...))` for a fixed value set. */
const oneOf = (name: string, column: string, values: readonly string[]) =>
  check(name, sql.raw(`${column} in (${values.map((v) => `'${v}'`).join(', ')})`));

export const ORG_ROLES = ['OWNER', 'ADMIN', 'MEMBER'] as const;
export const PROJECT_ROLES = ['VIEWER', 'EDITOR', 'ADMIN'] as const;
export const PROJECT_VISIBILITIES = ['ORG', 'PRIVATE'] as const;
export const INVITABLE_ROLES = ['ADMIN', 'MEMBER'] as const;
export const PII_ACCESS = ['strict', 'full'] as const;
export const LANGUAGES = ['pl', 'en', 'uk', 'de'] as const;
export const ANSWER_TYPES = ['TEXT', 'BOOLEAN', 'CHOICE', 'NUMERIC'] as const;
export const CALL_STATUSES = ['pending', 'completed', 'completed_with_errors'] as const;
export const JOB_STATUSES = ['queued', 'sent', 'completed', 'completed_with_errors', 'failed', 'superseded'] as const;
export const ANALYSIS_KINDS = ['summary', 'call_reason', 'scorecard'] as const;
export const ANALYSIS_STATUSES = ['completed', 'failed'] as const;
export const QUOTE_MATCHES = ['verbatim', 'normalised', 'other_turn', 'unverified'] as const;
export const PII_TYPES = [
  'PERSON',
  'PHONE',
  'EMAIL',
  'IBAN',
  'CREDIT_CARD',
  'PESEL',
  'NIP',
  'REGON',
  'ID_CARD',
  'POSTAL_CODE',
  'LOCATION',
  'ORGANIZATION',
  'DATE_TIME',
  'IP_ADDRESS',
  'URL',
] as const;
export const PROVIDER_SLOTS = ['speech', 'diarization', 'llm'] as const;
export const PROVIDER_ADAPTERS = ['openai-compatible', 'pyannote-ai'] as const;
export const DATA_LOCATIONS = ['eu', 'us', 'own_network', 'other'] as const;
export const PII_ACCESS_KINDS = ['text', 'audio'] as const;
export const ACTION_ITEM_STATUSES = ['PENDING', 'IN_PROGRESS', 'DONE', 'CANCELLED'] as const;
export const ACTION_ITEM_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;

// --- organisations and people ---------------------------------------------------------------

/** Flyway V1_005, without `plan` and `deleted_at` (deletion is permanent). */
export const organizations = appSchema.table(
  'organizations',
  {
    id: id(),
    name: text('name').notNull(),
    logoUrl: text('logo_url'),
    allowMemberProjectCreate: boolean('allow_member_project_create').notNull().default(true),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    description: text('description'),
    twoFaRequired: boolean('two_fa_required').notNull().default(false),
    useCase: text('use_case'),
  },
  (t) => [index('organizations_created_by_idx').on(t.createdBy)]
);

/** Flyway V1_006. A row is created when an invitation is accepted, not when it is sent. */
export const organizationMembers = appSchema.table(
  'organization_members',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ORG_ROLES }).notNull(),
    invitedBy: text('invited_by').references(() => user.id, { onDelete: 'set null' }),
    joinedAt: tz('joined_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.userId] }),
    index('org_members_user_idx').on(t.userId),
    oneOf('organization_members_role_check', 'role', ORG_ROLES),
  ]
);

export const invitations = appSchema.table(
  'invitations',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Stored lower-case. */
    email: text('email').notNull(),
    role: text('role', { enum: INVITABLE_ROLES }).notNull(),
    /** SHA-256 (hex) of the link token; the token itself is never stored. */
    tokenHash: text('token_hash').notNull().unique(),
    invitedBy: text('invited_by').references(() => user.id, { onDelete: 'set null' }),
    expiresAt: tz('expires_at').notNull(),
    acceptedAt: tz('accepted_at'),
    revokedAt: tz('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('invitations_open_per_email')
      .on(t.organizationId, t.email)
      .where(sql`accepted_at is null and revoked_at is null`),
    oneOf('invitations_role_check', 'role', INVITABLE_ROLES),
  ]
);

// --- projects --------------------------------------------------------------------------------

/** Flyway V1_007 and V1_031: `default_language` replaced by `allowed_languages`. */
export const projects = appSchema.table(
  'projects',
  {
    id: id(),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    visibility: text('visibility', { enum: PROJECT_VISIBILITIES }).notNull().default('ORG'),
    defaultRole: text('default_role', { enum: PROJECT_ROLES }).notNull().default('VIEWER'),
    allowedLanguages: text('allowed_languages')
      .array()
      .notNull()
      .default(sql`'{en}'::text[]`),
    memberPiiAccess: text('member_pii_access', { enum: PII_ACCESS }).notNull().default('full'),
    /** null keeps calls for ever. */
    retentionDays: integer('retention_days'),
  },
  (t) => [
    index('projects_org_idx').on(t.organizationId),
    oneOf('projects_visibility_check', 'visibility', PROJECT_VISIBILITIES),
    oneOf('projects_default_role_check', 'default_role', PROJECT_ROLES),
    oneOf('projects_member_pii_access_check', 'member_pii_access', PII_ACCESS),
    check(
      'projects_allowed_languages_check',
      sql`cardinality(allowed_languages) > 0 and allowed_languages <@ array['pl','en','uk','de']::text[]`
    ),
    check('projects_retention_days_check', sql`retention_days is null or retention_days > 0`),
  ]
);

/** Flyway V1_008. */
export const projectMembers = appSchema.table(
  'project_members',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role', { enum: PROJECT_ROLES }).notNull(),
    addedBy: text('added_by').references(() => user.id, { onDelete: 'set null' }),
    addedAt: tz('added_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    index('project_members_user_idx').on(t.userId),
    oneOf('project_members_role_check', 'role', PROJECT_ROLES),
  ]
);

/** Flyway V1_020. One active template per project. */
export const analysisTemplates = appSchema.table(
  'analysis_templates',
  {
    id: id(),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    description: text('description'),
    isActive: boolean('is_active').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
  },
  (t) => [
    index('analysis_templates_user_id_idx').on(t.userId),
    uniqueIndex('analysis_templates_unique_name_per_project').on(t.projectId, t.name),
    uniqueIndex('analysis_templates_active_per_project')
      .on(t.projectId)
      .where(sql`is_active`),
  ]
);

export const analysisTemplateFields = appSchema.table(
  'analysis_template_fields',
  {
    id: id(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => analysisTemplates.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    prompt: text('prompt').notNull(),
    answerType: text('answer_type', { enum: ANSWER_TYPES }).notNull(),
    options: jsonb('options').$type<string[] | null>(),
    isRequired: boolean('is_required').notNull().default(false),
    displayOrder: integer('display_order').notNull(),
  },
  (t) => [
    index('analysis_template_fields_template_order_idx').on(t.templateId, t.displayOrder),
    oneOf('analysis_template_fields_answer_type_check', 'answer_type', ANSWER_TYPES),
  ]
);

/** Flyway V1_012. One taxonomy per project. */
export const taxonomies = appSchema.table('taxonomies', {
  id: id(),
  userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
  name: text('name').notNull().default('Default Taxonomy'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  projectId: uuid('project_id')
    .notNull()
    .unique('taxonomies_project_id_key')
    .references(() => projects.id, { onDelete: 'cascade' }),
});

/** Flyway V1_013. A tree through parent_id, at most three levels (checked in code). */
export const categories = appSchema.table(
  'categories',
  {
    id: id(),
    taxonomyId: uuid('taxonomy_id')
      .notNull()
      .references(() => taxonomies.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id').references((): AnyPgColumn => categories.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    displayOrder: integer('display_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('categories_taxonomy_parent_idx').on(t.taxonomyId, t.parentId),
    unique('categories_unique_name_per_parent').on(t.taxonomyId, t.parentId, t.name).nullsNotDistinct(),
  ]
);

/** Flyway V1_016. `speakers` is the ordered list of labels. */
export const speakerPresets = appSchema.table(
  'speaker_presets',
  {
    id: id(),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    speakers: jsonb('speakers').$type<string[]>().notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
  },
  (t) => [
    index('speaker_presets_user_id_idx').on(t.userId),
    uniqueIndex('speaker_presets_unique_name_per_project').on(t.projectId, t.name),
  ]
);

// --- providers -------------------------------------------------------------------------------

export const providerConnections = appSchema.table(
  'provider_connections',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: PROVIDER_SLOTS }).notNull(),
    adapter: text('adapter', { enum: PROVIDER_ADAPTERS }).notNull(),
    name: text('name').notNull(),
    baseUrl: text('base_url').notNull(),
    /** 12-byte nonce, then AES-256-GCM ciphertext and tag; null for a keyless own server. */
    apiKeyEncrypted: bytea('api_key_encrypted'),
    dataLocation: text('data_location', { enum: DATA_LOCATIONS }).notNull(),
    /** Speech only: did the last test return word times. */
    wordTimes: boolean('word_times'),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('provider_connections_name_per_org').on(t.organizationId, t.name),
    oneOf('provider_connections_kind_check', 'kind', PROVIDER_SLOTS),
    oneOf('provider_connections_adapter_check', 'adapter', PROVIDER_ADAPTERS),
    oneOf('provider_connections_data_location_check', 'data_location', DATA_LOCATIONS),
  ]
);

export const projectProviderChoice = appSchema.table(
  'project_provider_choice',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    slot: text('slot', { enum: PROVIDER_SLOTS }).notNull(),
    // `no action`, not `restrict`: checked at the end of the statement, so deleting an organisation
    // (projects, choices and connections in one statement) does not fail.
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => providerConnections.id, { onDelete: 'no action' }),
    /** Free text; null for diarization. */
    model: text('model'),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.slot] }),
    oneOf('project_provider_choice_slot_check', 'slot', PROVIDER_SLOTS),
  ]
);

// --- calls and results -----------------------------------------------------------------------

export const calls = appSchema.table(
  'calls',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    uploadedBy: text('uploaded_by').references(() => user.id, { onDelete: 'set null' }),
    originalFilename: text('original_filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    audioSha256: text('audio_sha256').notNull(),
    /** The state of the stored result (Status model). */
    status: text('status', { enum: CALL_STATUSES }).notNull().default('pending'),
    durationMs: integer('duration_ms'),
    language: text('language', { enum: LANGUAGES }),
    /** Set by "Process again" with a language; kept for retries and later runs. */
    forcedLanguage: text('forced_language', { enum: LANGUAGES }),
    /** {channel_0, channel_1}; null means customer, agent. */
    channelRoles: jsonb('channel_roles').$type<{ channel_0: string; channel_1: string } | null>(),
    manualCategoryId: uuid('manual_category_id').references(() => categories.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('calls_project_created_idx').on(t.projectId, t.createdAt.desc()),
    index('calls_audio_sha256_idx').on(t.audioSha256),
    oneOf('calls_status_check', 'status', CALL_STATUSES),
    check('calls_language_check', sql`language is null or language in ('pl', 'en', 'uk', 'de')`),
    check('calls_forced_language_check', sql`forced_language is null or forced_language in ('pl', 'en', 'uk', 'de')`),
  ]
);

export type JobStep = {
  name: string;
  status: string;
  error_code?: string | null;
  cached?: boolean;
  tokens?: { input: number; output: number } | null;
  duration_ms?: number;
};

/** One row per job (one dispatch of a call to the engine). */
export const jobs = appSchema.table(
  'jobs',
  {
    id: id(),
    callId: uuid('call_id')
      .notNull()
      .references(() => calls.id, { onDelete: 'cascade' }),
    /** 1, 2, 3 within a run. */
    attempt: integer('attempt').notNull(),
    status: text('status', { enum: JOB_STATUSES }).notNull().default('queued'),
    /** What was asked, without API keys; written at dispatch. */
    request: jsonb('request'),
    steps: jsonb('steps').$type<JobStep[] | null>(),
    sentAt: tz('sent_at'),
    lastHeartbeatAt: tz('last_heartbeat_at'),
    finishedAt: tz('finished_at'),
    /** Not sent before this time; set on attempts 2 and 3. */
    dispatchAfter: tz('dispatch_after'),
    currentStep: text('current_step'),
    errorStep: text('error_step'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdAt: createdAt(),
  },
  (t) => [
    index('jobs_call_created_idx').on(t.callId, t.createdAt.desc()),
    uniqueIndex('jobs_one_active_per_call')
      .on(t.callId)
      .where(sql`status in ('queued', 'sent')`),
    oneOf('jobs_status_check', 'status', JOB_STATUSES),
    check('jobs_attempt_check', sql`attempt between 1 and 3`),
  ]
);

export type Word = { w: string; start_ms: number; end_ms: number; speaker: string };
export type Turn = { speaker: string; start_word: number; end_word: number };
export type Speaker = { id: string; label: string };

/** One per call; replaced whole when a later job completes. */
export const transcripts = appSchema.table(
  'transcripts',
  {
    callId: uuid('call_id')
      .primaryKey()
      .references(() => calls.id, { onDelete: 'cascade' }),
    words: jsonb('words').$type<Word[]>().notNull(),
    turns: jsonb('turns').$type<Turn[]>().notNull(),
    speakers: jsonb('speakers').$type<Speaker[]>().notNull(),
    /** Redacted text, only for search; trigram index. */
    searchText: text('search_text').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [index('transcripts_search_text_trgm_idx').using('gin', sql`${t.searchText} gin_trgm_ops`)]
);

export const piiRanges = appSchema.table(
  'pii_ranges',
  {
    id: id(),
    callId: uuid('call_id')
      .notNull()
      .references(() => calls.id, { onDelete: 'cascade' }),
    startWord: integer('start_word').notNull(),
    /** Inclusive. */
    endWord: integer('end_word').notNull(),
    type: text('type', { enum: PII_TYPES }).notNull(),
    /** The redaction token as the engine rendered it, e.g. [PERSON_1] or [OSOBA_1]. */
    token: text('token').notNull(),
  },
  (t) => [
    uniqueIndex('pii_ranges_call_start_word').on(t.callId, t.startWord),
    oneOf('pii_ranges_type_check', 'type', PII_TYPES),
    check('pii_ranges_word_order_check', sql`start_word >= 0 and end_word >= start_word`),
  ]
);

/** One per call and kind. */
export const analyses = appSchema.table(
  'analyses',
  {
    id: id(),
    callId: uuid('call_id')
      .notNull()
      .references(() => calls.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ANALYSIS_KINDS }).notNull(),
    templateId: uuid('template_id').references(() => analysisTemplates.id, { onDelete: 'set null' }),
    status: text('status', { enum: ANALYSIS_STATUSES }).notNull(),
    result: jsonb('result'),
    errorCode: text('error_code'),
    model: text('model').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('analyses_call_kind').on(t.callId, t.kind),
    oneOf('analyses_kind_check', 'kind', ANALYSIS_KINDS),
    oneOf('analyses_status_check', 'status', ANALYSIS_STATUSES),
  ]
);

/** One per claim, found or not. */
export const quotes = appSchema.table(
  'quotes',
  {
    id: id(),
    analysisId: uuid('analysis_id')
      .notNull()
      .references(() => analyses.id, { onDelete: 'cascade' }),
    /** "sentiment", "action_items.{n}" or "fields.{field_id}". */
    claimPath: text('claim_path').notNull(),
    /** 1-based, the number shown to the model; word indexes are 0-based. */
    turn: integer('turn').notNull(),
    startWord: integer('start_word'),
    endWord: integer('end_word'),
    match: text('match', { enum: QUOTE_MATCHES }).notNull(),
  },
  (t) => [
    index('quotes_analysis_idx').on(t.analysisId),
    oneOf('quotes_match_check', 'match', QUOTE_MATCHES),
    check(
      'quotes_unverified_has_no_range_check',
      sql`(match = 'unverified') = (start_word is null and end_word is null)`
    ),
  ]
);

/** Flyway V1_022 with transcript_id → call_id, transcript_index → item_index, evidence → quote_id. */
export const actionItems = appSchema.table(
  'action_items',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    callId: uuid('call_id')
      .notNull()
      .references(() => calls.id, { onDelete: 'cascade' }),
    itemIndex: integer('item_index').notNull(),
    description: text('description').notNull(),
    responsibleParty: text('responsible_party').notNull(),
    deadlineMentioned: text('deadline_mentioned'),
    quoteId: uuid('quote_id').references(() => quotes.id, { onDelete: 'set null' }),
    status: text('status', { enum: ACTION_ITEM_STATUSES }).notNull().default('PENDING'),
    priority: text('priority', { enum: ACTION_ITEM_PRIORITIES }).notNull().default('MEDIUM'),
    notes: text('notes'),
    completedAt: tz('completed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('action_items_project_id_idx').on(t.projectId),
    index('action_items_status_idx').on(t.projectId, t.status),
    index('action_items_call_idx').on(t.callId),
    oneOf('action_items_status_check', 'status', ACTION_ITEM_STATUSES),
    oneOf('action_items_priority_check', 'priority', ACTION_ITEM_PRIORITIES),
  ]
);

/** One row when someone loads a call's original text or audio (#44). */
export const piiAccessLog = appSchema.table(
  'pii_access_log',
  {
    id: id(),
    callId: uuid('call_id')
      .notNull()
      .references(() => calls.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    kind: text('kind', { enum: PII_ACCESS_KINDS }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('pii_access_log_call_created_idx').on(t.callId, t.createdAt.desc()),
    oneOf('pii_access_log_kind_check', 'kind', PII_ACCESS_KINDS),
  ]
);
