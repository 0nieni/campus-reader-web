import {lexmountConfigurationStatus} from './lexmount-pages';
type Status=ReturnType<typeof lexmountConfigurationStatus>;
const inspectRuntime=()=>({...lexmountConfigurationStatus(),processEnvironment:lexmountConfigurationStatus({apiKey:process.env.LEXMOUNT_API_KEY||'',projectId:process.env.LEXMOUNT_PROJECT_ID||'',baseUrl:process.env.LEXMOUNT_WEBFETCH_BASE_URL,engine:process.env.LEXMOUNT_WEBFETCH_ENGINE})});
/** Non-secret configuration metadata only: no accounts, SQL, fetches or provider authentication. */
export function withCollectionHealth(handler:(request:Request)=>Promise<Response>,inspect:()=>Status&{processEnvironment?:Status}=inspectRuntime){
 return async(request:Request)=>{
  const url=new URL(request.url);
  if(request.method==='GET'&&url.pathname==='/.netlify/functions/api'&&url.searchParams.get('health')==='collection')return Response.json({check:'configuration_only',...inspect()},{headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
  return handler(request);
 };
}
