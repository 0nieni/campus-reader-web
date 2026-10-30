import {getStore,getDeployStore} from '@netlify/blobs';
import type {SqlPool} from './postgres-storage';
import type {Repository,ItemRow} from './repository';
import {materialArchive} from './material-archive';
import {schoolDirectory} from './school-directory';
import {websiteSources} from './website-sources';
import {approvedSchoolUrl,type SchoolSource} from './school-pages';
import {readLexmountPage} from './lexmount-pages';
import {AppError} from './errors';
import {publicSources as createPublicSources} from './public-sources';
import {noticeBriefRuntime,briefSchool} from './notice-brief-runtime';
import {canonicalBriefBody} from './notice-brief';

/** Preview SQL clones can contain production metadata; scopes never share objects. */
export function materialRuntime(pool:SqlPool,repo:Repository,context:{production:boolean;deployId:string}){
 const scope=context.production?'production-v1':`preview-${context.deployId}`;
 const briefs=noticeBriefRuntime(pool,context,articleForBrief);
 const store=context.production?getStore({name:'campus-materials-production-v1',consistency:'strong'}):getDeployStore({name:'campus-materials',consistency:'strong'});
 const archive=materialArchive(pool,{async put(key,bytes){await store.set(key,bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer);},async get(key){const data=await store.get(key,{type:'arrayBuffer'});return data?new Uint8Array(data):null;},async remove(key){await store.delete(key);}},scope,{onArticleSaved:async(row,school,text)=>{try{await briefs.enqueue(row,school,text);}catch{console.warn(JSON.stringify({event:'notice-brief-queue',code:'QUEUE_UNAVAILABLE'}));}}});
 const directory=schoolDirectory(pool,repo,readLexmountPage,Date.now,{archive}),websites=websiteSources(pool,repo,readLexmountPage,Date.now,undefined,archive);
 const publicSources=createPublicSources(pool,repo,websites,directory.sources,archive);
 async function source(row:ItemRow):Promise<SchoolSource>{
  if(row.importKind==='website')return websites.materialSource(row);
  if(row.sourceId?.startsWith('directory_')){const value=await directory.materialSource(row);if(value)return value;}
  // Existing reviewed public imports retain their exact origin and source policy.
  const policy=(await pool.query("SELECT body FROM campus_documents WHERE collection='sources' AND id=$1",[row.sourceId])).rows[0]?.body;
  if(!policy||row.ownerOpenid||!row.originalUrl)throw new AppError('NO_MATERIAL','此资料暂未配置可自动采集的来源。');
  const entry=policy.entryUrl||policy.url;
  if(typeof entry!=='string')throw new AppError('NO_MATERIAL','此来源尚未配置公开采集入口。');
  const fallbackSchool=policy.scope==='global'||['ciscn-announcement','lanqiao-competition'].includes(policy.key)?'global':policy.schoolIds?.[0]||'bjtu';
  const descriptor:SchoolSource={id:briefSchool(row,fallbackSchool),name:policy.name||'公开来源',announcementUrl:entry,homepage:new URL(entry).origin+'/',exactHost:true};
  approvedSchoolUrl(row.originalUrl,descriptor);return descriptor;
 }
 async function material(row:ItemRow,settings:{force?:boolean;deadline?:number;articleOnly?:boolean}={deadline:Date.now()+18000}){
  if(row.aiSearchExpiresAt)return row; // Search evidence keeps its existing 24-hour lifetime.
  if(row.importKind==='public_website')return publicSources.material(row,settings);
  if(row.importKind==='website')return websites.archivedMaterial(row,settings);
  return archive.collect(row,await source(row),readLexmountPage,settings);
 }
 async function articleForBrief(row:ItemRow,school:string,deadline:number){
  const article=async()=>(await pool.query(`SELECT text_content FROM campus_material_files
   WHERE store_scope=$1 AND item_id=$2 AND school_id=$3 AND source_id=$4 AND owner_key=''
   AND kind='article' AND blob_key IS NOT NULL AND expires_at>$5 AND original_url=$6 AND state NOT IN ('deleted','deleting')
   ORDER BY updated_at DESC LIMIT 1`,[scope,row._id,school,row.sourceId,new Date().toISOString(),row.originalUrl||''])).rows[0]?.text_content as string|undefined;
  const cached=await article(),body=canonicalBriefBody(row.contentText||''),prefix=canonicalBriefBody(cached||'');
  if(cached&&(body===prefix||body.startsWith(prefix+'\n## 附件：')))return cached;
  if(!row.originalUrl){if(row.contentText&&!row.materialArchive)return row.contentText.split('\n\n## 附件：')[0];throw new AppError('NO_MATERIAL','此公告尚无可读取的完整正文。');}
  if(Date.now()>=deadline)throw new AppError('NO_MATERIAL','本批正文读取时间已用完。');
  await material(row,{deadline,articleOnly:true,force:Boolean(cached&&row.contentText)});
  const text=await article();if(!text)throw new AppError('NO_MATERIAL','尚未提取到完整公告正文。');return text;
 }
 repo.material=row=>material(row);
 repo.brief=(row,school)=>briefs.get(row,briefSchool(row,school));
 return{archive,directory,websites,publicSources,source,material,briefs};
}
