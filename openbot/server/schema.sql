-- Fresh PDSDuet PostgreSQL schema. No legacy data conversion or CopilotKit services.

CREATE TYPE "public"."agent_type" AS ENUM ('built_in', 'remote_ag_ui', 'remote_mastra');

CREATE TYPE "public"."credential_kind" AS ENUM ('model', 'connector', 'agent', 'mcp', 'mcp_oauth_client', 'mcp_user_token');

CREATE TYPE "public"."role" AS ENUM ('admin', 'user');

CREATE TYPE "public"."agent_visibility" AS ENUM ('public', 'private');

CREATE TYPE "public"."routine_run_status" AS ENUM ('succeeded', 'failed', 'skipped', 'waiting');

CREATE TYPE "public"."responsibility_run_status" AS ENUM ('queued', 'running', 'waiting', 'succeeded', 'failed', 'skipped');

CREATE TYPE "public"."responsibility_status" AS ENUM ('active', 'paused', 'completed');

CREATE TABLE "accounts" (
  "id" text PRIMARY KEY NOT NULL,
  "account_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "issuer" text,
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

CREATE TABLE "agents" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "type" "public"."agent_type" NOT NULL,
  "configuration" jsonb NOT NULL,
  "package_id" uuid,
  "override" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "channel_id" text NOT NULL,
  "uploaded_by" text NOT NULL,
  "name" text NOT NULL,
  "mime_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "bytes" bytea NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "attached_at" timestamp with time zone,
  "upload_group" text
);

CREATE TABLE "audit_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "actor_user_id" text,
  "initiator_kind" text DEFAULT 'person' NOT NULL,
  "initiator_id" text,
  "event_type" text NOT NULL,
  "target_type" text NOT NULL,
  "target_id" text,
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "channel_agents" (
  "channel_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "channel_agents_channel_id_agent_id_pk" PRIMARY KEY ("channel_id", "agent_id")
);

CREATE TABLE "channel_memberships" (
  "channel_id" text NOT NULL,
  "user_id" text NOT NULL,
  "pinned_at" timestamp with time zone,
  "last_read_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "channel_memberships_channel_id_user_id_pk" PRIMARY KEY ("channel_id", "user_id")
);

CREATE TABLE "channels" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "suggested_prompts" text[] DEFAULT '{}' NOT NULL,
  "allowed_groups" text[] DEFAULT '{}' NOT NULL,
  "package_id" uuid,
  "override" jsonb,
  "summary" text,
  "summary_at" timestamp with time zone,
  "last_message" text,
  "last_message_source_id" text,
  "last_message_needs_input" boolean,
  "busy_claims" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "last_message_at" timestamp with time zone,
  "last_message_agent_id" text,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" "public"."credential_kind" NOT NULL,
  "provider" text NOT NULL,
  "encrypted_value" text NOT NULL,
  "key_id" text NOT NULL,
  "metadata" jsonb NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "deployment_packages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" text NOT NULL,
  "source_path" text NOT NULL,
  "checksum" text NOT NULL,
  "loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "deployment_packages_tenant_id_unique" UNIQUE ("tenant_id")
);

CREATE TABLE "thread_channel_mappings" (
  "user_id" text NOT NULL,
  "channel_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "thread_channel_mappings_user_id_channel_id_pk" PRIMARY KEY ("user_id", "channel_id")
);

CREATE TABLE "revoked_access" (
  "email" text PRIMARY KEY NOT NULL,
  "revoked_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_by" text NOT NULL
);

CREATE TABLE "sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "token" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sessions_token_unique" UNIQUE ("token")
);

CREATE TABLE "sso_providers" (
  "id" text PRIMARY KEY NOT NULL,
  "issuer" text NOT NULL,
  "oidc_config" text,
  "saml_config" text,
  "user_id" text,
  "provider_id" text NOT NULL,
  "organization_id" text,
  "domain" text NOT NULL,
  CONSTRAINT "sso_providers_provider_id_unique" UNIQUE ("provider_id")
);

