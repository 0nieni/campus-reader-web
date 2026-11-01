-- MCP grants are independent from browser credentials, transfers and AI accounts.
CREATE TABLE campus_mcp_clients (
 id text PRIMARY KEY, body jsonb NOT NULL, secret_hash text,
 created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE campus_mcp_pending (
 ticket_hash text PRIMARY KEY, client_id text NOT NULL REFERENCES campus_mcp_clients(id),
 redirect_uri text NOT NULL, resource text NOT NULL, scopes text[] NOT NULL,
 challenge text NOT NULL, state text NOT NULL, expires_at timestamptz NOT NULL,
 consumed_at timestamptz
);
CREATE TABLE campus_mcp_grants (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES campus_guest_workspaces(id),
 client_id text REFERENCES campus_mcp_clients(id), name text NOT NULL,
 resource text NOT NULL, scopes text[] NOT NULL, allowed_origins text[] NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 last_used_at timestamptz, revoked_at timestamptz
);
CREATE INDEX campus_mcp_grants_workspace ON campus_mcp_grants(workspace_id);
CREATE TABLE campus_mcp_tokens (
 token_hash text PRIMARY KEY, grant_id text NOT NULL REFERENCES campus_mcp_grants(id),
 kind text NOT NULL CHECK(kind IN ('manual','access','refresh')),
 expires_at timestamptz NOT NULL, consumed_at timestamptz
);
CREATE INDEX campus_mcp_tokens_grant ON campus_mcp_tokens(grant_id);
CREATE TABLE campus_mcp_codes (
 code_hash text PRIMARY KEY, grant_id text NOT NULL REFERENCES campus_mcp_grants(id),
 redirect_uri text NOT NULL, challenge text NOT NULL, expires_at timestamptz NOT NULL,
 consumed_at timestamptz
);
CREATE TABLE campus_mcp_limits (
 bucket text NOT NULL, subject text NOT NULL, used integer NOT NULL,
 expires_at timestamptz NOT NULL, PRIMARY KEY(bucket,subject)
);
CREATE TABLE campus_mcp_receipts (
 grant_id text NOT NULL REFERENCES campus_mcp_grants(id), request_id text NOT NULL,
 tool text NOT NULL, input_hash text NOT NULL, response jsonb NOT NULL,
 expires_at timestamptz NOT NULL, PRIMARY KEY(grant_id,request_id)
);
REVOKE ALL ON campus_mcp_clients,campus_mcp_pending,campus_mcp_grants,campus_mcp_tokens,campus_mcp_codes,campus_mcp_limits,campus_mcp_receipts FROM PUBLIC;
