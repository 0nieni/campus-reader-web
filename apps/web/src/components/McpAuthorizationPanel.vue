<script setup lang="ts">
import {onMounted,onUnmounted,ref} from 'vue';
import type {McpConsent,McpScope} from '@campus/contracts';
import type {Transport} from '../lib/transport';
import {safeError} from '../lib/errors';
const props=defineProps<{transport:Transport;ticket:string}>();
const emit=defineEmits<{back:[]}>();
const info=ref<McpConsent|null>(null),selected=ref<McpScope[]>([]),loading=ref(true),busy=ref(false),error=ref('');let active=true;
const names:Record<McpScope,string>={'announcements:read':'查询学校、公开公告和正文','bookmarks:read':'读取当前工作区收藏','bookmarks:write':'添加和取消当前工作区收藏','reminders:read':'读取提醒、导出日历','reminders:write':'创建、修改和取消提醒',offline_access:'允许保持连接（最长90天，可随时撤销）'};
onMounted(async()=>{try{await props.transport.anonymous!.state();const result=await props.transport.mcp!.consent(props.ticket);if(active){info.value=result;selected.value=result.scopes.filter(scope=>!scope.endsWith(':write'));}}catch(caught){if(active)error.value=safeError(caught);}finally{if(active)loading.value=false;}});
onUnmounted(()=>{active=false;});
async function decide(approved:boolean){
 if(busy.value||!info.value)return;busy.value=true;error.value='';
 try{const result=await props.transport.mcp!.decide({ticket:props.ticket,approved,scopes:[...selected.value]});if(active)location.assign(result.redirect);}
 catch(caught){if(active)error.value=safeError(caught);}finally{if(active)busy.value=false;}
}
</script>
<template>
 <div class="form-wrap mcp-consent" aria-labelledby="mcp-consent-title" :aria-busy="loading||busy">
  <div class="welcome">MCP AUTHORIZATION</div><h2 id="mcp-consent-title">授权外部 AI</h2><p v-if="loading" role="status">正在核对连接请求…</p>
  <template v-if="info"><p><strong>{{info.clientName}}</strong> 请求访问你的匿名工作区。</p><div class="mcp-client-info"><p>客户端来源：<strong>{{info.clientOrigin}}</strong></p><p v-if="info.redirectOrigin!==info.clientOrigin">返回地址：{{info.redirectOrigin}}</p><p>匿名身份：<code>{{info.workspaceId}}</code></p></div>
   <p class="small muted">请确认这是保存了你所需收藏和提醒的浏览器。新浏览器可先返回网站导入迁移码，再重新连接。此授权不需要登录AI账号。</p>
   <fieldset :disabled="busy"><legend>选择允许的操作</legend><label v-for="scope in info.scopes" :key="scope" class="mcp-permission"><input v-model="selected" type="checkbox" :value="scope">{{names[scope]}}</label></fieldset>
   <p class="small muted">可在“个人工作区 → MCP连接”随时撤销。邮箱验证、设备订阅、AI密钥与聊天不在授权范围内；新提醒不会自动开启外部发送。</p>
   <button type="button" class="submit" :disabled="busy||!selected.some(scope=>scope!=='offline_access')" @click="decide(true)">{{busy?'正在处理…':'允许所选操作并返回客户端'}}</button><button type="button" class="text-button mcp-deny" :disabled="busy" @click="decide(false)">拒绝并返回客户端</button>
  </template>
  <p v-if="error" class="error-message" role="alert">{{error}}</p><button type="button" class="text-button" :disabled="busy" @click="emit('back')">返回匿名工作区</button>
 </div>
</template>