CREATE TABLE "user_instructions" (
  "user_id" text PRIMARY KEY NOT NULL,
  "instructions" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "user_roles" (
  "user_id" text NOT NULL,
  "role" "public"."role" NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_roles_user_id_role_pk" PRIMARY KEY ("user_id", "role")
);

CREATE TABLE "users" (
  "id" text PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "name" text,
  "image" text,
  "email_verified" boolean DEFAULT false NOT NULL,
  "preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "groups" text[] DEFAULT '{}' NOT NULL,
  "onboarding_step" integer DEFAULT 0 NOT NULL,
  "onboarding_completed_at" timestamp with time zone,
  "last_signed_in_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "users_email_unique" UNIQUE ("email")
);

CREATE TABLE "verifications" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "action_policy" (
  "id" text PRIMARY KEY NOT NULL,
  "mode" text NOT NULL,
  "deny" text[] NOT NULL,
  "allow" text[] NOT NULL,
  "updated_by" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "computer_page_frame" (
  "computer_id" text NOT NULL,
  "tool_call_id" text NOT NULL,
  "url" text NOT NULL,
  "title" text,
  "frame" text NOT NULL,
  "captured_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "computer_page_frame_computer_id_tool_call_id_pk" PRIMARY KEY ("computer_id", "tool_call_id")
);

CREATE TABLE "computer_snapshot" (
  "computer_id" text PRIMARY KEY NOT NULL,
  "snapshot_id" integer NOT NULL,
  "url" text NOT NULL,
  "elements" jsonb NOT NULL,
  "taken_at" timestamp with time zone DEFAULT now() NOT NULL,
  "session" text
);

CREATE TABLE "agent_preferences" (
  "user_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "hidden_at" timestamp with time zone,
  "pinned_at" timestamp with time zone,
  CONSTRAINT "agent_preferences_user_id_agent_id_pk" PRIMARY KEY ("user_id", "agent_id")
);

CREATE TABLE "agent_profiles" (
  "agent_id" text PRIMARY KEY NOT NULL,
  "owner_user_id" text,
  "title" text NOT NULL,
  "role_description" text NOT NULL,
  "avatar_seed" text NOT NULL,
  "visibility" "public"."agent_visibility" NOT NULL,
  "callback_token_hash" text,
  "callback_token_issued_at" timestamp with time zone,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "routine_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "routine_id" text NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "status" "public"."routine_run_status",
  "waiting" jsonb,
  "error" text,
  "source" text DEFAULT 'schedule' NOT NULL
);

CREATE TABLE "routine_sweeps" (
  "id" text PRIMARY KEY NOT NULL,
  "swept_at" timestamp with time zone DEFAULT now() NOT NULL,
  "owner" text
);

CREATE TABLE "routines" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_user_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "channel_id" text NOT NULL,
  "instruction" text NOT NULL,
  "cron" text NOT NULL,
  "timezone" text DEFAULT 'UTC' NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "next_run_at" timestamp with time zone NOT NULL,
  "last_run_at" timestamp with time zone,
  "enabled_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "component_exclusions" (
  "component_name" text NOT NULL,
  "agent_id" text NOT NULL,
  "withheld_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "component_exclusions_component_name_agent_id_pk" PRIMARY KEY ("component_name", "agent_id")
);

CREATE TABLE "component_functions" (
  "component_name" text NOT NULL,
  "function_name" text NOT NULL,
  "granted_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "component_functions_component_name_function_name_pk" PRIMARY KEY ("component_name", "function_name")
);

CREATE TABLE "components" (
  "name" text PRIMARY KEY NOT NULL,
  "title" text NOT NULL,
  "kind" text NOT NULL,
  "draft_description" text NOT NULL,
  "published_description" text,
  "published" boolean DEFAULT false NOT NULL,
  "published_at" timestamp with time zone,
  "updated_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "app_access_requests" (
  "id" text PRIMARY KEY NOT NULL,
  "requested_by" text NOT NULL,
  "agent_id" text,
  "app_key" text NOT NULL,
  "app_title" text NOT NULL,
  "kind" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone,
  "resolved_by" text,
  CONSTRAINT "app_access_requests_kind_check" CHECK ("app_access_requests"."kind" IN ('enable', 'grant', 'connect_shared')),
  CONSTRAINT "app_access_requests_status_check" CHECK ("app_access_requests"."status" IN ('pending', 'approved', 'dismissed', 'cancelled'))
);

CREATE TABLE "brokered_connections" (
  "provider" text NOT NULL,
  "app" text NOT NULL,
  "holder" text NOT NULL,
  "user_id" text,
  "vendor_user_id" text NOT NULL,
  "connected_by" text,
  "connected_at" timestamp with time zone DEFAULT now() NOT NULL,
  "verified" boolean DEFAULT false NOT NULL,
  "verified_at" timestamp with time zone,
  "probe_action" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "brokered_connections_holder_check" CHECK (("brokered_connections"."holder" = 'person' AND "brokered_connections"."user_id" IS NOT NULL) OR ("brokered_connections"."holder" = 'deployment' AND "brokered_connections"."user_id" IS NULL)),
  CONSTRAINT "brokered_connections_provider_check" CHECK ("brokered_connections"."provider" IN ('composio', 'arcade'))
);

CREATE TABLE "composio_connections" (
  "toolkit" text NOT NULL,
  "user_id" text NOT NULL,
  "connected_at" timestamp with time zone DEFAULT now() NOT NULL,
  "verified" boolean DEFAULT false NOT NULL,
  "verified_at" timestamp with time zone,
  "probe_action" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "composio_connections_toolkit_user_id_pk" PRIMARY KEY ("toolkit", "user_id")
);

CREATE TABLE "mcp_servers" (
  "id" text PRIMARY KEY NOT NULL,
  "title" text NOT NULL,
  "logo" text,
  "vendor" text NOT NULL,
  "url" text NOT NULL,
  "provenance" text DEFAULT 'first-party' NOT NULL,
  "credential_id" uuid,
  "auth_scheme" text,
  "account_mode" text,
  "shared_vendor_user_id" text,
  "tools_refreshed_at" timestamp with time zone,
  "last_error" text,
  "skipped_tools" text[],
  "added_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mcp_servers_account_mode_check" CHECK ("mcp_servers"."account_mode" IS NULL OR "mcp_servers"."account_mode" IN ('personal', 'shared'))
);

CREATE TABLE "mcp_tools" (
  "server_id" text NOT NULL,
  "name" text NOT NULL,
  "vendor_name" text,
  "description" text DEFAULT '' NOT NULL,
  "input_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "effect" text,
  "destructive" boolean DEFAULT false NOT NULL,
  "version" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mcp_tools_server_id_name_pk" PRIMARY KEY ("server_id", "name")
);

CREATE TABLE "mcp_user_credentials" (
  "server_id" text NOT NULL,
  "user_id" text NOT NULL,
  "credential_id" uuid NOT NULL,
  "scope" text NOT NULL,
  "connected_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mcp_user_credentials_server_id_user_id_pk" PRIMARY KEY ("server_id", "user_id")
);

CREATE TABLE "pending_authorizations" (
  "actor_id" text PRIMARY KEY NOT NULL,
  "server_id" text NOT NULL,
  "action" text NOT NULL,
  "holder" text NOT NULL,
  "user_id" text,
  "vendor_user_id" text NOT NULL,
  "auth_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  "outcome" text,
  CONSTRAINT "pending_authorizations_holder_check" CHECK (("pending_authorizations"."holder" = 'person' AND "pending_authorizations"."user_id" IS NOT NULL) OR ("pending_authorizations"."holder" = 'deployment' AND "pending_authorizations"."user_id" IS NULL)),
  CONSTRAINT "pending_authorizations_outcome_check" CHECK ("pending_authorizations"."outcome" IS NULL OR "pending_authorizations"."outcome" IN ('completed', 'failed', 'unreconciled', 'withdrawn')),
  CONSTRAINT "pending_authorizations_completion_check" CHECK (("pending_authorizations"."completed_at" IS NULL) = ("pending_authorizations"."outcome" IS NULL)),
  CONSTRAINT "pending_authorizations_user_is_actor_check" CHECK ("pending_authorizations"."user_id" IS NULL OR "pending_authorizations"."user_id" = "pending_authorizations"."actor_id")
);

CREATE TABLE "plugin_grants" (
  "kind" text NOT NULL,
  "ref" text NOT NULL,
  "agent_id" text NOT NULL,
  "granted_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "plugin_grants_kind_ref_agent_id_pk" PRIMARY KEY ("kind", "ref", "agent_id")
);

CREATE TABLE "sandboxed_components" (
  "name" text PRIMARY KEY NOT NULL,
  "title" text NOT NULL,
  "draft_description" text DEFAULT '' NOT NULL,
  "draft_html" text DEFAULT '' NOT NULL,
  "draft_css" text DEFAULT '' NOT NULL,
  "draft_js_functions" text DEFAULT '' NOT NULL,
  "draft_argument_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "published_description" text,
  "published_html" text,
  "published_css" text,
  "published_js_functions" text,
  "published_argument_schema" jsonb,
  "sample_arguments" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "revision" integer DEFAULT 0 NOT NULL,
  "published" boolean DEFAULT false NOT NULL,
  "published_at" timestamp with time zone,
  "authored_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "skill_tools" (
  "skill_id" text NOT NULL,
  "ref" text NOT NULL,
  "declared_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_tools_skill_id_ref_pk" PRIMARY KEY ("skill_id", "ref")
);

CREATE TABLE "skills" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_user_id" text,
  "slug" text NOT NULL,
  "title" text NOT NULL,
  "summary" text NOT NULL,
  "instructions" text NOT NULL,
  "origin" text DEFAULT 'yours' NOT NULL,
  "installed_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "work_items" (
  "kind" text NOT NULL,
  "key" text NOT NULL,
  "run_at" timestamp with time zone DEFAULT now() NOT NULL,
  "claimed_by" text,
  "lease_until" timestamp with time zone,
  "attempts" integer DEFAULT 0 NOT NULL,
  "finished_at" timestamp with time zone,
  "last_error" text,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "work_items_kind_key_pk" PRIMARY KEY ("kind", "key")
);

CREATE TABLE "voice_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "channel_id" text NOT NULL,
  "user_id" text NOT NULL,
  "anchor_message_id" text,
  "started_at" timestamp with time zone NOT NULL,
  "ended_at" timestamp with time zone NOT NULL,
  "duration_seconds" integer NOT NULL,
  "transcript" jsonb NOT NULL,
  "summary" text,
  "summary_status" text DEFAULT 'failed' NOT NULL,
  CONSTRAINT "voice_sessions_duration_check" CHECK ("voice_sessions"."duration_seconds" >= 0),
  CONSTRAINT "voice_sessions_summary_check" CHECK (("voice_sessions"."summary_status" = 'ready' AND "voice_sessions"."summary" IS NOT NULL) OR ("voice_sessions"."summary_status" = 'failed' AND "voice_sessions"."summary" IS NULL))
);

CREATE TABLE "responsibilities" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_user_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "channel_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "title" text NOT NULL,
  "instruction" text NOT NULL,
  "success_criteria" text NOT NULL,
  "status" "public"."responsibility_status" DEFAULT 'active' NOT NULL,
  "progress" text DEFAULT '' NOT NULL,
  "last_result" text,
  "subscriptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "responsibility_events" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_user_id" text NOT NULL,
  "source" text NOT NULL,
  "external_id" text NOT NULL,
  "type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "responsibility_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "responsibility_id" text NOT NULL,
  "event_id" text NOT NULL,
  "status" "public"."responsibility_run_status" DEFAULT 'queued' NOT NULL,
  "reply_text" text,
  "error" text,
  "waiting" jsonb,
  "continuation" jsonb,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "responsibility_source_bindings" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_user_id" text NOT NULL,
  "source" text NOT NULL,
  "repository" text NOT NULL,
  "credential_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "responsibility_triggers" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_user_id" text NOT NULL,
  "responsibility_id" text NOT NULL,
  "kind" text NOT NULL,
  "config" jsonb NOT NULL,
  "credential_id" uuid,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "approval_preferences" (
  "owner_user_id" text PRIMARY KEY NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "auto_review" boolean DEFAULT false NOT NULL,
  "host_commands" text DEFAULT 'ask' NOT NULL,
  CONSTRAINT "approval_preferences_host_commands_check" CHECK ("approval_preferences"."host_commands" IN ('ask', 'allow', 'never'))
);

