<script setup lang="ts">
import {ref,onUnmounted} from 'vue';
import type {Reminder,ReminderState} from '@campus/contracts';
import type {Transport} from '../lib/transport';
import {safeError} from '../lib/errors';
const props=defineProps<{transport:Transport;schoolId:string;itemId:string;title:string;reminder?:Reminder}>();
const emit=defineEmits<{saved:[state:ReminderState];cancel:[]}>();
const expanded=ref(Boolean(props.reminder)),label=ref(props.reminder?.label||'报名／事项截止'),when=ref(props.reminder?.dueAt?new Date(Date.parse(props.reminder.dueAt)+8*3600000).toISOString().slice(0,16):''),days=ref(props.reminder?.days.length?[...props.reminder.days]:[7,3,1,0]),busy=ref(false),error=ref(''),message=ref('');
let active=true;onUnmounted(()=>{active=false;});
async function save(){
 if(busy.value)return;busy.value=true;error.value='';message.value='';
 try{
  if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(when.value))throw new Error('请选择有效日期和具体时间。');
  const parsed=new Date(when.value+':00+08:00');
  if(!Number.isFinite(parsed.getTime())||new Date(parsed.getTime()+8*3600000).toISOString().slice(0,16)!==when.value)throw new Error('日期无效，请重新选择。');
  const result=await props.transport.call('reminders.save',{...(props.reminder?{id:props.reminder.id}:{}),schoolId:props.schoolId,itemId:props.itemId,label:label.value,dueAt:parsed.toISOString(),days:days.value});
  if(!active)return;emit('saved',result);message.value='提醒已保存；已过去的提前档位会自动略过。';expanded.value=false;
 }catch(caught){if(active)error.value=caught instanceof Error&&!(caught as any).code?caught.message:safeError(caught);}finally{if(active)busy.value=false;}
}
</script>
<template>
 <div class="reminder-editor">
  <button v-if="!expanded" class="secondary" @click="expanded=true;message=''">{{reminder?'编辑提醒':'设置提醒'}}</button>
  <p v-if="message" class="small" role="status">{{message}}</p>
  <form v-if="expanded" class="reminder-form" @submit.prevent="save">
   <fieldset :disabled="busy"><legend>{{reminder?.dueAt?'编辑提醒时间':'设置提醒时间'}}</legend>
    <p class="small muted">{{title}}。请核对原文后填写，时间统一按北京时间，不调用 AI。</p>
    <label>事项名称<input v-model="label" required maxlength="80" placeholder="例如：报名截止"></label>
    <label>截止或自定时间（北京时间）<input v-model="when" required type="datetime-local"></label>
    <div class="reminder-offsets" role="group" aria-label="提醒时间"><label v-for="value in [7,3,1,0]" :key="value"><input v-model="days" type="checkbox" :value="value">{{value?`提前${value}天`:'到时提醒'}}</label></div>
    <p class="small muted">站内检查会补显错过的提醒；后台推送每天09:00、20:00检查，可能晚于所设时刻。需要更及时的系统提醒可导出手机日历。</p>
    <p v-if="error" class="error-message" role="alert">{{error}}</p>
    <div class="action-row"><button class="primary" type="submit">{{busy?'正在保存…':'保存提醒'}}</button><button class="text-button" type="button" @click="expanded=false;emit('cancel')">取消</button></div>
   </fieldset>
  </form>
 </div>
</template>
