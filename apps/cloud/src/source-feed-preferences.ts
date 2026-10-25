import type {School,SourceCatalogueEntry} from '@campus/contracts';
import type {SqlPool} from './postgres-storage';
import {schoolSources,publicSourceId} from './school-sources';
import {competitionSources} from './competition-sources';
import {sourceVisible,type Resource} from './scope';
import {AppError} from './errors';
type Definition=Pick<SourceCatalogueEntry,'id'|'name'|'kind'|'url'|'categories'>;
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
function publicUrl(value:unknown){try{const url=new URL(String(value));return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}}
/** Display preferences never grant access or limit internal AI candidates. */
export async function feedSourceDefinitions(pool:SqlPool,school:School,owner:string):Promise<Definition[]> {
 const definitions=new Map<string,Definition>();
 for(const source of schoolSources(school).sources)definitions.set(publicSourceId(school.id,source.key),{id:publicSourceId(school.id,source.key),name:source.label,kind:'school',url:source.announcementUrl,categories:[/学院|系[ ·]|院系/.test(source.label)?'college':'school']});
 for(const source of competitionSources)definitions.set(source.id,{id:source.id,name:source.name,kind:'public',url:source.entryUrl,categories:source.categories});
 const result=await pool.query("SELECT id,body FROM campus_documents WHERE collection='sources' AND body->>'deleted' IS DISTINCT FROM 'true' AND (coalesce(body->>'ownerOpenid','')='' OR body->>'ownerOpenid'=$1) ORDER BY id LIMIT 2001",[owner]);
 if(result.rows.length>2000)throw new AppError('SOURCE_LIMIT_EXCEEDED','来源目录超过当前读取范围。');
 for(const row of result.rows){
  const resource=row.body as Resource;if(definitions.has(row.id)||!sourceVisible(resource,school.id,owner))continue;
  if(resource.ownerOpenid&&resource.importKind==='website'&&!resource.schoolIds?.includes(school.id))continue;
  const config=object(row.body.config),kind:Definition['kind']=resource.ownerOpenid?'personal':resource.scope==='global'||['ciscn-announcement','lanqiao-competition'].includes(resource.key||'')?'public':resource.scope==='school'||resource.schoolIds?.includes(school.id)||['bjtu-tzgg','bjtu-bksy','bjtu-cs-tzgg'].includes(resource.key||'')?'school':'public';
  const categories=Array.isArray(config.categories)?config.categories:Array.isArray(resource.categories)?resource.categories:kind==='school'?['school']:resource.category==='mail'||resource.key==='mail-inbox'?['mail']:['competition'];
  definitions.set(row.id,{id:row.id,name:String(config.name||row.body.name||row.id),kind,url:publicUrl(config.entryUrl||resource.entryUrl||resource.siteUrl),categories:categories.filter((value):value is string=>typeof value==='string')});
 }
 return [...definitions.values()];
}
export async function feedSourceSelection(pool:SqlPool,school:School,owner:string){
 const definitions=await feedSourceDefinitions(pool,school,owner);
 const row=(await pool.query("SELECT body->'hiddenFeedSources'->$2::text AS hidden,body->'sourceFeedVisibility'->$2::text AS choices FROM campus_documents WHERE collection='user_profiles' AND id=$1",[owner,school.id])).rows[0];
 const hidden=Array.isArray(row?.hidden)?row.hidden:[],choices=object(row?.choices);
 const shownIds=definitions.filter(source=>typeof choices[source.id]==='boolean'?choices[source.id]===true:!hidden.includes(source.id)&&source.kind==='school').map(source=>source.id);
 return{definitions,shownIds,hiddenIds:definitions.filter(source=>!shownIds.includes(source.id)).map(source=>source.id)};
}
export async function hiddenFeedSources(pool:SqlPool,owner:string,schoolId:string):Promise<string[]> {
 const row=(await pool.query("SELECT body FROM campus_documents WHERE collection='schools' AND id=$1",[schoolId])).rows[0]?.body;
 const school:School=row?{...row,id:schoolId}:{id:schoolId,name:schoolId,status:'ready'};
 return(await feedSourceSelection(pool,school,owner)).hiddenIds;
}
export async function feedDisplayState(pool:SqlPool,school:School,owner:string){const selection=await feedSourceSelection(pool,school,owner);return{total:selection.definitions.length,shown:selection.shownIds.length,hidden:selection.hiddenIds.length};}
export async function saveAllFeedVisibility(pool:SqlPool,school:School,owner:string,visible:boolean){
 const definitions=await feedSourceDefinitions(pool,school,owner),ids=definitions.map(source=>source.id),hidden=visible?[]:ids,choices=Object.fromEntries(ids.map(id=>[id,visible]));
 await pool.query("INSERT INTO campus_documents(collection,id,body) VALUES('user_profiles',$1,$5::jsonb) ON CONFLICT(collection,id) DO UPDATE SET body=campus_documents.body || jsonb_build_object('hiddenFeedSources',coalesce(campus_documents.body->'hiddenFeedSources','{}'::jsonb) || jsonb_build_object($2::text,$3::jsonb),'sourceFeedVisibility',coalesce(campus_documents.body->'sourceFeedVisibility','{}'::jsonb) || jsonb_build_object($2::text,$4::jsonb))",[owner,school.id,JSON.stringify(hidden),JSON.stringify(choices),JSON.stringify({_id:owner,hiddenFeedSources:{[school.id]:hidden},sourceFeedVisibility:{[school.id]:choices}})]);
 return{total:ids.length,shown:visible?ids.length:0,hidden:hidden.length};
}
export async function saveFeedVisibility(pool:SqlPool,school:School,owner:string,sourceId:string,visible:boolean){
 if(!(await feedSourceDefinitions(pool,school,owner)).some(source=>source.id===sourceId))throw new AppError('NOT_FOUND','来源不存在或不属于当前账号和学校。');
 const initial={_id:owner,hiddenFeedSources:{[school.id]:visible?[]:[sourceId]},sourceFeedVisibility:{[school.id]:{[sourceId]:visible}}};
 await pool.query("INSERT INTO campus_documents(collection,id,body) VALUES('user_profiles',$1,$5::jsonb) ON CONFLICT(collection,id) DO UPDATE SET body=campus_documents.body || jsonb_build_object('hiddenFeedSources',coalesce(campus_documents.body->'hiddenFeedSources','{}'::jsonb) || jsonb_build_object($2::text,CASE WHEN $4::boolean THEN coalesce(campus_documents.body->'hiddenFeedSources'->$2::text,'[]'::jsonb)-$3::text ELSE (coalesce(campus_documents.body->'hiddenFeedSources'->$2::text,'[]'::jsonb)-$3::text) || jsonb_build_array($3::text) END),'sourceFeedVisibility',coalesce(campus_documents.body->'sourceFeedVisibility','{}'::jsonb) || jsonb_build_object($2::text,coalesce(campus_documents.body->'sourceFeedVisibility'->$2::text,'{}'::jsonb) || jsonb_build_object($3::text,$4::boolean)))",[owner,school.id,sourceId,visible,JSON.stringify(initial)]);
 return{visible};
}
