import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { approvedSchoolUrl, type SchoolSource } from './school-pages';
import { publicAddress } from './model-provider';
import { AppError } from './errors';
import { MAX_FILE_BYTES } from './material-extraction';

export interface DownloadedMaterial { bytes:Uint8Array; url:string; contentType:string }
export type MaterialDownloader=(url:string,source:SchoolSource)=>Promise<DownloadedMaterial>;
export const downloadMaterial:MaterialDownloader=async(value,source)=>{
  const deadline=Date.now()+12000;
  async function read(target:string,redirects:number):Promise<DownloadedMaterial>{
    const url=approvedSchoolUrl(target,source);
    if(redirects>3||Date.now()>=deadline)throw new AppError('SOURCE_UNAVAILABLE','附件读取超时或跳转过多。');
    let dnsTimer:ReturnType<typeof setTimeout>|undefined;
    const addresses=await Promise.race([lookup(url.hostname,{family:4,all:true}),new Promise<never>((_,reject)=>{dnsTimer=setTimeout(()=>reject(new AppError('SOURCE_UNAVAILABLE','附件地址暂时无法解析。')),2000);})]).finally(()=>clearTimeout(dnsTimer));
    if(!addresses.length||addresses.some(row=>!publicAddress(row.address)))throw new AppError('SOURCE_RESTRICTED','附件地址不允许采集。');
    return new Promise((resolve,reject)=>{
      const fail=(code='SOURCE_UNAVAILABLE',message='附件暂时无法读取。')=>reject(new AppError(code,message));
      const req=(url.protocol==='https:'?https:http).get(url,{agent:false,lookup:((_host:string,options:{all?:boolean},cb:any)=>options?.all?cb(null,[{address:addresses[0]!.address,family:4}]):cb(null,addresses[0]!.address,4)) as any,headers:{'user-agent':'CampusReader/1.0 (public university notices)','accept-encoding':'identity',accept:'application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream'}},res=>{
        if([301,302,303,307,308].includes(res.statusCode||0)&&res.headers.location){res.resume();read(new URL(res.headers.location,url).href,redirects+1).then(resolve,reject);return;}
        if(res.statusCode!==200){res.resume();fail('SOURCE_RESTRICTED','附件需要登录、已失效或源站拒绝读取。');return;}
        if(Number(res.headers['content-length'])>MAX_FILE_BYTES){res.resume();fail('FILE_TOO_LARGE','附件超过 10 MiB 采集上限。');return;}
        const chunks:Buffer[]=[];let size=0;
        res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>MAX_FILE_BYTES){req.destroy();fail('FILE_TOO_LARGE','附件超过 10 MiB 采集上限。');}else chunks.push(chunk);});
        res.on('error',()=>fail());res.on('end',()=>{
          const bytes=Buffer.concat(chunks);
          if(!bytes.length){fail();return;}
          const pdf=bytes.subarray(0,1024).includes(Buffer.from('%PDF-')),zip=bytes[0]===0x50&&bytes[1]===0x4b,ole=bytes.subarray(0,8).equals(Buffer.from([208,207,17,224,161,177,26,225]));
          if(!pdf&&!zip&&!ole){fail('SOURCE_RESTRICTED','附件返回的内容不是允许的文档格式。');return;}
          resolve({bytes:new Uint8Array(bytes),url:url.href,contentType:String(res.headers['content-type']||'application/octet-stream').split(';')[0]!});
        });
      });
      const timer=setTimeout(()=>req.destroy(new Error('deadline')),Math.max(1,deadline-Date.now()));req.on('close',()=>clearTimeout(timer));req.on('error',()=>fail());
    });
  }
  return read(value,0);
};
