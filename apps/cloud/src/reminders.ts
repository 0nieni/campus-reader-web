import {randomUUID,createHash} from 'node:crypto';
import type {Reminder,ReminderNotification,ReminderState,NoticeWatch,BrowserPushSubscription} from '@campus/contracts';
import type {IdentityContext} from './identity';
import type {SqlPool,SqlClient} from './postgres-storage';
import {postgresRepository,visibleItemsSql} from './postgres-repository';
import {identifier,authorizedItem,authorizeSchool} from './access';
import {isPrivate,itemVisible,sourceVisible,type Resource,type Scope} from './scope';
import {isRetained} from './gateway';
import type {ItemRow} from './repository';
import {reject} from './errors';
import {checkedSubscription,endpointHash,sendBrowserPush,type PushConfig} from './browser-push';
import {reminderCalendar} from './reminder-calendar';

type Notification=ReminderNotification&{reminderId?:string;watchId?:string;sent:Record<string,'sending'|'sent'|'failed'|'skipped'>};
type StoredReminder=Reminder&{generation:string;fired:number[]};
interface State {reminders:StoredReminder[];watches:NoticeWatch[];notifications:Notification[];lastScan?:number;more?:boolean;lastTest?:number}
interface Options {now?:()=>number;push?:PushConfig;send?:typeof sendBrowserPush}
const day=86400000;
const cleanText=(value:unknown,max:number,fallback='')=>{
  if(typeof value!=='string'||value.length>max||/[\x00-\x1f\x7f]/.test(value))reject('VALIDATION_FAILED','提醒文字过长或包含无效字符。');
  return value.trim()||fallback;
};
const id=()=>randomUUID().replace(/-/g,'');
const notificationId=(value:string)=>createHash('sha256').update(value).digest('hex');
const empty=():State=>({reminders:[],watches:[],notifications:[]});
export function reminderService(pool:SqlPool,options:Options={}){
  const now=options.now||Date.now,send=options.send||sendBrowserPush;
  async function transaction<T>(owner:string,run:(state:State,client:SqlClient)=>Promise<T>){
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout='6000'");
      await client.query('INSERT INTO campus_reminder_accounts(owner_id) VALUES($1) ON CONFLICT DO NOTHING',[owner]);
      const {rows}=await client.query('SELECT body FROM campus_reminder_accounts WHERE owner_id=$1 FOR UPDATE',[owner]);
      const state={...empty(),...rows[0].body} as State;
      const result=await run(state,client);
      await client.query('UPDATE campus_reminder_accounts SET body=$2::jsonb,checked_at=$3 WHERE owner_id=$1',[owner,JSON.stringify(state),new Date(now()).toISOString()]);
      await client.query('COMMIT');return result;
    }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
  }
  const repoFor=(client:SqlClient)=>postgresRepository({query:(sql,values)=>client.query(sql,values),connect:async()=>client});
  async function access(client:SqlClient,owner:string){
    const {rows}=await client.query("SELECT id,body FROM campus_documents WHERE collection='sources' ORDER BY id LIMIT 2001");
    if(rows.length>2000)reject('SOURCE_LIMIT_EXCEEDED','来源目录超过当前读取范围。');
    const scopes=new Map<string,Scope>();
    const scope=(school:string)=>{
      if(!scopes.has(school)){
        const result:Scope={ownerId:owner,schoolId:school,publicSourceIds:[],privateSourceIds:[]};
        for(const source of rows){if(isPrivate(source.body as Resource))result.privateSourceIds.push(source.id);else if(sourceVisible(source.body,school,owner))result.publicSourceIds.push(source.id);}
        scopes.set(school,result);
      }return scopes.get(school)!;
    };
    return scope;
  }
  async function synchronize(state:State,client:SqlClient,owner:string){
    const time=now(),scope=await access(client,owner),since=new Date(time-365*day).toISOString();
    const itemIds=[...new Set([...state.reminders,...state.notifications].map(r=>r.itemId))];
    const {rows}=await client.query("SELECT id,body FROM campus_documents WHERE collection='items' AND id=ANY($1::text[])",[itemIds]);
    const items=new Map(rows.map(r=>[r.id,{...r.body,_id:r.id} as ItemRow]));
    const allowed=(school:string,item:ItemRow|undefined)=>Boolean(item&&item.status==='published'&&itemVisible(item,scope(school))&&isRetained(item,since));
    // Revalidate on every read, including exports and dispatch; old snapshots
    // cannot reveal a source removed from the caller's workspace.
    state.reminders=state.reminders.filter(r=>allowed(r.schoolId,items.get(r.itemId))&&(r.dueAt===null||Date.parse(r.dueAt)>=time-90*day));
    state.notifications=state.notifications.filter(r=>allowed(r.schoolId,items.get(r.itemId))&&Date.parse(r.createdAt)>=time-90*day);
    for(const reminder of state.reminders){
      reminder.title=String(items.get(reminder.itemId)!.title||'未命名公告').slice(0,300);
      if(reminder.dueAt===null)continue;
      const dueAt=reminder.dueAt;
      const due=reminder.days.filter(days=>!reminder.fired.includes(days)&&Date.parse(dueAt)-days*day<=time);
      if(!due.length)continue;
      // After an offline gap combine crossed offsets into the most recent one.
      const days=Math.min(...due);reminder.fired.push(...due);
      const eventId=notificationId(`${reminder.id}/${reminder.generation}/${days}`);
      if(!state.notifications.some(event=>event.id===eventId))state.notifications.unshift({id:eventId,kind:'deadline',reminderId:reminder.id,title:reminder.title,message:Date.parse(reminder.dueAt)<=time?`${reminder.label}已到时间，请核对事项进度。`:`${reminder.label}：${days?`提前${days}天提醒`:'已到时间'}。`,schoolId:reminder.schoolId,itemId:reminder.itemId,createdAt:new Date(time).toISOString(),read:false,sent:{}});
    }
    state.more=false;
    // Throttle repeated badge reads. No background scraping and no AI calls.
    if(!state.lastScan||time-state.lastScan>=60000){
      let remaining=50;
      for(const watch of state.watches){
        if(remaining<=0){state.more=true;break;}
        const ownScope=scope(watch.schoolId);
        const result=await client.query(`SELECT d.id,d.body FROM campus_notice_arrivals AS a JOIN campus_documents AS d ON d.collection='items' AND d.id=a.item_id
          WHERE ${visibleItemsSql} AND body->>'status'='published' AND a.arrived_at >= $5::timestamptz
          AND a.arrived_at >= $6::timestamptz AND strpos(lower(coalesce(body->>'title','')),lower($7))>0
          AND coalesce(nullif(body->>'publishedAt',''),nullif(body->>'discoveredAt',''),body->>'createdAt') >= $8
          AND NOT EXISTS(SELECT 1 FROM campus_reminder_seen seen WHERE seen.owner_id=$1 AND seen.watch_id=$9 AND seen.item_id=d.id)
          ORDER BY a.arrived_at,a.item_id LIMIT $10`,[owner,watch.schoolId,ownScope.publicSourceIds,ownScope.privateSourceIds,watch.createdAt,new Date(time-90*day).toISOString(),watch.keyword,since,watch.id,remaining+1]);
        if(result.rows.length>remaining)state.more=true;
        for(const row of result.rows.slice(0,remaining)){
          await client.query('INSERT INTO campus_reminder_seen(owner_id,watch_id,item_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[owner,watch.id,row.id]);
          if(!allowed(watch.schoolId,{...row.body,_id:row.id}))continue;
          const eventId=notificationId(`${watch.id}/${row.id}`);
          if(!state.notifications.some(e=>e.id===eventId))state.notifications.unshift({id:eventId,watchId:watch.id,kind:'new_notice',title:String(row.body.title||'未命名公告').slice(0,300),message:`${watch.schoolName}列表有新公告${watch.keyword?`，标题匹配「${watch.keyword}」`:''}。`,schoolId:watch.schoolId,itemId:row.id,createdAt:new Date(time).toISOString(),read:false,sent:{}});
        }
        remaining-=Math.min(remaining,result.rows.length);
      }
      state.lastScan=state.more?undefined:time;
    }
    state.notifications=state.notifications.slice(0,200);
  }
  function dto(state:State):ReminderState{
    return{reminders:state.reminders.map(({generation,fired,...row})=>row),watches:state.watches,notifications:state.notifications.map(({sent,reminderId,watchId,...row})=>row),unread:state.notifications.filter(r=>!r.read).length,checkedAt:new Date(now()).toISOString(),more:Boolean(state.more),pushConfigured:Boolean(options.push),publicKey:options.push?.publicKey||null};
  }
  async function handle(action:string,input:Record<string,unknown>,identity:IdentityContext):Promise<unknown>{
    const owner=identity.dataOwnerId;
    if(action==='reminders.push.status'){
      if(typeof input.endpoint!=='string'||input.endpoint.length>2048)reject('VALIDATION_FAILED','推送设备信息无效。');
      const {rows}=await pool.query('SELECT endpoint_hash FROM campus_push_devices WHERE owner_id=$1 AND endpoint_hash=$2',[owner,endpointHash(input.endpoint)]);
      return{active:Boolean(rows.length)};
    }
    if(action==='reminders.push.subscribe'){
      if(!options.push)reject('PUSH_UNAVAILABLE','当前环境尚未启用浏览器推送，站内提醒和日历仍可使用。');
      const subscription=checkedSubscription(input.subscription),hash=endpointHash(subscription.endpoint);
      return transaction(owner,async(state,client)=>{
        const {rows}=await client.query('SELECT endpoint_hash FROM campus_push_devices WHERE owner_id=$1',[owner]);
        if(rows.length>=5&&!rows.some(row=>row.endpoint_hash===hash))reject('PUSH_LIMIT','每个账号最多启用5个浏览器，请先在旧设备关闭推送。');
        await client.query('INSERT INTO campus_push_devices(endpoint_hash,owner_id,subscription) VALUES($1,$2,$3::jsonb) ON CONFLICT(endpoint_hash) DO UPDATE SET owner_id=EXCLUDED.owner_id,subscription=EXCLUDED.subscription,updated_at=now()',[hash,owner,JSON.stringify(subscription)]);
        for(const event of state.notifications)event.sent[hash]='skipped';
        return{id:hash};
      });
    }
    if(action==='reminders.push.unsubscribe'){
      if(typeof input.endpoint!=='string'||input.endpoint.length>2048)reject('VALIDATION_FAILED','推送设备信息无效。');
      await pool.query('DELETE FROM campus_push_devices WHERE owner_id=$1 AND endpoint_hash=$2',[owner,endpointHash(input.endpoint)]);
      return{removed:true};
    }
    if(action==='reminders.push.test'){
      if(!options.push)reject('PUSH_UNAVAILABLE','当前环境尚未启用浏览器推送。');
      if(typeof input.endpoint!=='string'||input.endpoint.length>2048)reject('VALIDATION_FAILED','推送设备信息无效。');
      const {rows}=await pool.query("UPDATE campus_push_devices SET last_test_at=$3 WHERE owner_id=$1 AND endpoint_hash=$2 AND (last_test_at IS NULL OR last_test_at < $3::timestamptz - interval '1 minute') RETURNING subscription",[owner,endpointHash(input.endpoint),new Date(now()).toISOString()]);
      if(!rows.length)reject('PUSH_NOT_READY','请先开启此浏览器推送；测试每分钟最多一次。');
      try{await send(checkedSubscription(rows[0].subscription),options.push,'campus-reader-test');}catch{reject('PUSH_FAILED','推送服务未确认接收，请检查网络与系统通知权限后重试。');}
      return{accepted:true};
    }
    return transaction(owner,async(state,client)=>{
      const repo=repoFor(client),time=now();
      if(action==='reminders.add'){
        const schoolId=identifier(input.schoolId);
        const school=await authorizeSchool(repo,owner,schoolId);
        if(!Array.isArray(input.itemIds)||!input.itemIds.length||input.itemIds.length>20)reject('VALIDATION_FAILED','一次请选择1至20篇公告。');
        const itemIds=[...new Set(input.itemIds.map(identifier))];
        // Validate the entire selection before writing any draft. Added notices
        // do not acquire a guessed time or create notifications/AI requests.
        const rows=[];
        for(const itemId of itemIds)rows.push(await authorizedItem(repo,owner,schoolId,itemId,time));
        const additions=rows.filter(row=>!state.reminders.some(r=>r.schoolId===schoolId&&r.itemId===row._id));
        if(state.reminders.length+additions.length>100)reject('REMINDER_LIMIT','每个账号最多保存100条提醒，请先移除已完成事项。');
        state.reminders.unshift(...additions.map(row=>({id:id(),schoolId,itemId:row._id,label:'报名／事项截止',dueAt:null,days:[],title:String(row.title||'未命名公告').slice(0,300),schoolName:school.name,createdAt:new Date(time).toISOString(),generation:id(),fired:[]})));
      }else if(action==='reminders.save'){
        const existing=input.id===undefined?undefined:state.reminders.find(r=>r.id===identifier(input.id));
        if(input.id&&!existing)reject('NOT_FOUND','提醒不存在或不属于当前账号。');
        const schoolId=identifier(input.schoolId),itemId=identifier(input.itemId),row=await authorizedItem(repo,owner,schoolId,itemId,time,!existing);
        const school=await repo.school(schoolId),label=cleanText(input.label,80,'事项截止');
        if(typeof input.dueAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/.test(input.dueAt)||!Number.isFinite(Date.parse(input.dueAt))||new Date(input.dueAt).toISOString()!==input.dueAt||Date.parse(input.dueAt)<=time||Date.parse(input.dueAt)>time+2*366*day)reject('VALIDATION_FAILED','请选择未来两年内的有效日期和具体时间。');
        if(!Array.isArray(input.days)||!input.days.length||input.days.some(value=>![0,1,3,7].includes(value)))reject('VALIDATION_FAILED','请选择提前7天、3天、1天或到时提醒。');
        const days=[...new Set(input.days as number[])].filter(value=>Date.parse(input.dueAt as string)-value*day>time).sort((a,b)=>b-a);
        if(!days.length)reject('VALIDATION_FAILED','所选提醒时间均已过去，请选择更近的提醒档位。');
        const reminderId=existing?.id||id();
        if(existing&&(existing.schoolId!==schoolId||existing.itemId!==itemId))reject('VALIDATION_FAILED','编辑提醒不能变更关联公告。');
        if(!existing&&state.reminders.length>=100)reject('REMINDER_LIMIT','每个账号最多保存100条提醒，请先移除已完成事项。');
        state.reminders=state.reminders.filter(r=>r.id!==reminderId);
        state.reminders.unshift({id:reminderId,schoolId,itemId,label,dueAt:input.dueAt,days,title:String(row.title||'未命名公告').slice(0,300),schoolName:school!.name,createdAt:existing?.createdAt||new Date(time).toISOString(),generation:id(),fired:[]});
        for(const event of state.notifications)if(event.reminderId===reminderId)event.read=true;
      }else if(action==='reminders.remove'){
        const target=identifier(input.id);state.reminders=state.reminders.filter(r=>r.id!==target);for(const event of state.notifications)if(event.reminderId===target)event.read=true;
      }else if(action==='reminders.watch.save'){
        const schoolId=identifier(input.schoolId),school=await authorizeSchool(repo,owner,schoolId),keyword=cleanText(input.keyword,60);
        const watchId=input.id===undefined?id():identifier(input.id),existing=state.watches.find(w=>w.id===watchId);
        if(input.id&&!existing)reject('NOT_FOUND','关注规则不存在或不属于当前账号。');
        if(!existing&&state.watches.length>=10)reject('WATCH_LIMIT','每个账号最多保存10条关注规则。');
        if(state.watches.some(w=>w.id!==watchId&&w.schoolId===schoolId&&w.keyword.toLocaleLowerCase()===keyword.toLocaleLowerCase()))reject('WATCH_EXISTS','已经关注了这个学校和关键词。');
        state.watches=state.watches.filter(w=>w.id!==watchId);state.watches.push({id:watchId,schoolId,schoolName:school.name,keyword,createdAt:new Date(time).toISOString()});state.lastScan=undefined;
        for(const event of state.notifications)if(event.watchId===watchId)event.read=true;
      }else if(action==='reminders.watch.remove'){
        const target=identifier(input.id);state.watches=state.watches.filter(w=>w.id!==target);
        for(const event of state.notifications)if(event.watchId===target)event.read=true;
        await client.query('DELETE FROM campus_reminder_seen WHERE owner_id=$1 AND watch_id=$2',[owner,target]);
      }else if(!['reminders.state','reminders.read','reminders.export'].includes(action))reject('ACTION_NOT_ALLOWED','提醒操作不存在。');
      await synchronize(state,client,owner);
      if(action==='reminders.read'){const target=input.id===undefined?null:identifier(input.id);for(const event of state.notifications)if(!target||event.id===target)event.read=true;}
      if(action==='reminders.export'){
        const target=input.id===undefined?null:identifier(input.id),rows=state.reminders.filter((r):r is StoredReminder&{dueAt:string}=>(!target||r.id===target)&&r.dueAt!==null&&Date.parse(r.dueAt)>time);
        if(!rows.length)reject('NO_FUTURE_REMINDERS','当前没有已设置未来时间的提醒。请先在提醒中心逐条设置时间，或修改已到时间的事项。');
        return{content:reminderCalendar(rows,new Date(time).toISOString()),filename:'校园阅览室提醒.ics'};
      }
      return dto(state);
    });
  }
  async function dispatch(owner:string){
    if(!options.push)return{accepted:0,failed:0};
    const push=options.push;
    const jobs=await transaction(owner,async(state,client)=>{
      await synchronize(state,client,owner);
      const {rows}=await client.query('SELECT endpoint_hash,subscription FROM campus_push_devices WHERE owner_id=$1',[owner]);
      const result:Array<{hash:string;subscription:BrowserPushSubscription;ids:string[]}>=[];
      for(const device of rows){
        const pending=state.notifications.filter(event=>!event.read&&!event.sent[device.endpoint_hash]);
        if(!pending.length)continue;
        for(const event of pending)event.sent[device.endpoint_hash]='sending';
        result.push({hash:device.endpoint_hash,subscription:device.subscription,ids:pending.map(event=>event.id)});
      }
      return result;
    });
    let accepted=0,failed=0;
    await Promise.all(jobs.map(async job=>{
      let outcome:'sent'|'failed'='sent',expired=false;
      // Recheck the account binding immediately before each external request.
      const {rows}=await pool.query('SELECT owner_id FROM campus_push_devices WHERE endpoint_hash=$1',[job.hash]);
      if(rows[0]?.owner_id!==owner)return;
      const current=await pool.query('SELECT body FROM campus_reminder_accounts WHERE owner_id=$1',[owner]);
      if(!(current.rows[0]?.body.notifications as Notification[]|undefined)?.some(event=>job.ids.includes(event.id)&&!event.read))return;
      try{await send(checkedSubscription(job.subscription),push,notificationId(job.ids.join('/')).slice(0,32));accepted++;}
      catch(error){outcome='failed';failed++;expired=[404,410].includes(Number((error as {statusCode?:number})?.statusCode));}
      await transaction(owner,async(state,client)=>{
        for(const event of state.notifications)if(job.ids.includes(event.id))event.sent[job.hash]=outcome;
        if(expired)await client.query('DELETE FROM campus_push_devices WHERE owner_id=$1 AND endpoint_hash=$2',[owner,job.hash]);
      });
    }));
    return{accepted,failed};
  }
  return{handle,dispatch};
}

export async function runReminderTick(pool:SqlPool,options:Options&{budgetMs?:number}={}){
  const start=Date.now(),service=reminderService(pool,options);
  const {rows}=await pool.query('SELECT a.owner_id FROM campus_reminder_accounts a WHERE EXISTS(SELECT 1 FROM campus_push_devices d WHERE d.owner_id=a.owner_id) ORDER BY a.checked_at,a.owner_id LIMIT 20');
  let processed=0,accepted=0,failed=0;
  for(const row of rows){
    if(Date.now()-start>(options.budgetMs??18000))break;
    try{const result=await service.dispatch(row.owner_id);accepted+=result.accepted;failed+=result.failed;}
    catch{failed++;await pool.query('UPDATE campus_reminder_accounts SET checked_at=$2 WHERE owner_id=$1',[row.owner_id,new Date((options.now||Date.now)()).toISOString()]);}
    processed++;
  }
  return{processed,accepted,failed};
}
