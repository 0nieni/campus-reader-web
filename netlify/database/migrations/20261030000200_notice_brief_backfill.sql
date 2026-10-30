-- Durable history scan; independent of personal workspaces and AI allowances.
CREATE TABLE campus_notice_brief_backfill (
 store_scope text PRIMARY KEY,
 cursor_id text NOT NULL DEFAULT '',
 available_at timestamptz NOT NULL DEFAULT '1970-01-01',
 budget_day text NOT NULL DEFAULT '',
 scanned integer NOT NULL DEFAULT 0,
 article_reads integer NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON campus_notice_brief_backfill FROM PUBLIC;
