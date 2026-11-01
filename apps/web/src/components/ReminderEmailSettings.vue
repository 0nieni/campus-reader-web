<script setup lang="ts">
import {ref,onUnmounted} from 'vue';
import type {ReminderEmailState} from '@campus/contracts';
import type {Transport} from '../lib/transport';
import {safeError} from '../lib/errors';
const props=defineProps<{transport:Transport;state:ReminderEmailState}>();
const emit=defineEmits<{changed:[state:ReminderEmailState]}>();
const busy=ref(false),error=ref(''),message=ref(''),email=ref('');let active=true;
onUnmounted(()=>{active=false;});
async function bind(){
 if(busy.value||!email.value.trim())return;busy.value=true;error.value='';message.value='';
 try{const result=await props.transport.call('reminders.email.bind',{email:email.value.trim()});if(active){emit('changed',result);email.value='';message.value='邮箱已保存，请点击“验证当前邮箱”接收验证邮件。';}}
 catch(caught){if(active)error.value=safeError(caught);}finally{if(active)busy.value=false;}
}
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
  <div class="email-setting-main"><div><strong>邮件提醒</strong><span class="small muted">{{state.address||(state.identityKind==='guest'?'尚未填写提醒邮箱':'当前账号邮箱')}} · {{state.suspended?'因退信或投诉已暂停':state.verified?'已验证':'待验证'}} · {{state.enabled?'已开启':'已关闭'}}</span></div>
   <div class="action-row"><button v-if="!state.verified||state.suspended" class="secondary" :disabled="busy||!state.configured||!state.address" @click="run('reminders.email.verify')">验证当前邮箱</button><button v-else class="secondary" :disabled="busy||(!state.enabled&&!state.configured)" @click="run('reminders.email.enable',!state.enabled)">{{state.enabled?'关闭邮件提醒':'开启邮件提醒'}}</button><button v-if="state.enabled" class="text-button" :disabled="busy||!state.configured" @click="run('reminders.email.test')">发送测试邮件</button></div>
  </div>
  <form v-if="state.identityKind==='guest'" class="anonymous-email-form" @submit.prevent="bind"><label for="guest-reminder-email">提醒收件邮箱</label><div class="anonymous-code-row"><input id="guest-reminder-email" v-model="email" type="email" required maxlength="254" autocomplete="email" :disabled="busy" :placeholder="state.address?'填写新邮箱以更换':'输入你的邮箱'"><button type="submit" class="secondary" :disabled="busy||!email.trim()">保存邮箱</button></div><p class="small muted">保存后需验证并主动开启。更换邮箱或导入迁移码后需重新验证。</p></form>
  <p class="small muted">{{state.configured?`仅发往${state.identityKind==='guest'?'单独验证的提醒':'当前账号'}邮箱；验证和测试也计入每日发送量。`:'邮件服务待配置，预览环境不发送真实邮件。'}} {{state.configured?`今天已尝试 ${state.usedToday}／${state.dailyLimit} 封。`:''}}</p>
  <p v-if="message" class="small" role="status">{{message}}</p><p v-if="error" class="error-message" role="alert">{{error}}</p>
 </aside>
</template>
