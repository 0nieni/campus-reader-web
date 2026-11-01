import {randomUUID} from 'node:crypto';
import type {SourceCatalogue,SourceCatalogueEntry,SourceCollectionStats,SchoolSourceCatalogue,WebsiteSourceInput} from '@campus/contracts';
import type {SqlPool} from './postgres-storage';
import type {Repository,ItemRow} from './repository';
import type {IdentityContext} from './identity';
import type {websiteSources} from './website-sources';
import type {MaterialArchive} from './material-archive';
import {competitionSources,competitionConfig,type CompetitionSource} from './competition-sources';
import {competitionDirectory,directoryCollectionStatus} from './competition-directory';
import {feedSourceSelection,feedSourceDefinitions} from './source-feed-preferences';
import {noticeSourceAliases} from './school-sources';
import {authorizeSchool,identifier} from './access';
import {AppError} from './errors';
import {hash,parserSource,parseWebsite,websiteUrl} from './website-parser';
import {articleShapedUrl} from './school-pages';
type Readers=Pick<ReturnType<typeof websiteSources>,'publicPage'|'publicDownload'>;
type CollectionSource=Pick<CompetitionSource,'id'|'name'|'entryUrl'|'categories'|'selectors'>;
const iso=(time:number)=>new Date(time).toISOString();
const syncId=(id:string)=>'__competition_'+id;
const manualVersion=(config:WebsiteSourceInput)=>hash(JSON.stringify([config.name,config.entryUrl,config.type,config.categories,config.intervalMinutes,Object.entries(config.selectors).sort(([a],[b])=>a.localeCompare(b)),config.allowAi,config.authorized]));
export function publicSources(pool:SqlPool,repo:Repository,readers:Readers,schoolCatalogue:(id:string,owner:string)=>Promise<SchoolSourceCatalogue>,archive?:MaterialArchive,now=Date.now){
 async function catalogue(schoolId:string,owner:string):Promise<SourceCatalogue>{
  const school=await repo.school(schoolId);if(!school)throw new AppError('SCHOOL_NOT_FOUND','学校不在目录中。');
  const selection=await feedSourceSelection(pool,school,owner),schools=await schoolCatalogue(schoolId,owner);
  const records=await pool.query("SELECT id,body FROM campus_documents WHERE (collection='sources' AND id=ANY($1::text[])) OR (collection='school_sync' AND id=ANY($2::text[]))",[selection.definitions.map(source=>source.id),selection.definitions.filter(source=>source.kind==='public').map(source=>syncId(source.id))]);
  const recordsById=new Map(records.rows.map(row=>[row.id,row.body]));
  const sources:SourceCatalogueEntry[]=selection.definitions.map(definition=>{
   const directory=competitionDirectory.find(source=>source.id===definition.id);
   const schoolSource=schools.sources.find(source=>noticeSourceAliases(schoolId,definition.id).includes(source.id)),publicSource=competitionSources.find(source=>source.id===definition.id),sync=recordsById.get(syncId(definition.id)),stored=recordsById.get(definition.id),record=publicSource||definition.kind==='public'&&sync?.mode==='manual'?sync:stored;
   const manual=definition.kind==='public'&&sync?.mode==='manual';
   const ready=publicSource?record?.version===hash(JSON.stringify(competitionConfig(publicSource))):manual?record?.config&&record.version===manualVersion(record.config):true;
   const state:SourceCatalogueEntry['state']=schoolSource?.state||(ready&&(record?.state==='unavailable'||record?.lastErrorCode)?'unavailable':ready&&record?.lastSuccessAt?'ready':'unchecked');
   const collectionStatus=publicSource?'verified':directory?directoryCollectionStatus(directory):undefined;
   const fallback=publicSource?'接入前已通过列表和正文验证，本环境尚未采集。':collectionStatus==='entry_only'?'已收录原站链接；此入口为单篇通知、文件或需单独适配的页面，暂不自动采集。':directory?'已收录原站链接，公告列表和正文尚待验证，暂不自动采集。':'尚无采集记录。';
   return{...definition,schoolId,showInFeed:selection.shownIds.includes(definition.id),collectable:Boolean(schoolSource||publicSource||manual&&record?.lastSuccessAt&&stored?.enabled!==false||definition.kind==='personal'&&record?.importKind==='website'&&record.enabled!==false),state,checkedAt:schoolSource?.checkedAt||ready&&(record?.checkedAt||record?.lastAttemptAt)||null,count:schoolSource?.count??(ready&&record?.count!==undefined?Number(record.count):null),message:schoolSource?.message||(ready&&record?.message?String(record.message):fallback),...(publicSource?{verifiedAt:publicSource.verifiedAt}:{}),...(directory?{collectionStatus,directory:{number:directory.number,entryType:directory.entryType,note:directory.note}}:{}),nextRefreshAt:record?.retryAt||record?.nextRefreshAt||null,errorCode:record?.lastErrorCode||null};
  });
  return{sources,total:sources.length,shown:selection.shownIds.length,hidden:selection.hiddenIds.length};
 }
 async function collectSource(definition:CollectionSource,owner?:string,manual=false){
  const id=definition.id;let config=competitionConfig(definition);
  if(manual){const url=new URL(websiteUrl(config.entryUrl));if(/\.(rss|xml)$/i.test(url.pathname))config.type='rss';else if(/\.json$/i.test(url.pathname))config.type='json_api';else if(articleShapedUrl(url))config.type='html_detail';}
  const token=randomUUID(),key=syncId(id);
  const prior=(await pool.query("SELECT body FROM campus_documents WHERE collection='sources' AND id=$1",[id])).rows[0]?.body;
  if(prior?.ownerOpenid||prior?.scope==='private')throw new AppError('NOT_FOUND','此来源不在公共采集范围内。');
  if(prior?.enabled===false||prior?.deleted===true)throw new AppError('SOURCE_DISABLED','此公共来源已停用。');
  const lease=await pool.query(`INSERT INTO campus_documents(collection,id,body) VALUES('school_sync',$1,$2::jsonb)
   ON CONFLICT(collection,id) DO UPDATE SET body=campus_documents.body || EXCLUDED.body
   WHERE coalesce(campus_documents.body->>'retryAt','')<=$3 RETURNING id`,[key,JSON.stringify({state:'checking',version:manual?manualVersion(config):hash(JSON.stringify(config)),config,mode:manual?'manual':'reviewed',token,checkedAt:iso(now()),retryAt:iso(now()+90000)}),iso(now())]);
  if(!lease.rows.length)throw new AppError('SOURCE_INTERVAL','该公共来源正在采集或处于冷却期，请按下次采集时间重试。');
  try{
   if(manual&&/\.(pdf|docx?|xlsx?|zip|rar)(?:$|[?#])/i.test(config.entryUrl))throw new AppError('SOURCE_UNSUPPORTED_TYPE','此入口是文件，当前网页更新无法将其识别为公告列表。请查看原站或选择主办方的公告网页。');
   const page=await readers.publicPage(config.entryUrl,config,id,owner);
   if(manual&&!/<a\b/i.test(page.html)&&/<(?:div|main)[^>]+id=["'](?:root|app|__next)["'][^>]*>\s*<\//i.test(page.html))throw new AppError('SOURCE_DYNAMIC_PAGE','此入口依赖动态加载，本次只读到页面外壳，没有取得公告内容。请查看原站或使用可公开读取的公告列表入口。');
   let rows:ReturnType<typeof parseWebsite>;
   try{rows=parseWebsite(page,config,id);}catch(error){if(manual&&error instanceof AppError&&error.code==='SOURCE_PARSE_FAILED')throw new AppError('SOURCE_PARSE_FAILED','当前入口未识别到可读取的公告列表或正文，可能是赛事主页或需要专门适配。请查看原站或联系维护者配置公告栏目。');throw error;}
   const entries=rows.filter(row=>!row.publishedAt||Date.parse(row.publishedAt)>=now()-365*86400000).map(row=>({_id:'publicnotice_'+hash(id+'\n'+row.url),title:row.title,originalUrl:row.url,canonicalUrl:row.url,publishedAt:row.publishedAt,sourceId:id,sourceName:definition.name,scope:'global',schoolIds:['global'],importKind:'public_website',status:'published',categories:definition.categories,aiProcessing:'allow',createdAt:iso(now()),discoveredAt:iso(now())}));
   const client=await pool.connect();
   try{
    await client.query('BEGIN');
    const current=(await client.query("SELECT body FROM campus_documents WHERE collection='school_sync' AND id=$1 FOR UPDATE",[key])).rows[0]?.body;
    const policy=(await client.query("SELECT body FROM campus_documents WHERE collection='sources' AND id=$1 FOR UPDATE",[id])).rows[0]?.body;
    if(current?.token!==token||policy?.enabled===false||policy?.deleted===true||manual&&JSON.stringify(policy??null)!==JSON.stringify(prior??null))throw new AppError('STALE_SOURCE','来源状态已变化，请重试。');
    const existing=entries.length?(await client.query("SELECT id FROM campus_documents WHERE collection='items' AND id=ANY($1::text[])",[entries.map(row=>row._id)])).rows.length:0;
    const stats:SourceCollectionStats={newCount:entries.length-existing,existingCount:existing,failedSources:0,skippedCount:rows.length-entries.length};
    await client.query("INSERT INTO campus_documents(collection,id,body) VALUES('sources',$1,$2::jsonb) ON CONFLICT(collection,id) DO UPDATE SET body=campus_documents.body || EXCLUDED.body",[id,JSON.stringify({_id:id,key:id,name:definition.name,scope:'global',entryUrl:config.entryUrl,config,enabled:true,aiProcessing:'allow',importKind:'public_website',...(manual?{manualRefresh:true}:{})})]);
    if(entries.length)await client.query("INSERT INTO campus_documents(collection,id,body) SELECT 'items',entry->>'_id',entry FROM jsonb_array_elements($1::jsonb) entry ON CONFLICT(collection,id) DO UPDATE SET body=campus_documents.body || (EXCLUDED.body - ARRAY['createdAt','discoveredAt']::text[])",[JSON.stringify(entries)]);
    const message=`本次新增 ${stats.newCount} 条、已有 ${stats.existingCount} 条、跳过过期 ${stats.skippedCount} 条。${manual?'已完成手动更新，未接入定时更新的来源仍需手动更新。':''}`;
    await client.query("UPDATE campus_documents SET body=body || $2::jsonb WHERE collection='school_sync' AND id=$1",[key,JSON.stringify({state:'ready',count:entries.length,checkedAt:iso(now()),lastSuccessAt:iso(now()),lastErrorCode:null,stats,message,retryAt:iso(now()+3600000)})]);
    await client.query('COMMIT');return{count:entries.length,stats,message};
   }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }catch(error){
   await pool.query("UPDATE campus_documents SET body=body || $3::jsonb WHERE collection='school_sync' AND id=$1 AND body->>'token'=$2",[key,token,JSON.stringify({state:'unavailable',checkedAt:iso(now()),lastErrorCode:error instanceof AppError?error.code:'SOURCE_UNAVAILABLE',message:error instanceof AppError?error.message:'本次公开采集未完成，已有公告保留。',retryAt:iso(now()+300000)})]);throw error;
  }
 }
 async function refreshSource(id:string,owner?:string){
  const definition=competitionSources.find(source=>source.id===id);if(!definition)throw new AppError('NOT_FOUND','此来源未通过公共采集验证。');
  return collectSource(definition,owner);
 }
 async function manualRefreshSource(id:string,schoolId:string,owner:string){
  if(competitionSources.some(source=>source.id===id))return refreshSource(id,owner);
  const school=await repo.school(schoolId);if(!school)throw new AppError('SCHOOL_NOT_FOUND','学校不在目录中。');
  // Resolve only an existing public catalogue entry; the browser never supplies fetch URLs or selectors.
  const definition=(await feedSourceDefinitions(pool,school,owner)).find(source=>source.id===id&&source.kind==='public');
  if(!definition?.url)throw new AppError('NOT_FOUND','来源不存在、没有公开入口或不属于当前学校的公共目录。');
  return collectSource({id,name:definition.name,entryUrl:websiteUrl(definition.url),categories:definition.categories},owner,true);
 }
 async function material(row:ItemRow,settings:{force?:boolean;deadline?:number}={}){
  const definition=competitionSources.find(source=>source.id===row.sourceId);
  if(!archive||row.ownerOpenid||row.scope!=='global'||!row.sourceId)throw new AppError('NO_MATERIAL','公共资料来源暂不可读取。');
  const policy=definition?undefined:(await pool.query("SELECT body FROM campus_documents WHERE collection='sources' AND id=$1",[row.sourceId])).rows[0]?.body;
  if(!definition&&(!policy?.manualRefresh||policy.importKind!=='public_website'||policy.ownerOpenid||policy.enabled===false||policy.deleted===true))throw new AppError('NO_MATERIAL','此手动采集来源已停用或暂不可读取。');
  const config:WebsiteSourceInput=definition?competitionConfig(definition):policy.config,source={...parserSource(config,row.sourceId),id:'global'};
  return archive.collect(row,source,url=>readers.publicPage(url,config,row.sourceId!),{...settings,download:url=>readers.publicDownload(url,config,row.sourceId!)});
 }
 async function handle(action:string,input:Record<string,unknown>,identity:IdentityContext){
  const schoolId=identifier(input.schoolId);await authorizeSchool(repo,identity.dataOwnerId,schoolId);
  if(action==='sources.catalogue')return catalogue(schoolId,identity.dataOwnerId);
  if(action==='sources.public.refresh')return manualRefreshSource(identifier(input.sourceId),schoolId,identity.dataOwnerId);
  throw new AppError('ACTION_NOT_ALLOWED','公共来源操作无效。');
 }
 return{handle,catalogue,refreshSource,material,supports:(action:string)=>['sources.catalogue','sources.public.refresh'].includes(action)};
}
