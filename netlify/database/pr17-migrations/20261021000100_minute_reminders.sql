-- Additive outbox. Never modify the five previously committed migrations.
ALTER TABLE campus_push_devices ADD COLUMN binding_id text NOT NULL DEFAULT '';
ALTER TABLE campus_reminder_accounts ADD COLUMN queue_checked_at timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z';
CREATE TABLE campus_reminder_jobs (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES campus_reminder_accounts(owner_id) ON DELETE CASCADE,
  reminder_id text NOT NULL,
  generation text NOT NULL,
  offset_days integer NOT NULL,
  run_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  outcome text,
  message_id text,
  registration_error text,
  attempts integer NOT NULL DEFAULT 0,
  retry_at timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z',
  lease_until timestamptz,
  lease_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,reminder_id,generation,offset_days)
);
CREATE INDEX campus_reminder_jobs_pending ON campus_reminder_jobs(state,run_at,retry_at);
CREATE INDEX campus_reminder_jobs_owner ON campus_reminder_jobs(owner_id,reminder_id,generation);
CREATE TABLE campus_reminder_deliveries (
  job_id text NOT NULL REFERENCES campus_reminder_jobs(id) ON DELETE CASCADE,
  endpoint_hash text NOT NULL,
  binding_id text NOT NULL,
  state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY(job_id,endpoint_hash,binding_id)
);
CREATE TABLE campus_reminder_queue_budget (
  day date PRIMARY KEY,
  used integer NOT NULL DEFAULT 0
);
