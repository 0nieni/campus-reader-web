// Push worker only. No fetch handler, page cache, auth tokens or announcement content.
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('push',event=>{
 let payload={};try{const data=event.data?.json();if(data&&typeof data==='object'&&!Array.isArray(data))payload=data;}catch{/* Old or malformed pushes still display a fallback. */}
 const title=typeof payload.title==='string'&&payload.title.trim()?payload.title.slice(0,300):'校园阅览室';
 const body=typeof payload.body==='string'&&payload.body.trim()?payload.body.slice(0,1000):'你有新的提醒，请登录提醒中心查看。';
 const tag=typeof payload.tag==='string'&&/^[\w-]{1,64}$/.test(payload.tag)?payload.tag:'campus-reader-reminders';
 event.waitUntil(self.registration.showNotification(title,{body,tag,renotify:true,icon:'/app-icon-192.png',data:{url:'/?view=reminders'}}));
});
self.addEventListener('notificationclick',event=>{
 event.notification.close();
 event.waitUntil((async()=>{
  const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  const page=windows.find(client=>new URL(client.url).origin===self.location.origin);
  if(page){page.postMessage({type:'open-reminders'});await page.focus();}
  else await self.clients.openWindow('/?view=reminders');
 })());
});
