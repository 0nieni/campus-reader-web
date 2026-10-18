import type {SqlPool} from './postgres-storage';
import type {SchoolSync} from '@campus/contracts';

/** Daily, bounded work on shared public feeds; never enumerate user profiles. */
export async function warmRecentSchools(pool:SqlPool,refresh:(id:string)=>Promise<SchoolSync>,now=Date.now) {
  const at=new Date(now()).toISOString(),day=new Date(now()+8*3600000).toISOString().slice(0,10);
  const lease=await pool.query(`INSERT INTO campus_documents(collection,id,body) VALUES('school_sync','__daily_public_warm__',$1::jsonb)
    ON CONFLICT(collection,id) DO UPDATE SET body=EXCLUDED.body
    WHERE campus_documents.body->>'warmDay' IS DISTINCT FROM $2 RETURNING id`,[JSON.stringify({warmDay:day,checkedAt:at}),day]);
  if(!lease.rows.length)return {selected:0,ready:0,unavailable:0,skipped:true};
  const candidates=await pool.query(`SELECT sync.id FROM campus_documents sync
    JOIN campus_documents school ON school.collection='schools' AND school.id=sync.id
    WHERE sync.collection='school_sync' AND sync.body->>'lastVisitedAt'>=$1
    AND coalesce(sync.body->>'retryAt','')<$2
    ORDER BY coalesce(sync.body->>'warmAttemptAt','') ASC,sync.body->>'lastVisitedAt' DESC,sync.id LIMIT 3`,[new Date(now()-7*86400000).toISOString(),at]);
  const ids=candidates.rows.map(row=>String(row.id));
  if(ids.length)await pool.query("UPDATE campus_documents SET body=body || $2::jsonb WHERE collection='school_sync' AND id=ANY($1::text[])",[ids,JSON.stringify({warmAttemptAt:at})]);
  const results=await Promise.all(ids.map(async id=>{try{return (await refresh(id)).state;}catch{return 'unavailable';}}));
  return {selected:ids.length,ready:results.filter(value=>value==='ready').length,unavailable:results.filter(value=>value==='unavailable').length,inProgress:results.filter(value=>value==='checking').length,skipped:false};
}
