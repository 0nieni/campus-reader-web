import {createHash,randomUUID} from 'node:crypto';
import type {ItemRow} from './repository';
import type {SqlPool,SqlClient,Row} from './postgres-storage';
import {AppError} from './errors';
import {extractArticle,type SchoolSource,type PageReader,type SchoolPage} from './school-pages';
import {attachmentCandidates,extractMaterialText,type MaterialText} from './material-extraction';
import {downloadMaterial,type MaterialDownloader} from './material-download';
import {sourceVisible,itemVisible,isPrivate} from './scope';

export const MATERIAL_YEAR=365*86400000;
export interface MaterialObjects {put(key:string,bytes:Uint8Array):Promise<void>;get(key:string):Promise<Uint8Array|null>;remove(key:string):Promise<void>}
export interface MaterialFileView {id:string;filename:string;kind:'article'|'attachment';state:string;message:string;collectedAt:string|null;expiresAt:string|null;characters:number;available:boolean}
export interface MaterialArchiveView {expiresAt:string;files:MaterialFileView[];attachmentNote:string;version:string}
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const iso=(at:number)=>new Date(at).toISOString();
const time=(value:unknown)=>value instanceof Date?value.getTime():Date.parse(String(value));
const stamp=(value:unknown)=>value?iso(time(value)):null;
const blocked=()=>new AppError('NOT_FOUND','资料已过期、来源已停用或不在当前账号和学校范围内。');

