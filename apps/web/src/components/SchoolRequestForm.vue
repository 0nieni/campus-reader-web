<script setup lang="ts">
import { ref } from 'vue';
import type { Transport } from '../lib/transport';
import { safeError } from '../lib/errors';
const props = defineProps<{transport:Transport}>();
const name = ref(''), busy = ref(false), message = ref(''), requestId = ref('');
async function submit() {
  if (busy.value) return;
  busy.value = true; message.value = ''; requestId.value = '';
  try {
    const result = await props.transport.call('school.request',{schoolName:name.value.trim()});
    message.value = result.message; requestId.value = result.id;
  } catch (error) { message.value = safeError(error); }
  finally { busy.value = false; }
}
</script>
<template>
  <form name="school-add-request" class="school-request" @submit.prevent="submit">
    <input type="hidden" name="form-name" value="school-add-request">
    <label for="request-school">输入你的学校名称</label>
    <input id="request-school" v-model="name" name="school" required minlength="2" maxlength="80" placeholder="请填写学校全称" :disabled="busy">
    <p class="muted small">提交后，学校名称和登录邮箱会发送给客服，用于核实公告入口和回复申请。每天最多申请 3 所学校。</p>
    <button class="primary" type="submit" :disabled="busy">{{busy ? '正在提交…' : '提交学校添加申请'}}</button>
    <p v-if="message" role="status">{{message}}</p>
    <p v-if="requestId" class="request-id">申请编号：{{requestId}}</p>
  </form>
</template>
<style scoped>
.school-request {margin:14px 0 24px;padding:18px;border:1px solid #d7e1ef;background:#f6f8fc;}
.school-request label {display:block;margin-bottom:10px;}
.school-request input:not([type=hidden]) {width:100%;box-sizing:border-box;}
.request-id {overflow-wrap:anywhere;font-size:12px;color:#6d7e96;}
</style>
