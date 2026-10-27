-- Independent guest credentials. No existing account or migration is rewritten.
CREATE TABLE campus_guest_workspaces (
 id text PRIMARY KEY,
 created_at timestamptz NOT NULL,
 last_seen_at timestamptz NOT NULL
);
CREATE TABLE campus_guest_sessions (
 token_hash text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES campus_guest_workspaces(id),
 expires_at timestamptz NOT NULL
);
CREATE INDEX campus_guest_sessions_expiry ON campus_guest_sessions(expires_at);
CREATE TABLE campus_guest_transfers (
 token_hash text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES campus_guest_workspaces(id),
 created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 consumed_by text REFERENCES campus_guest_workspaces(id),
 result jsonb
);
CREATE UNIQUE INDEX campus_guest_transfer_active ON campus_guest_transfers(workspace_id) WHERE consumed_at IS NULL;
CREATE INDEX campus_guest_transfer_expiry ON campus_guest_transfers(expires_at);
CREATE TABLE campus_guest_limits (
 bucket text NOT NULL,
 subject text NOT NULL,
 used integer NOT NULL,
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(bucket,subject)
);
ALTER TABLE campus_reminder_email ADD COLUMN identity_kind text NOT NULL DEFAULT 'account' CHECK(identity_kind IN ('account','guest'));
REVOKE ALL ON campus_guest_workspaces,campus_guest_sessions,campus_guest_transfers,campus_guest_limits FROM PUBLIC;
