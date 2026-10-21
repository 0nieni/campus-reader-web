<script setup lang="ts">
import {ref,onUnmounted} from 'vue';
import type {ReminderEmailState} from '@campus/contracts';
import type {Transport} from '../lib/transport';
import {safeError} from '../lib/errors';
const props=defineProps<{transport:Transport;state:ReminderEmailState}>();
const emit=defineEmits<{changed:[state:ReminderEmailState]}>();
const busy=ref(false),error=ref(''),message=ref('');let active=true;
onUnmounted(()=>{active=false;});
async function run(action:'reminders.email.verify'|'reminders.email.test'|'reminders.email.enable',enabled?:boolean){
 if(busy.value)return;busy.value=true;error.value='';message.value='';
 try{
  const result=action==='reminders.email.enable'?await props.transport.call(action,{enabled:enabled!}):await props.transport.call(action,{});
  if(!active)return;emit('changed',result);
  message.value=action==='reminders.email.verify'?'验证邮件已交给邮件服务。请查看收件箱和垃圾箱；完成验证后，返回这里点击“检查提醒”，再主动开启邮件。':action==='reminders.email.test'?'邮件服务已接收测试请求，请到邮箱核对是否收到。':enabled?'邮件提醒已开启。请在需要提醒的事项中勾选“邮件提醒”；历史事项不会自动开启。':'邮件提醒已关闭，后续发送将停止。已被邮件服务接收的邮件可能仍会送达。';
 }catch(caught){if(active)error.value=safeError(caught);}finally{if(active)busy.value=false;}
}
</script>
<template>
 <aside class="reminder-email-settings" aria-label="邮件提醒设置">
  <div class="email-setting-main"><div><strong>邮件提醒</strong><span class="small muted">{{state.address||'当前账号邮箱'}} · {{state.suspended?'因退信或投诉已暂停':state.verified?'已验证':'待验证'}} · {{state.enabled?'已开启':'已关闭'}}</span></div>
   <div class="action-row"><button v-if="!state.verified||state.suspended" class="secondary" :disabled="busy||!state.configured||!state.address" @click="run('reminders.email.verify')">验证当前邮箱</button><button v-else class="secondary" :disabled="busy||(!state.enabled&&!state.configured)" @click="run('reminders.email.enable',!state.enabled)">{{state.enabled?'关闭邮件提醒':'开启邮件提醒'}}</button><button v-if="state.enabled" class="text-button" :disabled="busy||!state.configured" @click="run('reminders.email.test')">发送测试邮件</button></div>
  </div>
  <p class="small muted">{{state.configured?'仅发往当前账号邮箱；验证和测试也计入每日发送量。':'邮件服务待配置，预览环境不发送真实邮件。'}} {{state.configured?`今天已尝试 ${state.usedToday}／${state.dailyLimit} 封。`:''}}</p>
  <p v-if="message" class="small" role="status">{{message}}</p><p v-if="error" class="error-message" role="alert">{{error}}</p>
 </aside>
</template>
