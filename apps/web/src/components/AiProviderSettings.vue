<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { AiProviderProtocol, AiProviderSave, AiProviderSelection, AiProviderState, AiSavedProvider } from '@campus/contracts';
import type { Transport } from '../lib/transport';
import { ClientError, safeError } from '../lib/errors';
const props = defineProps<{ transport: Transport; disabled?: boolean; active?: boolean; idPrefix?:string }>();
function fieldId(value:string){return (props.idPrefix||'')+value;}
const emit = defineEmits<{ changed: [state: AiProviderState]; selected: [value:AiProviderSelection|null,activate:boolean]; busy:[value:boolean] }>();
const state = ref<AiProviderState>({ storageConfigured: false, version: 0, profiles: [], selection: null });
const loading = ref(false), busy = ref(false), error = ref(''), message = ref(''), editor = ref(false), deleting = ref('');
const editing = ref<AiSavedProvider | null>(null), name = ref(''), protocol = ref<AiProviderProtocol>('openai-chat'), baseUrl = ref(''), modelsText = ref(''), defaultModel = ref(''), apiKey = ref(''), preset = ref('custom');
const chosenModels = ref<Record<string, string>>({});
let active = true, revision = 0, loaded = false;
watch(()=>busy.value||loading.value,value=>emit('busy',value));
const labels: Record<AiProviderProtocol,string> = { 'openai-chat':'Chat Completions', 'openai-responses':'Responses', anthropic:'Anthropic Messages', gemini:'Gemini GenerateContent' };
const presets: Record<string,{ name:string; protocol:AiProviderProtocol; baseUrl:string }> = {
  deepseek:{name:'DeepSeek',protocol:'openai-chat',baseUrl:'https://api.deepseek.com'},
  openai:{name:'OpenAI',protocol:'openai-responses',baseUrl:'https://api.openai.com/v1'},
  anthropic:{name:'Anthropic',protocol:'anthropic',baseUrl:'https://api.anthropic.com/v1'},
  gemini:{name:'Gemini',protocol:'gemini',baseUrl:'https://generativelanguage.googleapis.com/v1beta'},
};
const models = computed(() => [...new Set(modelsText.value.split(/[,，\n]/).map(v=>v.trim()).filter(Boolean))]);
const keyRequired=computed(()=>!editing.value||editing.value.protocol!==protocol.value||editing.value.baseUrl!==baseUrl.value.trim().replace(/\/+$/,''));
watch(models, values=>{if(!values.includes(defaultModel.value))defaultModel.value=values[0]||'';});
function apply(value: AiProviderState, activate=false) {
  state.value=value;
  chosenModels.value=Object.fromEntries(value.profiles.map(p=>[p.id,value.selection?.profile.id===p.id?value.selection.model:p.defaultModel]));
  emit('changed',value);
  emit('selected',value.selection,activate);
}
function clearDraft() { revision++; apiKey.value=''; editor.value=false; editing.value=null; deleting.value='';loading.value=false;busy.value=false; }
async function refresh() {
  if(busy.value)return;
  const ticket=revision;loading.value=true;error.value='';
  try { const value=await props.transport.call('ai.providers.list',{});if(active&&ticket===revision){apply(value,!loaded&&Boolean(value.selection));loaded=true;} }
  catch(caught) { if(active&&ticket===revision)error.value=caught instanceof ClientError&&caught.code==='ACTION_NOT_ALLOWED'?'个人配置功能尚未部署，官方与临时 API 仍可使用。':safeError(caught); }
  finally { if(active&&ticket===revision)loading.value=false; }
}
async function mutate(work:()=>Promise<AiProviderState>, success:string, activate=false) {
  if(busy.value||loading.value||props.disabled)return;
  const ticket=revision;busy.value=true;error.value='';message.value='';
  try {const value=await work();if(active&&ticket===revision){apply(value,activate);message.value=success;deleting.value='';}}
  catch(caught) {
    if(active&&ticket===revision){error.value=safeError(caught);if(caught instanceof ClientError&&['PROVIDER_CONFIG_CONFLICT','AI_PROVIDER_CONFLICT'].includes(caught.code)){try{const latest=await props.transport.call('ai.providers.list',{});if(active&&ticket===revision){apply(latest);editor.value=false;error.value='配置已在其他页面更新，已加载最新版本，请重新编辑。';}}catch{}}}
  } finally {apiKey.value='';if(active&&ticket===revision)busy.value=false;}
}
function add() { clearDraft();name.value='';protocol.value='openai-chat';baseUrl.value='';modelsText.value='';defaultModel.value='';preset.value='custom';editor.value=true;error.value=''; }
function edit(value:AiSavedProvider) { clearDraft();editing.value=value;name.value=value.name;protocol.value=value.protocol;baseUrl.value=value.baseUrl;modelsText.value=value.models.join('\n');defaultModel.value=value.defaultModel;preset.value='custom';editor.value=true;error.value=''; }
function usePreset() { const value=presets[preset.value];apiKey.value='';if(value){name.value=value.name;protocol.value=value.protocol;baseUrl.value=value.baseUrl;modelsText.value='';defaultModel.value='';} }
async function save() {
  if(!models.value.length||models.value.length>20){error.value='请填写 1 至 20 个模型 ID。';return;}
  if(keyRequired.value&&!apiKey.value){error.value='请重新填写对应的 API Key。';return;}
  const profile:AiProviderSave={version:state.value.version,name:name.value.trim(),protocol:protocol.value,baseUrl:baseUrl.value.trim(),models:models.value,defaultModel:defaultModel.value,...(editing.value?{id:editing.value.id,profileVersion:editing.value.version}:{}),...(apiKey.value?{apiKey:apiKey.value}:{})};
  const before=state.value.version;
  await mutate(()=>props.transport.call('ai.providers.save',{profile}),'配置已保存。点击“使用此配置”后用于新的问题。');
  if(active&&state.value.version!==before&&!error.value)editor.value=false;
}
async function select(value:AiSavedProvider) { await mutate(()=>props.transport.call('ai.providers.select',{id:value.id,model:chosenModels.value[value.id]||value.defaultModel,version:state.value.version}),'已切换回答服务，仅影响之后新发起的问题。',true); }
async function chooseOfficial() {
  if(!state.value.selection)return true;
  await mutate(()=>props.transport.call('ai.providers.select',{id:null,version:state.value.version}),'已清除个人服务商选择。');
  return !state.value.selection;
}
async function remove(value:AiSavedProvider) { await mutate(()=>props.transport.call('ai.providers.remove',{id:value.id,version:state.value.version}),'配置与保存的密钥已删除。请明确选择下一项配置、官方 AI 或临时 API；未完成的旧回答将停止。'); }
// An authoritative update from another settings surface invalidates local drafts
// and pending reads, without losing the surrounding AI conversation.
function syncState(value:AiProviderState){clearDraft();error.value='';message.value='';apply(value);loaded=true;}
defineExpose({chooseOfficial,clearDraft,refresh,syncState});
onMounted(refresh);
onUnmounted(()=>{active=false;clearDraft();});
</script>

