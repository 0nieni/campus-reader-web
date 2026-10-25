import {createHash} from 'node:crypto';
import type { SchoolSync, SchoolSourceCatalogue } from '@campus/contracts';
import type { SqlPool } from './postgres-storage';
import type { ItemRow, Repository } from './repository';
import { readSchoolPage, extractNotices, extractArticle, PARSER_VERSION, type PageReader } from './school-pages';
import {schoolSources,publicSourceId} from './school-sources';
import { AppError } from './errors';
import {hiddenFeedSources} from './source-feed-preferences';

export function schoolDirectory(pool: SqlPool, repo: Repository, reader: PageReader = readSchoolPage, now = Date.now, options:{trackActivity?:boolean;archive?:import('./material-archive').MaterialArchive}={}) {
  const configVersion=(config:ReturnType<typeof schoolSources>)=>createHash('sha256').update(PARSER_VERSION+JSON.stringify(config)).digest('hex');
  async function sources(id:string,owner?:string):Promise<SchoolSourceCatalogue> {
    const school=await repo.school(id);
    if(!school)throw new AppError('SCHOOL_NOT_FOUND','学校不在目录中，请重新选择。');
    const config=schoolSources(school);
    const hidden=owner?await hiddenFeedSources(pool,owner,id):[];
    const cached=(await pool.query("SELECT body FROM campus_documents WHERE collection='school_sync' AND id=$1",[id])).rows[0]?.body;
    const checked=Boolean(cached && cached.version===configVersion(config) && ['ready','unavailable'].includes(cached.state) && typeof cached.checkedAt==='string' && Number.isFinite(Date.parse(cached.checkedAt)));
    return {school,coverage:config.note,sources:config.sources.map(source=>{
      const record=checked && Array.isArray(cached.sources)?cached.sources.find((row:Record<string,unknown>)=>row.url===source.announcementUrl && row.name===source.label):undefined;
      const state=record?.state==='ready'?'ready':record?.state==='unavailable'?'unavailable':'unchecked';
      return {id:publicSourceId(id,source.key),showInFeed:!hidden.includes(publicSourceId(id,source.key)),name:source.label,url:source.announcementUrl,state,checkedAt:state==='unchecked'?null:cached.checkedAt,count:state==='unchecked'?null:Number(record.count||0),message:state==='unchecked'?'尚未检查，已配置不代表实时可读取。':String(record.message||'请以原站实际状态为准。'),...(record?{errorCode:record.errorCode||null,stats:record.stats,nextRefreshAt:cached.retryAt||null}:{})};
    })};
  }
  async function configuration(id:string) {
    const school=await repo.school(id);
    if(!school?.homepage)throw new AppError('SOURCE_UNAVAILABLE','此学校尚未配置公开公告入口。');
    const config=schoolSources(school);
    if(!config.sources.length)throw new AppError('SOURCE_UNAVAILABLE','此学校尚未配置公开公告入口。');
    return config;
  }
  async function refresh(id: string): Promise<SchoolSync> {
    const config=await configuration(id),at=new Date(now()).toISOString();
    const version=configVersion(config);
    // An active lease cannot be stolen by another deployment version. Completed
    // old configuration caches are refreshed once after a source/parser update.
    const lease=await pool.query(`INSERT INTO campus_documents(collection,id,body) VALUES('school_sync',$1,$2::jsonb)
      ON CONFLICT(collection,id) DO UPDATE SET body=campus_documents.body || EXCLUDED.body
      WHERE coalesce(campus_documents.body->>'retryAt','')<$3
      OR (campus_documents.body->>'version' IS DISTINCT FROM $4 AND campus_documents.body->>'state' IS DISTINCT FROM 'checking') RETURNING body`,
      [id,JSON.stringify({state:'checking',version,retryAt:new Date(now()+5*60000).toISOString(),checkedAt:at,...(options.trackActivity===false?{}:{lastVisitedAt:at})}),at,version]);
    if(!lease.rows.length) {
      // Aggregate school activity only, no account IDs or visit history. A warm
      // job must never keep its own school eligible for future warming.
      if(options.trackActivity!==false)await pool.query(`UPDATE campus_documents SET body=body || $2::jsonb WHERE collection='school_sync' AND id=$1
        AND coalesce(body->>'lastVisitedAt','')<$3`,[id,JSON.stringify({lastVisitedAt:at}),new Date(now()-30*60000).toISOString()]);
      const cached=await pool.query("SELECT body FROM campus_documents WHERE collection='school_sync' AND id=$1",[id]);
      const body=cached.rows[0]?.body || {};
      return {state:body.state==='ready'?'ready':body.state==='unavailable'?'unavailable':'checking',count:Number(body.count||0),checkedAt:body.checkedAt||null,changed:false,message:body.state==='checking'?'正在更新学校公开来源，已有公告仍可阅读。':body.message||'正在读取学校公开页面，请稍后刷新。',coverage:config.note,...(body.stats?{stats:body.stats}:{}),...(Array.isArray(body.sources)?{sources:body.sources}:{})};
    }
    // At most three reviewed public columns per selected school; no crawl of all
    // schools at login. A failed column never discards another column's results.
    const outcomes=await Promise.all(config.sources.map(async source=>{
      try {const rows=extractNotices(await reader(source.announcementUrl,source),source);
        if(!rows.length)throw new AppError('SOURCE_PARSE_FAILED','未识别到公开公告列表，入口可能已调整或需要人工适配。');
        return {source,rows,message:'列表可读取；正文在打开详情时验证。',errorCode:null};
      }catch(error){return {source,rows:[],message:error instanceof AppError?error.message:'学校公开页面暂时无法连接，保留已有公告。',errorCode:error instanceof AppError?error.code:'SOURCE_UNAVAILABLE'};}
    }));
    const allIds=[...new Set(outcomes.flatMap(o=>o.rows.map(row=>row.id)))];
    const known=new Set(allIds.length?(await pool.query("SELECT id FROM campus_documents WHERE collection='items' AND id=ANY($1::text[])",[allIds])).rows.map(row=>row.id):[]);
    const sources:NonNullable<SchoolSync['sources']>=outcomes.map(o=>({name:o.source.label,url:o.source.announcementUrl,state:o.rows.length?'ready':'unavailable',count:o.rows.length,message:o.message,errorCode:o.errorCode,stats:{newCount:o.rows.filter(row=>!known.has(row.id)).length,existingCount:o.rows.filter(row=>known.has(row.id)).length,failedSources:o.rows.length?0:1,skippedCount:0}}));
    const items=new Map<string,Record<string,unknown>>();const sourceBodies:Record<string,unknown>[]=[];
    for(const outcome of outcomes) {
      if(!outcome.rows.length)continue;
      const source=outcome.source,sourceId=publicSourceId(id,source.key),name=`${source.name} · ${source.label}`;
      sourceBodies.push({_id:sourceId,key:sourceId,name,scope:'school',schoolIds:[id],aiProcessing:'allow',entryUrl:source.announcementUrl});
      for(const row of outcome.rows)if(!items.has(row.id))items.set(row.id,{_id:row.id,title:row.title,originalUrl:row.url,canonicalUrl:row.url,publishedAt:row.publishedAt,status:'published',scope:'school',schoolIds:[id],sourceId,sourceName:name,aiProcessing:'allow',categories:[/竞赛|比赛|大赛/.test(row.title)?'competition':/奖学金|助学金|奖助学/.test(row.title)?'scholarship':/讲座|研讨会|论坛/.test(row.title)?'academic':/活动|报名/.test(row.title)?'activity':'school'],discoveredAt:at,createdAt:at});
    }
    // Two bounded bulk writes replace up to ninety sequential database requests.
    // Preserve cached bodies, original discovery dates and separate personal labels.
    if(sourceBodies.length)await pool.query(`INSERT INTO campus_documents(collection,id,body) SELECT 'sources',entry->>'_id',entry FROM jsonb_array_elements($1::jsonb) entry
      ON CONFLICT(collection,id) DO UPDATE SET body=EXCLUDED.body`,[JSON.stringify(sourceBodies)]);
    let changed=false;
    if(items.size){const writes=await pool.query(`INSERT INTO campus_documents(collection,id,body) SELECT 'items',entry->>'_id',entry FROM jsonb_array_elements($1::jsonb) entry
      ON CONFLICT(collection,id) DO UPDATE SET body=campus_documents.body || (EXCLUDED.body - 'discoveredAt' - 'createdAt')
      WHERE campus_documents.body IS DISTINCT FROM campus_documents.body || (EXCLUDED.body - 'discoveredAt' - 'createdAt') RETURNING id`,[JSON.stringify([...items.values()])]);changed=writes.rows.length>0;}
    const recent=[...items.values()].filter(row=>typeof row.publishedAt==='string' && Date.parse(row.publishedAt)>=now()-365*86400000).length;
    const undated=[...items.values()].filter(row=>!row.publishedAt).length;
    const ready=sources.filter(s=>s.state==='ready').length;
    if(ready)await pool.query("UPDATE campus_documents SET body=body || '{\"status\":\"ready\"}'::jsonb WHERE collection='schools' AND id=$1",[id]);
    const stats={newCount:[...items.keys()].filter(key=>!known.has(key)).length,existingCount:[...items.keys()].filter(key=>known.has(key)).length,failedSources:sources.length-ready,skippedCount:0};
    const result:SchoolSync={state:ready?'ready':'unavailable',count:items.size,checkedAt:at,changed,coverage:config.note,sources,stats,
      message:ready?`已读取 ${ready}/${sources.length} 个栏目，共 ${items.size} 条公告（近一年已标注日期 ${recent} 条，日期不完整 ${undated} 条）。${ready<sources.length?'部分栏目暂不可用。':''}列表缓存一小时；正文按需读取，图片和附件不自动识别。`:'本次栏目均未读取成功，保留已有公告。请查看下方来源状态或学校原站。'};
    await pool.query("UPDATE campus_documents SET body=body || $2::jsonb WHERE collection='school_sync' AND id=$1 AND body->>'version'=$3",[id,JSON.stringify({...result,retryAt:new Date(now()+(ready?3600000:5*60000)).toISOString()}),version]);
    return result;
  }
  async function material(row: ItemRow): Promise<ItemRow> {
    if(options.archive&&row.sourceId?.startsWith('directory_')){
      const source=await materialSource(row);if(source)return options.archive.collect(row,source,reader,{deadline:now()+18000});
    }
    if(row.contentText?.trim()||!row.sourceId?.startsWith('directory_'))return row;
    const id=row.schoolIds?.[0];
    if(!id||row.scope!=='school'||row.ownerOpenid||!row.originalUrl)return row;
    const config=await configuration(id),source=config.sources.find(s=>publicSourceId(id,s.key)===row.sourceId);
    if(!source)return row;
    const lease=await pool.query(`UPDATE campus_documents SET body=body || $2::jsonb WHERE collection='items' AND id=$1
      AND coalesce(body->>'materialRetryAt','')<$3 RETURNING body`,[row._id,JSON.stringify({materialRetryAt:new Date(now()+5*60000).toISOString()}),new Date(now()).toISOString()]);
    if(!lease.rows.length) {const cached=await repo.item(row._id);if(cached?.contentText)return cached;throw new AppError('NO_MATERIAL','此公告正文正在读取或暂时无法读取，请稍后查看原文。');}
    const text=extractArticle(await reader(row.originalUrl,source),source),patch={contentText:text,updatedAt:new Date(now()).toISOString()};
    await pool.query("UPDATE campus_documents SET body=body || $2::jsonb WHERE collection='items' AND id=$1",[row._id,JSON.stringify(patch)]);
    return {...row,...patch};
  }
  async function materialSource(row:ItemRow){const id=row.schoolIds?.[0];if(!id)return null;return(await configuration(id)).sources.find(s=>publicSourceId(id,s.key)===row.sourceId)||null;}
  return {refresh,material,materialSource,sources};
}