CREATE TABLE "approval_requests" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_user_id" text NOT NULL,
  "run_id" text NOT NULL,
  "tool_call_id" text NOT NULL,
  "action_digest" text NOT NULL,
  "action" jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "decision" text,
  "result" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "decided_at" timestamp with time zone,
  "consumed_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  CONSTRAINT "approval_status_check" CHECK ("approval_requests"."status" IN ('pending', 'approved', 'denied', 'consumed', 'completed')),
  CONSTRAINT "approval_decision_check" CHECK ("approval_requests"."decision" IN ('allow_once', 'allow_always', 'deny', 'handled'))
);

CREATE TABLE "approval_rules" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_user_id" text NOT NULL,
  "bot_id" text NOT NULL,
  "tool_ref" text NOT NULL,
  "effect" text NOT NULL,
  "scope" text NOT NULL,
  "behaviour" text DEFAULT 'allow' NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "approval_rules_behaviour_check" CHECK ("approval_rules"."behaviour" IN ('allow', 'pre_approved', 'ask', 'hand_off'))
);

CREATE TABLE "approval_team_rules" (
  "id" text PRIMARY KEY NOT NULL,
  "bot_id" text NOT NULL,
  "tool_ref" text NOT NULL,
  "effect" text NOT NULL,
  "scope" text NOT NULL,
  "behaviour" text NOT NULL,
  "created_by" text,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "approval_team_rules_behaviour_check" CHECK ("approval_team_rules"."behaviour" IN ('allow', 'pre_approved', 'ask', 'hand_off'))
);

CREATE TABLE "approval_team_settings" (
  "id" text PRIMARY KEY NOT NULL,
  "enforce_auto_review" boolean DEFAULT false NOT NULL,
  "custom_rules_enabled" boolean DEFAULT true NOT NULL,
  "host_commands_cap" text DEFAULT 'allow' NOT NULL,
  "updated_by" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "approval_team_settings_host_commands_cap_check" CHECK ("approval_team_settings"."host_commands_cap" IN ('ask', 'allow', 'never'))
);

CREATE TABLE "memory_sources" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_user_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "tool_ref" text NOT NULL,
  "title" text NOT NULL,
  "args" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "sync_status" text DEFAULT 'idle' NOT NULL,
  "sync_error" text,
  "last_sync_at" timestamp with time zone,
  "next_sync_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "personal_memories" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_user_id" text NOT NULL,
  "source_id" text,
  "external_id" text,
  "import_digest" text,
  "content" text NOT NULL,
  "provenance" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "review_state" text DEFAULT 'unreviewed' NOT NULL,
  "deleted_at" timestamp with time zone,
  "formed_by" text DEFAULT 'person' NOT NULL,
  "formed_by_agent_id" text,
  "source_app" text,
  "source_ref" text,
  "source_link" text,
  "observed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "default_opt_outs" (
  "owner_user_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "feature" text NOT NULL,
  "scope" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "default_opt_outs_owner_user_id_agent_id_feature_scope_pk" PRIMARY KEY ("owner_user_id", "agent_id", "feature", "scope"),
  CONSTRAINT "default_opt_outs_feature_check" CHECK ("default_opt_outs"."feature" IN ('memory_source', 'proactive_research'))
);

CREATE TABLE "proactive_settings" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_user_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "channel_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "focus" text DEFAULT '' NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "interval_minutes" integer DEFAULT 240 NOT NULL,
  "next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_run_at" timestamp with time zone,
  "last_status" text DEFAULT 'idle' NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "proactive_settings_interval_check" CHECK ("proactive_settings"."interval_minutes" >= 15 AND "proactive_settings"."interval_minutes" <= 1440),
  CONSTRAINT "proactive_settings_status_check" CHECK ("proactive_settings"."last_status" IN ('idle', 'running', 'succeeded', 'error'))
);

CREATE TABLE "proactive_suggestions" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_user_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "setting_id" text NOT NULL,
  "run_id" text NOT NULL,
  "title" text NOT NULL,
  "detail" text NOT NULL,
  "source_app" text,
  "source_ref" text,
  "source_link" text,
  "from_channel_id" text,
  "status" text DEFAULT 'open' NOT NULL,
  "delivered_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "proactive_suggestions_status_check" CHECK ("proactive_suggestions"."status" IN ('open', 'dismissed', 'started'))
);

CREATE TABLE "demonstrations" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_user_id" text NOT NULL,
  "bot_id" text NOT NULL,
  "title" text NOT NULL,
  "status" text DEFAULT 'recording' NOT NULL,
  "actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "draft" jsonb,
  "skill_slug" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone
);

CREATE TABLE "delivery_bindings" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_user_id" text NOT NULL,
  "channel_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "transport" text NOT NULL,
  "identity" text NOT NULL,
  "realm" text NOT NULL,
  "address" text NOT NULL,
  "mention_id" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "opted_out_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "delivery_challenges" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_user_id" text NOT NULL,
  "channel_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "transport" text NOT NULL,
  "address" text,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "delivery_inbox" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_user_id" text NOT NULL,
  "channel_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "binding_id" text,
  "source" text NOT NULL,
  "realm" text NOT NULL,
  "external_id" text NOT NULL,
  "text" text NOT NULL,
  "state" text DEFAULT 'queued' NOT NULL,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "delivery_outbox" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_user_id" text NOT NULL,
  "channel_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "dedupe_key" text NOT NULL,
  "binding_id" text,
  "device_id" text,
  "transport" text NOT NULL,
  "text" text NOT NULL,
  "kind" text NOT NULL,
  "request_id" text,
  "state" text DEFAULT 'queued' NOT NULL,
  "provider_id" text,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "delivery_outbox_dedupe_key_unique" UNIQUE ("dedupe_key")
);

CREATE TABLE "push_devices" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_user_id" text NOT NULL,
  "token" text NOT NULL,
  "project_id" text NOT NULL,
  "platform" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "push_devices_token_unique" UNIQUE ("token")
);

CREATE TABLE "group_bot_threads" (
  "owner_user_id" text NOT NULL,
  "channel_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "group_bot_threads_owner_user_id_channel_id_agent_id_pk" PRIMARY KEY ("owner_user_id", "channel_id", "agent_id")
);

CREATE TABLE "group_messages" (
  "id" text PRIMARY KEY NOT NULL,
  "channel_id" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "agent_id" text,
  "thread_id" text,
  "text" text NOT NULL,
  "status" text DEFAULT 'completed' NOT NULL,
  "details" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "group_messages_status_check" CHECK ("group_messages"."status" IN ('queued', 'running', 'waiting', 'completed', 'failed'))
);

CREATE TABLE "action_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "surface" text NOT NULL,
  "bot_id" text,
  "actor_user_id" text,
  "tool_name" text NOT NULL,
  "command" text NOT NULL,
  "outcome" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "action_records_surface_check" CHECK ("action_records"."surface" IN ('cloud', 'local'))
);

CREATE TABLE "capability_settings" (
  "scope_kind" text NOT NULL,
  "scope_id" text DEFAULT '' NOT NULL,
  "capability" text NOT NULL,
  "allowed" boolean NOT NULL,
  "updated_by" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "capability_settings_scope_kind_scope_id_capability_pk" PRIMARY KEY ("scope_kind", "scope_id", "capability"),
  CONSTRAINT "capability_settings_scope_kind_check" CHECK ("capability_settings"."scope_kind" IN ('organization', 'role', 'group'))
);

CREATE TABLE "enterprise_settings" (
  "key" text PRIMARY KEY NOT NULL,
  "value" jsonb NOT NULL,
  "updated_by" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "model_usage" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text,
  "agent_id" text NOT NULL,
  "thread_id" text,
  "run_id" text,
  "model" text NOT NULL,
  "source" text NOT NULL,
  "allowed" boolean NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "model_usage_source_check" CHECK ("model_usage"."source" IN ('configured', 'observed', 'unknown'))
);

