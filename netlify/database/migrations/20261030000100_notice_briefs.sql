-- Automatic public-notice briefs have an independent ledger, never AI accounts.
CREATE TABLE campus_notice_briefs (
 id text PRIMARY KEY, store_scope text NOT NULL, item_id text NOT NULL, school_id text NOT NULL,
 source_id text NOT NULL, signature text NOT NULL, content_hash text NOT NULL,
 raw_hash text NOT NULL, raw_length integer NOT NULL, input jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','running','ready','failed','unavailable','uncertain','stale')),
 result jsonb, message text, error_code text, request_id text, attempts integer NOT NULL DEFAULT 0,
 lease_id text, lease_until timestamptz, quota_day text, reserved_tokens integer NOT NULL DEFAULT 0,
 quota_settled boolean NOT NULL DEFAULT true, usage jsonb, model_signature text,
 available_at timestamptz NOT NULL, created_at timestamptz NOT NULL, generated_at timestamptz,
 expires_at timestamptz NOT NULL
);
CREATE INDEX campus_notice_briefs_read ON campus_notice_briefs(store_scope,item_id,signature,created_at DESC);
CREATE INDEX campus_notice_briefs_queue ON campus_notice_briefs(store_scope,state,available_at);
CREATE TABLE campus_notice_brief_budget (
 store_scope text NOT NULL, day text NOT NULL, attempts integer NOT NULL DEFAULT 0,
 held_tokens bigint NOT NULL DEFAULT 0, used_tokens bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(store_scope,day)
);
CREATE TABLE campus_notice_brief_workers (
 store_scope text PRIMARY KEY, lease_id text, lease_until timestamptz NOT NULL DEFAULT '1970-01-01',
 dispatch_after timestamptz NOT NULL DEFAULT '1970-01-01'
);
REVOKE ALL ON campus_notice_briefs,campus_notice_brief_budget,campus_notice_brief_workers FROM PUBLIC;
