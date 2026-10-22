ALTER TABLE campus_documents DROP CONSTRAINT campus_documents_collection_check;
ALTER TABLE campus_documents ADD CONSTRAINT campus_documents_collection_check CHECK (collection IN ('schools','sources','items','user_profiles','web_ai_tasks','web_ai_accounts','school_sync','school_requests','web_ai_conversations'));
CREATE INDEX campus_ai_conversations_owner_school ON campus_documents ((body->>'owner'), (body->>'schoolId'), (body->>'createdAt') DESC) WHERE collection='web_ai_conversations';