CREATE TABLE "network_policies" (
  "scope_kind" text NOT NULL,
  "scope_id" text DEFAULT '' NOT NULL,
  "mode" text NOT NULL,
  "rules" jsonb DEFAULT '{"entries":[]}'::jsonb NOT NULL,
  "locked" boolean DEFAULT false NOT NULL,
  "updated_by" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "network_policies_scope_kind_scope_id_pk" PRIMARY KEY ("scope_kind", "scope_id"),
  CONSTRAINT "network_policies_scope_kind_check" CHECK ("network_policies"."scope_kind" IN ('organization', 'group')),
  CONSTRAINT "network_policies_mode_check" CHECK ("network_policies"."mode" IN ('allow_all', 'defaults_plus_allowlist', 'allowlist_only'))
);

CREATE TABLE "scim_connection_bindings" (
  "id" text PRIMARY KEY NOT NULL,
  "connection_id" text NOT NULL,
  "connection_key" text NOT NULL,
  "provisioning_domain_id" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "decommissioned_at" timestamp with time zone,
  "decommission_status" text DEFAULT 'active' NOT NULL,
  "decommission_cursor_user_id" text,
  "decommission_reconciled_user_count" integer DEFAULT 0 NOT NULL,
  "decommission_batch_count" integer DEFAULT 0 NOT NULL,
  "decommission_revision" integer DEFAULT 0 NOT NULL,
  "decommission_completed_at" timestamp with time zone,
  "decommission_lease_id" text,
  "decommission_lease_expires_at" timestamp with time zone,
  CONSTRAINT "scim_connection_bindings_connection_key_unique" UNIQUE ("connection_key")
);

CREATE TABLE "scim_group_members" (
  "id" text PRIMARY KEY NOT NULL,
  "connection_id" text NOT NULL,
  "group_id" text NOT NULL,
  "scim_user_id" text NOT NULL,
  "membership_key" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "scim_group_members_membership_key_unique" UNIQUE ("membership_key")
);

CREATE TABLE "scim_groups" (
  "id" text PRIMARY KEY NOT NULL,
  "connection_id" text NOT NULL,
  "provisioning_domain_id" text NOT NULL,
  "revision" integer DEFAULT 0 NOT NULL,
  "display_name" text NOT NULL,
  "display_name_key" text NOT NULL,
  "external_id" text,
  "external_id_key" text,
  "order_key" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "scim_groups_display_name_key_unique" UNIQUE ("display_name_key"),
  CONSTRAINT "scim_groups_external_id_key_unique" UNIQUE ("external_id_key"),
  CONSTRAINT "scim_groups_order_key_unique" UNIQUE ("order_key")
);

CREATE TABLE "scim_identity_tombstones" (
  "id" text PRIMARY KEY NOT NULL,
  "connection_id" text NOT NULL,
  "provisioning_domain_id" text NOT NULL,
  "external_id" text NOT NULL,
  "external_id_key" text NOT NULL,
  "user_id" text NOT NULL,
  "profile" text NOT NULL,
  "deleted_at" timestamp with time zone NOT NULL,
  CONSTRAINT "scim_identity_tombstones_external_id_key_unique" UNIQUE ("external_id_key")
);

CREATE TABLE "scim_projection_grants" (
  "id" text PRIMARY KEY NOT NULL,
  "connection_id" text NOT NULL,
  "provisioning_domain_id" text NOT NULL,
  "scim_user_id" text NOT NULL,
  "user_id" text NOT NULL,
  "source_kind" text NOT NULL,
  "source_id" text NOT NULL,
  "source_value" text,
  "role" text NOT NULL,
  "grant_key" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "scim_projection_grants_grant_key_unique" UNIQUE ("grant_key")
);

CREATE TABLE "scim_subjects" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "profile_source_id" text,
  "revision" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "scim_subjects_user_id_unique" UNIQUE ("user_id")
);

CREATE TABLE "scim_users" (
  "id" text PRIMARY KEY NOT NULL,
  "connection_id" text NOT NULL,
  "provisioning_domain_id" text NOT NULL,
  "user_id" text NOT NULL,
  "connection_user_key" text NOT NULL,
  "user_name" text NOT NULL,
  "user_name_key" text NOT NULL,
  "primary_email" text NOT NULL,
  "work_email_value_index" text NOT NULL,
  "email_value_index" text NOT NULL,
  "display_name" text NOT NULL,
  "formatted_name" text NOT NULL,
  "given_name" text,
  "family_name" text,
  "serialized_emails" text NOT NULL,
  "serialized_attributes" text,
  "external_id" text,
  "external_id_key" text,
  "active" boolean NOT NULL,
  "order_key" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "scim_users_connection_user_key_unique" UNIQUE ("connection_user_key"),
  CONSTRAINT "scim_users_user_name_key_unique" UNIQUE ("user_name_key"),
  CONSTRAINT "scim_users_external_id_key_unique" UNIQUE ("external_id_key"),
  CONSTRAINT "scim_users_order_key_unique" UNIQUE ("order_key")
);

CREATE TABLE "bot_lifecycle" (
  "owner_user_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "paused_at" timestamp with time zone,
  "notify" text DEFAULT 'all' NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bot_lifecycle_owner_user_id_agent_id_pk" PRIMARY KEY ("owner_user_id", "agent_id")
);

CREATE TABLE "update_routing_preferences" (
  "owner_user_id" text NOT NULL,
  "kind" text NOT NULL,
  "transports" text[] DEFAULT '{}' NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "update_routing_preferences_owner_user_id_kind_pk" PRIMARY KEY ("owner_user_id", "kind")
);

CREATE TABLE "saved_logins" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_user_id" text NOT NULL,
  "origin" text NOT NULL,
  "username" text NOT NULL,
  "encrypted_password" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone
);

CREATE TABLE "sign_in_requests" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_user_id" text NOT NULL,
  "bot_id" text NOT NULL,
  "origin" text NOT NULL,
  "reason" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "method" text,
  "outcome" text,
  "thread_id" text,
  "tool_call_id" text,
  "control_request_id" text,
  "continuation" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "resolved_at" timestamp with time zone,
  "filling_until" timestamp with time zone,
  CONSTRAINT "sign_in_requests_status_check" CHECK ("sign_in_requests"."status" IN ('pending', 'filling', 'code_required', 'taken_over', 'signed_in', 'failed', 'cancelled', 'expired')),
  CONSTRAINT "sign_in_requests_method_check" CHECK ("sign_in_requests"."method" IS NULL OR "sign_in_requests"."method" IN ('typed', 'saved', 'takeover'))
);

CREATE TABLE "team_bot_assignments" (
  "agent_id" text NOT NULL,
  "group_name" text NOT NULL,
  "assigned_by" text NOT NULL,
  "assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "team_bot_assignments_agent_id_group_name_pk" PRIMARY KEY ("agent_id", "group_name")
);

CREATE TABLE "team_bot_audience" (
  "agent_id" text NOT NULL,
  "kind" text NOT NULL,
  "value" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "team_bot_audience_agent_id_kind_value_pk" PRIMARY KEY ("agent_id", "kind", "value"),
  CONSTRAINT "team_bot_audience_kind_check" CHECK ("team_bot_audience"."kind" IN ('user', 'group'))
);

CREATE TABLE "team_bot_consent_defaults" (
  "user_id" text NOT NULL,
  "server_id" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "team_bot_consent_defaults_user_id_server_id_pk" PRIMARY KEY ("user_id", "server_id")
);

CREATE TABLE "team_bot_consents" (
  "user_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "server_id" text NOT NULL,
  "decision" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "team_bot_consents_user_id_agent_id_server_id_pk" PRIMARY KEY ("user_id", "agent_id", "server_id"),
  CONSTRAINT "team_bot_consents_decision_check" CHECK ("team_bot_consents"."decision" IN ('always', 'once'))
);

CREATE TABLE "team_bot_publications" (
  "agent_id" text PRIMARY KEY NOT NULL,
  "published_by" text NOT NULL,
  "audience" text NOT NULL,
  "published_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "team_bot_publications_audience_check" CHECK ("team_bot_publications"."audience" IN ('team', 'people'))
);

