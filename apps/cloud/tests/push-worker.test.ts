import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

function worker(){
 const handlers=new Map<string,(event:any)=>void>(),shown:{title:string;options:any}[]=[];
 runInNewContext(readFileSync(new URL('../../web/public/reminder-worker.js',import.meta.url),'utf8'),{URL,self:{
  location:{origin:'https://example.test'},addEventListener:(name:string,handler:any)=>handlers.set(name,handler),
  registration:{showNotification:async(title:string,options:any)=>{shown.push({title,options});}},
  skipWaiting:async()=>{},clients:{claim:async()=>{}}
 }});
 return{shown,async push(data?:unknown){let work:Promise<unknown>|undefined;handlers.get('push')!({data:data===undefined?undefined:{json:()=>data},waitUntil:(promise:Promise<unknown>)=>{work=promise;}});await work;}};
}
test('the installed app displays the delivered announcement title, deadline and distinct reminder tag',async()=>{
 const app=worker();await app.push({title:'合成竞赛报名公告',body:'报名截止\n到期时间：2027-01-20 09:30（北京时间）',tag:'reminder-one',url:'https://evil.invalid'});
 assert.equal(app.shown[0].title,'合成竞赛报名公告');assert.match(app.shown[0].options.body,/2027-01-20 09:30/);
 assert.equal(app.shown[0].options.tag,'reminder-one');assert.equal(app.shown[0].options.data.url,'/?view=reminders');
 await app.push({title:'另一条公告',body:'到期时间：2027-01-21 10:00（北京时间）',tag:'reminder-two'});
 assert.notEqual(app.shown[0].options.tag,app.shown[1].options.tag);
});
test('empty and invalid push payloads still display a safe fallback notification',async()=>{
 const app=worker();await app.push();await app.push({title:{html:'untrusted'},body:42,tag:'https://evil.invalid'});
 for(const notification of app.shown){assert.equal(notification.title,'校园阅览室');assert.equal(notification.options.body,'你有新的提醒，请登录提醒中心查看。');}
});