<template>
  <section class="provider-settings" :aria-labelledby="fieldId('provider-settings-title')">
    <header class="provider-heading"><div><h3 :id="fieldId('provider-settings-title')">我的服务商</h3><p>按账号保存配置，选择服务商和模型后用于新的问题。</p></div><div class="provider-actions"><button type="button" class="text-button" :disabled="busy||loading||disabled" @click="refresh">刷新配置</button><button type="button" data-test="add-provider" class="secondary" :disabled="busy||loading||disabled||!state.storageConfigured||state.profiles.length>=10" @click="add">添加服务商</button></div></header>
    <p v-if="!loading&&!state.storageConfigured" class="provider-note">个人配置保存待启用，请联系站点管理员。官方 AI 和临时 API 仍可使用。</p>
    <p v-if="loading" class="provider-note" role="status">正在读取个人配置…</p>
    <p v-if="!loading&&state.storageConfigured&&!state.profiles.length" class="provider-empty">还没有保存的服务商。添加一项后即可选择模型，不必每次重新填写 Key。</p>
    <ul class="provider-list">
      <li v-for="item in state.profiles" :key="item.id" class="provider-row" :class="{'provider-current':state.selection?.profile.id===item.id}">
        <div class="provider-identity"><strong>{{item.name}}</strong><span v-if="state.selection?.profile.id===item.id" class="provider-badge">当前服务商</span><small>{{labels[item.protocol]}} · Key 已保存</small><span class="provider-endpoint">{{item.baseUrl}}</span></div>
        <div class="provider-controls"><label :for="fieldId(`provider-model-${item.id}`)">模型</label><select :id="fieldId(`provider-model-${item.id}`)" v-model="chosenModels[item.id]" :disabled="busy||disabled"><option v-for="id in item.models" :key="id" :value="id">{{id}}</option></select><button type="button" data-test="select-provider" class="secondary" :disabled="busy||loading||disabled||!state.storageConfigured" @click="select(item)">{{state.selection?.profile.id===item.id&&state.selection.model===chosenModels[item.id]?'正在使用':'使用此配置'}}</button></div>
        <div class="provider-actions"><button type="button" data-test="edit-provider" class="text-button" :disabled="busy||disabled" @click="edit(item)">编辑 {{item.name}}</button><button type="button" data-test="delete-provider" class="text-button" :disabled="busy||disabled" @click="deleting=item.id">删除 {{item.name}}</button></div>
        <div v-if="deleting===item.id" class="provider-delete"><p>删除后需要重新填写密钥，使用此配置的未完成回答将停止。</p><button type="button" data-test="confirm-delete-provider" class="secondary" :disabled="busy||disabled" @click="remove(item)">确认删除</button><button type="button" class="text-button" :disabled="busy" @click="deleting=''">保留配置</button></div>
      </li>
    </ul>
    <form v-if="editor" class="provider-editor" @submit.prevent="save">
      <h4>{{editing?'编辑服务商':'添加服务商'}}</h4>
      <fieldset :disabled="busy||disabled"><label :for="fieldId('provider-template')">快速填写</label><select :id="fieldId('provider-template')" v-model="preset" @change="usePreset"><option value="custom">自定义配置</option><option v-for="(item,id) in presets" :key="id" :value="id">{{item.name}}</option></select><p class="provider-note">预设填写接口地址；模型 ID 请以你账号可调用的模型为准。切换预设会清空草稿中的模型和密钥。</p>
      <label :for="fieldId('provider-name')">配置名称</label><input :id="fieldId('provider-name')" v-model="name" required maxlength="60" autocomplete="off" placeholder="例如：我的 DeepSeek" />
      <label :for="fieldId('provider-protocol')">接口协议</label><select :id="fieldId('provider-protocol')" v-model="protocol"><option v-for="(label,id) in labels" :key="id" :value="id">{{label}}</option></select>
      <label :for="fieldId('provider-base-url')">接口基础地址</label><input :id="fieldId('provider-base-url')" v-model="baseUrl" required type="url" maxlength="1000" autocomplete="off" placeholder="服务商提供的 HTTPS 基础地址" /><p class="provider-note">保留地址中的版本路径，例如 /v1；无需填写 API Key 或查询参数。</p>
      <label :for="fieldId('provider-models')">模型 ID，每行一个</label><textarea :id="fieldId('provider-models')" v-model="modelsText" required rows="3" maxlength="2020" spellcheck="false" placeholder="填写服务商提供的完整模型 ID，最多20个" />
      <label :for="fieldId('provider-default-model')">默认模型</label><select :id="fieldId('provider-default-model')" v-model="defaultModel" required><option value="" disabled>先填写模型 ID</option><option v-for="id in models" :key="id" :value="id">{{id}}</option></select>
      <label :for="fieldId('provider-api-key')">{{editing?'更新 API Key（留空保留）':'API Key'}}</label><input :id="fieldId('provider-api-key')" v-model="apiKey" type="password" :required="keyRequired" :placeholder="editing ? '留空保留已保存的 Key' : '输入此服务商的 API Key'" maxlength="2048" autocomplete="new-password" spellcheck="false" /><p class="provider-note">密钥加密保存，页面不回显。更换地址或协议时必须重新填写 Key；用量由该服务商计费。</p>
      <div class="provider-actions"><button type="submit" class="primary" :disabled="!models.length||models.length>20">{{busy?'正在保存…':'保存配置'}}</button><button type="button" class="text-button" @click="clearDraft">取消编辑</button></div></fieldset>
    </form>
    <p v-if="error" class="error-message" role="alert">{{error}}</p><p v-if="message" class="provider-note" role="status">{{message}}</p>
  </section>