CREATE TABLE "shared_use_approval_members" (
  "agent_id" text NOT NULL,
  "server_id" text NOT NULL,
  "kind" text NOT NULL,
  "value" text NOT NULL,
  CONSTRAINT "shared_use_approval_members_agent_id_server_id_kind_value_pk" PRIMARY KEY ("agent_id", "server_id", "kind", "value"),
  CONSTRAINT "shared_use_approval_members_kind_check" CHECK ("shared_use_approval_members"."kind" IN ('user', 'group'))
);

CREATE TABLE "shared_use_approvals" (
  "agent_id" text NOT NULL,
  "server_id" text NOT NULL,
  "audience" text NOT NULL,
  "outside_input" boolean NOT NULL,
  "approved_by" text NOT NULL,
  "approved_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "shared_use_approvals_agent_id_server_id_pk" PRIMARY KEY ("agent_id", "server_id"),
  CONSTRAINT "shared_use_approvals_audience_check" CHECK ("shared_use_approvals"."audience" IN ('owner', 'people', 'team'))
);

CREATE TABLE "shared_use_requests" (
  "id" text PRIMARY KEY NOT NULL,
  "agent_id" text NOT NULL,
  "server_id" text NOT NULL,
  "proposed_audience" text NOT NULL,
  "proposed_outside_input" boolean NOT NULL,
  "proposed_members" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "reason" text NOT NULL,
  "requested_by" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "decided_by" text,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "shared_use_requests_audience_check" CHECK ("shared_use_requests"."proposed_audience" IN ('owner', 'people', 'team')),
  CONSTRAINT "shared_use_requests_reason_check" CHECK ("shared_use_requests"."reason" IN ('publish', 'trigger', 'grant', 'refused_call')),
  CONSTRAINT "shared_use_requests_status_check" CHECK ("shared_use_requests"."status" IN ('pending', 'approved', 'declined', 'superseded'))
);

CREATE TABLE "identity_link_challenges" (
  "token_hash" text PRIMARY KEY NOT NULL,
  "provider" text NOT NULL,
  "user_id" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);

CREATE TABLE "identity_links" (
  "id" text PRIMARY KEY NOT NULL,
  "provider" text NOT NULL,
  "realm" text NOT NULL,
  "subject" text NOT NULL,
  "user_id" text NOT NULL,
  "handle" text,
  "verified_by" text NOT NULL,
  "credential_id" uuid,
  "status" text DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "identity_links_verified_by_check" CHECK ("identity_links"."verified_by" IN ('challenge', 'oauth')),
  CONSTRAINT "identity_links_status_check" CHECK ("identity_links"."status" IN ('active', 'needs_reconnect'))
);

CREATE TABLE "openduet_channels" (
  "channel_id" text PRIMARY KEY NOT NULL,
  "icon" text NOT NULL,
  "colour" text NOT NULL,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "openduet_channels_icon_check" CHECK ("openduet_channels"."icon" IN ('check', 'calendar', 'mail', 'dollar', 'chart', 'globe', 'pin', 'home', 'cube', 'video', 'folder', 'pencil', 'search', 'heart', 'people', 'briefcase', 'book', 'plane', 'car', 'food', 'bag', 'gift', 'sprout', 'music')),
  CONSTRAINT "openduet_channels_colour_check" CHECK ("openduet_channels"."colour" IN ('berry', 'blush', 'peach', 'amber', 'sage', 'green', 'sky', 'blue', 'lavender'))
);

CREATE TABLE "openduet_pages" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_user_id" text NOT NULL,
  "bot_id" text NOT NULL,
  "channel_id" text,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "summary" text,
  "thumbnail" text,
  "theme" text DEFAULT 'classic' NOT NULL,
  "content" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "openduet_pages_theme_check" CHECK ("openduet_pages"."theme" IN ('classic', 'studio', 'earth', 'ocean', 'editorial')),
  CONSTRAINT "openduet_pages_kind_check" CHECK ("openduet_pages"."kind" IN ('page', 'slides', 'dashboard', 'doc', 'design', 'design-system'))
);

CREATE TABLE "openduet_tasks" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_user_id" text NOT NULL,
  "bot_id" text NOT NULL,
  "channel_id" text NOT NULL,
  "from_channel_id" text,
  "title" text NOT NULL,
  "why" text,
  "thumbnail" text,
  "origin" text NOT NULL,
  "suggestion_id" text,
  "source_app" text,
  "source_link" text,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "openduet_tasks_origin_check" CHECK ("openduet_tasks"."origin" IN ('asked', 'suggestion', 'check_in'))
);

ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX "accounts_provider_account_idx" ON "accounts" USING btree ("provider_id" ASC NULLS LAST, "account_id" ASC NULLS LAST);

ALTER TABLE "agents" ADD CONSTRAINT "agents_package_id_deployment_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."deployment_packages" ("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "attachments" ADD CONSTRAINT "attachments_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "attachments_channel_idx" ON "attachments" USING btree ("channel_id" ASC NULLS LAST);

CREATE INDEX "attachments_uploaded_by_idx" ON "attachments" USING btree ("uploaded_by" ASC NULLS LAST);

CREATE INDEX "attachments_upload_group_idx" ON "attachments" USING btree ("channel_id" ASC NULLS LAST, "uploaded_by" ASC NULLS LAST, "upload_group" ASC NULLS LAST) WHERE "attachments"."attached_at" is null;

CREATE INDEX "attachments_staged_idx" ON "attachments" USING btree ("created_at" ASC NULLS LAST) WHERE "attachments"."attached_at" is null;

CREATE INDEX "audit_events_created_at_idx" ON "audit_events" USING btree ("created_at" ASC NULLS LAST);

CREATE INDEX "audit_events_type_time_idx" ON "audit_events" USING btree ("event_type" ASC NULLS LAST, "created_at" DESC NULLS LAST, "id" DESC NULLS LAST);

CREATE INDEX "audit_events_actor_time_idx" ON "audit_events" USING btree ("actor_user_id" ASC NULLS LAST, "created_at" DESC NULLS LAST, "id" DESC NULLS LAST);

CREATE INDEX "audit_events_target_time_idx" ON "audit_events" USING btree ("target_type" ASC NULLS LAST, "target_id" ASC NULLS LAST, "created_at" DESC NULLS LAST, "id" DESC NULLS LAST);

CREATE INDEX "audit_events_initiator_time_idx" ON "audit_events" USING btree ("initiator_kind" ASC NULLS LAST, "created_at" DESC NULLS LAST, "id" DESC NULLS LAST);

ALTER TABLE "channel_agents" ADD CONSTRAINT "channel_agents_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "channel_agents" ADD CONSTRAINT "channel_agents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "channel_memberships" ADD CONSTRAINT "channel_memberships_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "channel_memberships" ADD CONSTRAINT "channel_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "channels" ADD CONSTRAINT "channels_package_id_deployment_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."deployment_packages" ("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "channels" ADD CONSTRAINT "channels_last_message_agent_id_agents_id_fk" FOREIGN KEY ("last_message_agent_id") REFERENCES "public"."agents" ("id") ON DELETE set null ON UPDATE no action;

CREATE INDEX "channels_recent_activity_idx" ON "channels" USING btree ((COALESCE("last_message_at", "created_at")) DESC);

CREATE INDEX "channels_awaiting_summary_idx" ON "channels" USING btree ("id" ASC NULLS LAST) WHERE "channels"."summary" is null and "channels"."deleted_at" is null;

CREATE UNIQUE INDEX "credentials_active_key_idx" ON "credentials" USING btree ("kind" ASC NULLS LAST, "provider" ASC NULLS LAST, "key_id" ASC NULLS LAST) WHERE "credentials"."revoked_at" IS NULL;

ALTER TABLE "thread_channel_mappings" ADD CONSTRAINT "thread_channel_mappings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "thread_channel_mappings" ADD CONSTRAINT "thread_channel_mappings_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels" ("id") ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX "thread_channel_mappings_thread_idx" ON "thread_channel_mappings" USING btree ("thread_id" ASC NULLS LAST);

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "sso_providers" ADD CONSTRAINT "sso_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "user_instructions" ADD CONSTRAINT "user_instructions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "computer_page_frame_captured_idx" ON "computer_page_frame" USING btree ("captured_at" ASC NULLS LAST);

