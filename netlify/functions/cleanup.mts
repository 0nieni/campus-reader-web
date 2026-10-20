import { getDatabase } from '@netlify/database';
import {postgresRepository} from '../../apps/cloud/src/postgres-repository';
import {schoolDirectory} from '../../apps/cloud/src/school-directory';
import {warmRecentSchools} from '../../apps/cloud/src/school-warmup';
import type {SqlPool} from '../../apps/cloud/src/postgres-storage';
import {cleanupAssistantData} from '../../apps/cloud/src/assistant-cleanup';
// 18:17 UTC = 02:17 Beijing. Do not wake the sleeping Free database every hour:
// that alone would exceed its shared monthly credits. Reads reject at 24h and
// also purge expired bodies; this daily job handles unattended physical cleanup.
export const config = { schedule: '17 18 * * *' };
export default async () => {
  const start=Date.now(),database=getDatabase();
  await cleanupAssistantData(database.pool as unknown as SqlPool);
  // Reuse this one daily database wake; do not add hourly keepalive/cron work.
  // Prioritize retention cleanup and leave a bounded window for public lists.
  if(Date.now()-start<12000) {
    const pool=database.pool as unknown as SqlPool;
    const directory=schoolDirectory(pool,postgresRepository(pool),undefined,Date.now,{trackActivity:false});
    const result=await warmRecentSchools(pool,directory.refresh);
    console.info(JSON.stringify({event:'public-school-warmup',...result}));
  }
  return new Response(null, { status: 204 });
};
