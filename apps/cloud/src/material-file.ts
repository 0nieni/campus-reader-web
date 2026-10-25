import type {Repository} from './repository';
import type {MaterialArchive} from './material-archive';
import type {SchoolSource} from './school-pages';
import {authorizedItem,identifier} from './access';
import {AppError} from './errors';
/** Auth identity must be resolved before this handler; no caller-supplied blob key. */
export async function materialFile(request:Request,owner:string,repo:Repository,archive:MaterialArchive,source:(row:import('./repository').ItemRow)=>Promise<SchoolSource>){
 const headers={'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
 try{
  if(request.method!=='GET')return new Response(null,{status:405,headers:{...headers,allow:'GET'}});
  const url=new URL(request.url),school=identifier(url.searchParams.get('schoolId')),item=identifier(url.searchParams.get('itemId')),id=identifier(url.searchParams.get('fileId'));
  const row=await authorizedItem(repo,owner,school,item),file=await archive.readFile(id,row,await source(row));
  await authorizedItem(repo,owner,school,item); // Check selection/ownership again after storage I/O.
  const filename=encodeURIComponent(file.filename.replace(/[\r\n\0]/g,'_')).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16));
  const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(file.bytes);controller.close();}});
  return new Response(stream,{headers:{...headers,'content-type':'application/octet-stream','content-disposition':`attachment; filename="document"; filename*=UTF-8''${filename}`}});
 }catch(error){return Response.json({ok:false,message:error instanceof AppError?error.message:'资料暂不可下载。'},{status:error instanceof AppError&&error.code==='VALIDATION_FAILED'?400:404,headers});}
}
