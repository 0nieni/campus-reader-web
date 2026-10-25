-- Retained material payloads are separate from announcements and reminders.
CREATE TABLE campus_material_files (
 id text PRIMARY KEY,
 store_scope text NOT NULL,
 item_id text NOT NULL,
 school_id text NOT NULL,
 owner_key text NOT NULL,
 source_id text NOT NULL,
 original_url text NOT NULL,
 filename text NOT NULL,
 kind text NOT NULL CHECK (kind IN ('article','attachment')),
 state text NOT NULL DEFAULT 'pending',
 content_type text,
 byte_length integer NOT NULL DEFAULT 0,
 content_hash text,
 blob_key text,
 pending_blob_key text,
 text_content text NOT NULL DEFAULT '',
 message text NOT NULL DEFAULT '',
 collected_at timestamptz,
 expires_at timestamptz,
 checked_at timestamptz,
 lease_id text,
 lease_until timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z',
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX campus_material_files_item ON campus_material_files(store_scope,item_id,owner_key,school_id);
CREATE INDEX campus_material_files_expiry ON campus_material_files(store_scope,expires_at);
CREATE TABLE campus_material_garbage (
 store_scope text NOT NULL,
 blob_key text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(store_scope,blob_key)
);
CREATE TABLE campus_collection_jobs (
 id text PRIMARY KEY,
 run_day date NOT NULL,
 kind text NOT NULL CHECK(kind IN ('school','source','item')),
 school_id text NOT NULL,
 owner_key text NOT NULL DEFAULT '',
 target_id text NOT NULL,
 state text NOT NULL DEFAULT 'pending',
 attempts integer NOT NULL DEFAULT 0,
 lease_id text,
 lease_until timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z',
 message text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX campus_collection_jobs_due ON campus_collection_jobs(state,run_day,lease_until,kind,id);

-- Existing imported caches receive a fixed lifetime; stable IDs and reminders stay.
UPDATE campus_documents SET body=body || jsonb_build_object('materialExpiresAt',
 to_char((coalesce(nullif(body->>'updatedAt',''),nullif(body->>'discoveredAt',''),nullif(body->>'createdAt',''),now()::text)::timestamptz + interval '365 days') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
 WHERE collection='items' AND length(coalesce(body->>'contentText',''))>0
 AND NOT(body ? 'materialExpiresAt') AND NOT(body ? 'aiSearchExpiresAt');
