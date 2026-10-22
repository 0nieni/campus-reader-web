-- Seventh, additive migration. The six previous migration checksums stay intact.
ALTER TABLE campus_reminder_jobs ADD COLUMN provider text NOT NULL DEFAULT 'qstash';
ALTER TABLE campus_reminder_jobs ADD COLUMN registered_at timestamptz;
CREATE INDEX campus_reminder_jobs_provider_due ON campus_reminder_jobs(provider,state,run_at,retry_at);
CREATE TABLE campus_reminder_email (
 owner_id text PRIMARY KEY REFERENCES campus_reminder_accounts(owner_id) ON DELETE CASCADE,
 identity_id text NOT NULL,
 email text NOT NULL,
 binding_id text NOT NULL,
 verified_at timestamptz,
 enabled boolean NOT NULL DEFAULT false,
 enabled_at timestamptz,
 suspended boolean NOT NULL DEFAULT false,
 token_hash text UNIQUE,
 token_expires timestamptz,
 unsubscribe_hash text UNIQUE,
 last_verify_at timestamptz,
 last_test_at timestamptz,
 feedback_checked_at timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z',
 feedback_due_at timestamptz,
 feedback_until timestamptz,
 feedback_failures integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE campus_reminder_channel_receipts (
 job_id text NOT NULL REFERENCES campus_reminder_jobs(id) ON DELETE CASCADE,
 channel text NOT NULL CHECK(channel IN ('browser','email')),
 target_id text NOT NULL,
 binding_id text NOT NULL,
 state text NOT NULL,
 attempts integer NOT NULL DEFAULT 1,
 retry_at timestamptz,
 provider_id text,
 code text,
 created_at timestamptz NOT NULL,
 started_at timestamptz,
 finished_at timestamptz,
 PRIMARY KEY(job_id,channel,target_id,binding_id)
);
CREATE TABLE campus_reminder_email_budget (
 day date NOT NULL,
 owner_id text NOT NULL,
 kind text NOT NULL,
 used integer NOT NULL DEFAULT 0,
 PRIMARY KEY(day,owner_id,kind)
);
