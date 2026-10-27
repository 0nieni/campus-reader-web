<script setup lang="ts">
import {nextTick,onMounted,onUnmounted,onUpdated,ref} from 'vue';
import type {AiProviderState,AnonymousImport} from '@campus/contracts';
import type {ProviderChange,Transport} from '../lib/transport';
import {safeError} from '../lib/errors';
import AiProviderSettings from './AiProviderSettings.vue';
import AnonymousIdentityPanel from './AnonymousIdentityPanel.vue';
const props=defineProps<{transport:Transport;username:string|null;opener?:HTMLElement|null;anonymous?:boolean;initialTab?:'school'}>();
const emit=defineEmits<{close:[];providersChanged:[change:ProviderChange];login:[];imported:[result:AnonymousImport]}>();
const tab=ref<'identity'|'account'|'school'|'models'>(props.initialTab||(props.anonymous?'identity':'account')),dialog=ref<HTMLElement|null>(null);
const sending=ref(false),sent=ref(false),error=ref(''),cooldown=ref(0),providerBusy=ref(false);
const providerSettings=ref<InstanceType<typeof AiProviderSettings>|null>(null);
const providerState=ref<AiProviderState>({storageConfigured:false,version:0,selection:null,profiles:[]});
let active=true,lastVersion:number|undefined,pendingState:AiProviderState|null=null;
const previousFocus=props.opener||(document.activeElement instanceof HTMLElement?document.activeElement:null),previousOverflow=document.body.style.overflow;
const timer=setInterval(()=>{if(cooldown.value>0)cooldown.value--;},1000);
onMounted(async()=>{document.body.style.overflow='hidden';window.addEventListener('keydown',keys,true);await nextTick();dialog.value?.focus();});
onUpdated(()=>{void nextTick(()=>{if(active&&!dialog.value?.contains(document.activeElement))dialog.value?.focus();});});
onUnmounted(()=>{active=false;clearInterval(timer);window.removeEventListener('keydown',keys,true);document.body.style.overflow=previousOverflow;void nextTick(()=>{if(previousFocus?.isConnected)previousFocus.focus();});});
function keys(event:KeyboardEvent){
 if(event.key==='Escape'){event.preventDefault();event.stopPropagation();emit('close');return;}
 if(event.key!=='Tab')return;
 const controls=[...dialog.value!.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary')].filter(el=>el.getClientRects().length);
 const first=controls[0],last=controls.at(-1);if(!first){event.preventDefault();return;}
 if(!dialog.value?.contains(document.activeElement)){event.preventDefault();(event.shiftKey?last:first)?.focus();return;}
 if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog.value)){event.preventDefault();last?.focus();}else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===dialog.value)){event.preventDefault();first.focus();}
}
async function sendRecovery(){
 if(sending.value||cooldown.value||!props.transport.requestPasswordRecovery)return;
 sending.value=true;error.value='';sent.value=false;
 try{await props.transport.requestPasswordRecovery();if(active){sent.value=true;cooldown.value=60;}}
 catch(caught){if(active)error.value=safeError(caught);}
 finally{if(active)sending.value=false;}
}
function providersChanged(state:AiProviderState){pendingState=lastVersion!==undefined&&lastVersion!==state.version?state:null;lastVersion=state.version;providerState.value=state;}
function providerSelected(_value:unknown,activate:boolean){if(pendingState){emit('providersChanged',{state:pendingState,activate:activate?'saved':null});pendingState=null;}}
async function official(){if(providerSettings.value&&await providerSettings.value.chooseOfficial()&&active)emit('providersChanged',{state:providerState.value,activate:'official'});}
</script>
<template>
 <section ref="dialog" class="overlay show account-dialog" role="dialog" aria-modal="true" aria-labelledby="account-settings-title" tabindex="-1" @click.self="emit('close')">
  <div class="modal account-modal">
   <header class="account-heading"><div><h2 id="account-settings-title">个人工作区</h2><p class="account-username"><span>{{anonymous?'AI账号':'用户名'}}</span><strong>{{username||(anonymous?'尚未登录，仍可匿名阅读':'未提供用户名')}}</strong></p></div><button type="button" class="account-close" aria-label="关闭个人工作区" @click="emit('close')">×</button></header>
   <nav class="account-tabs" aria-label="个人设置"><button v-if="anonymous&&transport.anonymous" type="button" :aria-pressed="tab==='identity'" @click="tab='identity'">匿名身份</button><button v-for="item in ([['account','账号安全'],['school','我的学校'],['models','服务模型']] as const)" :key="item[0]" type="button" :aria-pressed="tab===item[0]" @click="tab=item[0]">{{item[1]}}</button></nav>
   <AnonymousIdentityPanel v-if="tab==='identity'&&transport.anonymous" :transport="transport" @imported="emit('imported',$event)" />
   <section v-else-if="tab==='account'" class="account-section"><template v-if="!anonymous||username"><h3>更换密码</h3><p>向当前账号邮箱发送重置邮件。打开邮件中的链接后，设置新密码。</p><p class="account-email">{{username}}</p><button type="button" class="close-btn" :disabled="sending||cooldown>0||!transport.requestPasswordRecovery" @click="sendRecovery">{{sending?'正在发送…':cooldown?`${cooldown} 秒后可重新发送`:'发送密码重置邮件'}}</button><p v-if="sent" class="account-note" role="status">重置邮件已请求发送，请查看收件箱和垃圾邮件。</p><p v-if="!transport.requestPasswordRecovery" class="account-note">当前认证环境暂不支持邮件重置，请联系站点管理员。</p><p v-if="error" class="error-message" role="alert">{{error}}</p></template><template v-else><h3>登录以使用 AI</h3><p>登录后保留当前匿名工作区，AI配置和聊天按登录账号独立保存。</p><button type="button" class="close-btn" @click="emit('login')">登录或注册</button></template><p v-if="transport.anonymous&&username&&anonymous" class="account-note"><a href="/?workspace=account">打开原账号工作区</a>，查看过去保存在账号中的学校、收藏和私人来源。</p><p v-if="transport.anonymous&&!anonymous" class="account-note"><a href="/">返回匿名工作区</a></p></section>
   <section v-else-if="tab==='school'" class="account-section account-school"><h3>我的学校</h3><p>学校偏好保存在当前{{anonymous?'匿名工作区':'账号'}}，更换后将读取对应学校的公告。</p><slot name="school"/></section>
   <section v-else-if="anonymous&&!username" class="account-section"><h3>登录以设置 AI</h3><p>模型配置、API密钥和聊天归登录账号保存。</p><button type="button" class="close-btn" @click="emit('login')">登录或注册</button></section>
   <section v-else class="account-section account-models"><div class="account-model-heading"><h3>API 与模型</h3><button type="button" class="text-button" :disabled="providerBusy" @click="official">使用官方 AI</button></div><p>保存服务商与 API Key，选择模型后点击“使用此配置”。</p><AiProviderSettings ref="providerSettings" id-prefix="account-" :transport="transport" :active="Boolean(providerState.selection)" @changed="providersChanged" @selected="providerSelected" @busy="providerBusy=$event"/></section>
  </div>
 </section>
</template>
