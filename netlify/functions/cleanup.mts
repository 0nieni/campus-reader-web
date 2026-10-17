import { getDatabase } from '@netlify/database';
// 18:17 UTC = 02:17 Beijing. Do not wake the sleeping Free database every hour:
// that alone would exceed its shared monthly credits. Reads reject at 24h and
// also purge expired bodies; this daily job handles unattended physical cleanup.
export const config = { schedule: '17 18 * * *' };
export default async () => {
  await getDatabase().sql`UPDATE campus_documents
    SET body=(body - ARRAY['docs','notes','batches','question','result']::text[]) || '{"purged":true}'::jsonb
    WHERE collection='web_ai_tasks' AND body->>'expireAt' <= ${new Date().toISOString()}
    AND body->>'purged' IS DISTINCT FROM 'true'`;
  return new Response(null, { status: 204 });
};
