import {jobSignature,MATERIAL_JOB_PATH} from './material-jobs';
/** Fixed configured site origin, never a caller-controlled Host or callback URL. */
export async function dispatchMaterials(origin:string|undefined,secret:string|undefined){
 if(!origin||!secret||secret.length<32)throw new Error('MATERIALS_JOB_NOT_CONFIGURED');
 const url=new URL(origin);if(url.protocol!=='https:'||url.username||url.password||url.port||url.pathname!=='/')throw new Error('MATERIALS_SITE_INVALID');
 const at=String(Date.now()),body='{}';
 const response=await fetch(new URL(MATERIAL_JOB_PATH,url),{method:'POST',headers:{'content-type':'application/json','x-material-time':at,'x-material-signature':jobSignature(secret,at,body)},body,redirect:'error',signal:AbortSignal.timeout(12000)});
 if(response.status!==202)throw new Error('MATERIALS_DISPATCH_FAILED');
}
