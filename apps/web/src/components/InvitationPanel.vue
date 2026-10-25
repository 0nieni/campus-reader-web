<script setup lang="ts">
import { ref, onUnmounted } from 'vue';
import { acceptInvite } from '@netlify/identity';
import TemplateIcon from './TemplateIcon.vue';
const props = defineProps<{ token: string }>();
const emit = defineEmits<{ complete: [] }>();
const password = ref(''), confirmation = ref(''), busy = ref(false), error = ref('');
onUnmounted(() => { password.value = ''; confirmation.value = ''; });
async function accept() {
  if (busy.value) return;
  if (password.value.length < 12 || password.value.length > 256 || password.value !== confirmation.value) { error.value = '请设置至少 12 位密码，并确保两次输入一致。'; return; }
  const value = password.value; password.value = ''; confirmation.value = ''; busy.value = true; error.value = '';
  try { await acceptInvite(props.token, value); emit('complete'); }
  catch { error.value = '邀请未能完成，请确认链接未过期，并稍后重试。'; }
  finally { busy.value = false; }
}
</script>
<template>
  <section class="form-wrap" aria-labelledby="invite-title">
    <div class="welcome">WELCOME TO CAMPUS READER</div>
    <h2 id="invite-title">设置你的阅览室密码</h2>
    <p class="sub">此邀请仅用于本站账号。设置完成后即可登录。</p>
    <form @submit.prevent="accept">
      <div class="field"><div class="field-head"><label for="invite-password">设置密码</label></div><div class="input-box"><TemplateIcon name="lock" /><input id="invite-password" v-model="password" type="password" autocomplete="new-password" minlength="12" maxlength="256" required :disabled="busy" /></div></div>
      <div class="field"><div class="field-head"><label for="invite-confirm">再输入一次</label></div><div class="input-box"><TemplateIcon name="lock" /><input id="invite-confirm" v-model="confirmation" type="password" autocomplete="new-password" required maxlength="256" :disabled="busy" /></div></div>
      <p v-if="error" role="alert" class="error-message">{{ error }}</p>
      <button class="submit" type="submit" :disabled="busy">{{ busy ? '正在开通…' : '完成设置' }}</button>
    </form>
  </section>
</template>
