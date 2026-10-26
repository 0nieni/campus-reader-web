import type {Transport} from './transport';
export function pushSupport(){
  if(!window.isSecureContext)return'请通过 HTTPS 打开网站后启用推送。';
  const apple=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  if(apple&&!window.matchMedia('(display-mode: standalone)').matches)return'请在 Safari 分享菜单中选择“添加到主屏幕”，从主屏幕打开后开启推送。';
  return 'serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window?'':'此浏览器暂不支持网页推送，可使用站内提醒或导出手机日历。';
}
export async function currentPush(){
  if(!('serviceWorker' in navigator))return null;
  const worker=await navigator.serviceWorker.getRegistration('/');
  // Refresh installed apps as well as browser tabs; the worker activates without page caches.
  if(worker?.update)void worker.update().catch(()=>{});
  return worker?.pushManager?await worker.pushManager.getSubscription():null;
}
function decodeKey(value:string){return Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(value.length/4)*4,'=')),c=>c.charCodeAt(0));}
export async function enablePush(transport:Transport,publicKey:string){
  const reason=pushSupport();if(reason)throw new Error(reason);
  // Request only from the explicit enable-button gesture, before any await.
  const permission=await Notification.requestPermission();
  if(permission!=='granted')throw new Error('尚未获得通知权限，请在浏览器的网站设置中允许通知后重试。');
  await navigator.serviceWorker.register('/reminder-worker.js',{scope:'/',updateViaCache:'none'});
  let timeout:ReturnType<typeof setTimeout>|undefined;
  const worker=await Promise.race([navigator.serviceWorker.ready,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('推送组件未能启动，请刷新网页后重试。')),12000);})]).finally(()=>clearTimeout(timeout));
  const key=decodeKey(publicKey);
  let subscription=await worker.pushManager.getSubscription();
  const previousKey=subscription?.options?.applicationServerKey;
  if(subscription&&previousKey){const previous=new Uint8Array(previousKey);if(previous.length!==key.length||previous.some((byte,index)=>byte!==key[index])){await transport.call('reminders.push.unsubscribe',{endpoint:subscription!.endpoint});await subscription.unsubscribe();subscription=null;}}
  const created=!subscription;
  // Android's installed app and Chrome can share a subscription. Repair the
  // authenticated binding without invalidating the other open surface.
  subscription??=await worker.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
  try{
    const keys=subscription.toJSON().keys;
    if(!keys?.auth||!keys.p256dh)throw new Error('浏览器未提供推送加密参数。');
    await transport.call('reminders.push.subscribe',{subscription:{endpoint:subscription.endpoint,keys:{p256dh:keys.p256dh,auth:keys.auth}}});
  }catch(error){if(created)await subscription.unsubscribe().catch(()=>{});throw error;}
  return subscription;
}
export async function disablePush(transport:Transport){
  const subscription=await currentPush();if(!subscription)return;
  // Stop this browser immediately, even if the account API is unreachable.
  await Promise.all([transport.call('reminders.push.unsubscribe',{endpoint:subscription.endpoint}),subscription.unsubscribe()]);
}
