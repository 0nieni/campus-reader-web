import type {WebsiteSource,WebsiteSourceInput,SourceCollectionStats} from '@campus/contracts';
import type {IdentityContext} from './identity';
import type {Repository,ItemRow} from './repository';
import type {SqlPool,Row} from './postgres-storage';
import {authorizeSchool,identifier} from './access';
import {AppError} from './errors';
import {extractArticle,readSchoolPage,type PageReader} from './school-pages';
import {hash,sourceInput,parserSource,parseWebsite,robotsAllowed,websiteUrl} from './website-parser';
import {hiddenFeedSources} from './source-feed-preferences';
const iso=(at:number)=>new Date(at).toISOString();
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
export function websiteSources(pool:SqlPool,repo:Repository,reader:PageReader=readSchoolPage,now=Date.now,pause=sleep) {
  const record=async(id:string,owner:string,schoolId:string)=>{
    const row=(await pool.query("SELECT body FROM campus_documents WHERE collection='sources' AND id=$1 AND body->>'ownerOpenid'=$2 AND body->'schoolIds' ? $3 AND body->>'importKind'='website' AND body->>'deleted' IS DISTINCT FROM 'true'",[id,owner,schoolId])).rows[0]?.body;
    if(!row)throw new AppError('NOT_FOUND','来源不存在或不属于当前账号和学校。');return row;
  };
  const dto=(row:Row):WebsiteSource=>({...row.config,id:row._id,enabled:row.enabled!==false,lastSuccessAt:row.lastSuccessAt||null,lastAttemptAt:row.lastAttemptAt||null,nextRefreshAt:row.nextRefreshAt||null,lastErrorCode:row.lastErrorCode||null,lastCollection:row.lastCollection||null,message:row.message||'尚未采集',count:Number(row.count||0)});
  async function budget(owner:string) {
    const day=iso(now()+8*3600000).slice(0,10);
    const claimed=await pool.query(`UPDATE campus_documents SET body=body || jsonb_build_object('websiteFetchDay',$2::text,'websiteFetchCount',CASE WHEN body->>'websiteFetchDay'=$2 THEN coalesce((body->>'websiteFetchCount')::int,0)+1 ELSE 1 END)
      WHERE collection='user_profiles' AND id=$1 AND (body->>'websiteFetchDay' IS DISTINCT FROM $2 OR coalesce((body->>'websiteFetchCount')::int,0)<60) RETURNING id`,[owner,day]);
    if(!claimed.rows.length)throw new AppError('SOURCE_DAILY_LIMIT','今天的来源请求（含正文读取）已达60次，请明天再试；不影响已保存公告和阅读额度。');
  }
  async function polite(url:string,source:ReturnType<typeof parserSource>) {
    const key='__website_host_'+hash(new URL(url).hostname);
    for(let attempt=0;attempt<2;attempt++){
      const result=await pool.query(`INSERT INTO campus_documents(collection,id,body) VALUES('school_sync',$1,$2::jsonb)
        ON CONFLICT(collection,id) DO UPDATE SET body=campus_documents.body || EXCLUDED.body WHERE coalesce(campus_documents.body->>'nextAt','')<=$3 RETURNING id`,[key,JSON.stringify({nextAt:iso(now()+1500)}),iso(now())]);
      if(result.rows.length)return reader(url,source);
      if(!attempt)await pause(1550);
    }
    throw new AppError('SOURCE_BUSY','该网站正在采集，请稍后重试。');
  }
  async function page(url:string,config:WebsiteSourceInput,id:string) {
    const source=parserSource(config,id),origin=new URL(config.entryUrl).origin,key='__website_robots_'+hash(origin);
    let cached=(await pool.query("SELECT body FROM campus_documents WHERE collection='school_sync' AND id=$1",[key])).rows[0]?.body;
    if(!cached||cached.expireAt<=iso(now())){
      let text='';try{text=(await polite(origin+'/robots.txt',source)).html;}catch(error){if(!(error instanceof AppError)||error.code!=='SOURCE_NOT_FOUND')throw error;}
      if(text.length>100000)throw new AppError('SOURCE_ROBOTS_BLOCKED','站点采集规则过大，暂不能自动读取。');
      const delays=[...text.matchAll(/^\s*crawl-delay\s*:\s*([\d.]+)/gim)].map(m=>Number(m[1]));
      if(delays.some(delay=>delay>1.5))throw new AppError('SOURCE_ROBOTS_BLOCKED','站点要求更长的采集间隔，当前暂不自动接入。');
      cached={text,expireAt:iso(now()+3600000)};
      await pool.query("INSERT INTO campus_documents(collection,id,body) VALUES('school_sync',$1,$2::jsonb) ON CONFLICT(collection,id) DO UPDATE SET body=EXCLUDED.body",[key,JSON.stringify(cached)]);
    }
    source.allowedPath=target=>robotsAllowed(cached.text,target);
    if(!source.allowedPath(url))throw new AppError('SOURCE_ROBOTS_BLOCKED','该公告路径不允许自动采集，请使用原站。');
    return polite(url,source);
  }
  async function material(row:ItemRow):Promise<ItemRow> {
    if(row.importKind!=='website'||row.contentText?.trim())return row;
    if(!row.ownerOpenid||!row.schoolIds?.[0]||!row.sourceId||!row.originalUrl)return row;
    const source=await record(row.sourceId,row.ownerOpenid,row.schoolIds[0]);
    await budget(row.ownerOpenid);
    const text=extractArticle(await page(websiteUrl(row.originalUrl),source.config,source._id),parserSource(source.config,source._id));
    const patch={contentText:text,updatedAt:iso(now())};
    await pool.query("UPDATE campus_documents SET body=body || $3::jsonb WHERE collection='items' AND id=$1 AND body->>'ownerOpenid'=$2",[row._id,row.ownerOpenid,JSON.stringify(patch)]);
    return{...row,...patch};
  }
  async function handle(action:string,input:Record<string,unknown>,identity:IdentityContext) {
    const owner=identity.dataOwnerId,schoolId=identifier(input.schoolId);await authorizeSchool(repo,owner,schoolId);
    if(action==='sources.list'){
      const rows=await pool.query("SELECT body FROM campus_documents WHERE collection='sources' AND body->>'ownerOpenid'=$1 AND body->'schoolIds' ? $2 AND body->>'importKind'='website' AND body->>'deleted' IS DISTINCT FROM 'true' ORDER BY id LIMIT 21",[owner,schoolId]);
      const hidden=await hiddenFeedSources(pool,owner,schoolId);
      return{sources:rows.rows.map(row=>({...dto(row.body),showInFeed:!hidden.includes(row.body._id)}))};
    }
    if(action==='sources.save'){
      const config=sourceInput(input.source),id=input.sourceId?identifier(input.sourceId):'websource_'+hash(owner+'\n'+schoolId+'\n'+config.entryUrl);
      if(input.sourceId&&(await record(id,owner,schoolId)).config.entryUrl!==config.entryUrl)throw new AppError('VALIDATION_FAILED','修改网址请删除旧来源后重新添加，避免旧公告混入其他站点。');
      const client=await pool.connect();try{
        await client.query('BEGIN');
        await client.query("SELECT id FROM campus_documents WHERE collection='user_profiles' AND id=$1 FOR UPDATE",[owner]);
        const rows=await client.query("SELECT id FROM campus_documents WHERE collection='sources' AND body->>'ownerOpenid'=$1 AND body->>'importKind'='website' AND body->>'deleted' IS DISTINCT FROM 'true' AND id<>$2 LIMIT 20",[owner,id]);
        if(rows.rows.length>=20)throw new AppError('SOURCE_LIMIT','每个账号最多添加20个网站来源，请先移除不使用的来源。');
        const body={_id:id,config,name:config.name,entryUrl:config.entryUrl,type:config.type,categories:config.categories,ownerOpenid:owner,scope:'private',schoolIds:[schoolId],importKind:'website',aiProcessing:config.allowAi?'allow':'import_only',enabled:true,deleted:false,updatedAt:iso(now())};
        await client.query(`INSERT INTO campus_documents(collection,id,body) VALUES('sources',$1,$2::jsonb)
          ON CONFLICT(collection,id) DO UPDATE SET body=campus_documents.body || (EXCLUDED.body - 'enabled')
          || CASE WHEN campus_documents.body->>'deleted'='true' THEN '{"enabled":true}'::jsonb ELSE '{}'::jsonb END`,[id,JSON.stringify(body)]);
        await client.query('COMMIT');return{id};
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    }
    const id=identifier(input.sourceId),source=await record(id,owner,schoolId);
    if(action==='sources.toggle'){
      if(typeof input.enabled!=='boolean')throw new AppError('VALIDATION_FAILED','启用状态无效。');
      await pool.query("UPDATE campus_documents SET body=body || $3::jsonb WHERE collection='sources' AND id=$1 AND body->>'ownerOpenid'=$2",[id,owner,JSON.stringify({enabled:input.enabled})]);return{enabled:input.enabled};
    }
    if(action==='sources.remove'){
      const client=await pool.connect();try{await client.query('BEGIN');
        await client.query("UPDATE campus_documents SET body=body || '{\"deleted\":true,\"enabled\":false,\"aiProcessing\":\"import_only\"}'::jsonb WHERE collection='sources' AND id=$1 AND body->>'ownerOpenid'=$2",[id,owner]);
        await client.query("UPDATE campus_documents SET body=body || '{\"status\":\"withdrawn\"}'::jsonb WHERE collection='items' AND body->>'sourceId'=$1 AND body->>'ownerOpenid'=$2",[id,owner]);
        await client.query('COMMIT');return{removed:true};
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    }
    if(!['sources.test','sources.refresh'].includes(action))throw new AppError('ACTION_NOT_ALLOWED','来源操作无效。');
    if(action==='sources.refresh'&&source.enabled===false)throw new AppError('SOURCE_DISABLED','请先启用该来源。');
    if(action==='sources.refresh'&&source.nextRefreshAt&&source.nextRefreshAt>iso(now()))throw new AppError('SOURCE_INTERVAL','尚未到下次采集时间，请按配置间隔稍后刷新。');
    // A completed test leaves only a short polite gap, not a spurious busy error.
    const gap=Date.parse(source.requestAfter||'')-now();
    if(gap>0&&gap<=1500)await pause(gap+20);
    const lease=await pool.query("UPDATE campus_documents SET body=body || $4::jsonb WHERE collection='sources' AND id=$1 AND body->>'ownerOpenid'=$2 AND coalesce(body->>'requestAfter','')<=$3 RETURNING id",[id,owner,iso(now()),JSON.stringify({requestAfter:iso(now()+30000)})]);
    if(!lease.rows.length)throw new AppError('SOURCE_BUSY','此来源正在检查或采集中，请稍后重试。');
    try{
      await budget(owner);
      const rows=parseWebsite(await page(source.config.entryUrl,source.config,id),source.config,id);
      if(action==='sources.test'){
        await pool.query("UPDATE campus_documents SET body=body || $2::jsonb WHERE collection='sources' AND id=$1",[id,JSON.stringify({lastAttemptAt:iso(now()),lastErrorCode:null})]);
        return{count:rows.length,titles:rows.slice(0,5).map(row=>row.title),message:'连接与列表解析成功，尚未导入；正文在打开详情或预览AI资料时读取。'};
      }
      const entries=rows.filter(row=>!row.publishedAt||Date.parse(row.publishedAt)>=now()-365*86400000).map(row=>({_id:'webnotice_'+hash(id+'\n'+row.url),title:row.title,originalUrl:row.url,canonicalUrl:row.url,publishedAt:row.publishedAt,contentText:row.contentText||'',scope:'private',ownerOpenid:owner,schoolIds:[schoolId],importKind:'website',sourceId:id,sourceName:source.name,status:'published',categories:source.config.categories,aiProcessing:source.aiProcessing,createdAt:iso(now()),discoveredAt:iso(now())}));
      // Serialize writes with source deletion/config changes after network I/O.
      const client=await pool.connect();try{await client.query('BEGIN');
        const latest=(await client.query("SELECT body FROM campus_documents WHERE collection='sources' AND id=$1 FOR UPDATE",[id])).rows[0]?.body;
        if(latest?.deleted||latest?.enabled===false||JSON.stringify(latest?.config)!==JSON.stringify(source.config))throw new AppError('STALE_SOURCE','来源已修改或删除，请重新打开来源管理。');
        const existing=entries.length?(await client.query("SELECT id FROM campus_documents WHERE collection='items' AND id=ANY($1::text[])",[entries.map(row=>row._id)])).rows.length:0;
        const stats:SourceCollectionStats={newCount:entries.length-existing,existingCount:existing,failedSources:0,skippedCount:rows.length-entries.length};
        if(entries.length)await client.query(`INSERT INTO campus_documents(collection,id,body) SELECT 'items',entry->>'_id',entry FROM jsonb_array_elements($1::jsonb) entry
          ON CONFLICT(collection,id) DO UPDATE SET body=campus_documents.body || (EXCLUDED.body - 'contentText' - 'createdAt' - 'discoveredAt') || CASE WHEN length(EXCLUDED.body->>'contentText')>0 THEN jsonb_build_object('contentText',EXCLUDED.body->>'contentText') ELSE '{}'::jsonb END`,[JSON.stringify(entries)]);
        await client.query("UPDATE campus_documents SET body=body || $2::jsonb WHERE collection='sources' AND id=$1",[id,JSON.stringify({lastSuccessAt:iso(now()),lastAttemptAt:iso(now()),lastErrorCode:null,lastCollection:stats,nextRefreshAt:iso(now()+source.config.intervalMinutes*60000),count:entries.length,message:`本次新增 ${stats.newCount} 条、已有 ${stats.existingCount} 条、跳过过期 ${stats.skippedCount} 条；未生成摘要，不扣AI次数。`})]);
        await client.query('COMMIT');return{count:entries.length,stats,message:`本次新增 ${stats.newCount} 条、已有 ${stats.existingCount} 条，失败 0 个来源。可返回公告列表查看。`};
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    }catch(error){
      await pool.query("UPDATE campus_documents SET body=body || $3::jsonb WHERE collection='sources' AND id=$1 AND body->>'ownerOpenid'=$2",[id,owner,JSON.stringify({lastAttemptAt:iso(now()),lastErrorCode:error instanceof AppError?error.code:'SOURCE_UNAVAILABLE',...(action==='sources.refresh'?{lastCollection:{newCount:0,existingCount:0,failedSources:1,skippedCount:0}}:{}),message:error instanceof AppError?error.message:'本次未采集成功，已有公告保留。'})]);throw error;
    }finally{await pool.query("UPDATE campus_documents SET body=body || $2::jsonb WHERE collection='sources' AND id=$1",[id,JSON.stringify({requestAfter:iso(now()+1500)})]);}
  }
  return{handle,material};
}
