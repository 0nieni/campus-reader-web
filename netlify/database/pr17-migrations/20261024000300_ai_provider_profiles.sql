-- Personal credentials are authenticated ciphertext. The wrapping key is never stored here.
CREATE TABLE campus_ai_provider_accounts (
  owner_id text PRIMARY KEY,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  selected_id text,
  selected_model text,
  CHECK ((selected_id IS NULL) = (selected_model IS NULL))
);
CREATE TABLE campus_ai_provider_profiles (
  owner_id text NOT NULL REFERENCES campus_ai_provider_accounts(owner_id) ON DELETE CASCADE,
  id text NOT NULL CHECK (id ~ '^[A-Za-z0-9_-]{1,100}$'),
  version integer NOT NULL CHECK (version > 0),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60 AND name = btrim(name)),
  protocol text NOT NULL CHECK (protocol IN ('openai-chat','openai-responses','anthropic','gemini')),
  base_url text NOT NULL,
  models jsonb NOT NULL CHECK (jsonb_typeof(models) = 'array' AND jsonb_array_length(models) BETWEEN 1 AND 20),
  default_model text NOT NULL CHECK (char_length(default_model) BETWEEN 1 AND 100 AND models ? default_model),
  key_ciphertext text NOT NULL CHECK (char_length(key_ciphertext) BETWEEN 1 AND 4096),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (owner_id,id)
);
