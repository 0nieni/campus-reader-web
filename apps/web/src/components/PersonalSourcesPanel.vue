<script setup lang="ts">
import {computed,onMounted,onUnmounted,ref,watch} from 'vue';
import type {WebsiteSource,WebsiteSourceInput} from '@campus/contracts';
import type {Transport} from '../lib/transport';
import {safeError,ClientError} from '../lib/errors';
import {categoryNames,displaySourceTime,safeOriginal,sourceDiagnosis} from '../lib/presentation';
const props=defineProps<{transport:Transport;schoolId:string|null;schoolName:string;revision?:number;openSource?:(source:{id:string;name:string})=>Promise<void>}>();
const emit=defineEmits<{changed:[kind?:'visibility'];back:[];busy:[value:boolean]}>();
const sources=ref<WebsiteSource[]>([]),busy=ref(false),error=ref(''),message=ref(''),titles=ref<string[]>([]),editing=ref(''),formOpen=ref(false),removeId=ref('');
const query=ref(''),status=ref('all');
watch(busy,value=>emit('busy',value),{flush:'sync'});
const errorCode=ref<string|null>(null),clock=ref(Date.now());
let tick:ReturnType<typeof setInterval>|undefined;
const cooling=(row:WebsiteSource)=>Boolean(row.nextRefreshAt&&Date.parse(row.nextRefreshAt)>clock.value);
const filteredSources=computed(()=>sources.value.filter(row=>row.name.includes(query.value.trim())&&(status.value==='all'||row.enabled===(status.value==='enabled'))));
const typeNames={html_list:'网页公告列表',html_detail:'单篇公告',rss:'RSS / Atom',json_api:'公开 JSON 接口'};
const defaults=():WebsiteSourceInput=>({name:'',entryUrl:'',type:'html_list',categories:['school'],intervalMinutes:60,selectors:{},allowAi:true,authorized:false});
const form=ref(defaults()),selectors=ref('{}');let active=true;
const categories=['school','college','competition','academic','activity','scholarship'];
const categoryText=(values:string[])=>values.map(value=>categoryNames[value]||value).join(' / ');
async function load(){if(!props.schoolId)return;const result=await props.transport.call('sources.list',{schoolId:props.schoolId});if(active)sources.value=result.sources;}
async function run(work:()=>Promise<void>){if(busy.value)return;busy.value=true;error.value='';errorCode.value=null;message.value='';titles.value=[];try{await work();}catch(caught){if(active){error.value=safeError(caught);errorCode.value=caught instanceof ClientError?caught.code:'SOURCE_UNAVAILABLE';}}finally{if(active)busy.value=false;}}
function edit(row?:WebsiteSource){editing.value=row?.id||'';form.value=row?{name:row.name,entryUrl:row.entryUrl,type:row.type,categories:[...row.categories],intervalMinutes:row.intervalMinutes,selectors:{...row.selectors},allowAi:row.allowAi,authorized:true}:defaults();selectors.value=JSON.stringify(form.value.selectors,null,2);formOpen.value=true;}
async function save(){await run(async()=>{if(!props.schoolId)return;let parsed:unknown;try{parsed=JSON.parse(selectors.value);}catch{throw new ClientError('VALIDATION_FAILED','解析设置须为有效的JSON对象。');}const result=await props.transport.call('sources.save',{schoolId:props.schoolId,...(editing.value?{sourceId:editing.value}:{}),source:{...form.value,selectors:parsed as Record<string,string>}});if(!active)return;formOpen.value=false;editing.value=result.id;message.value='来源已保存。先测试连接，再点击立即采集。';emit('changed');await load();});}
async function test(row:WebsiteSource){await run(async()=>{if(!props.schoolId)return;const result=await props.transport.call('sources.test',{schoolId:props.schoolId,sourceId:row.id});if(!active)return;message.value=result.message;titles.value=result.titles;await load();});}
async function collect(row:WebsiteSource){await run(async()=>{if(!props.schoolId)return;const result=await props.transport.call('sources.refresh',{schoolId:props.schoolId,sourceId:row.id});if(!active)return;message.value=result.message;emit('changed');await load();});}
async function toggle(row:WebsiteSource){await run(async()=>{if(!props.schoolId)return;await props.transport.call('sources.toggle',{schoolId:props.schoolId,sourceId:row.id,enabled:!row.enabled});if(!active)return;message.value=row.enabled?'来源已停用，已有公告保留。':'来源已启用。';await load();});}
async function setFeedVisibility(row:WebsiteSource,event:Event){
 const control=event.target as HTMLInputElement;
 await run(async()=>{
  if(!props.schoolId)return;
  const saved=await props.transport.call('sources.feedVisibility',{schoolId:props.schoolId,sourceId:row.id,visible:control.checked});if(!active)return;
  row.showInFeed=saved.visible;message.value=saved.visible?'已在主页公告中显示此来源。':'已从主页公告中隐藏此来源，采集和阅读权限保持不变。';emit('changed','visibility');
 });
 if(active)control.checked=row.showInFeed!==false;
}
async function remove(row:WebsiteSource){await run(async()=>{if(!props.schoolId)return;await props.transport.call('sources.remove',{schoolId:props.schoolId,sourceId:row.id});if(!active)return;removeId.value='';message.value='来源已移除，相关导入公告已隐藏。';emit('changed');await load();});}
async function inspect(row:WebsiteSource){await run(async()=>{await props.openSource?.({id:row.id,name:row.name});});}
watch(()=>props.revision,()=>void run(load));
onMounted(()=>{void run(load);tick=setInterval(()=>{clock.value=Date.now();},1000);});onUnmounted(()=>{active=false;if(tick)clearInterval(tick);});
</script>
<template>
 <section aria-label="个人来源管理">
  <p class="muted">以下来源属于{{schoolName||'当前学校'}}，导入内容仅本人可见。</p>
  <p>新增来源 → 测试连接 → 立即采集。支持公开网页、单篇公告、RSS/Atom和JSON接口。</p>
  <p class="muted">采集和普通浏览不扣 AI 次数，不提供免费摘要。生成摘要请进入 AI 阅读并主动发送问题，与其他 AI 对话共用每日额度。</p>
  <p class="muted small">最短采集间隔限制手动请求频率，不代表后台定时更新。</p>
  <p v-if="error" class="error-message" role="alert">{{error}} {{sourceDiagnosis(errorCode)?.advice}}</p><p v-if="message" role="status">{{message}}</p>
  <ul v-if="titles.length" class="source-preview"><li v-for="title in titles" :key="title">{{title}}</li></ul>
  <button class="primary" :disabled="busy||!schoolId" @click="edit()">新增来源</button>
  <div class="source-toolbar"><label>搜索个人来源<input v-model="query" type="search" aria-label="搜索个人来源" placeholder="输入来源名称"></label><label>启用状态<select v-model="status" aria-label="来源启用状态"><option value="all">全部状态</option><option value="enabled">已启用</option><option value="disabled">已停用</option></select></label></div>
  <form v-if="formOpen" class="source-form" @submit.prevent="save">
   <fieldset :disabled="busy"><legend>{{editing?'编辑来源':'新增来源'}}</legend>
    <label>来源名称<input v-model="form.name" required minlength="2" maxlength="80" placeholder="例如：某学院通知公告"></label>
    <label>来源类型<select v-model="form.type"><option value="html_list">网页公告列表</option><option value="html_detail">单篇公告网页</option><option value="rss">RSS / Atom</option><option value="json_api">公开 JSON 接口</option></select></label>
    <label>入口网址<input v-model="form.entryUrl" type="url" required maxlength="1800" :readonly="Boolean(editing)" placeholder="https://学校官网/通知公告"></label>
    <p v-if="editing" class="muted small">更换网址需移除旧来源后重新添加。</p>
    <div class="source-categories"><label v-for="category in categories" :key="category"><input v-model="form.categories" type="checkbox" :value="category">{{categoryNames[category]}}</label></div>
    <label>最短采集间隔（分钟）<input v-model.number="form.intervalMinutes" type="number" required min="15" max="1440"></label>
    <details><summary>高级解析设置（默认通用规则）</summary><p class="muted small">网页可填listItem、detailLink、title、content、publishedAt选择器；JSON可填itemsPath、titleField、urlField、contentField、dateField字段路径。JSON默认读取data.list。</p><textarea v-model="selectors" rows="6" maxlength="2500" aria-label="解析设置JSON" spellcheck="false"></textarea></details>
    <label class="source-check"><input v-model="form.allowAi" type="checkbox">允许在我主动使用AI阅读时发送本站公告正文；采集时不会自动调用模型。</label>
    <label class="source-check"><input v-model="form.authorized" type="checkbox" required>我确认这是允许采集的公开来源。不会提交登录凭据或绕过站点访问限制。</label>
    <div class="source-actions"><button class="primary" type="submit">保存来源</button><button class="text-button" type="button" @click="formOpen=false">取消</button></div>
   </fieldset>
  </form>
  <p v-if="!sources.length&&!busy" class="empty-state">还没有添加网站来源。学校目录原有公告仍可正常浏览。</p>
  <p v-if="sources.length&&!filteredSources.length" class="empty-state">没有符合条件的来源，请修改搜索或筛选。</p>
  <article v-for="row in filteredSources" :key="row.id" class="source-card"><h2>{{row.name}} <small>{{row.enabled?'已启用':'已停用'}}</small></h2><a v-if="safeOriginal(row.entryUrl)" class="source-url" :href="safeOriginal(row.entryUrl)!" target="_blank" rel="noopener noreferrer">{{row.entryUrl}}</a><p v-else class="source-url">原站链接不可用</p><p class="muted small">{{typeNames[row.type]}} · {{categoryText(row.categories)}} · 最短间隔 {{row.intervalMinutes}} 分钟</p><p class="small">{{row.allowAi?'允许主动 AI 阅读':'不允许 AI 阅读'}} · 最近成功采集：{{displaySourceTime(row.lastSuccessAt)}} · 上次采集 {{row.count}} 条</p><p class="muted small">{{row.message}}</p>
   <p v-if="sourceDiagnosis(row.lastErrorCode)" class="source-diagnosis small"><strong>{{sourceDiagnosis(row.lastErrorCode)!.title}}</strong> · {{sourceDiagnosis(row.lastErrorCode)!.advice}}</p>
   <p v-if="row.lastCollection" class="small">本次新增 {{row.lastCollection.newCount}} 条 · 已有 {{row.lastCollection.existingCount}} 条 · 失败 {{row.lastCollection.failedSources}} 个来源 · 跳过过期 {{row.lastCollection.skippedCount}} 条</p>
   <p v-if="row.lastAttemptAt" class="muted small">最近检查：{{displaySourceTime(row.lastAttemptAt)}}</p>
   <p v-if="row.nextRefreshAt" class="muted small">下次可采集：{{displaySourceTime(row.nextRefreshAt)}}{{cooling(row)?'（冷却中）':'（已可采集）'}}</p>
   <label class="source-display"><input type="checkbox" aria-label="在主页公告中显示" :checked="row.showInFeed!==false" :disabled="busy" @change="setFeedVisibility(row,$event)">在主页公告中显示</label>
   <div class="source-actions"><button v-if="openSource" class="text-button" :disabled="busy" @click="inspect(row)">查看该来源公告</button><button class="text-button" :disabled="busy" @click="test(row)">测试连接</button><button class="text-button" :disabled="busy||!row.enabled||cooling(row)" @click="collect(row)">立即采集</button><button class="text-button" :disabled="busy" @click="edit(row)">编辑</button><button class="text-button" :disabled="busy" @click="toggle(row)">{{row.enabled?'停用':'启用'}}</button><button class="text-button danger" :disabled="busy" @click="removeId=row.id">移除</button></div>
   <div v-if="removeId===row.id" class="source-actions"><span>移除后隐藏此来源的导入公告。</span><button class="text-button danger" :disabled="busy" @click="remove(row)">确认移除</button><button class="text-button" :disabled="busy" @click="removeId=''">取消</button></div>
  </article>
  <p v-if="busy" class="muted" role="status">正在处理，请保留此页面…</p>
 </section>
</template>
