import { postgresStorage, type SqlPool } from './postgres-storage';
import { atomic, transactionRow } from './storage';

/** Reuses the daily cleanup wake; bounds profile work and rotates by last sweep. */
export async function cleanupAssistantData(pool: SqlPool, now = Date.now()) {
  const at = new Date(now).toISOString();
  await pool.query(`UPDATE campus_documents SET body=(body - ARRAY['docs','notes','batches','question','result','chat','webEvidence','webSearch']::text[]) || '{"purged":true}'::jsonb
    WHERE collection='web_ai_tasks' AND body->>'expireAt'<=$1 AND body->>'purged' IS DISTINCT FROM 'true'`, [at]);
  await pool.query(`UPDATE campus_documents SET body=(body - ARRAY['turns','pendingTurn']::text[]) || '{"purged":true}'::jsonb
    WHERE collection='web_ai_conversations' AND body->>'expireAt'<=$1 AND body->>'purged' IS DISTINCT FROM 'true'`, [at]);
  await pool.query(`UPDATE campus_documents SET body=(body - ARRAY['contentText','summary','autoSummary']::text[]) || '{"status":"withdrawn","aiSearchPurged":true}'::jsonb
    WHERE collection='items' AND body->>'aiSearchExpiresAt'<=$1 AND body->>'aiSearchPurged' IS DISTINCT FROM 'true'`, [at]);
  const { rows } = await pool.query(`SELECT id FROM campus_documents WHERE collection='user_profiles' AND body ? 'aiAssistant'
    ORDER BY coalesce(body->>'aiAssistantCleanupAt',''), id LIMIT 200`);
  const db = postgresStorage(pool);
  for (const { id } of rows) await atomic(db, async tx => {
    const ref = tx.collection('user_profiles').doc(String(id)), row = transactionRow((await ref.get()).data);
    if (!row.aiAssistant || typeof row.aiAssistant !== 'object' || Array.isArray(row.aiAssistant)) return;
    const profiles = { ...row.aiAssistant };
    for (const [schoolId, value] of Object.entries(profiles)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const state = value as Record<string, any>;
      const behavior = state.preferences?.learningEnabled === true && Array.isArray(state.behavior)
        ? state.behavior.filter((e: any) => e && typeof e.at === 'number' && e.at > now - 30 * 86400000 && e.at <= now && typeof e.itemId === 'string' && typeof e.day === 'string' && Array.isArray(e.categories)).slice(-200) : [];
      profiles[schoolId] = { ...state, behavior };
    }
    await ref.update({ aiAssistant: profiles, aiAssistantCleanupAt: at });
  });
  return { profiles: rows.length };
}