export function materialArchive(pool:SqlPool,objects:MaterialObjects,scope:string,options:{now?:()=>number;download?:MaterialDownloader;extract?:typeof extractMaterialText;onArticleSaved?:(row:ItemRow,school:string,text:string)=>Promise<void>}={}) {
 const now=options.now||Date.now,download=options.download||downloadMaterial,extract=options.extract||extractMaterialText;
 async function transaction<T>(work:(client:SqlClient)=>Promise<T>){const client=await pool.connect();try{await client.query('BEGIN');const result=await work(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
 const owner=(row:ItemRow)=>String(row.ownerOpenid||'');
 const keyOf=(row:ItemRow,source:SchoolSource,url:string)=>hash([scope,owner(row),source.id,row._id,url].join('\n'));
 async function access(row:ItemRow,source:SchoolSource){
  const found=await pool.query("SELECT body FROM campus_documents WHERE collection='items' AND id=$1",[row._id]),actual=found.rows[0]?.body;
  const origins=await pool.query("SELECT body FROM campus_documents WHERE collection='sources' AND id=$1",[row.sourceId]),policy=origins.rows[0]?.body;
  if(!actual||actual.status!=='published'||String(actual.ownerOpenid||'')!==owner(row)||actual.sourceId!==row.sourceId||!policy||policy.enabled===false||policy.deleted===true||String(policy.ownerOpenid||'')!==owner(row))throw blocked();
  if(!sourceVisible(policy,source.id,owner(row))||!itemVisible(actual,{schoolId:source.id,ownerId:owner(row),publicSourceIds:[row.sourceId!],privateSourceIds:[]})||!owner(row)&&(isPrivate(actual)||isPrivate(policy)))throw blocked();
  const date=Date.parse(actual.publishedAt||actual.discoveredAt||actual.createdAt||'');
  if(!Number.isFinite(date)||date<now()-MATERIAL_YEAR||actual.aiSearchExpiresAt)throw blocked();
  return hash(JSON.stringify([actual.sourceId,actual.ownerOpenid,actual.schoolIds,policy]));
 }
 async function rowsFor(row:ItemRow,source:SchoolSource){return(await pool.query('SELECT * FROM campus_material_files WHERE store_scope=$1 AND item_id=$2 AND owner_key=$3 AND school_id=$4 ORDER BY kind,original_url',[scope,row._id,owner(row),source.id])).rows;}
 const valid=(file:Row)=>Boolean(file.blob_key&&file.expires_at&&time(file.expires_at)>now()&&!['deleted','deleting'].includes(file.state));
 async function queueGarbage(client:SqlClient,key:string|null|undefined){if(key)await client.query('INSERT INTO campus_material_garbage(store_scope,blob_key) VALUES($1,$2) ON CONFLICT DO NOTHING',[scope,key]);}
 async function save(row:ItemRow,source:SchoolSource,url:string,filename:string,kind:'article'|'attachment',load:()=>Promise<{bytes:Uint8Array;contentType:string;text?:string}>,force=false,repair=false){
  const id=keyOf(row,source,url),prior=(await pool.query('SELECT * FROM campus_material_files WHERE id=$1 AND store_scope=$2',[id,scope])).rows[0];
  if(prior&&valid(prior)&&!force)return prior;
  const token=randomUUID(),newKey=`files/${id}/${token}`;
  const claim=await transaction(async client=>{
   await client.query(`INSERT INTO campus_material_files(id,store_scope,item_id,school_id,owner_key,source_id,original_url,filename,kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,[id,scope,row._id,source.id,owner(row),row.sourceId,url,filename,kind]);
   const result=await client.query('SELECT * FROM campus_material_files WHERE id=$1 FOR UPDATE',[id]),current=result.rows[0]!;
   if(time(current.lease_until)>now())return null;
   await queueGarbage(client,current.pending_blob_key);
   await client.query('UPDATE campus_material_files SET lease_id=$2,lease_until=$3,pending_blob_key=$4 WHERE id=$1',[id,token,iso(now()+120000),newKey]);return current;
  });
  if(!claim)throw new AppError('NO_MATERIAL','资料正在入库，请稍后自动读取或刷新。');
  try{
   const signature=await access(row,source),value=await load(),digest=hash(value.bytes);
   if(await access(row,source)!==signature)throw blocked();
   if(valid(claim)&&claim.content_hash===digest&&!repair){await pool.query("UPDATE campus_material_files SET checked_at=$3,lease_id=NULL,lease_until='1970-01-01',pending_blob_key=NULL WHERE id=$1 AND lease_id=$2",[id,token,iso(now())]);return{...claim,checked_at:iso(now())};}
   await objects.put(newKey,value.bytes);
   const result:MaterialText=kind==='article'?{state:value.text?'ready':'no_text',text:value.text||'',message:value.text?'公告正文已提取。':'已保存网页快照，未识别到足够正文；请查看附件或原文。'}:await extract(value.bytes,filename);
   if(await access(row,source)!==signature)throw blocked();
   return await transaction(async client=>{
    const same=valid(claim)&&claim.content_hash===digest;
    const resultRow=await client.query(`UPDATE campus_material_files SET state=$3,content_type=$4,byte_length=$5,content_hash=$6,blob_key=$7,pending_blob_key=NULL,text_content=$8,message=$9,collected_at=$10,expires_at=$11,checked_at=$12,lease_id=NULL,lease_until='1970-01-01',updated_at=$12 WHERE id=$1 AND lease_id=$2 RETURNING *`,[id,token,result.state,value.contentType,value.bytes.byteLength,digest,newKey,result.text,result.message,same?stamp(claim.collected_at):iso(now()),same?stamp(claim.expires_at):iso(now()+MATERIAL_YEAR),iso(now())]);
    if(!resultRow.rows.length)throw new AppError('SOURCE_BUSY','资料入库状态已变化，请重试读取。');
    if(claim.blob_key!==newKey)await queueGarbage(client,claim.blob_key);return resultRow.rows[0]!;
   });
  }catch(error){
   await transaction(async client=>{await queueGarbage(client,newKey);await client.query("UPDATE campus_material_files SET state=CASE WHEN expires_at>$3::timestamptz AND blob_key IS NOT NULL THEN state ELSE 'failed' END,message=$4,lease_id=NULL,lease_until='1970-01-01',pending_blob_key=NULL WHERE id=$1 AND lease_id=$2",[id,token,iso(now()),error instanceof AppError?error.message:'本次资料采集或提取未完成，已有有效资料保留。']);});
   throw error;
  }
 }
 async function collect(row:ItemRow,source:SchoolSource,reader:PageReader,settings:{force?:boolean;deadline?:number;repair?:boolean;download?:MaterialDownloader}={}):Promise<ItemRow>{
  await access(row,source);
  if(!row.originalUrl)throw new AppError('NO_MATERIAL','此公告没有可采集的原文地址。');
  const previousArticle=options.onArticleSaved?(await rowsFor(row,source)).find(file=>file.kind==='article'):undefined;
  let page:SchoolPage|undefined;
  const article=await save(row,source,row.originalUrl,`${(row.title||'公告').replace(/[\r\n/\\]/g,'_').slice(0,100)}.html`,'article',async()=>{
   page=await reader(row.originalUrl!,source);let text='';
   try{text=extractArticle(page,source);}catch(error){if(!(error instanceof AppError)||error.code!=='NO_MATERIAL')throw error;}
   return{bytes:new TextEncoder().encode(page.html),contentType:'text/html; charset=utf-8',text};
  },settings.force,settings.repair);
  const fetchedArticle=Boolean(page);
  if(!page){const raw=await objects.get(article.blob_key);if(raw)page={url:row.originalUrl,html:new TextDecoder().decode(raw)};else if(!settings.repair)return collect(row,source,reader,{...settings,force:true,repair:true});else throw new AppError('NO_MATERIAL','正文快照暂不可读取。');}
  const attachments=attachmentCandidates(page,source),notes:string[]=[];
  for(const file of attachments.slice(0,20)){
   if(settings.deadline&&now()>=settings.deadline){notes.push('部分附件待后台继续采集。');break;}
   try{await save(row,source,file.url,file.filename,'attachment',()=>(settings.download||download)(file.url,source),settings.force);}
   catch(error){if(error instanceof AppError&&error.code==='NOT_FOUND')throw error;notes.push(`${file.filename}：${error instanceof AppError?error.message:'暂未采集成功。'}`);}
  }
  if(attachments.length>20)notes.push('附件超过每篇 20 份的采集上限，其余请查看原文。');
  const all=await rowsFor(row,source),allowed=new Set([row.originalUrl,...attachments.slice(0,20).map(file=>file.url)]);
  const files=all.filter(file=>allowed.has(file.original_url)),usable=files.filter(valid),body=usable.find(file=>file.kind==='article');
  // Removed attachment links no longer contribute evidence or downloads.
  for(const old of all.filter(file=>!allowed.has(file.original_url)))await transaction(async client=>{await queueGarbage(client,old.blob_key);await client.query("UPDATE campus_material_files SET state='deleted',blob_key=NULL,text_content='',expires_at=$2 WHERE id=$1 AND lease_until<=$2",[old.id,iso(now())]);});
  if(!body)throw new AppError('NO_MATERIAL','正文尚未完成入库，请稍后重试。');
  const text=usable.filter(file=>file.kind==='attachment'&&file.text_content).map(file=>`\n\n## 附件：${file.filename}\n${file.message}\n${file.text_content}`).join('');
  const attachmentNote=[`资料保存 365 天；识别 ${attachments.length} 份附件，已保存 ${usable.filter(file=>file.kind==='attachment').length} 份。`,...usable.filter(file=>file.kind==='attachment'&&file.state!=='ready').map(file=>`${file.filename}：${file.message}`),...notes].join(' ');
  const view:MaterialArchiveView={expiresAt:iso(Math.min(...usable.map(file=>time(file.expires_at)))),files:files.map(file=>({id:file.id,filename:file.filename,kind:file.kind,state:valid(file)?file.state:file.blob_key?'expired':file.state,message:file.message,collectedAt:stamp(file.collected_at),expiresAt:stamp(file.expires_at),characters:file.text_content.length,available:valid(file)})),attachmentNote,version:hash(JSON.stringify(usable.map(file=>[file.id,file.content_hash,file.state])))};
  const materialPending=attachments.slice(0,20).some(candidate=>!files.some(file=>file.original_url===candidate.url&&(valid(file)||file.state==='failed')));
  const patch={contentText:body.text_content+text,materialExpiresAt:view.expiresAt,materialArchive:view,inlineMaterial:false,materialPending,updatedAt:iso(Math.max(...usable.map(file=>time(file.collected_at))))};
  await access(row,source);
  await pool.query("UPDATE campus_documents SET body=body || $3::jsonb WHERE collection='items' AND id=$1 AND coalesce(body->>'ownerOpenid','')=$2 AND body->>'sourceId'=$4 AND body->>'status'='published'",[row._id,owner(row),JSON.stringify(patch),row.sourceId]);
  await access(row,source);
  if(fetchedArticle&&previousArticle?.text_content!==body.text_content)await options.onArticleSaved?.({...row,...patch},source.id,body.text_content);
  return{...row,...patch};
 }
 async function readFile(id:string,row:ItemRow,source:SchoolSource){
  await access(row,source);
  const file=(await pool.query('SELECT * FROM campus_material_files WHERE id=$1 AND store_scope=$2 AND item_id=$3 AND owner_key=$4 AND school_id=$5',[id,scope,row._id,owner(row),source.id])).rows[0];
  if(!file||!valid(file))throw blocked();
  const bytes=await objects.get(file.blob_key);if(!bytes)throw new AppError('NO_MATERIAL','原文件暂不可读取，请重新打开公告采集。');
  await access(row,source);if(!valid(file))throw blocked();return{bytes,filename:file.filename as string,contentType:file.content_type as string};
 }
 async function cleanup(limit=100){
  const expired=await transaction(async client=>{
   const rows=await client.query(`SELECT * FROM campus_material_files WHERE store_scope=$1 AND ((expires_at<=$2 AND blob_key IS NOT NULL) OR (pending_blob_key IS NOT NULL AND lease_until<=$2)) AND lease_until<=$2 ORDER BY expires_at NULLS FIRST,id LIMIT $3 FOR UPDATE SKIP LOCKED`,[scope,iso(now()),limit]);
   for(const file of rows.rows){await queueGarbage(client,file.pending_blob_key);if(file.expires_at&&time(file.expires_at)<=now()){await queueGarbage(client,file.blob_key);await client.query("UPDATE campus_material_files SET state='deleted',blob_key=NULL,pending_blob_key=NULL,text_content='',byte_length=0,message='资料已到期删除，需要时重新采集。',lease_id=NULL WHERE id=$1",[file.id]);}else await client.query('UPDATE campus_material_files SET pending_blob_key=NULL,lease_id=NULL WHERE id=$1',[file.id]);}
   const payloads=await client.query(`UPDATE campus_documents SET body=body - ARRAY['contentText','materialArchive','materialExpiresAt']::text[] WHERE collection='items' AND id IN (SELECT id FROM campus_documents WHERE collection='items' AND body->>'materialExpiresAt'<=$1 LIMIT $2) RETURNING id`,[iso(now()),limit]);
   return rows.rows.length+payloads.rows.length;
  });
  const garbage=(await pool.query('SELECT blob_key FROM campus_material_garbage WHERE store_scope=$1 ORDER BY created_at,blob_key LIMIT $2',[scope,limit])).rows;
  let deleted=0;for(const file of garbage){
   // An uncertain commit must never cause a still referenced object to be deleted.
   const live=await pool.query('SELECT id FROM campus_material_files WHERE store_scope=$1 AND (blob_key=$2 OR pending_blob_key=$2) LIMIT 1',[scope,file.blob_key]);
   if(live.rows.length){await pool.query('DELETE FROM campus_material_garbage WHERE store_scope=$1 AND blob_key=$2',[scope,file.blob_key]);continue;}
   await objects.remove(file.blob_key);await pool.query('DELETE FROM campus_material_garbage WHERE store_scope=$1 AND blob_key=$2',[scope,file.blob_key]);deleted++;
  }
  const remaining=await pool.query(`SELECT 1 WHERE EXISTS(SELECT 1 FROM campus_material_files WHERE store_scope=$1 AND lease_until<=$2 AND ((expires_at<=$2 AND blob_key IS NOT NULL) OR pending_blob_key IS NOT NULL)) OR EXISTS(SELECT 1 FROM campus_material_garbage WHERE store_scope=$1) OR EXISTS(SELECT 1 FROM campus_documents WHERE collection='items' AND body->>'materialExpiresAt'<=$3)`,[scope,iso(now()),iso(now())]);
  return{expired,deleted,more:remaining.rows.length>0};
 }
 return{collect,readFile,cleanup,scope,validate:access};
}
export type MaterialArchive=ReturnType<typeof materialArchive>;