ALTER TABLE "agent_preferences" ADD CONSTRAINT "agent_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "agent_preferences" ADD CONSTRAINT "agent_preferences_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE set null ON UPDATE no action;

CREATE INDEX "agent_profiles_visibility_deleted_idx" ON "agent_profiles" USING btree ("visibility" ASC NULLS LAST, "deleted_at" ASC NULLS LAST);

ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines" ("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "routine_runs_by_routine_idx" ON "routine_runs" USING btree ("routine_id" ASC NULLS LAST, "started_at" ASC NULLS LAST);

ALTER TABLE "routines" ADD CONSTRAINT "routines_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "routines" ADD CONSTRAINT "routines_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "routines_due_idx" ON "routines" USING btree ("enabled" ASC NULLS LAST, "next_run_at" ASC NULLS LAST);

CREATE INDEX "routines_by_owner_idx" ON "routines" USING btree ("owner_user_id" ASC NULLS LAST, "enabled" ASC NULLS LAST);

ALTER TABLE "component_exclusions" ADD CONSTRAINT "component_exclusions_component_name_components_name_fk" FOREIGN KEY ("component_name") REFERENCES "public"."components" ("name") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "component_exclusions" ADD CONSTRAINT "component_exclusions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "component_functions" ADD CONSTRAINT "component_functions_component_name_components_name_fk" FOREIGN KEY ("component_name") REFERENCES "public"."components" ("name") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "app_access_requests" ADD CONSTRAINT "app_access_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "app_access_requests" ADD CONSTRAINT "app_access_requests_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX "app_access_requests_pending_idx" ON "app_access_requests" USING btree ("requested_by" ASC NULLS LAST, "app_key" ASC NULLS LAST, (coalesce("agent_id", '')) ASC NULLS LAST, "kind" ASC NULLS LAST) WHERE "app_access_requests"."status" = 'pending';

CREATE INDEX "app_access_requests_status_idx" ON "app_access_requests" USING btree ("status" ASC NULLS LAST, "app_key" ASC NULLS LAST);

CREATE UNIQUE INDEX "brokered_connections_person_idx" ON "brokered_connections" USING btree ("provider" ASC NULLS LAST, "app" ASC NULLS LAST, "user_id" ASC NULLS LAST) WHERE "brokered_connections"."holder" = 'person';

CREATE UNIQUE INDEX "brokered_connections_deployment_idx" ON "brokered_connections" USING btree ("provider" ASC NULLS LAST, "app" ASC NULLS LAST) WHERE "brokered_connections"."holder" = 'deployment';

CREATE INDEX "brokered_connections_user_idx" ON "brokered_connections" USING btree ("user_id" ASC NULLS LAST);

CREATE INDEX "composio_connections_user_idx" ON "composio_connections" USING btree ("user_id" ASC NULLS LAST);

ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials" ("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "mcp_tools" ADD CONSTRAINT "mcp_tools_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "mcp_user_credentials" ADD CONSTRAINT "mcp_user_credentials_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "mcp_user_credentials" ADD CONSTRAINT "mcp_user_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "mcp_user_credentials" ADD CONSTRAINT "mcp_user_credentials_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials" ("id") ON DELETE no action ON UPDATE no action;

CREATE INDEX "mcp_user_credentials_user_idx" ON "mcp_user_credentials" USING btree ("user_id" ASC NULLS LAST);

ALTER TABLE "pending_authorizations" ADD CONSTRAINT "pending_authorizations_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "pending_authorizations" ADD CONSTRAINT "pending_authorizations_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers" ("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "pending_authorizations_server_idx" ON "pending_authorizations" USING btree ("server_id" ASC NULLS LAST);

ALTER TABLE "plugin_grants" ADD CONSTRAINT "plugin_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "plugin_grants_agent_idx" ON "plugin_grants" USING btree ("agent_id" ASC NULLS LAST);

