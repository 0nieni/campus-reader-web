<script setup lang="ts">
import {computed,onMounted,onUnmounted,ref,watch} from 'vue';
import type {School,SchoolSourceCatalogue} from '@campus/contracts';
import type {Transport} from '../lib/transport';
import {safeError,ClientError} from '../lib/errors';
import {displaySourceTime,safeOriginal,sourceDiagnosis} from '../lib/presentation';
const props=defineProps<{transport:Transport;schoolId:string|null;schoolName:string;revision?:number;openSchool?:(schoolId:string,source?:{id:string;name:string})=>Promise<void>}>();
const emit=defineEmits<{changed:[kind?:'visibility'];busy:[value:boolean]}>();
const schools=ref<School[]>([]),query=ref(''),browsing=ref(props.schoolId||'');
const catalogue=ref<SchoolSourceCatalogue|null>(null),loading=ref(false),listing=ref(false),acting=ref(false);
const error=ref(''),listError=ref(''),message=ref('');
watch(acting,value=>emit('busy',value),{flush:'sync'});
const errorCode=ref<string|null>(null);
const matching=computed(()=>schools.value.filter(s=>s.name.includes(query.value.trim())));
let active=true,request=0;
const stateNames={unchecked:'尚未检查',ready:'最近读取成功',unavailable:'读取失败'};
async function setFeedVisibility(source:SchoolSourceCatalogue['sources'][number],event:Event){
  const control=event.target as HTMLInputElement;
  if(acting.value){control.checked=source.showInFeed!==false;return;}
  acting.value=true;error.value='';message.value='';
  try{
    const saved=await props.transport.call('sources.feedVisibility',{schoolId:browsing.value,sourceId:source.id,visible:control.checked});
    if(!active)return;
    source.showInFeed=saved.visible;
    message.value=saved.visible?'已在主页公告中显示此来源。':'已从主页公告中隐藏此来源，采集和阅读权限保持不变。';
    emit('changed','visibility');
  }catch(caught){if(active){error.value=safeError(caught);errorCode.value=caught instanceof ClientError?caught.code:'SOURCE_UNAVAILABLE';}}
  finally{if(active){control.checked=source.showInFeed!==false;acting.value=false;}}
}
async function browse(id:string){
  if(acting.value)return;
  browsing.value=id;catalogue.value=null;message.value='';error.value='';
  const ticket=++request;loading.value=true;
  try{const result=await props.transport.call('school.sources',{schoolId:id});if(active&&ticket===request)catalogue.value=result;}
  catch(caught){if(active&&ticket===request)error.value=safeError(caught);}
  finally{if(active&&ticket===request)loading.value=false;}
}
async function loadSchools(){
  if(listing.value)return;listing.value=true;listError.value='';
  try{
    let cursor:string|null=null;const rows:School[]=[];const seen=new Set<string>();
    do{
      const page:{schools:School[];nextCursor:string|null}=await props.transport.call('school.list',cursor?{cursor}:{});if(!active)return;
      rows.push(...page.schools);cursor=page.nextCursor;
      if(cursor&&seen.has(cursor))throw new Error('学校目录分页异常，请重试。');
      if(cursor)seen.add(cursor);
      schools.value=rows.filter((row,index)=>rows.findIndex(s=>s.id===row.id)===index);
    }while(cursor);
    if(!browsing.value&&rows[0])void browse(rows[0].id);
  }catch(caught){if(active)listError.value=safeError(caught);}
  finally{if(active)listing.value=false;}
}
async function open(source?:{id:string;name:string}){
  if(acting.value||!props.openSchool)return;
  acting.value=true;error.value='';
  try{if(source)await props.openSchool(browsing.value,{id:source.id,name:source.name});else await props.openSchool(browsing.value);}
  catch(caught){if(active)error.value=safeError(caught);}
  finally{if(active)acting.value=false;}
}
async function refresh(){
  if(acting.value||loading.value||browsing.value!==props.schoolId)return;
  acting.value=true;error.value='';message.value='';const id=browsing.value;
  try{
    const result=await props.transport.call('school.refresh',{schoolId:id});if(!active)return;
    message.value=result.message;emit('changed');
    const updated=await props.transport.call('school.sources',{schoolId:id});if(active)catalogue.value=updated;
  }catch(caught){if(active)error.value=safeError(caught);}
  finally{if(active)acting.value=false;}
}
onMounted(()=>{void loadSchools();if(browsing.value)void browse(browsing.value);});
watch(()=>props.revision,()=>{if(browsing.value)void browse(browsing.value);});
onUnmounted(()=>{active=false;request++;});
</script>
<template>
 <section aria-label="学校来源目录">
  <p class="muted">查看不同学校的公开来源。浏览目录不会切换阅读学校，也不会触发采集。</p>
  <div class="source-toolbar"><label>搜索学校<input v-model="query" type="search" aria-label="搜索学校" placeholder="输入学校名称"></label></div>
  <p v-if="listError" class="error-message" role="alert">{{listError}} <button class="text-button" :disabled="listing" @click="loadSchools">重试学校目录</button></p>
  <div class="school-choices" aria-label="选择浏览学校">
   <button v-for="school in matching" :key="school.id" class="school-choice" :class="{active:browsing===school.id}" :aria-pressed="browsing===school.id" :disabled="acting" @click="browse(school.id)">{{school.name}}</button>
  </div>
  <p v-if="listing" class="muted" role="status">正在加载学校目录…</p>
  <p v-else-if="!matching.length&&!listError" class="empty-state">没有找到匹配的学校，请修改搜索词。</p>
  <p v-if="error" class="error-message" role="alert">{{error}} {{sourceDiagnosis(errorCode)?.advice}} <button v-if="!catalogue&&browsing" class="text-button" :disabled="loading||acting" @click="browse(browsing)">重试来源目录</button></p>
  <p v-if="message" role="status">{{message}}</p>
  <p v-if="loading" class="muted" role="status">正在读取来源目录…</p>
  <template v-if="catalogue">
   <div class="source-school-heading"><div><span class="panel-kicker">{{browsing===schoolId?'当前学校':'正在浏览'}}</span><h2>{{catalogue.school.name}}</h2></div><a v-if="safeOriginal(catalogue.school.homepage||null)" :href="safeOriginal(catalogue.school.homepage||null)!" target="_blank" rel="noopener noreferrer">学校官网 ↗</a></div>
   <p class="source-coverage">{{catalogue.coverage}}</p>
   <div class="source-actions">
    <button v-if="openSchool" class="primary" :disabled="acting" @click="open()">{{browsing===schoolId?'查看公告':'切换到该校并查看公告'}}</button>
    <button v-if="browsing===schoolId&&catalogue.sources.length" class="text-button" :disabled="acting" @click="refresh">刷新本校公告</button>
   </div>
   <p v-if="acting" class="muted" role="status">正在处理，请稍候…</p>
   <p v-if="!catalogue.sources.length" class="empty-state">该校尚未配置公告来源，可通过学校官网查看。配置入口不代表已接入全部校内公告。</p>
   <div class="school-source-grid">
    <article v-for="source in catalogue.sources" :key="source.id" class="source-card school-source-card">
     <span class="source-status" :class="`source-status-${source.state}`">{{stateNames[source.state]}}</span>
     <h3>{{source.name}}</h3><p class="muted small">{{catalogue.school.name}} · 已配置</p>
     <label class="source-display"><input type="checkbox" aria-label="在主页公告中显示" :checked="source.showInFeed!==false" :disabled="acting" @change="setFeedVisibility(source,$event)">在主页公告中显示</label>
     <a v-if="safeOriginal(source.url)" class="source-url" :href="safeOriginal(source.url)!" target="_blank" rel="noopener noreferrer">查看原站 ↗</a>
     <button v-if="openSchool" class="text-button" :disabled="acting||source.showInFeed===false" @click="open(source)">查看该来源公告</button>
     <p class="small">{{catalogue.coverage}}</p><p class="muted small">{{source.message}}</p>
     <p v-if="sourceDiagnosis(source.errorCode)" class="source-diagnosis small"><strong>{{sourceDiagnosis(source.errorCode)!.title}}</strong> · {{sourceDiagnosis(source.errorCode)!.advice}}</p>
     <p v-if="source.stats" class="small">本次新增 {{source.stats.newCount}} 条 · 已有 {{source.stats.existingCount}} 条 · 失败 {{source.stats.failedSources}} 个来源</p>
     <p class="muted small">最近检查：{{displaySourceTime(source.checkedAt)}}<template v-if="source.count!==null"> · 上次读取 {{source.count}} 条</template></p>
     <p v-if="source.nextRefreshAt" class="muted small">下次可重新检查：{{displaySourceTime(source.nextRefreshAt)}}（此前刷新使用缓存）</p>
    </article>
   </div>
   <p class="muted small">读取状态来自已有检查记录，不代表实时可用；列表读取成功也不保证每篇正文和附件可读。学校内置来源由项目维护者统一配置。</p>
  </template>
 </section>
</template>
