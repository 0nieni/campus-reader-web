import {createHash,randomUUID} from 'node:crypto';
import type {NoticeBrief} from '../../../packages/contracts/src/notice-brief';
import type {SqlPool,SqlClient,Row} from './postgres-storage';
import type {ItemRow} from './repository';
import {isPrivate,sourceVisible,itemVisible} from './scope';
import {AppError} from './errors';
import {prepareBrief,validateBrief,canonicalBriefBody,briefHash,briefPublicationDay,BRIEF_GUIDE,BRIEF_SCHEMA,BRIEF_PROMPT,BRIEF_PARSER} from './notice-brief';
import type {CompletionResult,Connection} from './model-provider';
import {noticeBriefBackfill,type BriefArticleReader} from './notice-brief-backfill';
const iso=(at:number)=>new Date(at).toISOString(),day=(at:number)=>iso(at+8*3600000).slice(0,10);
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const year=365*86400000;
interface Options {
 scope:string;enabled():boolean;model():{connection:Connection;endpoint:string}|null;
 complete(connection:Connection,guide:string,content:string,maxTokens:number,endpoint:string):Promise<CompletionResult>;
 now?:()=>number;dailyCalls?:number;dailyTokens?:number;dailyArticleReads?:number;dispatch?:()=>Promise<void>;article?:BriefArticleReader;
}
export function noticeBriefJobs(pool:SqlPool,options:Options){
 const now=options.now||Date.now,scope=options.scope,callLimit=Math.min(100,Math.max(0,options.dailyCalls??100)),tokenLimit=Math.min(10000000,Math.max(0,options.dailyTokens??1000000));
 async function tx<T>(work:(client:SqlClient)=>Promise<T>){const client=await pool.connect();try{await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='10000'");const result=await work(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}}
 function modelSignature(){const config=options.model();return config?briefHash([config.connection.provider,config.connection.model,config.endpoint,config.connection.protocol,BRIEF_PROMPT]):null;}
 async function current(sql:Pick<SqlPool,'query'>,id:string,school:string,lock=false,requireBody=true){
  const item=(await sql.query("SELECT body FROM campus_documents WHERE collection='items' AND id=$1"+(lock?' FOR SHARE':''),[id])).rows[0]?.body as ItemRow|undefined;
  if(!item||item.status!=='published'||isPrivate(item)||item.aiSearchExpiresAt||item.aiProcessing==='import_only'||(item as any).allowAi===false||requireBody&&!item.contentText||item.materialExpiresAt&&Date.parse(item.materialExpiresAt)<=now())return null;
  const stamp=Date.parse(item.publishedAt||item.discoveredAt||item.createdAt||'');if(!Number.isFinite(stamp)||stamp<now()-year)return null;
  const ids=[...new Set([item.sourceId,...(item.sourceIds||[])].filter((id):id is string=>Boolean(id)))].sort();if(!ids.length)return null;
  const policies=(await sql.query("SELECT id,body FROM campus_documents WHERE collection='sources' AND id=ANY($1::text[]) ORDER BY id"+(lock?' FOR SHARE':''),[ids])).rows;
  if(policies.length!==ids.length||policies.some(row=>isPrivate(row.body)||row.body.enabled===false||row.body.deleted===true||row.body.aiProcessing==='import_only'||row.body.allowAi===false||!sourceVisible(row.body,school,'')))return null;
  if(!itemVisible(item,{schoolId:school,ownerId:'',publicSourceIds:ids,privateSourceIds:[]}))return null;
  const policy=policies.map(row=>[row.id,row.body.scope,row.body.schoolIds,row.body.enabled,row.body.deleted,row.body.aiProcessing,row.body.allowAi]);
  const signature=briefHash([item.title,item.publishedAt,item.status,item.scope,item.schoolIds,item.sourceId,ids,item.originalUrl,item.aiProcessing,(item as any).allowAi,policy,BRIEF_SCHEMA,BRIEF_PARSER,BRIEF_PROMPT]);
  return{item:{...item,_id:id},signature,sourceId:item.sourceId!};
 }
 // Fingerprints and task IDs use the same canonical article; appended archive
 // attachment text stays outside that fingerprint and never enters the model.
 const matches=(value:Awaited<ReturnType<typeof current>>,job:Row)=>{if(!value||value.signature!==job.signature)return false;const body=canonicalBriefBody(value.item.contentText!),tail=body.slice(job.raw_length);return body.length>=job.raw_length&&hash(body.slice(0,job.raw_length))===job.raw_hash&&(!tail||tail.startsWith('\n## 附件：'));};
 // A small model verification budget must not stop at the first failed pages.
 const readLimit=Math.min(100,Math.max(0,options.dailyArticleReads??100));
 const backfill=options.article?noticeBriefBackfill(pool,{scope,now,readLimit,article:options.article,enabled:()=>options.enabled()&&Boolean(options.model()),
  capacity:async()=>{
   if(!callLimit||!tokenLimit)return false;
   const budget=(await pool.query('SELECT * FROM campus_notice_brief_budget WHERE store_scope=$1 AND day=$2',[scope,day(now())])).rows[0];
   if(budget&&(budget.attempts>=callLimit||Number(budget.held_tokens)+Number(budget.used_tokens)>=tokenLimit))return false;
   return Number((await pool.query("SELECT count(*) AS count FROM campus_notice_briefs WHERE store_scope=$1 AND state IN ('pending','running') AND expires_at>$2",[scope,iso(now())])).rows[0].count)<Math.min(200,callLimit-Number(budget?.attempts||0));
  },eligible:async(id,school)=>(await current(pool,id,school,false,false))?.item||null,
  known:async(row,school)=>{const value=await current(pool,row._id,school);if(!value)return false;return(await pool.query('SELECT * FROM campus_notice_briefs WHERE store_scope=$1 AND item_id=$2 ORDER BY created_at DESC LIMIT 8',[scope,row._id])).rows.some(job=>matches(value,job)&&Date.parse(job.expires_at)>now());},enqueue}):null;
 async function enqueue(row:ItemRow,school:string,body:string){
  if(!options.enabled()||!options.model()||isPrivate(row))return false;
  const latest=await current(pool,row._id,school);if(!latest||!latest.item.contentText!.startsWith(body))return false;
  const canonical=canonicalBriefBody(body),fingerprint=hash(canonical),length=canonical.length;
  let prepared:ReturnType<typeof prepareBrief>;try{prepared=prepareBrief(body);}catch(error){if(!(error instanceof AppError))throw error;await pool.query("INSERT INTO campus_notice_briefs(id,store_scope,item_id,school_id,source_id,signature,content_hash,raw_hash,raw_length,input,state,message,available_at,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'{}','unavailable',$10,$11,$11,$12) ON CONFLICT DO NOTHING",[briefHash([scope,row._id,school,latest.signature,fingerprint]),scope,row._id,school,latest.sourceId,latest.signature,fingerprint,fingerprint,length,error.message,iso(now()),latest.item.materialExpiresAt||iso(now()+year)]);return false;}
  const id=briefHash([scope,row._id,school,latest.signature,prepared.contentHash]);
  const inserted=await tx(async sql=>{
   await sql.query("INSERT INTO campus_notice_brief_workers(store_scope) VALUES($1) ON CONFLICT DO NOTHING",[scope]);
   await sql.query('SELECT store_scope FROM campus_notice_brief_workers WHERE store_scope=$1 FOR UPDATE',[scope]);
   const count=Number((await sql.query("SELECT count(*) AS count FROM campus_notice_briefs WHERE store_scope=$1 AND state IN ('pending','running') AND expires_at>$2",[scope,iso(now())])).rows[0].count);if(count>=200)return false;
   if(!matches(await current(sql,row._id,school,true),{signature:latest.signature,raw_length:length,raw_hash:fingerprint}))return false;
   const budget=(await sql.query('SELECT * FROM campus_notice_brief_budget WHERE store_scope=$1 AND day=$2',[scope,day(now())])).rows[0],defer=budget&&(budget.attempts>=callLimit||Number(budget.held_tokens)+Number(budget.used_tokens)>=tokenLimit);
   const result=await sql.query("INSERT INTO campus_notice_briefs(id,store_scope,item_id,school_id,source_id,signature,content_hash,raw_hash,raw_length,input,state,available_at,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'pending',$11,$12,$13) ON CONFLICT DO NOTHING RETURNING id",[id,scope,row._id,school,latest.sourceId,latest.signature,prepared.contentHash,fingerprint,length,JSON.stringify(prepared),defer?iso(Date.parse(day(now())+'T00:00:00+08:00')+86400000):iso(now()),iso(now()),latest.item.materialExpiresAt||iso(now()+year)]);return result.rows.length>0;
  });
  if(inserted)await wake();return inserted;
 }
 async function wake(){
  if(!options.enabled()||!options.dispatch)return;
  const historyDue=backfill?await backfill.due():false;
  await pool.query('INSERT INTO campus_notice_brief_workers(store_scope) VALUES($1) ON CONFLICT DO NOTHING',[scope]);
  const due=(await pool.query("UPDATE campus_notice_brief_workers SET dispatch_after=$2 WHERE store_scope=$1 AND dispatch_after<=$3 AND (EXISTS(SELECT 1 FROM campus_notice_briefs WHERE store_scope=$1 AND state='pending' AND available_at<=$3 AND expires_at>$3) OR $4::boolean) RETURNING store_scope",[scope,iso(now()+60000),iso(now()),historyDue])).rows.length;
  if(due)await options.dispatch().catch(()=>{}); // durable queue survives dispatcher failure
 }
 async function get(row:ItemRow,school:string):Promise<NoticeBrief>{
  const base={checkedAt:iso(now()),attachmentsRead:false as const},latest=await current(pool,row._id,school);
  if(!latest)return{...base,state:'unavailable',message:'此来源或正文暂不允许自动摘要，请阅读原文。'};
  const jobs=(await pool.query('SELECT * FROM campus_notice_briefs WHERE store_scope=$1 AND item_id=$2 ORDER BY created_at DESC LIMIT 8',[scope,row._id])).rows;
  const job=jobs.find(job=>matches(latest,job)&&Date.parse(job.expires_at)>now());
  if(!job)return{...base,state:jobs.length?'stale':'unavailable',message:jobs.length?'正文或来源已更新，原摘要已失效，等待后台按独立额度重新整理。':!options.enabled()?'自动摘要尚未启用，可继续阅读正文。':!options.model()?'自动摘要模型尚未配置，可继续阅读正文。':'此公告尚无自动摘要，后台将按独立额度逐步补齐，可先阅读正文。'};
  const metadata={contentHash:job.content_hash,schemaVersion:BRIEF_SCHEMA};
  if(!matches(await current(pool,row._id,school),job))return{...base,state:'stale',message:'正文或来源许可已变化，请重新读取原文。'};
  if(job.state==='ready')return{...base,...metadata,state:'ready',content:job.result,generatedAt:new Date(job.generated_at).toISOString()};
  if(job.state==='pending'||job.state==='running')return{...base,...metadata,state:'pending',message:job.message||'摘要正在整理，可先阅读正文。'};
  return{...base,...metadata,state:job.state==='stale'?'stale':job.state==='unavailable'?'unavailable':'failed',message:job.message||'摘要暂未完成，可先阅读正文。'};
 }
 async function settle(sql:SqlClient,job:Row,total:number,usage?:CompletionResult['usage']){
  if(job.quota_settled)return;
  await sql.query('UPDATE campus_notice_brief_budget SET held_tokens=GREATEST(0,held_tokens-$3),used_tokens=used_tokens+$4 WHERE store_scope=$1 AND day=$2',[scope,job.quota_day,job.reserved_tokens,total]);
  await sql.query('UPDATE campus_notice_briefs SET quota_settled=true,usage=$2::jsonb WHERE id=$1',[job.id,JSON.stringify(usage||{reservedTokens:total,usageUnknown:true})]);
 }
 async function run(deadline=now()+12*60000){
  if(!options.enabled()||!options.model())return{processed:0,more:false};
  const worker=randomUUID();await pool.query('INSERT INTO campus_notice_brief_workers(store_scope) VALUES($1) ON CONFLICT DO NOTHING',[scope]);
  const acquired=(await pool.query('UPDATE campus_notice_brief_workers SET lease_id=$2,lease_until=$3 WHERE store_scope=$1 AND lease_until<=$4 RETURNING store_scope',[scope,worker,iso(now()+14*60000),iso(now())])).rows.length;if(!acquired)return{processed:0,more:false};
  let processed=0,more=false;
  try{
   // A crashed call has an unknown billing result; never reclaim it for sending.
   await tx(async sql=>{const expired=(await sql.query("SELECT * FROM campus_notice_briefs WHERE store_scope=$1 AND state='running' AND lease_until<=$2 FOR UPDATE",[scope,iso(now())])).rows;for(const job of expired){await settle(sql,job,job.reserved_tokens);await sql.query("UPDATE campus_notice_briefs SET state='uncertain',input='{}',error_code='MODEL_UNCERTAIN',message='上次请求结果不明，已停止自动重试，请先核查服务商用量。' WHERE id=$1",[job.id]);}});
   if(backfill)await backfill.run(Math.min(deadline-40000,now()+2*60000));
   while(options.enabled()&&now()<deadline-35000&&processed<100){
    const token=randomUUID(),config=options.model();if(!config)break;
    const claimed=await tx(async sql=>{
     const job=(await sql.query("SELECT * FROM campus_notice_briefs WHERE store_scope=$1 AND state='pending' AND available_at<=$2 AND expires_at>$2 ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED",[scope,iso(now())])).rows[0];if(!job)return null;
     if(!matches(await current(sql,job.item_id,job.school_id,true),job)){await sql.query("UPDATE campus_notice_briefs SET state='stale',input='{}',message='正文或来源许可已变化，未向模型发送。' WHERE id=$1",[job.id]);return{skip:true};}
     const content=JSON.stringify({publishedAt:(await current(sql,job.item_id,job.school_id))!.item.publishedAt||null,paragraphs:job.input.paragraphs});
     const reserve=Buffer.byteLength(BRIEF_GUIDE+content,'utf8')+1500+1024,quotaDay=day(now());
     await sql.query('INSERT INTO campus_notice_brief_budget(store_scope,day) VALUES($1,$2) ON CONFLICT DO NOTHING',[scope,quotaDay]);
     const budget=await sql.query('UPDATE campus_notice_brief_budget SET attempts=attempts+1,held_tokens=held_tokens+$3 WHERE store_scope=$1 AND day=$2 AND attempts<$4 AND held_tokens+used_tokens+$3<=$5 RETURNING day',[scope,quotaDay,reserve,callLimit,tokenLimit]);
     if(!budget.rows.length){await sql.query("UPDATE campus_notice_briefs SET available_at=$2,message='今日自动摘要独立额度已用完，等待下一日；不影响正文或个人AI阅读额度。' WHERE store_scope=$1 AND state='pending' AND available_at<=$3",[scope,iso(Date.parse(quotaDay+'T00:00:00+08:00')+86400000),iso(now())]);return{skip:true,budget:true};}
     const result=(await sql.query("UPDATE campus_notice_briefs SET state='running',attempts=attempts+1,lease_id=$2,request_id=$2,error_code=NULL,lease_until=$3,quota_day=$4,reserved_tokens=$5,quota_settled=false,model_signature=$6 WHERE id=$1 RETURNING *",[job.id,token,iso(now()+120000),quotaDay,reserve,modelSignature()])).rows[0];return{job:result,content};
    });
    if(!claimed)break;if('skip' in claimed){if(claimed.budget)break;continue;}const {job,content}=claimed;
    let sent=false,completion:CompletionResult|undefined;
    try{
     if(!options.enabled()||!matches(await current(pool,job.item_id,job.school_id),job)||modelSignature()!==job.model_signature)throw new AppError('BRIEF_STALE','正文、来源或模型已变化，未执行旧任务。');
     sent=true;completion=await options.complete(config.connection,BRIEF_GUIDE,content,1500,config.endpoint);
     const latest=await current(pool,job.item_id,job.school_id),result=validateBrief(completion.text,job.input,latest?.item.publishedAt);
     const publication=briefPublicationDay(latest?.item.publishedAt);if(!result.publishedDate&&publication)result.publishedDate={value:publication,precision:'date',evidence:[]};
     await tx(async sql=>{const actual=(await sql.query('SELECT * FROM campus_notice_briefs WHERE id=$1 FOR UPDATE',[job.id])).rows[0];if(actual.state!=='running'||actual.lease_id!==token)return;
      await settle(sql,actual,completion!.usage?.totalTokens??actual.reserved_tokens,completion!.usage);
      if(!options.enabled()||!matches(await current(sql,job.item_id,job.school_id,true),job)||modelSignature()!==job.model_signature){await sql.query("UPDATE campus_notice_briefs SET state='stale',input='{}',message='生成期间正文、来源或模型已变化，结果未展示。' WHERE id=$1",[job.id]);return;}
      await sql.query("UPDATE campus_notice_briefs SET state='ready',result=$2::jsonb,input='{}',message=NULL,generated_at=$3,lease_id=NULL WHERE id=$1",[job.id,JSON.stringify(result),iso(now())]);
     });
    }catch(error){
     const candidate=error&&typeof error==='object'&&'code' in error?String(error.code):'',code=/^[A-Z][A-Z0-9_]{1,60}$/.test(candidate)?candidate:'MODEL_UNCERTAIN',uncertain=sent&&!completion&& !['KEY_REJECTED','MODEL_INVALID','PROVIDER_RATE_LIMITED','INPUT_TOO_LONG','CONTEXT_TOO_LONG','UNSUPPORTED_PROVIDER','KEY_INVALID'].includes(code);
     // Persist only a fixed diagnostic category, never the provider response.
     const detail=code==='BRIEF_EVIDENCE'&&error instanceof AppError&&'briefDiagnostic' in error?String(error.briefDiagnostic):'',diagnostic=/^BRIEF_EVIDENCE_(JSON|SCHEMA|EMPTY|QUOTE|VALUE|DATE)$/.test(detail)?detail:code;
     await tx(async sql=>{const actual=(await sql.query('SELECT * FROM campus_notice_briefs WHERE id=$1 FOR UPDATE',[job.id])).rows[0];if(actual.state!=='running'||actual.lease_id!==token)return;
      await settle(sql,actual,completion?.usage?.totalTokens??(sent?actual.reserved_tokens:0),completion?.usage);
      await sql.query("UPDATE campus_notice_briefs SET state=$2,input='{}',message=$3,error_code=$4,lease_id=NULL WHERE id=$1",[job.id,uncertain?'uncertain':code==='BRIEF_STALE'?'stale':'failed',uncertain?'模型请求结果不明，已停止自动重试；可继续阅读原文。':code==='BRIEF_EVIDENCE'||code==='BRIEF_DATE_CONFLICT'?'摘要依据或日期未通过核验，请以原文为准。':'摘要暂未生成成功，请先阅读原文；未占用个人AI阅读次数。',diagnostic]);
     });
    }processed++;
   }
   more=Boolean((await pool.query("SELECT id FROM campus_notice_briefs WHERE store_scope=$1 AND state='pending' AND available_at<=$2 AND expires_at>$2 LIMIT 1",[scope,iso(now())])).rows.length)||Boolean(backfill&&await backfill.due());
  }finally{await pool.query("UPDATE campus_notice_brief_workers SET lease_until='1970-01-01',dispatch_after='1970-01-01' WHERE store_scope=$1 AND lease_id=$2",[scope,worker]);}
  if(more)await wake();return{processed,more};
 }
 return{enqueue,get,run,wake};
}