</template>

<style scoped>
.provider-editor input,.provider-editor textarea,.provider-editor select,.provider-controls select{border:1px solid #d4dfef;border-radius:4px;padding:8px 10px;font:inherit;line-height:1.6;color:#173766;background:#fff}.provider-editor textarea{resize:vertical}.provider-editor input:focus-visible,.provider-editor textarea:focus-visible,.provider-editor select:focus-visible,.provider-controls select:focus-visible{outline:2px solid #89b0ff;outline-offset:2px}
.provider-settings{border-top:1px solid var(--line,#dce5f3);margin-top:1.25rem;padding-top:1.25rem;min-width:0}.provider-heading{display:flex;justify-content:space-between;gap:1rem;align-items:start}.provider-heading h3{margin:0 0 .35rem;font-size:1.12rem}.provider-heading p,.provider-note,.provider-empty{color:var(--muted,#63748c);font-size:.95rem;line-height:1.65}.provider-heading p{margin:0}.provider-actions{display:flex;gap:.75rem;flex-wrap:wrap;align-items:center}.provider-list{padding:0;list-style:none;margin:1rem 0}.provider-row{padding:1rem 0;border-bottom:1px solid var(--line,#dce5f3);display:grid;grid-template-columns:minmax(0,1fr) minmax(12rem,1fr);gap:.75rem 1rem;min-width:0}.provider-current{border-left:3px solid var(--primary,#2563eb);padding-left:.8rem}.provider-identity{min-width:0}.provider-identity strong{font-size:1rem}.provider-identity small,.provider-endpoint{display:block;overflow-wrap:anywhere;color:var(--muted,#63748c);font-size:.875rem;margin-top:.35rem}.provider-badge{display:inline-block;margin-left:.55rem;background:#e9f0ff;color:#234f9b;font-size:.8rem;padding:.12rem .4rem;border-radius:3px}.provider-controls{display:grid;grid-template-columns:1fr auto;gap:.45rem;align-content:center;min-width:0}.provider-controls label{grid-column:1/-1;font-size:.875rem}.provider-controls select{min-width:0;width:100%}.provider-row>.provider-actions{grid-column:1/-1}.provider-delete{grid-column:1/-1;background:#fff7f4;padding:.8rem;font-size:.95rem}.provider-delete p{margin-top:0}.provider-editor{margin-top:1rem;padding:1rem;background:var(--surface-subtle,#f4f7fc);border:1px solid var(--line,#dce5f3)}.provider-editor h4{margin:0 0 1rem}.provider-editor fieldset{border:0;margin:0;padding:0;display:grid;gap:.5rem;min-width:0}.provider-editor input,.provider-editor textarea,.provider-editor select{width:100%;min-width:0;box-sizing:border-box}.provider-editor label{font-size:.95rem;margin-top:.4rem}.provider-editor .provider-note{margin:0 0 .5rem}.provider-editor .provider-actions{margin-top:.65rem}.provider-empty{padding:1rem 0}@media(max-width:640px){.provider-heading{display:block}.provider-heading>.provider-actions{margin-top:.8rem}.provider-row{grid-template-columns:minmax(0,1fr)}.provider-controls{grid-template-columns:minmax(0,1fr)}.provider-controls button{justify-self:start}.provider-editor{padding:.75rem}}
</style>
