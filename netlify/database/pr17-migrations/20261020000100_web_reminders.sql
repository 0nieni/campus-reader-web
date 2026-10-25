-- Additive only. Existing data and the four earlier migrations are unchanged.
CREATE TABLE campus_reminder_accounts (
  owner_id text PRIMARY KEY,
  body jsonb NOT NULL DEFAULT '{"reminders":[],"watches":[],"notifications":[]}',
  checked_at timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z'
);
CREATE TABLE campus_notice_arrivals (
  item_id text PRIMARY KEY,
  arrived_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX campus_notice_arrivals_time ON campus_notice_arrivals(arrived_at,item_id);
CREATE TABLE campus_reminder_seen (
  owner_id text NOT NULL,
  watch_id text NOT NULL,
  item_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,watch_id,item_id)
);
CREATE TABLE campus_push_devices (
  endpoint_hash text PRIMARY KEY,
  owner_id text NOT NULL,
  subscription jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_test_at timestamptz
);
CREATE INDEX campus_push_devices_owner ON campus_push_devices(owner_id);
-- No backfill: subscribing must not notify about all existing announcements.
CREATE FUNCTION campus_record_notice_arrival() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.collection='items' AND NEW.body->>'status'='published' THEN
    IF TG_OP='INSERT' THEN
      INSERT INTO campus_notice_arrivals(item_id) VALUES(NEW.id) ON CONFLICT DO NOTHING;
    ELSIF OLD.body->>'status' IS DISTINCT FROM 'published' THEN
      INSERT INTO campus_notice_arrivals(item_id) VALUES(NEW.id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER campus_notice_arrival AFTER INSERT OR UPDATE ON campus_documents
  FOR EACH ROW EXECUTE FUNCTION campus_record_notice_arrival();
