import {getStore,getDeployStore} from '@netlify/blobs';
import type {SqlPool} from './postgres-storage';
import type {Repository,ItemRow} from './repository';
import {materialArchive} from './material-archive';
import {schoolDirectory} from './school-directory';
import {websiteSources} from './website-sources';
import {readSchoolPage,approvedSchoolUrl,type SchoolSource} from './school-pages';
import {AppError} from './errors';

/** Preview SQL clones can contain production metadata; scopes never share objects. */
export function materialRuntime(pool:SqlPool,repo:Repository,context:{production:boolean;deployId:string}){
 const scope=context.production?'production-v1':`preview-${context.deployId}`;
 const store=context.production?getStore({name:'campus-materials-production-v1',consistency:'strong'}):getDeployStore({name:'campus-materials',consistency:'strong'});
 const archive=materialArchive(pool,{async put(key,bytes){await store.set(key,bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer);},async get(key){const data=await store.get(key,{type:'arrayBuffer'});return data?new Uint8Array(data):null;},async remove(key){await store.delete(key);}},scope);
 const directory=schoolDirectory(pool,repo,readSchoolPage,Date.now,{archive}),websites=websiteSources(pool,repo,readSchoolPage,Date.now,undefined,archive);
 async function source(row:ItemRow):Promise<SchoolSource>{
  if(row.importKind==='website')return websites.materialSource(row);
  if(row.sourceId?.startsWith('directory_')){const value=await directory.materialSource(row);if(value)return value;}
  // Existing reviewed public imports retain their exact origin and source policy.
  const policy=(await pool.query("SELECT body FROM campus_documents WHERE collection='sources' AND id=$1",[row.sourceId])).rows[0]?.body;
  if(!policy||row.ownerOpenid||!row.originalUrl)throw new AppError('NO_MATERIAL','此资料暂未配置可自动采集的来源。');
  const entry=policy.entryUrl||policy.url;
  if(typeof entry!=='string')throw new AppError('NO_MATERIAL','此来源尚未配置公开采集入口。');
  const descriptor:SchoolSource={id:row.schoolIds?.[0]||(['ciscn-announcement','lanqiao-competition'].includes(policy.key)?'global':'bjtu'),name:policy.name||'公开来源',announcementUrl:entry,homepage:new URL(entry).origin+'/',exactHost:true};
  approvedSchoolUrl(row.originalUrl,descriptor);return descriptor;
 }
 async function material(row:ItemRow,settings:{force?:boolean;deadline?:number}={deadline:Date.now()+18000}){
  if(row.aiSearchExpiresAt)return row; // Search evidence keeps its existing 24-hour lifetime.
  if(row.importKind==='website')return websites.archivedMaterial(row,settings);
  return archive.collect(row,await source(row),readSchoolPage,settings);
 }
 repo.material=row=>material(row);
 return{archive,directory,websites,source,material};
}
