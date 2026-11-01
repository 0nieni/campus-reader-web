import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {approvedSchoolUrl,type SchoolSource} from './school-pages';
import {publicAddress} from './provider-endpoints';
import {AppError} from './errors';
type Options={lookup?:(host:string)=>Promise<Array<{address:string}>>;head?:(url:URL,address:string,timeout:number)=>Promise<{status:number;location?:string}>};
const failure=()=>new AppError('SOURCE_UNAVAILABLE','公开网页的重定向或访问状态无法核验，本次未读取正文。');
/** No cookies or keys. Only headers are read; pin DNS and validate every redirect. */
export async function resolveSearchRedirects(value:string,source:SchoolSource,options:Options={}):Promise<string>{
  const deadline=Date.now()+8000;
  let target=value;
  for(let redirects=0;redirects<=3;redirects++){
    const url=approvedSchoolUrl(target,source),remaining=deadline-Date.now();if(url.protocol!=='https:'||remaining<=0)throw failure();
    let timer:ReturnType<typeof setTimeout>|undefined;
    const addresses=await Promise.race([options.lookup?options.lookup(url.hostname):lookup(url.hostname,{family:4,all:true}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(failure()),Math.min(2000,remaining));})]).finally(()=>clearTimeout(timer));
    if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw failure();
    const timeout=Math.min(5000,deadline-Date.now());if(timeout<=0)throw failure();
    const response=await(options.head?options.head(url,addresses[0]!.address,timeout):new Promise<{status:number;location?:string}>((resolve,reject)=>{
      let done=false;const finish=(error?:Error,response?:{status:number;location?:string})=>{if(done)return;done=true;clearTimeout(timer);if(error)reject(error);else resolve(response!);};
      const request=https.request(url,{method:'HEAD',agent:false,lookup:((_host:string,opts:{all?:boolean},cb:any)=>opts?.all?cb(null,[{address:addresses[0]!.address,family:4}]):cb(null,addresses[0]!.address,4)) as any,headers:{'user-agent':'CampusReader/1.0 (public source verification)',accept:'text/html,application/xhtml+xml'}},res=>{finish(undefined,{status:res.statusCode||0,location:res.headers.location});res.destroy();});
      timer=setTimeout(()=>{finish(failure());request.destroy();},timeout);request.on('error',()=>finish(failure()));request.end();
    }));
    if([301,302,303,307,308].includes(response.status)&&response.location){target=new URL(response.location,url).href;continue;}
    if(response.status!==200)throw failure();
    return url.href;
  }
  throw failure();
}
