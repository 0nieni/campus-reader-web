<script setup lang="ts">
import {computed,onMounted,onUnmounted,ref,watch} from 'vue';
import type {Reminder,ReminderState,ReminderNotification,ReminderChannelDelivery,ReminderEmailState} from '@campus/contracts';
import type {Transport} from '../lib/transport';
import {safeError} from '../lib/errors';
import {pushSupport,currentPush,enablePush,disablePush} from '../lib/browser-push';
import ReminderForm from './ReminderForm.vue';
import ReminderNoticePicker from './ReminderNoticePicker.vue';
import ReminderEmailSettings from './ReminderEmailSettings.vue';
const props=defineProps<{transport:Transport;schoolId:string|null;schoolName:string;revision:number;visible:boolean}>();
const emit=defineEmits<{unread:[count:number];changed:[state:ReminderState];open:[event:ReminderNotification];back:[]}>();
const state=ref<ReminderState|null>(null),busy=ref(false),error=ref(''),message=ref(''),editing=ref<Reminder|null>(null),pushOn=ref(false),onlyUnread=ref(false),tab=ref<'notifications'|'schedule'>('notifications');
const clock=ref(Date.now()),support=ref('');
const notices=computed(()=>state.value?.notifications.filter(n=>!onlyUnread.value||!n.read)||[]);
const schedule=computed(()=>[...(state.value?.reminders||[])].sort((a,b)=>a.dueAt===null?b.dueAt===null?b.createdAt.localeCompare(a.createdAt):-1:b.dueAt===null?1:a.dueAt.localeCompare(b.dueAt)));
const futureCount=computed(()=>schedule.value.filter(r=>r.dueAt!==null&&Date.parse(r.dueAt)>clock.value).length);
const pendingCount=computed(()=>schedule.value.filter(r=>r.dueAt===null).length);
const exportHelp=computed(()=>futureCount.value?`仅导出${futureCount.value}条已设置未来时间的事项。`:pendingCount.value?'请先为待设置的公告填写未来时间，再导出日历。':'当前没有未来事项可导出；已到时间的提醒可重新设置时间。');
const deliverySummary=computed(()=>{
 if(!state.value)return'正在检查推送服务';
 if(state.value.scheduler==='aliyun-fc'&&state.value.queueConfigured){const labels={unconfigured:'分钟提醒服务待配置',waiting:'等待定时提醒服务连接',active:'每分钟检查已登记事项',stale:'定时提醒服务连接已中断',failed:'定时提醒登记暂时失败'};return labels[state.value.schedulerHealth||'waiting'];}
 return state.value.deliveryMode==='minute'?state.value.queueConfigured?'按设定时间登记后台提醒':'分钟提醒服务待配置':'后台每天09:00、20:00检查';
});
function channelText(delivery:ReminderChannelDelivery){
 const labels={off:'未选择',unconfigured:'服务待配置',not_ready:'尚未开启或验证',pending:'待登记',registration_failed:'登记尚未成功，请稍后检查提醒',scheduled:'已登记',accepted:'服务已接收',failed:'发送失败',unknown:'结果未知，未自动重发',finished:'已结束',retrying:'暂时失败，等待重试',limited:'发送量受限，暂缓发送'};
 return labels[delivery.status]+(delivery.nextAt?` · 下次 ${time(delivery.nextAt)}`:'');
}
function emailChanged(email:ReminderEmailState){if(state.value)state.value={...state.value,email};void load();}
function deliveryText(reminder:Reminder){
 const labels={unconfigured:'分钟提醒服务待配置，站内提醒与日历仍可使用。',no_device:'尚未开启设备推送，请先点击上方“开启此浏览器推送”。',pending:'提醒已保存，正在等待后台登记。',scheduled:'已登记后台提醒，关闭页面后也可接收系统推送。',later:'远期提醒已保存，将在临近时自动登记。',registration_failed:'后台登记尚未成功，稍后点击“检查提醒”重试。',sent:'推送服务已接收；是否弹出请以设备通知为准。',failed:'最近一次发送失败，请检查设备订阅并发送测试通知。',unknown:'发送结果暂未确认，为避免重复打扰未自动重发。',finished:'本次后台提醒已结束。'};
 return reminder.delivery?labels[reminder.delivery.status]:'';
}
let active=true,ticket=0,timer:ReturnType<typeof setTimeout>|undefined,lastCheck=0;
const time=(value:string)=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));
function apply(result:ReminderState){if(!active)return;ticket++;state.value=result;clock.value=Date.now();lastCheck=Date.now();emit('unread',result.unread);emit('changed',result);planNext();}
function planNext(){
 clearTimeout(timer);if(!active)return;
 const upcoming=(state.value?.reminders||[]).flatMap(r=>r.dueAt?r.days.map(days=>Date.parse(r.dueAt!)-days*86400000):[]).filter(at=>at>Date.now());
 const delay=Math.max(10000,Math.min(300000,...upcoming.map(at=>at-Date.now()+1000)));
 timer=setTimeout(()=>{clock.value=Date.now();if(document.visibilityState==='visible')void load();else planNext();},delay);
}
async function load(){
 if(busy.value)return;const current=++ticket;
 try{const result=await props.transport.call('reminders.state',{});if(active&&ticket===current){error.value='';apply(result);}}
 catch(caught){if(active&&ticket===current)error.value=safeError(caught);}
 finally{if(active)planNext();}
}
async function run(work:()=>Promise<void>){if(busy.value)return;busy.value=true;ticket++;error.value='';message.value='';try{await work();}catch(caught){if(active)error.value=(caught as any)?.code?safeError(caught):caught instanceof Error?caught.message:'操作未完成，请重试。';}finally{if(active){busy.value=false;planNext();}}}
async function read(id?:string){await run(async()=>apply(await props.transport.call('reminders.read',id?{id}:{})));}
async function remove(id:string){await run(async()=>{apply(await props.transport.call('reminders.remove',{id}));if(active&&editing.value?.id===id)editing.value=null;});}
function added(result:ReminderState){apply(result);if(active){tab.value='schedule';message.value='已加入提醒中心，请逐篇设置时间。';}}
function isFuture(reminder:Reminder){return reminder.dueAt!==null&&Date.parse(reminder.dueAt)>clock.value;}
async function download(id?:string){await run(async()=>{
 clock.value=Date.now();
 if(!schedule.value.some(r=>(!id||r.id===id)&&isFuture(r))){message.value=exportHelp.value;return;}
 try{
  const file=await props.transport.call('reminders.export',id?{id}:{});if(!active)return;
  const url=URL.createObjectURL(new Blob([file.content],{type:'text/calendar;charset=utf-8'})),anchor=document.createElement('a');anchor.href=url;anchor.download=file.filename;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  message.value='日历文件已导出，请导入日历并核对系统提醒设置。修改或取消网页提醒后，需要同步更新已导入的日历。';
 }catch(caught){
  if((caught as {code?:string})?.code!=='NO_FUTURE_REMINDERS')throw caught;
  if(active){clock.value=Date.now();apply(await props.transport.call('reminders.state',{}));message.value=exportHelp.value;}
 }
});}
async function togglePush(){await run(async()=>{
 if(pushOn.value){try{await disablePush(props.transport);if(active)message.value='此浏览器推送已关闭，站内提醒保留。';}finally{if(active)pushOn.value=Boolean(await currentPush());}}
 else if(state.value?.publicKey){await enablePush(props.transport,state.value.publicKey);if(active){pushOn.value=true;message.value='此浏览器已订阅，请发送测试通知并确认系统是否显示。';}}
 try{apply(await props.transport.call('reminders.state',{}));}catch{if(active)message.value+=' 请点击“检查提醒”刷新设备与登记状态。';}
});}
async function testPush(){await run(async()=>{const subscription=await currentPush();if(!subscription)throw new Error('当前浏览器订阅已失效，请重新开启推送。');await props.transport.call('reminders.push.test',{endpoint:subscription.endpoint});if(active)message.value='推送服务已接收测试请求，请检查系统通知；接收请求不代表设备已显示。';});}
function wake(){clock.value=Date.now();if(document.visibilityState==='visible'&&Date.now()-lastCheck>=60000)void load();}
watch(()=>props.revision,()=>void load());
watch(()=>props.visible,visible=>{if(visible)void load();});
onMounted(()=>{support.value=pushSupport();void load();void currentPush().then(async value=>{if(value){const result=await props.transport.call('reminders.push.status',{endpoint:value.endpoint});if(active)pushOn.value=result.active;}}).catch(()=>{});document.addEventListener('visibilitychange',wake);window.addEventListener('focus',wake);});
onUnmounted(()=>{active=false;ticket++;clearTimeout(timer);document.removeEventListener('visibilitychange',wake);window.removeEventListener('focus',wake);state.value=null;});
</script>
<template>
 <section class="feature-surface reminders-center" aria-labelledby="reminders-title">
  <header class="feature-heading reminder-heading"><div><h1 id="reminders-title">提醒中心 <span v-if="state?.unread" class="unread-count">{{state.unread}}条未读</span></h1><p class="muted">勾选公告后逐篇设置时间 · 当前账号独立保存 · 北京时间</p></div><button class="text-button" @click="emit('back')">返回公告</button></header>
  <aside class="reminder-delivery compact-delivery"><div class="delivery-copy"><strong>浏览器通知</strong><span class="small muted">{{deliverySummary}}</span><details><summary>说明与设备设置</summary><p v-if="state?.deliveryMode==='minute'">设定时间后请确认事项显示“已登记”。后台按设定时间发起推送；网络、系统权限或省电设置可能延迟显示。推送仅显示通用提示，登录后查看内容。</p><p v-else>网页打开时检查到期提醒；关闭后每天09:00、20:00后台检查。推送只显示通用提示，登录后查看内容。</p><ul><li>Windows：使用 Chrome 或 Edge，允许网站和系统通知；建议安装为应用，保留浏览器后台运行。</li><li>iPhone／iPad：在 Safari 中“添加到主屏幕”，从图标进入后开启推送。</li><li>安卓：使用支持网页推送的浏览器，允许通知及后台活动，以测试通知实测为准。</li></ul><p>每台设备都需登录后单独开启。退出账号会解绑当前浏览器；每账号最多5个浏览器。</p><p v-if="state?.deviceCount!==undefined">当前账号已开启 {{state.deviceCount}} 个浏览器。</p><p v-if="support">{{support}}</p><p v-else-if="state&&!state.pushConfigured">此环境暂未开启浏览器推送。预览环境仅验证站内提醒与日历。</p></details></div><div class="action-row"><button class="secondary" :disabled="busy||(!pushOn&&Boolean(support||!state?.pushConfigured))" @click="togglePush">{{pushOn?'关闭此浏览器推送':'开启此浏览器推送'}}</button><button v-if="pushOn&&state?.pushConfigured" class="text-button" :disabled="busy" @click="testPush">发送测试通知</button></div></aside>
  <ReminderEmailSettings v-if="state?.email" :transport="transport" :state="state.email" @changed="emailChanged" />
  <p v-if="support" class="small muted push-support-note">{{support}}</p>
  <p v-if="error" class="error-message" role="alert">{{error}}</p><p v-if="message" class="reminder-feedback" role="status">{{message}}</p>
  <div class="reminder-workspace">
   <div class="reminder-content">
    <nav class="reminder-tabs" aria-label="提醒分类"><button :class="{active:tab==='notifications'}" @click="tab='notifications'">消息通知</button><button :class="{active:tab==='schedule'}" @click="tab='schedule'">时间提醒（{{state?.reminders.length||0}}）</button></nav>
    <div v-if="!state&&!error" class="empty-state" role="status">正在检查提醒…</div>
    <template v-if="tab==='notifications'&&state">
     <div class="reminder-toolbar"><label><input v-model="onlyUnread" type="checkbox">只看未读</label><div class="action-row"><button class="text-button" :disabled="busy" @click="load">{{state.more?'继续检查新公告':'检查提醒'}}</button><button class="text-button" :disabled="busy||!state.unread" @click="read()">全部标为已读</button></div></div>
     <div v-if="!notices.length" class="empty-state"><h2>{{onlyUnread?'没有未读提醒':'还没有提醒消息'}}</h2><p>在“选择公告”中勾选加入，再到“时间提醒”逐篇设置时间。</p></div>
     <article v-for="notice in notices" :key="notice.id" class="reminder-message" :class="{unread:!notice.read}"><div><span class="small muted">{{notice.kind==='deadline'?'时间提醒':'新公告'}} · {{time(notice.createdAt)}}</span><h2><button class="favorite-open" @click="emit('open',notice);read(notice.id)">{{notice.title}}</button></h2><p>{{notice.message}}</p></div><button v-if="!notice.read" class="text-button" :disabled="busy" @click="read(notice.id)">标为已读</button></article>
     <p class="small muted reminder-footnote">保留最近90天、最多200条通知。加入公告后请逐篇设置时间；未设置时间不会开始提醒。</p>
    </template>
    <template v-if="tab==='schedule'&&state">
     <div class="reminder-toolbar"><p class="muted">待设置 {{pendingCount}} 条 · 可导出 {{futureCount}} 条</p><div class="action-row"><button class="text-button" :disabled="busy" @click="load">检查提醒</button><button class="text-button" :disabled="busy||!futureCount" :title="exportHelp" @click="download()">导出全部日历</button></div></div>
     <p class="small muted calendar-guidance">{{exportHelp}}</p>
     <div v-if="!schedule.length" class="empty-state"><h2>还没有加入公告</h2><p>从“选择公告”中勾选加入，或在公告列表点击“加入提醒”。</p></div>
     <article v-for="reminder in schedule" :key="reminder.id" class="reminder-schedule" :class="{'pending-time':reminder.dueAt===null}">
      <div class="reminder-date"><time v-if="reminder.dueAt">{{time(reminder.dueAt)}}</time><span v-else>待设置时间</span><span v-if="reminder.dueAt&&!isFuture(reminder)" class="small muted schedule-status">已到时间</span></div>
      <div><p class="small muted">{{reminder.schoolName}} · {{reminder.label}}</p><h2>{{reminder.title}}</h2><p class="small">{{reminder.dueAt?reminder.days.map(days=>days?`提前${days}天`:'到时').join('、'):'尚未开始提醒，请先设置具体时间。'}}</p>
       <div v-if="reminder.dueAt&&reminder.channelDelivery" class="small muted reminder-channel-status" role="status"><p>浏览器通知：{{channelText(reminder.channelDelivery.browser)}}</p><p>邮件提醒：{{channelText(reminder.channelDelivery.email)}}</p></div>
       <p v-else-if="reminder.dueAt&&reminder.delivery" class="small muted reminder-delivery-status" role="status">{{deliveryText(reminder)}}<span v-if="reminder.delivery.nextAt"> 下次：{{time(reminder.delivery.nextAt)}}。</span></p>
       <div class="action-row"><button class="text-button" :disabled="busy" @click="editing=editing?.id===reminder.id?null:reminder">{{reminder.dueAt?'编辑时间':'设置时间'}}</button><button class="text-button" :disabled="busy||!isFuture(reminder)" :title="isFuture(reminder)?'导出这条事项':'请先设置未来时间'" @click="download(reminder.id)">导出日历</button><button class="text-button" :disabled="busy" @click="remove(reminder.id)">移出提醒</button></div>
       <ReminderForm v-if="editing?.id===reminder.id" :key="reminder.id" :transport="transport" :school-id="reminder.schoolId" :item-id="reminder.itemId" :title="reminder.title" :reminder="reminder" @saved="apply($event);editing=null" @cancel="editing=null" />
      </div>
     </article>
    </template>
   </div>
   <ReminderNoticePicker v-if="visible" :key="schoolId||'none'" :transport="transport" :school-id="schoolId" :school-name="schoolName" :reminders="state?.reminders||[]" @added="added" />
  </div>
 </section>
</template>
