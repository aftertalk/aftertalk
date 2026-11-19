-- Edited by hand: schemas are created by lib/db/migrate.ts before the journal; pg_trgm for call search.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "auth";
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "app";
--> statement-breakpoint
CREATE TABLE "auth"."account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "auth"."session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth"."two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL,
	"verified" boolean DEFAULT true,
	"failed_verification_count" integer DEFAULT 0,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auth"."user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"two_factor_enabled" boolean DEFAULT false,
	"display_name" text,
	"time_zone" text DEFAULT 'Europe/Warsaw' NOT NULL,
	"password_reset_at" timestamp with time zone,
	"password_reset_by" text,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "auth"."verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."action_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"item_index" integer NOT NULL,
	"description" text NOT NULL,
	"responsible_party" text NOT NULL,
	"deadline_mentioned" text,
	"quote_id" uuid,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"priority" text DEFAULT 'MEDIUM' NOT NULL,
	"notes" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "action_items_status_check" CHECK (status in ('PENDING', 'IN_PROGRESS', 'DONE', 'CANCELLED')),
	CONSTRAINT "action_items_priority_check" CHECK (priority in ('LOW', 'MEDIUM', 'HIGH'))
);
--> statement-breakpoint
CREATE TABLE "app"."analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"template_id" uuid,
	"status" text NOT NULL,
	"result" jsonb,
	"error_code" text,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analyses_kind_check" CHECK (kind in ('summary', 'call_reason', 'scorecard')),
	CONSTRAINT "analyses_status_check" CHECK (status in ('completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "app"."analysis_template_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"label" text NOT NULL,
	"prompt" text NOT NULL,
	"answer_type" text NOT NULL,
	"options" jsonb,
	"is_required" boolean DEFAULT false NOT NULL,
	"display_order" integer NOT NULL,
	CONSTRAINT "analysis_template_fields_answer_type_check" CHECK (answer_type in ('TEXT', 'BOOLEAN', 'CHOICE', 'NUMERIC'))
);
--> statement-breakpoint
CREATE TABLE "app"."analysis_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"uploaded_by" text,
	"original_filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"audio_sha256" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"duration_ms" integer,
	"language" text,
	"forced_language" text,
	"channel_roles" jsonb,
	"manual_category_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calls_status_check" CHECK (status in ('pending', 'completed', 'completed_with_errors')),
	CONSTRAINT "calls_language_check" CHECK (language is null or language in ('pl', 'en', 'uk', 'de')),
	CONSTRAINT "calls_forced_language_check" CHECK (forced_language is null or forced_language in ('pl', 'en', 'uk', 'de'))
);
--> statement-breakpoint
CREATE TABLE "app"."categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"taxonomy_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_unique_name_per_parent" UNIQUE NULLS NOT DISTINCT("taxonomy_id","parent_id","name")
);
--> statement-breakpoint
CREATE TABLE "app"."invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" text,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invitations_role_check" CHECK (role in ('ADMIN', 'MEMBER'))
);
--> statement-breakpoint
CREATE TABLE "app"."jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"request" jsonb,
	"steps" jsonb,
	"sent_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"dispatch_after" timestamp with time zone,
	"current_step" text,
	"error_step" text,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_status_check" CHECK (status in ('queued', 'sent', 'completed', 'completed_with_errors', 'failed', 'superseded')),
	CONSTRAINT "jobs_attempt_check" CHECK (attempt between 1 and 3)
);
--> statement-breakpoint
CREATE TABLE "app"."organization_members" (
	"organization_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"invited_by" text,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_members_organization_id_user_id_pk" PRIMARY KEY("organization_id","user_id"),
	CONSTRAINT "organization_members_role_check" CHECK (role in ('OWNER', 'ADMIN', 'MEMBER'))
);
--> statement-breakpoint
CREATE TABLE "app"."organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"logo_url" text,
	"allow_member_project_create" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"description" text,
	"two_fa_required" boolean DEFAULT false NOT NULL,
	"use_case" text
);
--> statement-breakpoint
CREATE TABLE "app"."pii_access_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"user_id" text,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pii_access_log_kind_check" CHECK (kind in ('text', 'audio'))
);
--> statement-breakpoint
CREATE TABLE "app"."pii_ranges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"start_word" integer NOT NULL,
	"end_word" integer NOT NULL,
	"type" text NOT NULL,
	"token" text NOT NULL,
	CONSTRAINT "pii_ranges_type_check" CHECK (type in ('PERSON', 'PHONE', 'EMAIL', 'IBAN', 'CREDIT_CARD', 'PESEL', 'NIP', 'REGON', 'ID_CARD', 'POSTAL_CODE', 'LOCATION', 'ORGANIZATION', 'DATE_TIME', 'IP_ADDRESS', 'URL')),
	CONSTRAINT "pii_ranges_word_order_check" CHECK (start_word >= 0 and end_word >= start_word)
);
--> statement-breakpoint
CREATE TABLE "app"."project_members" (
	"project_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"added_by" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_members_project_id_user_id_pk" PRIMARY KEY("project_id","user_id"),
	CONSTRAINT "project_members_role_check" CHECK (role in ('VIEWER', 'EDITOR', 'ADMIN'))
);
--> statement-breakpoint
CREATE TABLE "app"."project_provider_choice" (
	"project_id" uuid NOT NULL,
	"slot" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"model" text,
	CONSTRAINT "project_provider_choice_project_id_slot_pk" PRIMARY KEY("project_id","slot"),
	CONSTRAINT "project_provider_choice_slot_check" CHECK (slot in ('speech', 'diarization', 'llm'))
);
--> statement-breakpoint
CREATE TABLE "app"."projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"visibility" text DEFAULT 'ORG' NOT NULL,
	"default_role" text DEFAULT 'VIEWER' NOT NULL,
	"allowed_languages" text[] DEFAULT '{en}'::text[] NOT NULL,
	"member_pii_access" text DEFAULT 'full' NOT NULL,
	"retention_days" integer,
	CONSTRAINT "projects_visibility_check" CHECK (visibility in ('ORG', 'PRIVATE')),
	CONSTRAINT "projects_default_role_check" CHECK (default_role in ('VIEWER', 'EDITOR', 'ADMIN')),
	CONSTRAINT "projects_member_pii_access_check" CHECK (member_pii_access in ('strict', 'full')),
	CONSTRAINT "projects_allowed_languages_check" CHECK (cardinality(allowed_languages) > 0 and allowed_languages <@ array['pl','en','uk','de']::text[]),
	CONSTRAINT "projects_retention_days_check" CHECK (retention_days is null or retention_days > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."provider_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"adapter" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key_encrypted" "bytea",
	"data_location" text NOT NULL,
	"word_times" boolean,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_connections_kind_check" CHECK (kind in ('speech', 'diarization', 'llm')),
	CONSTRAINT "provider_connections_adapter_check" CHECK (adapter in ('openai-compatible', 'pyannote-ai')),
	CONSTRAINT "provider_connections_data_location_check" CHECK (data_location in ('eu', 'us', 'own_network', 'other'))
);
--> statement-breakpoint
CREATE TABLE "app"."quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"analysis_id" uuid NOT NULL,
	"claim_path" text NOT NULL,
	"turn" integer NOT NULL,
	"start_word" integer,
	"end_word" integer,
	"match" text NOT NULL,
	CONSTRAINT "quotes_match_check" CHECK (match in ('verbatim', 'normalised', 'other_turn', 'unverified')),
	CONSTRAINT "quotes_unverified_has_no_range_check" CHECK ((match = 'unverified') = (start_word is null and end_word is null))
);
--> statement-breakpoint
CREATE TABLE "app"."speaker_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"name" text NOT NULL,
	"speakers" jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."taxonomies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"name" text DEFAULT 'Default Taxonomy' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	CONSTRAINT "taxonomies_project_id_key" UNIQUE("project_id")
);
--> statement-breakpoint
CREATE TABLE "app"."transcripts" (
	"call_id" uuid PRIMARY KEY NOT NULL,
	"words" jsonb NOT NULL,
	"turns" jsonb NOT NULL,
	"speakers" jsonb NOT NULL,
	"search_text" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth"."account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."action_items" ADD CONSTRAINT "action_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."action_items" ADD CONSTRAINT "action_items_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "app"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."action_items" ADD CONSTRAINT "action_items_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "app"."quotes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."analyses" ADD CONSTRAINT "analyses_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "app"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."analyses" ADD CONSTRAINT "analyses_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "app"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."analyses" ADD CONSTRAINT "analyses_template_id_analysis_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "app"."analysis_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."analysis_template_fields" ADD CONSTRAINT "analysis_template_fields_template_id_analysis_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "app"."analysis_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."analysis_templates" ADD CONSTRAINT "analysis_templates_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."analysis_templates" ADD CONSTRAINT "analysis_templates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."calls" ADD CONSTRAINT "calls_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."calls" ADD CONSTRAINT "calls_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."calls" ADD CONSTRAINT "calls_manual_category_id_categories_id_fk" FOREIGN KEY ("manual_category_id") REFERENCES "app"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."categories" ADD CONSTRAINT "categories_taxonomy_id_taxonomies_id_fk" FOREIGN KEY ("taxonomy_id") REFERENCES "app"."taxonomies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "app"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."invitations" ADD CONSTRAINT "invitations_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."jobs" ADD CONSTRAINT "jobs_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "app"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."organization_members" ADD CONSTRAINT "organization_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."organization_members" ADD CONSTRAINT "organization_members_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."organizations" ADD CONSTRAINT "organizations_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."pii_access_log" ADD CONSTRAINT "pii_access_log_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "app"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."pii_access_log" ADD CONSTRAINT "pii_access_log_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."pii_ranges" ADD CONSTRAINT "pii_ranges_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "app"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."project_members" ADD CONSTRAINT "project_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."project_members" ADD CONSTRAINT "project_members_added_by_user_id_fk" FOREIGN KEY ("added_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."project_provider_choice" ADD CONSTRAINT "project_provider_choice_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."project_provider_choice" ADD CONSTRAINT "project_provider_choice_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "app"."provider_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."projects" ADD CONSTRAINT "projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."provider_connections" ADD CONSTRAINT "provider_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."provider_connections" ADD CONSTRAINT "provider_connections_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."quotes" ADD CONSTRAINT "quotes_analysis_id_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "app"."analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."speaker_presets" ADD CONSTRAINT "speaker_presets_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."speaker_presets" ADD CONSTRAINT "speaker_presets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."taxonomies" ADD CONSTRAINT "taxonomies_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."taxonomies" ADD CONSTRAINT "taxonomies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."transcripts" ADD CONSTRAINT "transcripts_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "app"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "auth"."account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "auth"."session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "two_factor_secret_idx" ON "auth"."two_factor" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "two_factor_user_id_idx" ON "auth"."two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "auth"."verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "action_items_project_id_idx" ON "app"."action_items" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "action_items_status_idx" ON "app"."action_items" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "action_items_call_idx" ON "app"."action_items" USING btree ("call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "analyses_call_kind" ON "app"."analyses" USING btree ("call_id","kind");--> statement-breakpoint
CREATE INDEX "analysis_template_fields_template_order_idx" ON "app"."analysis_template_fields" USING btree ("template_id","display_order");--> statement-breakpoint
CREATE INDEX "analysis_templates_user_id_idx" ON "app"."analysis_templates" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_templates_unique_name_per_project" ON "app"."analysis_templates" USING btree ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_templates_active_per_project" ON "app"."analysis_templates" USING btree ("project_id") WHERE is_active;--> statement-breakpoint
CREATE INDEX "calls_project_created_idx" ON "app"."calls" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "calls_audio_sha256_idx" ON "app"."calls" USING btree ("audio_sha256");--> statement-breakpoint
CREATE INDEX "categories_taxonomy_parent_idx" ON "app"."categories" USING btree ("taxonomy_id","parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_open_per_email" ON "app"."invitations" USING btree ("organization_id","email") WHERE accepted_at is null and revoked_at is null;--> statement-breakpoint
CREATE INDEX "jobs_call_created_idx" ON "app"."jobs" USING btree ("call_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_one_active_per_call" ON "app"."jobs" USING btree ("call_id") WHERE status in ('queued', 'sent');--> statement-breakpoint
CREATE INDEX "org_members_user_idx" ON "app"."organization_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "organizations_created_by_idx" ON "app"."organizations" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "pii_access_log_call_created_idx" ON "app"."pii_access_log" USING btree ("call_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "pii_ranges_call_start_word" ON "app"."pii_ranges" USING btree ("call_id","start_word");--> statement-breakpoint
CREATE INDEX "project_members_user_idx" ON "app"."project_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "projects_org_idx" ON "app"."projects" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_connections_name_per_org" ON "app"."provider_connections" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "quotes_analysis_idx" ON "app"."quotes" USING btree ("analysis_id");--> statement-breakpoint
CREATE INDEX "speaker_presets_user_id_idx" ON "app"."speaker_presets" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "speaker_presets_unique_name_per_project" ON "app"."speaker_presets" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "transcripts_search_text_trgm_idx" ON "app"."transcripts" USING gin ("search_text" gin_trgm_ops);