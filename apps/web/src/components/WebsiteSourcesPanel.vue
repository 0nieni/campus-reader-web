<script setup lang="ts">
import {onMounted,onUnmounted,ref} from 'vue';
import type {WebsiteSource,WebsiteSourceInput} from '@campus/contracts';
import type {Transport} from '../lib/transport';
import {safeError,ClientError} from '../lib/errors';
import {categoryNames} from '../lib/presentation';
const props=defineProps<{transport:Transport;schoolId:string|null;schoolName:string}>();
const emit=defineEmits<{changed:[];back:[]}>();
const sources=ref<WebsiteSource[]>([]),busy=ref(false),error=ref(''),message=ref(''),titles=ref<string[]>([]),editing=ref(''),formOpen=ref(false),removeId=ref('');
const defaults=():WebsiteSourceInput=>({name:'',entryUrl:'',type:'html_list',categories:['school'],intervalMinutes:60,selectors:{},allowAi:true,authorized:false});
const form=ref(defaults()),selectors=ref('{}');let active=true;
const categories=['school','college','competition','academic','activity','scholarship'];
const categoryText=(values:string[])=>values.map(value=>categoryNames[value]||value).join(' / ');
async function load(){if(!props.schoolId)return;const result=await props.transport.call('sources.list',{schoolId:props.schoolId});if(active)sources.value=result.sources;}
async function run(work:()=>Promise<void>){if(busy.value)return;busy.value=true;error.value='';message.value='';titles.value=[];try{await work();}catch(caught){if(active)error.value=safeError(caught);}finally{if(active)busy.value=false;}}
function edit(row?:WebsiteSource){editing.value=row?.id||'';form.value=row?{name:row.name,entryUrl:row.entryUrl,type:row.type,categories:[...row.categories],intervalMinutes:row.intervalMinutes,selectors:{...row.selectors},allowAi:row.allowAi,authorized:true}:defaults();selectors.value=JSON.stringify(form.value.selectors,null,2);formOpen.value=true;}
async function save(){await run(async()=>{if(!props.schoolId)return;let parsed:unknown;try{parsed=JSON.parse(selectors.value);}catch{throw new ClientError('VALIDATION_FAILED','解析设置须为有效的JSON对象。');}const result=await props.transport.call('sources.save',{schoolId:props.schoolId,...(editing.value?{sourceId:editing.value}:{}),source:{...form.value,selectors:parsed as Record<string,string>}});if(!active)return;formOpen.value=false;editing.value=result.id;message.value='来源已保存。先测试连接，再点击立即采集。';emit('changed');await load();});}
async function test(row:WebsiteSource){await run(async()=>{if(!props.schoolId)return;const result=await props.transport.call('sources.test',{schoolId:props.schoolId,sourceId:row.id});if(!active)return;message.value=result.message;titles.value=result.titles;await load();});}
async function collect(row:WebsiteSource){await run(async()=>{if(!props.schoolId)return;const result=await props.transport.call('sources.refresh',{schoolId:props.schoolId,sourceId:row.id});if(!active)return;message.value=result.message;emit('changed');await load();});}
async function toggle(row:WebsiteSource){await run(async()=>{if(!props.schoolId)return;await props.transport.call('sources.toggle',{schoolId:props.schoolId,sourceId:row.id,enabled:!row.enabled});if(!active)return;message.value=row.enabled?'来源已停用，已有公告保留。':'来源已启用。';await load();});}
async function remove(row:WebsiteSource){await run(async()=>{if(!props.schoolId)return;await props.transport.call('sources.remove',{schoolId:props.schoolId,sourceId:row.id});if(!active)return;removeId.value='';message.value='来源已移除，相关导入公告已隐藏。';emit('changed');await load();});}
onMounted(()=>void run(load));onUnmounted(()=>{active=false;});
</script>
<template>
 <section class="feature-surface website-sources" aria-labelledby="website-sources-title">
  <header class="feature-heading"><div><span class="panel-kicker">我的来源</span><h1 id="website-sources-title">导入网站公告来源</h1></div><button class="text-button" @click="emit('back')">返回公告</button></header>
  <p class="muted">当前学校：{{schoolName||'尚未选择'}}。导入内容仅本人可见；切换学校请返回公告页。</p>
  <p>新增来源 → 测试连接 → 立即采集。支持公开网页、单篇公告、RSS/Atom和JSON接口。</p>
  <p class="muted">采集和普通浏览不扣AI次数，不提供免费摘要。生成摘要请勾选公告进入AI阅读，官方每天3次，同一任务分批只计一次。</p>
  <p v-if="error" class="error-message" role="alert">{{error}}</p><p v-if="message" role="status">{{message}}</p>
  <ul v-if="titles.length" class="source-preview"><li v-for="title in titles" :key="title">{{title}}</li></ul>
  <button class="primary" :disabled="busy||!schoolId" @click="edit()">新增来源</button>
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
  <article v-for="row in sources" :key="row.id" class="source-card"><h2>{{row.name}} <small>{{row.enabled?'已启用':'已停用'}}</small></h2><p class="source-url">{{row.entryUrl}}</p><p class="muted small">{{row.type}} · {{categoryText(row.categories)}} · 最短间隔{{row.intervalMinutes}}分钟 · 上次采集{{row.count}}条</p><p class="muted small">{{row.message}}</p>
   <div class="source-actions"><button class="text-button" :disabled="busy" @click="test(row)">测试连接</button><button class="text-button" :disabled="busy||!row.enabled" @click="collect(row)">立即采集</button><button class="text-button" :disabled="busy" @click="edit(row)">编辑</button><button class="text-button" :disabled="busy" @click="toggle(row)">{{row.enabled?'停用':'启用'}}</button><button class="text-button danger" :disabled="busy" @click="removeId=row.id">移除</button></div>
   <div v-if="removeId===row.id" class="source-actions"><span>移除后隐藏此来源的导入公告。</span><button class="text-button danger" :disabled="busy" @click="remove(row)">确认移除</button><button class="text-button" :disabled="busy" @click="removeId=''">取消</button></div>
  </article>
  <p v-if="busy" class="muted" role="status">正在处理，请保留此页面…</p>
 </section>
</template>
