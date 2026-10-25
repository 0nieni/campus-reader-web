import {randomUUID} from 'node:crypto';
import type {SourceCatalogue,SourceCatalogueEntry,SourceCollectionStats,SchoolSourceCatalogue} from '@campus/contracts';
import type {SqlPool} from './postgres-storage';
import type {Repository,ItemRow} from './repository';
import type {IdentityContext} from './identity';
import type {websiteSources} from './website-sources';
import type {MaterialArchive} from './material-archive';
import {competitionSources,competitionConfig} from './competition-sources';
import {feedSourceSelection} from './source-feed-preferences';
import {authorizeSchool,identifier} from './access';
import {AppError} from './errors';
import {hash,parserSource,parseWebsite} from './website-parser';
type Readers=Pick<ReturnType<typeof websiteSources>,'publicPage'|'publicDownload'>;
const iso=(time:number)=>new Date(time).toISOString();
const syncId=(id:string)=>'__competition_'+id;
export function publicSources(pool:SqlPool,repo:Repository,readers:Readers,schoolCatalogue:(id:string,owner:string)=>Promise<SchoolSourceCatalogue>,archive?:MaterialArchive,now=Date.now){
 async function catalogue(schoolId:string,owner:string):Promise<SourceCatalogue>{
  const school=await repo.school(schoolId);if(!school)throw new AppError('SCHOOL_NOT_FOUND','学校不在目录中。');
  const selection=await feedSourceSelection(pool,school,owner),schools=await schoolCatalogue(schoolId,owner);
  const records=await pool.query("SELECT id,body FROM campus_documents WHERE (collection='sources' AND id=ANY($1::text[])) OR (collection='school_sync' AND id=ANY($2::text[]))",[selection.definitions.map(source=>source.id),competitionSources.map(source=>syncId(source.id))]);
  const recordsById=new Map(records.rows.map(row=>[row.id,row.body]));
  const sources:SourceCatalogueEntry[]=selection.definitions.map(definition=>{
   const schoolSource=schools.sources.find(source=>source.id===definition.id),publicSource=competitionSources.find(source=>source.id===definition.id),record=recordsById.get(publicSource?syncId(definition.id):definition.id);
   const ready=publicSource?record?.version===hash(JSON.stringify(competitionConfig(publicSource))):true;
   const state:SourceCatalogueEntry['state']=schoolSource?.state||(ready&&(record?.state==='unavailable'||record?.lastErrorCode)?'unavailable':ready&&record?.lastSuccessAt?'ready':'unchecked');
   return{...definition,schoolId,showInFeed:selection.shownIds.includes(definition.id),collectable:Boolean(schoolSource||publicSource||definition.kind==='personal'&&record?.importKind==='website'&&record.enabled!==false),state,checkedAt:schoolSource?.checkedAt||ready&&(record?.checkedAt||record?.lastAttemptAt)||null,count:schoolSource?.count??(ready&&record?.count!==undefined?Number(record.count):null),message:schoolSource?.message||(ready&&record?.message?String(record.message):publicSource?'接入前已通过列表和正文验证，本环境尚未采集。':'尚无采集记录。'),...(publicSource?{verifiedAt:publicSource.verifiedAt}:{}),nextRefreshAt:record?.retryAt||record?.nextRefreshAt||null,errorCode:record?.lastErrorCode||null};
  });
  return{sources,total:sources.length,shown:selection.shownIds.length,hidden:selection.hiddenIds.length};
 }
 async function refreshSource(id:string,owner?:string){
  const definition=competitionSources.find(source=>source.id===id);if(!definition)throw new AppError('NOT_FOUND','此来源未通过公共采集验证。');
  const config=competitionConfig(definition),version=hash(JSON.stringify(config)),token=randomUUID(),key=syncId(id);
  const prior=(await pool.query("SELECT body FROM campus_documents WHERE collection='sources' AND id=$1",[id])).rows[0]?.body;
  if(prior?.enabled===false||prior?.deleted===true)throw new AppError('SOURCE_DISABLED','此公共来源已停用。');
  const lease=await pool.query(`INSERT INTO campus_documents(collection,id,body) VALUES('school_sync',$1,$2::jsonb)
   ON CONFLICT(collection,id) DO UPDATE SET body=campus_documents.body || EXCLUDED.body
   WHERE coalesce(campus_documents.body->>'retryAt','')<=$3 RETURNING id`,[key,JSON.stringify({state:'checking',version,token,checkedAt:iso(now()),retryAt:iso(now()+90000)}),iso(now())]);
  if(!lease.rows.length)throw new AppError('SOURCE_INTERVAL','该公共来源正在采集或处于冷却期，请按下次采集时间重试。');
  try{
   const rows=parseWebsite(await readers.publicPage(config.entryUrl,config,id,owner),config,id);
   const entries=rows.filter(row=>!row.publishedAt||Date.parse(row.publishedAt)>=now()-365*86400000).map(row=>({_id:'publicnotice_'+hash(id+'\n'+row.url),title:row.title,originalUrl:row.url,canonicalUrl:row.url,publishedAt:row.publishedAt,sourceId:id,sourceName:definition.name,scope:'global',schoolIds:['global'],importKind:'public_website',status:'published',categories:definition.categories,aiProcessing:'allow',createdAt:iso(now()),discoveredAt:iso(now())}));
   const client=await pool.connect();
   try{
    await client.query('BEGIN');
    const current=(await client.query("SELECT body FROM campus_documents WHERE collection='school_sync' AND id=$1 FOR UPDATE",[key])).rows[0]?.body;
    const policy=(await client.query("SELECT body FROM campus_documents WHERE collection='sources' AND id=$1 FOR UPDATE",[id])).rows[0]?.body;
    if(current?.token!==token||policy?.enabled===false||policy?.deleted===true)throw new AppError('STALE_SOURCE','来源状态已变化，请重试。');
    const existing=entries.length?(await client.query("SELECT id FROM campus_documents WHERE collection='items' AND id=ANY($1::text[])",[entries.map(row=>row._id)])).rows.length:0;
    const stats:SourceCollectionStats={newCount:entries.length-existing,existingCount:existing,failedSources:0,skippedCount:rows.length-entries.length};
    await client.query("INSERT INTO campus_documents(collection,id,body) VALUES('sources',$1,$2::jsonb) ON CONFLICT(collection,id) DO UPDATE SET body=campus_documents.body || EXCLUDED.body",[id,JSON.stringify({_id:id,key:id,name:definition.name,scope:'global',entryUrl:config.entryUrl,config,enabled:true,aiProcessing:'allow',importKind:'public_website'})]);
    if(entries.length)await client.query("INSERT INTO campus_documents(collection,id,body) SELECT 'items',entry->>'_id',entry FROM jsonb_array_elements($1::jsonb) entry ON CONFLICT(collection,id) DO UPDATE SET body=campus_documents.body || (EXCLUDED.body - ARRAY['createdAt','discoveredAt']::text[])",[JSON.stringify(entries)]);
    const message=`本次新增 ${stats.newCount} 条、已有 ${stats.existingCount} 条、跳过过期 ${stats.skippedCount} 条。`;
    await client.query("UPDATE campus_documents SET body=body || $2::jsonb WHERE collection='school_sync' AND id=$1",[key,JSON.stringify({state:'ready',count:entries.length,checkedAt:iso(now()),lastSuccessAt:iso(now()),lastErrorCode:null,stats,message,retryAt:iso(now()+3600000)})]);
    await client.query('COMMIT');return{count:entries.length,stats,message};
   }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }catch(error){
   await pool.query("UPDATE campus_documents SET body=body || $3::jsonb WHERE collection='school_sync' AND id=$1 AND body->>'token'=$2",[key,token,JSON.stringify({state:'unavailable',checkedAt:iso(now()),lastErrorCode:error instanceof AppError?error.code:'SOURCE_UNAVAILABLE',message:error instanceof AppError?error.message:'本次公开采集未完成，已有公告保留。',retryAt:iso(now()+300000)})]);throw error;
  }
 }
 async function material(row:ItemRow,settings:{force?:boolean;deadline?:number}={}){
  const definition=competitionSources.find(source=>source.id===row.sourceId);
  if(!archive||!definition||row.ownerOpenid||row.scope!=='global')throw new AppError('NO_MATERIAL','公共资料来源暂不可读取。');
  const config=competitionConfig(definition),source={...parserSource(config,definition.id),id:'global'};
  return archive.collect(row,source,url=>readers.publicPage(url,config,definition.id),{...settings,download:url=>readers.publicDownload(url,config,definition.id)});
 }
 async function handle(action:string,input:Record<string,unknown>,identity:IdentityContext){
  const schoolId=identifier(input.schoolId);await authorizeSchool(repo,identity.dataOwnerId,schoolId);
  if(action==='sources.catalogue')return catalogue(schoolId,identity.dataOwnerId);
  if(action==='sources.public.refresh')return refreshSource(identifier(input.sourceId),identity.dataOwnerId);
  throw new AppError('ACTION_NOT_ALLOWED','公共来源操作无效。');
 }
 return{handle,catalogue,refreshSource,material,supports:(action:string)=>['sources.catalogue','sources.public.refresh'].includes(action)};
}
