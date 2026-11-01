<script setup lang="ts">
import { onUnmounted,ref } from 'vue';
import type {Transport} from '../lib/transport';
import {ClientError,safeError} from '../lib/errors';
import TemplateIcon from './TemplateIcon.vue';
const props=defineProps<{token:string;transport:Transport}>();
const emit=defineEmits<{complete:[];back:[]}>();
const password=ref(''),confirmation=ref(''),busy=ref(false),error=ref('');let active=true;
onUnmounted(()=>{active=false;password.value='';confirmation.value='';});
async function reset(){
  if(busy.value)return;
  if(password.value.length<12||password.value.length>256||password.value!==confirmation.value){error.value='请设置12至256位密码，并确保两次输入一致。';return;}
  const secret=password.value;password.value='';confirmation.value='';busy.value=true;error.value='';
  try{if(!props.transport.recoverPassword)throw new ClientError('RECOVERY_UNAVAILABLE','本站密码重置暂未启用。');await props.transport.recoverPassword(props.token,secret);if(active)emit('complete');}
  catch(caught){if(active)error.value=safeError(caught);}
  finally{if(active)busy.value=false;}
}
</script>
<template>
 <section class="form-wrap recovery-panel" aria-labelledby="recovery-title">
  <div class="welcome">RESET PASSWORD</div><h2 id="recovery-title">设置新密码</h2><p class="sub">完成后即可使用新密码登录校园阅览室。</p>
  <form @submit.prevent="reset">
   <div class="field"><div class="field-head"><label for="recovery-password">新密码</label></div><div class="input-box"><TemplateIcon name="lock"/><input id="recovery-password" v-model="password" type="password" required minlength="12" maxlength="256" autocomplete="new-password" :disabled="busy" placeholder="至少12位"/></div></div>
   <div class="field"><div class="field-head"><label for="recovery-confirm">确认新密码</label></div><div class="input-box"><TemplateIcon name="lock"/><input id="recovery-confirm" v-model="confirmation" type="password" required minlength="12" maxlength="256" autocomplete="new-password" :disabled="busy" placeholder="再输入一次"/></div></div>
   <p v-if="error" role="alert" class="error-message">{{error}}</p><button class="submit" :disabled="busy">{{busy?'正在重置…':'保存新密码'}}</button>
  </form><button type="button" class="switch-mode auth-back" :disabled="busy" @click="emit('back')">返回登录</button>
 </section>
</template>
