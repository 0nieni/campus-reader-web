import type {SqlExecutor} from './postgres-storage';
export async function cleanupReminderData(sql:SqlExecutor,now=Date.now()){
 const before=new Date(now-90*86400000).toISOString(),deviceBefore=new Date(now-180*86400000).toISOString();
 await sql.query('DELETE FROM campus_reminder_seen WHERE created_at < $1::timestamptz',[before]);
 await sql.query('DELETE FROM campus_notice_arrivals WHERE arrived_at < $1::timestamptz',[before]);
 await sql.query('DELETE FROM campus_push_devices WHERE updated_at < $1::timestamptz',[deviceBefore]);
 await sql.query("DELETE FROM campus_reminder_jobs WHERE run_at < $1::timestamptz OR (state='cancelled' AND updated_at < $1::timestamptz)",[before]);
 await sql.query('DELETE FROM campus_reminder_queue_budget WHERE day < $1::date',[before]);
 // Application timestamps are canonical UTC ISO strings, including milliseconds.
 await sql.query(`UPDATE campus_reminder_accounts SET body=
   jsonb_set(jsonb_set(body,'{notifications}',coalesce((SELECT jsonb_agg(entry) FROM jsonb_array_elements(body->'notifications') entry WHERE entry->>'createdAt' >= $1),'[]'::jsonb)),
   '{reminders}',coalesce((SELECT jsonb_agg(entry) FROM jsonb_array_elements(body->'reminders') entry WHERE entry->>'dueAt' IS NULL OR entry->>'dueAt' >= $1),'[]'::jsonb))
   WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(body->'notifications') entry WHERE entry->>'createdAt' < $1)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(body->'reminders') entry WHERE entry->>'dueAt' < $1)`,[before]);
}
