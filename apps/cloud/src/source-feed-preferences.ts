import type {School} from '@campus/contracts';
import type {SqlPool} from './postgres-storage';
import {schoolSources,publicSourceId} from './school-sources';
import {AppError} from './errors';

/** Display preferences are not access policies and must never enter AI scope. */
export async function hiddenFeedSources(pool:SqlPool,owner:string,schoolId:string):Promise<string[]> {
  const row=(await pool.query("SELECT body->'hiddenFeedSources'->$2::text AS hidden FROM campus_documents WHERE collection='user_profiles' AND id=$1",[owner,schoolId])).rows[0];
  return Array.isArray(row?.hidden)?row.hidden.filter((id:unknown):id is string=>typeof id==='string'):[];
}
async function sourceIds(pool:SqlPool,school:School,owner:string):Promise<string[]> {
  const personal=await pool.query("SELECT id FROM campus_documents WHERE collection='sources' AND body->>'ownerOpenid'=$1 AND body->'schoolIds' ? $2 AND body->>'importKind'='website' AND body->>'deleted' IS DISTINCT FROM 'true' LIMIT 21",[owner,school.id]);
  return [...new Set([...schoolSources(school).sources.map(s=>publicSourceId(school.id,s.key)),...personal.rows.map(row=>String(row.id))])];
}
export async function feedDisplayState(pool:SqlPool,school:School,owner:string){
  const ids=await sourceIds(pool,school,owner),hidden=await hiddenFeedSources(pool,owner,school.id);
  const count=ids.filter(id=>hidden.includes(id)).length;
  return{total:ids.length,shown:ids.length-count,hidden:count};
}
export async function saveAllFeedVisibility(pool:SqlPool,school:School,owner:string,visible:boolean){
  const ids=await sourceIds(pool,school,owner),hidden=visible?[]:ids;
  await pool.query(`INSERT INTO campus_documents(collection,id,body) VALUES('user_profiles',$1,$4::jsonb)
    ON CONFLICT(collection,id) DO UPDATE SET body=campus_documents.body || jsonb_build_object('hiddenFeedSources',
      coalesce(campus_documents.body->'hiddenFeedSources','{}'::jsonb) || jsonb_build_object($2::text,$3::jsonb))`,[owner,school.id,JSON.stringify(hidden),JSON.stringify({_id:owner,hiddenFeedSources:{[school.id]:hidden}})]);
  return{total:ids.length,shown:visible?ids.length:0,hidden:hidden.length};
}
export async function saveFeedVisibility(pool:SqlPool,school:School,owner:string,sourceId:string,visible:boolean) {
  const configured=schoolSources(school).sources.some(source=>publicSourceId(school.id,source.key)===sourceId);
  if(!configured){
    const own=await pool.query("SELECT id FROM campus_documents WHERE collection='sources' AND id=$1 AND body->>'ownerOpenid'=$2 AND body->'schoolIds' ? $3 AND body->>'importKind'='website' AND body->>'deleted' IS DISTINCT FROM 'true'",[sourceId,owner,school.id]);
    if(!own.rows.length)throw new AppError('NOT_FOUND','来源不存在或不属于当前账号和学校。');
  }
  // One atomic field merge preserves other schools, selection, AI memory and
  // simultaneous source updates. Repeated saves do not duplicate source IDs.
  const initial={_id:owner,hiddenFeedSources:{[school.id]:visible?[]:[sourceId]}};
  await pool.query(`INSERT INTO campus_documents(collection,id,body) VALUES('user_profiles',$1,$5::jsonb)
    ON CONFLICT(collection,id) DO UPDATE SET body=campus_documents.body || jsonb_build_object('hiddenFeedSources',
      coalesce(campus_documents.body->'hiddenFeedSources','{}'::jsonb) || jsonb_build_object($2::text,
        CASE WHEN $4::boolean THEN coalesce(campus_documents.body->'hiddenFeedSources'->$2::text,'[]'::jsonb)-$3::text
        ELSE (coalesce(campus_documents.body->'hiddenFeedSources'->$2::text,'[]'::jsonb)-$3::text) || jsonb_build_array($3::text) END))`,[owner,school.id,sourceId,visible,JSON.stringify(initial)]);
  return {visible};
}
