<script setup lang="ts">
import { onMounted,onUnmounted,ref } from 'vue';
import type {Transport} from '../lib/transport';
import {safeError} from '../lib/errors';
const props=defineProps<{token:string;transport:Transport}>();
const emit=defineEmits<{complete:[];back:[]}>();
const busy=ref(true),error=ref('');let active=true;
onUnmounted(()=>{active=false;});
onMounted(async()=>{
  try{if(!props.transport.confirmEmail)throw Error('Unavailable');await props.transport.confirmEmail(props.token);if(active)emit('complete');}
  catch(caught){if(active)error.value=safeError(caught);}
  finally{if(active)busy.value=false;}
});
</script>
<template>
  <main class="confirmation-wrap"><section class="login-panel confirmation-panel" aria-labelledby="confirmation-title" :aria-busy="busy">
    <span class="panel-kicker">邮箱验证</span><h1 id="confirmation-title">{{busy?'正在打开你的阅览室':'确认邮箱'}}</h1>
    <p v-if="busy" role="status">正在核对邮件中的确认链接，请稍候…</p>
    <p v-if="error" class="error-message" role="alert">{{error}}</p>
    <button v-if="!busy" type="button" class="primary login-button" @click="emit('back')">返回登录</button>
  </section></main>
</template>
