<script setup lang="ts">
import {onMounted,onUnmounted,ref} from 'vue';
import type {McpScope,McpConnections} from '@campus/contracts';
import type {Transport} from '../lib/transport';
import {safeError} from '../lib/errors';
import TemplateIcon from './TemplateIcon.vue';
const props=defineProps<{transport:Transport}>();
const state=ref<McpConnections|null>(null),name=ref(''),token=ref(''),showToken=ref(false),loading=ref(true),busy=ref(false),error=ref(''),message=ref('');
const selected=ref<McpScope[]>(['announcements:read','bookmarks:read','reminders:read']);
const choices:Array<[McpScope,string]>=[['announcements:read','查询公开公告与正文'],['bookmarks:read','读取我的收藏'],['bookmarks:write','添加和取消收藏'],['reminders:read','读取提醒与导出日历'],['reminders:write','创建、修改和取消提醒']];
let active=true;
const label=(scope:McpScope)=>scope==='offline_access'?'保持连接':choices.find(row=>row[0]===scope)?.[1]||scope;
const time=(value:string)=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));
async function load(){try{const result=await props.transport.mcp!.list();if(active)state.value=result;}catch(caught){if(active)error.value=safeError(caught);}finally{if(active)loading.value=false;}}
onMounted(()=>void load());onUnmounted(()=>{active=false;token.value='';});
async function run(work:()=>Promise<void>){if(busy.value)return;busy.value=true;error.value='';message.value='';try{await work();}catch(caught){if(active)error.value=safeError(caught);}finally{if(active)busy.value=false;}}
function create(){return run(async()=>{const result=await props.transport.mcp!.create({name:name.value.trim(),scopes:[...selected.value]});if(!active)return;token.value=result.token;showToken.value=false;name.value='';message.value='连接已创建，密钥仅在本次窗口显示。';await load();});}
function revoke(id:string){return run(async()=>{await props.transport.mcp!.revoke(id);if(active){token.value='';message.value='连接已撤销，客户端后续访问将被拒绝。';await load();}});}
async function copy(value:string,kind:string){try{await navigator.clipboard.writeText(value);if(active)message.value=kind+'已复制。';}catch{if(active)message.value='复制未成功，请手动选中复制。';}}
</script>
<template>
 <section class="account-section mcp-settings" aria-labelledby="mcp-settings-title">
  <h3 id="mcp-settings-title">连接外部 AI</h3><p>通过通用 MCP 查询公告、管理本设备匿名工作区的收藏和提醒。登录仍只解锁网站 AI。</p>
  <p v-if="loading" role="status">正在读取MCP连接…</p>
  <template v-if="state">
   <label for="mcp-url">MCP 服务地址</label><div class="anonymous-code-row"><input id="mcp-url" :value="state.url" readonly><button type="button" class="secondary" @click="copy(state!.url,'服务地址')">复制地址</button></div>
   <p class="small muted">支持 OAuth 的客户端填入此地址，再在网站确认权限。支持请求头配置的客户端可使用下方密钥，设置 Authorization: Bearer &lt;连接密钥&gt;。</p>
   <p class="small muted">授权绑定匿名身份 <code>{{state.workspaceId}}</code>，不随迁移码复制。AI密钥、聊天、邮箱地址和设备订阅不会提供给客户端。</p>
   <form class="mcp-create" @submit.prevent="create">
    <h4>创建手动连接密钥</h4><label for="mcp-connection-name">连接名称</label><input id="mcp-connection-name" v-model="name" maxlength="80" required placeholder="例如：我的桌面 AI" :disabled="busy">
    <fieldset :disabled="busy"><legend>允许这个连接做什么</legend><label v-for="choice in choices" :key="choice[0]" class="mcp-permission"><input v-model="selected" type="checkbox" :value="choice[0]">{{choice[1]}}</label></fieldset>
    <p class="small muted">90天有效，可随时撤销。新提醒默认仅站内和日历；邮件与设备推送继续使用你在网站验证、开启的设置。</p>
    <button type="submit" class="close-btn" :disabled="busy||!name.trim()||!selected.length">{{busy?'正在处理…':'生成连接密钥'}}</button>
   </form>
   <section v-if="token" class="mcp-secret" aria-label="新连接密钥"><label for="mcp-new-token">连接密钥（仅显示一次）</label><div class="anonymous-code-row"><input id="mcp-new-token" :value="token" :type="showToken?'text':'password'" readonly autocomplete="off"><button type="button" class="mcp-eye" :aria-label="showToken?'隐藏连接密钥':'显示连接密钥'" :aria-pressed="showToken" @click="showToken=!showToken"><TemplateIcon :name="showToken?'eye':'eye-closed'" /></button><button type="button" class="secondary" @click="copy(token,'连接密钥')">复制密钥</button></div><button type="button" class="text-button" @click="token=''">已保存，隐藏密钥</button></section>
   <h4 class="mcp-list-title">已授权连接（{{state.connections.length}}/20）</h4><p v-if="!state.connections.length" class="small muted">尚未授权外部AI。</p>
   <article v-for="connection in state.connections" :key="connection.id" class="mcp-connection"><div><strong>{{connection.name}}</strong><p class="small muted">{{connection.kind==='oauth'?'OAuth授权':'手动密钥'}}<span v-if="connection.clientOrigin"> · {{connection.clientOrigin}}</span></p><p class="small">{{connection.scopes.map(label).join('、')}}</p><p class="small muted">北京时间 {{time(connection.expiresAt)}} 到期<span v-if="connection.lastUsedAt"> · 最近使用 {{time(connection.lastUsedAt)}}</span></p></div><button type="button" class="text-button" :disabled="busy" :aria-label="'撤销连接 '+connection.name" @click="revoke(connection.id)">撤销连接</button></article>
  </template>
  <p v-if="message" role="status">{{message}}</p><p v-if="error" class="error-message" role="alert">{{error}}</p>
 </section>
</template>
