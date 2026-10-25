<script setup lang="ts">
import { onUnmounted, ref } from 'vue';
import type { Transport } from '../lib/transport';
import { safeError } from '../lib/errors';
const props=defineProps<{transport:Transport;disabled?:boolean}>();
const emit=defineEmits<{back:[];sent:[email:string]}>();
const email=ref(''),password=ref(''),confirmation=ref(''),busy=ref(false),error=ref(''),sent=ref(false);
let active=true;
onUnmounted(()=>{active=false;password.value='';confirmation.value='';});
async function register(){
  if(busy.value||props.disabled||!props.transport.signUp)return;
  error.value='';
  if(password.value.length<12||password.value.length>256||password.value!==confirmation.value){error.value='请设置12至256位密码，并确保两次输入一致。';return;}
  const secret=password.value,address=email.value.trim();password.value='';confirmation.value='';busy.value=true;
  try{await props.transport.signUp(address,secret);if(active){sent.value=true;emit('sent',address);}}
  catch(caught){if(active)error.value=safeError(caught);}
  finally{if(active)busy.value=false;}
}
</script>
<template>
  <div v-if="sent" class="registration-sent" role="status">
    <span class="auth-success-mark" aria-hidden="true">✓</span><h3>下一步，确认你的邮箱</h3>
    <p>请查看 <strong>{{email.trim()}}</strong> 的确认邮件，点击邮件中的链接，完成验证后即可进入阅览室。</p>
    <p class="account-help">没有看到邮件？请检查垃圾邮件，并确认邮箱填写正确。请勿重复提交注册。</p>
    <button type="button" class="primary login-button" @click="emit('back')">返回登录</button>
  </div>
  <form v-else data-test="registration-form" @submit.prevent="register">
    <label for="register-email">邮箱</label><input id="register-email" v-model="email" type="email" autocomplete="email" required maxlength="254" :disabled="busy||disabled" placeholder="用于登录和接收验证邮件" />
    <label for="register-password">设置密码</label><input id="register-password" v-model="password" type="password" autocomplete="new-password" required minlength="12" maxlength="256" :disabled="busy||disabled" placeholder="至少12位，建议组合字母与数字" />
    <label for="register-confirmation">确认密码</label><input id="register-confirmation" v-model="confirmation" type="password" autocomplete="new-password" required minlength="12" maxlength="256" :disabled="busy||disabled" placeholder="再输入一次密码" />
    <p v-if="error" class="error-message" role="alert">{{error}}</p>
    <p class="account-help">验证邮箱后自动开通。每个账号分别保存学校、收藏、提醒和个人模型配置。</p>
    <button type="submit" class="primary login-button" :disabled="busy||disabled">{{busy?'正在提交…':'注册并发送验证邮件'}}</button>
    <button type="button" class="text-button auth-back" :disabled="busy" @click="emit('back')">已有账号，返回登录</button>
  </form>
</template>
