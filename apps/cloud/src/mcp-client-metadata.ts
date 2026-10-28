import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {publicAddress} from './provider-endpoints';
import {mcpFail} from './mcp-security';
/** Public HTTPS only, DNS pinned, no redirects/cookies and bounded content. */
export async function readMcpClientMetadata(value:string):Promise<unknown>{
 let url:URL;try{url=new URL(value);}catch{return mcpFail('invalid_client_metadata','客户端标识地址无效。');}
 if(url.protocol!=='https:'||url.username||url.password||url.hash||url.href.length>1800||url.port&&url.port!=='443'||isIP(url.hostname)||url.hostname==='localhost'||!url.hostname.includes('.'))mcpFail('invalid_client_metadata','客户端元数据需公开HTTPS地址。');
 const addresses=await Promise.race([lookup(url.hostname,{family:4,all:true}),new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error('metadata DNS timeout')),2000);timer.unref();})]);
 if(!addresses.length||addresses.some(address=>!publicAddress(address.address)))mcpFail('invalid_client_metadata','客户端元数据不能访问内网地址。');
 return new Promise((resolve,reject)=>{
  const fail=()=>reject(Error('MCP client metadata unavailable'));
  const req=https.get(url,{agent:false,lookup:((_host:string,options:{all?:boolean},cb:any)=>options?.all?cb(null,[addresses[0]]):cb(null,addresses[0]!.address,4)) as any,headers:{accept:'application/json','accept-encoding':'identity','user-agent':'CampusReader-MCP/1.0'}},res=>{
   if(res.statusCode!==200||!/^application\/(?:[\w.-]+\+)?json(?:;|$)/i.test(String(res.headers['content-type']||''))||Number(res.headers['content-length']||0)>32768){res.resume();fail();return;}
   const chunks:Buffer[]=[];let bytes=0;
   res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>32768){req.destroy();fail();}else chunks.push(chunk);});
   res.on('error',fail);res.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{fail();}});
  });
  const timer=setTimeout(()=>{req.destroy();fail();},5000);req.once('close',()=>clearTimeout(timer));req.on('error',fail);
 });
}
