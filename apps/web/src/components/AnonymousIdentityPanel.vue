<script setup lang="ts">
import {onMounted,onUnmounted,ref} from 'vue';
import type {AnonymousState,AnonymousTransfer,AnonymousImport} from '@campus/contracts';
import type {Transport} from '../lib/transport';
import {safeError} from '../lib/errors';
const props=defineProps<{transport:Transport}>();
const emit=defineEmits<{imported:[result:AnonymousImport]}>();
const state=ref<AnonymousState|null>(null),transfer=ref<AnonymousTransfer|null>(null),code=ref(''),busy=ref(false),loading=ref(true),error=ref(''),message=ref('');
let active=true,timer:ReturnType<typeof setInterval>|undefined;
const time=(value:string)=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));
onMounted(async()=>{
 try{const result=await props.transport.anonymous!.state();if(active)state.value=result;}catch(caught){if(active)error.value=safeError(caught);}finally{if(active)loading.value=false;}
 if(!active)return;
 timer=setInterval(()=>{if(transfer.value&&Date.parse(transfer.value.expiresAt)<=Date.now()){transfer.value=null;if(state.value)state.value.transferExpiresAt=null;message.value='迁移码已过期，请重新生成。';}},1000);
});
onUnmounted(()=>{active=false;clearInterval(timer);transfer.value=null;code.value='';});
async function run(work:()=>Promise<void>){if(busy.value||loading.value)return;busy.value=true;error.value='';message.value='';try{await work();}catch(caught){if(active)error.value=safeError(caught);}finally{if(active)busy.value=false;}}
function generate(){return run(async()=>{const result=await props.transport.anonymous!.createTransfer();if(active){transfer.value=result;if(state.value)state.value.transferExpiresAt=result.expiresAt;message.value='迁移码已生成，仅显示在本次窗口中。';}});}
function cancel(){return run(async()=>{await props.transport.anonymous!.cancelTransfer();if(active){transfer.value=null;if(state.value)state.value.transferExpiresAt=null;message.value='迁移码已撤销。';}});}
async function copy(){if(!transfer.value||busy.value)return;try{await navigator.clipboard.writeText(transfer.value.code);if(active)message.value='已复制，请在另一台设备的个人工作区导入。';}catch{if(active)message.value='复制未成功，请手动选中迁移码复制。';}}
function importCode(){return run(async()=>{const result=await props.transport.anonymous!.importTransfer(code.value.trim());if(active){code.value='';transfer.value=null;emit('imported',result);}});}
</script>
<template>
 <section class="account-section anonymous-identity" aria-labelledby="anonymous-title">
  <h3 id="anonymous-title">匿名身份与迁移</h3>
  <p>公告、收藏和提醒保存在本设备的匿名工作区。登录只解锁 AI，不会切换这些数据。</p>
  <p v-if="loading" role="status">正在读取匿名身份…</p>
  <p v-if="state" class="anonymous-id"><span>匿名身份编号</span><code>{{state.id}}</code></p>
  <p class="small muted">编号用于区分工作区。换设备时，请使用下方的一次性迁移码。清除网站数据或使用无痕窗口会产生新的身份。</p>
  <div class="anonymous-transfer">
   <h4>导出到其他设备</h4><p>迁移学校、收藏、个人标签、来源显示选择和提醒。原设备的数据保留。</p>
   <div class="action-row"><button type="button" class="close-btn" :disabled="busy||loading||!state" @click="generate">{{busy?'正在处理…':state?.transferExpiresAt?'重新生成迁移码':'生成一次性迁移码'}}</button><button v-if="state?.transferExpiresAt" type="button" class="text-button" :disabled="busy" @click="cancel">撤销迁移码</button></div>
   <template v-if="transfer"><label for="anonymous-export">一次性迁移码</label><div class="anonymous-code-row"><input id="anonymous-export" :value="transfer.code" readonly spellcheck="false" autocomplete="off"><button type="button" class="secondary" :disabled="busy" @click="copy">复制迁移码</button></div><p class="small">北京时间 {{time(transfer.expiresAt)}} 前有效，导入后失效。请私下传给自己的设备。</p></template>
   <p v-else-if="state?.transferExpiresAt" class="small">已有迁移码，有效至北京时间 {{time(state.transferExpiresAt)}}。关闭窗口后无法再次查看，可撤销或重新生成。</p>
  </div>
  <form class="anonymous-transfer" @submit.prevent="importCode">
   <h4>从其他设备导入</h4><p>与本设备数据合并，已有收藏、标签和来源选择保留；阅读学校切换为导入的学校。失效或私有公告会跳过。</p>
   <label for="anonymous-import">粘贴另一台设备的迁移码</label><input id="anonymous-import" v-model="code" type="password" maxlength="100" autocomplete="off" spellcheck="false" required :disabled="busy||loading" placeholder="CR-…">
   <p class="small muted">导入后，本设备的提醒邮箱需重新验证，推送需重新检查并授权。AI账号、API密钥、聊天和记忆不迁移。</p>
   <button type="submit" class="close-btn" :disabled="busy||loading||!state||!code.trim()">导入并使用</button>
  </form>
  <p v-if="message" role="status">{{message}}</p><p v-if="error" class="error-message" role="alert">{{error}}</p>
 </section>
</template>