ALTER TABLE "skill_tools" ADD CONSTRAINT "skill_tools_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills" ("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "skill_tools_ref_idx" ON "skill_tools" USING btree ("ref" ASC NULLS LAST);

ALTER TABLE "skills" ADD CONSTRAINT "skills_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX "skills_slug_key" ON "skills" USING btree ("slug" ASC NULLS LAST);

CREATE INDEX "skills_owner_idx" ON "skills" USING btree ("owner_user_id" ASC NULLS LAST);

CREATE INDEX "work_items_claimable_idx" ON "work_items" USING btree ("kind" ASC NULLS LAST, "run_at" ASC NULLS LAST);

ALTER TABLE "voice_sessions" ADD CONSTRAINT "voice_sessions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "voice_sessions" ADD CONSTRAINT "voice_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "voice_sessions_channel_started_idx" ON "voice_sessions" USING btree ("channel_id" ASC NULLS LAST, "started_at" ASC NULLS LAST, "id" ASC NULLS LAST);

ALTER TABLE "responsibilities" ADD CONSTRAINT "responsibilities_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "responsibilities" ADD CONSTRAINT "responsibilities_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "responsibilities_owner_status_idx" ON "responsibilities" USING btree ("owner_user_id" ASC NULLS LAST, "status" ASC NULLS LAST);

ALTER TABLE "responsibility_events" ADD CONSTRAINT "responsibility_events_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX "responsibility_events_source_id_idx" ON "responsibility_events" USING btree ("owner_user_id" ASC NULLS LAST, "source" ASC NULLS LAST, "external_id" ASC NULLS LAST);

ALTER TABLE "responsibility_runs" ADD CONSTRAINT "responsibility_runs_responsibility_id_responsibilities_id_fk" FOREIGN KEY ("responsibility_id") REFERENCES "public"."responsibilities" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "responsibility_runs" ADD CONSTRAINT "responsibility_runs_event_id_responsibility_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."responsibility_events" ("id") ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX "responsibility_runs_event_idx" ON "responsibility_runs" USING btree ("responsibility_id" ASC NULLS LAST, "event_id" ASC NULLS LAST);

CREATE INDEX "responsibility_runs_status_idx" ON "responsibility_runs" USING btree ("status" ASC NULLS LAST, "created_at" ASC NULLS LAST);

ALTER TABLE "responsibility_source_bindings" ADD CONSTRAINT "responsibility_source_bindings_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "responsibility_source_bindings" ADD CONSTRAINT "responsibility_source_bindings_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials" ("id") ON DELETE no action ON UPDATE no action;

CREATE INDEX "responsibility_source_bindings_owner_idx" ON "responsibility_source_bindings" USING btree ("owner_user_id" ASC NULLS LAST);

ALTER TABLE "responsibility_triggers" ADD CONSTRAINT "responsibility_triggers_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "responsibility_triggers" ADD CONSTRAINT "responsibility_triggers_responsibility_id_responsibilities_id_fk" FOREIGN KEY ("responsibility_id") REFERENCES "public"."responsibilities" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "responsibility_triggers" ADD CONSTRAINT "responsibility_triggers_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials" ("id") ON DELETE no action ON UPDATE no action;

CREATE INDEX "responsibility_triggers_owner_idx" ON "responsibility_triggers" USING btree ("owner_user_id" ASC NULLS LAST);

CREATE INDEX "responsibility_triggers_responsibility_idx" ON "responsibility_triggers" USING btree ("responsibility_id" ASC NULLS LAST);

CREATE INDEX "responsibility_triggers_kind_idx" ON "responsibility_triggers" USING btree ("kind" ASC NULLS LAST);

ALTER TABLE "approval_preferences" ADD CONSTRAINT "approval_preferences_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX "approval_requests_action_idx" ON "approval_requests" USING btree ("owner_user_id" ASC NULLS LAST, "run_id" ASC NULLS LAST, "tool_call_id" ASC NULLS LAST);

CREATE INDEX "approval_requests_inbox_idx" ON "approval_requests" USING btree ("owner_user_id" ASC NULLS LAST, "status" ASC NULLS LAST);

ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "approval_rules_owner_idx" ON "approval_rules" USING btree ("owner_user_id" ASC NULLS LAST);

ALTER TABLE "approval_team_rules" ADD CONSTRAINT "approval_team_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users" ("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "approval_team_settings" ADD CONSTRAINT "approval_team_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users" ("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_sources_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_sources_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "memory_sources_owner_idx" ON "memory_sources" USING btree ("owner_user_id" ASC NULLS LAST);

CREATE INDEX "memory_sources_due_idx" ON "memory_sources" USING btree ("enabled" ASC NULLS LAST, "next_sync_at" ASC NULLS LAST);

ALTER TABLE "personal_memories" ADD CONSTRAINT "personal_memories_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "personal_memories" ADD CONSTRAINT "personal_memories_source_id_memory_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."memory_sources" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "personal_memories" ADD CONSTRAINT "personal_memories_formed_by_agent_id_agents_id_fk" FOREIGN KEY ("formed_by_agent_id") REFERENCES "public"."agents" ("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "personal_memories_owner_idx" ON "personal_memories" USING btree ("owner_user_id" ASC NULLS LAST, "enabled" ASC NULLS LAST);

CREATE INDEX "personal_memories_formed_idx" ON "personal_memories" USING btree ("owner_user_id" ASC NULLS LAST, "formed_by_agent_id" ASC NULLS LAST);

CREATE UNIQUE INDEX "personal_memories_import_idx" ON "personal_memories" USING btree ("source_id" ASC NULLS LAST, "external_id" ASC NULLS LAST);

CREATE UNIQUE INDEX "personal_memories_formed_digest_idx" ON "personal_memories" USING btree ("owner_user_id" ASC NULLS LAST, "import_digest" ASC NULLS LAST) WHERE "personal_memories"."formed_by" = 'bot';

ALTER TABLE "default_opt_outs" ADD CONSTRAINT "default_opt_outs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "default_opt_outs" ADD CONSTRAINT "default_opt_outs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "proactive_settings" ADD CONSTRAINT "proactive_settings_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "proactive_settings" ADD CONSTRAINT "proactive_settings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX "proactive_settings_owner_agent_idx" ON "proactive_settings" USING btree ("owner_user_id" ASC NULLS LAST, "agent_id" ASC NULLS LAST);

CREATE INDEX "proactive_settings_due_idx" ON "proactive_settings" USING btree ("enabled" ASC NULLS LAST, "next_run_at" ASC NULLS LAST);

ALTER TABLE "proactive_suggestions" ADD CONSTRAINT "proactive_suggestions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "proactive_suggestions" ADD CONSTRAINT "proactive_suggestions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "proactive_suggestions" ADD CONSTRAINT "proactive_suggestions_setting_id_proactive_settings_id_fk" FOREIGN KEY ("setting_id") REFERENCES "public"."proactive_settings" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "proactive_suggestions" ADD CONSTRAINT "proactive_suggestions_from_channel_id_channels_id_fk" FOREIGN KEY ("from_channel_id") REFERENCES "public"."channels" ("id") ON DELETE set null ON UPDATE no action;

CREATE INDEX "proactive_suggestions_owner_idx" ON "proactive_suggestions" USING btree ("owner_user_id" ASC NULLS LAST, "status" ASC NULLS LAST, "created_at" ASC NULLS LAST);

CREATE INDEX "proactive_suggestions_run_idx" ON "proactive_suggestions" USING btree ("run_id" ASC NULLS LAST);

ALTER TABLE "demonstrations" ADD CONSTRAINT "demonstrations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "demonstrations" ADD CONSTRAINT "demonstrations_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents" ("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "demonstrations_owner_idx" ON "demonstrations" USING btree ("owner_user_id" ASC NULLS LAST, "created_at" ASC NULLS LAST);

CREATE UNIQUE INDEX "demonstrations_active_bot_idx" ON "demonstrations" USING btree ("bot_id" ASC NULLS LAST) WHERE "demonstrations"."status" = 'recording';

ALTER TABLE "delivery_bindings" ADD CONSTRAINT "delivery_bindings_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "delivery_bindings" ADD CONSTRAINT "delivery_bindings_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "delivery_bindings" ADD CONSTRAINT "delivery_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX "delivery_binding_identity_idx" ON "delivery_bindings" USING btree ("transport" ASC NULLS LAST, "realm" ASC NULLS LAST, "identity" ASC NULLS LAST);

CREATE INDEX "delivery_bindings_owner_idx" ON "delivery_bindings" USING btree ("owner_user_id" ASC NULLS LAST);

ALTER TABLE "delivery_challenges" ADD CONSTRAINT "delivery_challenges_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "delivery_challenges" ADD CONSTRAINT "delivery_challenges_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "delivery_challenges" ADD CONSTRAINT "delivery_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "delivery_inbox" ADD CONSTRAINT "delivery_inbox_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "delivery_inbox" ADD CONSTRAINT "delivery_inbox_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "delivery_inbox" ADD CONSTRAINT "delivery_inbox_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX "delivery_inbox_dedupe_idx" ON "delivery_inbox" USING btree ("source" ASC NULLS LAST, "realm" ASC NULLS LAST, "external_id" ASC NULLS LAST);

CREATE INDEX "delivery_inbox_owner_idx" ON "delivery_inbox" USING btree ("owner_user_id" ASC NULLS LAST, "created_at" ASC NULLS LAST);

ALTER TABLE "delivery_outbox" ADD CONSTRAINT "delivery_outbox_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "delivery_outbox" ADD CONSTRAINT "delivery_outbox_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "delivery_outbox" ADD CONSTRAINT "delivery_outbox_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "delivery_outbox_owner_idx" ON "delivery_outbox" USING btree ("owner_user_id" ASC NULLS LAST, "created_at" ASC NULLS LAST);

CREATE INDEX "delivery_outbox_provider_idx" ON "delivery_outbox" USING btree ("transport" ASC NULLS LAST, "provider_id" ASC NULLS LAST);

ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "push_devices_owner_idx" ON "push_devices" USING btree ("owner_user_id" ASC NULLS LAST);

ALTER TABLE "group_bot_threads" ADD CONSTRAINT "group_bot_threads_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "group_bot_threads" ADD CONSTRAINT "group_bot_threads_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels" ("id") ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX "group_bot_threads_thread_idx" ON "group_bot_threads" USING btree ("thread_id" ASC NULLS LAST);

ALTER TABLE "group_messages" ADD CONSTRAINT "group_messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "group_messages" ADD CONSTRAINT "group_messages_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "group_messages_channel_idx" ON "group_messages" USING btree ("channel_id" ASC NULLS LAST, "created_at" ASC NULLS LAST, "id" ASC NULLS LAST);

CREATE INDEX "action_records_created_idx" ON "action_records" USING btree ("created_at" ASC NULLS LAST);

CREATE INDEX "action_records_bot_idx" ON "action_records" USING btree ("bot_id" ASC NULLS LAST, "created_at" ASC NULLS LAST);

CREATE INDEX "model_usage_created_idx" ON "model_usage" USING btree ("created_at" ASC NULLS LAST);

CREATE INDEX "model_usage_model_idx" ON "model_usage" USING btree ("model" ASC NULLS LAST, "created_at" ASC NULLS LAST);

CREATE INDEX "scim_connection_bindings_connection_idx" ON "scim_connection_bindings" USING btree ("connection_id" ASC NULLS LAST);

ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_group_id_scim_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."scim_groups" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_scim_user_id_scim_users_id_fk" FOREIGN KEY ("scim_user_id") REFERENCES "public"."scim_users" ("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "scim_group_members_connection_idx" ON "scim_group_members" USING btree ("connection_id" ASC NULLS LAST);

CREATE INDEX "scim_group_members_group_idx" ON "scim_group_members" USING btree ("group_id" ASC NULLS LAST);

CREATE INDEX "scim_group_members_scim_user_idx" ON "scim_group_members" USING btree ("scim_user_id" ASC NULLS LAST);

CREATE INDEX "scim_groups_connection_idx" ON "scim_groups" USING btree ("connection_id" ASC NULLS LAST);

CREATE INDEX "scim_groups_domain_idx" ON "scim_groups" USING btree ("provisioning_domain_id" ASC NULLS LAST);

ALTER TABLE "scim_identity_tombstones" ADD CONSTRAINT "scim_identity_tombstones_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "scim_identity_tombstones_connection_idx" ON "scim_identity_tombstones" USING btree ("connection_id" ASC NULLS LAST);

CREATE INDEX "scim_identity_tombstones_domain_idx" ON "scim_identity_tombstones" USING btree ("provisioning_domain_id" ASC NULLS LAST);

CREATE INDEX "scim_identity_tombstones_user_idx" ON "scim_identity_tombstones" USING btree ("user_id" ASC NULLS LAST);

ALTER TABLE "scim_projection_grants" ADD CONSTRAINT "scim_projection_grants_scim_user_id_scim_users_id_fk" FOREIGN KEY ("scim_user_id") REFERENCES "public"."scim_users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "scim_projection_grants" ADD CONSTRAINT "scim_projection_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "scim_projection_grants_connection_idx" ON "scim_projection_grants" USING btree ("connection_id" ASC NULLS LAST);

CREATE INDEX "scim_projection_grants_domain_idx" ON "scim_projection_grants" USING btree ("provisioning_domain_id" ASC NULLS LAST);

CREATE INDEX "scim_projection_grants_scim_user_idx" ON "scim_projection_grants" USING btree ("scim_user_id" ASC NULLS LAST);

CREATE INDEX "scim_projection_grants_user_idx" ON "scim_projection_grants" USING btree ("user_id" ASC NULLS LAST);

ALTER TABLE "scim_subjects" ADD CONSTRAINT "scim_subjects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "scim_subjects_profile_source_idx" ON "scim_subjects" USING btree ("profile_source_id" ASC NULLS LAST);

ALTER TABLE "scim_users" ADD CONSTRAINT "scim_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "scim_users_connection_idx" ON "scim_users" USING btree ("connection_id" ASC NULLS LAST);

CREATE INDEX "scim_users_domain_idx" ON "scim_users" USING btree ("provisioning_domain_id" ASC NULLS LAST);

CREATE INDEX "scim_users_user_idx" ON "scim_users" USING btree ("user_id" ASC NULLS LAST);

ALTER TABLE "bot_lifecycle" ADD CONSTRAINT "bot_lifecycle_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "bot_lifecycle" ADD CONSTRAINT "bot_lifecycle_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "update_routing_preferences" ADD CONSTRAINT "update_routing_preferences_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "saved_logins" ADD CONSTRAINT "saved_logins_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX "saved_logins_owner_origin_username_idx" ON "saved_logins" USING btree ("owner_user_id" ASC NULLS LAST, "origin" ASC NULLS LAST, "username" ASC NULLS LAST);

CREATE INDEX "saved_logins_owner_idx" ON "saved_logins" USING btree ("owner_user_id" ASC NULLS LAST);

ALTER TABLE "sign_in_requests" ADD CONSTRAINT "sign_in_requests_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "sign_in_requests_owner_idx" ON "sign_in_requests" USING btree ("owner_user_id" ASC NULLS LAST, "status" ASC NULLS LAST);

ALTER TABLE "team_bot_assignments" ADD CONSTRAINT "team_bot_assignments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "team_bot_assignments" ADD CONSTRAINT "team_bot_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "team_bot_audience" ADD CONSTRAINT "team_bot_audience_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "team_bot_consent_defaults" ADD CONSTRAINT "team_bot_consent_defaults_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "team_bot_consents" ADD CONSTRAINT "team_bot_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "team_bot_consents" ADD CONSTRAINT "team_bot_consents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "team_bot_publications" ADD CONSTRAINT "team_bot_publications_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "team_bot_publications" ADD CONSTRAINT "team_bot_publications_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "shared_use_approval_members" ADD CONSTRAINT "shared_use_approval_members_approval_fk" FOREIGN KEY ("agent_id", "server_id") REFERENCES "public"."shared_use_approvals" ("agent_id", "server_id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "shared_use_approvals" ADD CONSTRAINT "shared_use_approvals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "shared_use_approvals" ADD CONSTRAINT "shared_use_approvals_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "shared_use_requests" ADD CONSTRAINT "shared_use_requests_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "shared_use_requests" ADD CONSTRAINT "shared_use_requests_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers" ("id") ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX "shared_use_requests_pending_idx" ON "shared_use_requests" USING btree ("agent_id" ASC NULLS LAST, "server_id" ASC NULLS LAST) WHERE "shared_use_requests"."status" = 'pending';

CREATE INDEX "shared_use_requests_status_idx" ON "shared_use_requests" USING btree ("status" ASC NULLS LAST);

CREATE INDEX "identity_link_challenges_expiry_idx" ON "identity_link_challenges" USING btree ("expires_at" ASC NULLS LAST);

CREATE UNIQUE INDEX "identity_link_challenges_user_provider_idx" ON "identity_link_challenges" USING btree ("user_id" ASC NULLS LAST, "provider" ASC NULLS LAST);

ALTER TABLE "identity_links" ADD CONSTRAINT "identity_links_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials" ("id") ON DELETE no action ON UPDATE no action;

CREATE UNIQUE INDEX "identity_links_identity_idx" ON "identity_links" USING btree ("provider" ASC NULLS LAST, "realm" ASC NULLS LAST, "subject" ASC NULLS LAST);

CREATE UNIQUE INDEX "identity_links_user_realm_idx" ON "identity_links" USING btree ("user_id" ASC NULLS LAST, "provider" ASC NULLS LAST, "realm" ASC NULLS LAST);

CREATE UNIQUE INDEX "identity_links_credential_idx" ON "identity_links" USING btree ("credential_id" ASC NULLS LAST) WHERE "identity_links"."credential_id" IS NOT NULL;

ALTER TABLE "openduet_channels" ADD CONSTRAINT "openduet_channels_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "openduet_pages" ADD CONSTRAINT "openduet_pages_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "openduet_pages" ADD CONSTRAINT "openduet_pages_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents" ("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "openduet_pages_owner_updated_idx" ON "openduet_pages" USING btree ("owner_user_id" ASC NULLS LAST, "updated_at" ASC NULLS LAST);

ALTER TABLE "openduet_tasks" ADD CONSTRAINT "openduet_tasks_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "openduet_tasks" ADD CONSTRAINT "openduet_tasks_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "openduet_tasks" ADD CONSTRAINT "openduet_tasks_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels" ("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "openduet_tasks" ADD CONSTRAINT "openduet_tasks_from_channel_id_channels_id_fk" FOREIGN KEY ("from_channel_id") REFERENCES "public"."channels" ("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "openduet_tasks" ADD CONSTRAINT "openduet_tasks_suggestion_id_proactive_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."proactive_suggestions" ("id") ON DELETE set null ON UPDATE no action;

CREATE INDEX "openduet_tasks_owner_created_idx" ON "openduet_tasks" USING btree ("owner_user_id" ASC NULLS LAST, "created_at" ASC NULLS LAST);

CREATE UNIQUE INDEX "openduet_tasks_channel_idx" ON "openduet_tasks" USING btree ("channel_id" ASC NULLS LAST);

CREATE UNIQUE INDEX "openduet_tasks_suggestion_idx" ON "openduet_tasks" USING btree ("suggestion_id" ASC NULLS LAST);

CREATE FUNCTION prevent_audit_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE retention_days integer;
BEGIN
  IF TG_OP = 'TRUNCATE' OR TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Audit events are append-only';
  END IF;
  BEGIN
    retention_days := nullif(current_setting('openbot.audit_retention_days', true), '')::integer;
  EXCEPTION WHEN others THEN
    retention_days := NULL;
  END;
  IF retention_days IS NULL OR retention_days < 1 THEN
    RAISE EXCEPTION 'Audit events are append-only';
  END IF;
  IF OLD.created_at >= now() - (retention_days || ' days')::interval THEN
    RAISE EXCEPTION 'Audit events are append-only within the retention window';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_audit_event_mutation();

CREATE TRIGGER audit_events_no_truncate
BEFORE TRUNCATE ON audit_events
FOR EACH STATEMENT EXECUTE FUNCTION prevent_audit_event_mutation();
