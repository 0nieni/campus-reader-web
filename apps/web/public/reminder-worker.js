// Push worker only. No fetch handler, page cache, auth tokens or notice bodies.
self.addEventListener('push',event=>{
 event.waitUntil(self.registration.showNotification('校园阅览室',{body:'你有新的提醒，请登录提醒中心查看。',tag:'campus-reader-reminders',data:{url:'/?view=reminders'}}));
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
