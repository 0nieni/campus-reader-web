<script setup lang="ts">
import { onMounted,onUnmounted,ref } from 'vue';
import type {AuthSession} from '@campus/contracts';
import type {Transport} from '../lib/transport';
import {safeError} from '../lib/errors';
const props=defineProps<{token:string;attempt?:Promise<AuthSession>;transport:Transport}>();
const emit=defineEmits<{complete:[];back:[]}>();
const busy=ref(true),error=ref('');let active=true;
onUnmounted(()=>{active=false;});
onMounted(async()=>{
  try{if(props.attempt)await props.attempt;else{if(!props.transport.confirmEmail)throw Error('Unavailable');await props.transport.confirmEmail(props.token);}if(active)emit('complete');}
  catch(caught){if(active)error.value=safeError(caught);}
  finally{if(active)busy.value=false;}
});
</script>
<template>
  <div class="form-wrap confirmation-panel" aria-labelledby="confirmation-title" :aria-busy="busy">
    <div class="welcome">EMAIL VERIFICATION</div><h2 id="confirmation-title">{{busy?'正在打开你的阅览室':'确认邮箱'}}</h2>
    <p v-if="busy" role="status">正在核对邮件中的确认链接，请稍候…</p>
    <p v-if="error" class="error-message" role="alert">{{error}}</p>
    <button v-if="!busy" type="button" class="submit" @click="emit('back')">返回登录</button>
  </div>
</template>
