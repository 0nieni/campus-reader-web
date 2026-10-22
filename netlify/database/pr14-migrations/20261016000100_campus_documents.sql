-- Application data is server-only. The JSON envelope preserves existing source policies
-- and AI idempotency metadata while Postgres provides real multi-document transactions.
CREATE TABLE campus_documents (
  collection text NOT NULL CHECK (collection IN ('schools','sources','items','user_profiles','web_ai_tasks','web_ai_accounts')),
  id text NOT NULL,
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  PRIMARY KEY (collection, id)
);
CREATE INDEX campus_items_date ON campus_documents ((body->>'publishedAt') DESC, id DESC) WHERE collection='items';
CREATE INDEX campus_tasks_owner ON campus_documents ((body->>'owner'), (body->>'expireAt')) WHERE collection='web_ai_tasks';
CREATE INDEX campus_items_school ON campus_documents USING gin ((body->'schoolIds')) WHERE collection='items';
REVOKE ALL ON campus_documents FROM PUBLIC;
