import { getDatabase } from '@netlify/database';
import type {SqlPool} from '../../apps/cloud/src/postgres-storage';
import {cleanupAssistantData} from '../../apps/cloud/src/assistant-cleanup';
import {cleanupReminderData} from '../../apps/cloud/src/reminder-cleanup';
import {cleanupAnonymous} from '../../apps/cloud/src/anonymous-workspace';
import {cleanupMcp} from '../../apps/cloud/src/mcp-cleanup';
// 18:17 UTC = 02:17 Beijing. Do not wake the sleeping Free database every hour:
// that alone would exceed its shared monthly credits. Reads reject at 24h and
// also purge expired bodies; this daily job handles unattended physical cleanup.
export const config = { schedule: '17 18 * * *' };
export default async () => {
  const database=getDatabase();
  await cleanupAssistantData(database.pool as unknown as SqlPool);
  await cleanupReminderData(database.pool as unknown as SqlPool);
  await cleanupAnonymous(database.pool as unknown as SqlPool);
  await cleanupMcp(database.pool as unknown as SqlPool);
  // Public list collection runs in the 02:45 material background job. A rendered
  // fetch must not consume this scheduled function's 30-second cleanup budget.
  return new Response(null, { status: 204 });
};
