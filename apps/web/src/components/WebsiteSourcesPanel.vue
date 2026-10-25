<script setup lang="ts">
import {computed,onMounted,onUnmounted,ref} from 'vue';
import {noticeCategories,type SourceCatalogue,type SourceCatalogueEntry} from '@campus/contracts';
import type {Transport} from '../lib/transport';
import {safeError} from '../lib/errors';
import {categoryNames,displaySourceTime,safeOriginal,sourceDiagnosis} from '../lib/presentation';
import SchoolSourcesPanel from './SchoolSourcesPanel.vue';
import PersonalSourcesPanel from './PersonalSourcesPanel.vue';
const props=defineProps<{transport:Transport;schoolId:string|null;schoolName:string;openSchool?:(schoolId:string,source?:{id:string;name:string})=>Promise<void>}>();
const emit=defineEmits<{changed:[kind?:'visibility'];back:[]}>();
const tab=ref<'all'|'schools'|'personal'>('all'),schoolVisited=ref(false),personalVisited=ref(false);
const catalogue=ref<SourceCatalogue|null>(null),loading=ref(false),busy=ref(false),schoolBusy=ref(false),personalBusy=ref(false);
const error=ref(''),message=ref(''),query=ref(''),display=ref<'all'|'shown'|'hidden'>('all'),kind=ref<'all'|'school'|'public'|'personal'>('all');
const categories=ref<string[]>([...noticeCategories]),revision=ref(0);
const locked=computed(()=>busy.value||schoolBusy.value||personalBusy.value);
const sourceKinds={school:'学校来源',public:'公共来源',personal:'我的来源'};
const states={unchecked:'尚未采集',ready:'最近读取成功',unavailable:'暂未读取成功'};
function categoryLabel(values:readonly string[]){return values.map(category=>categoryNames[category]||category).join(' · ');}
const shown=computed(()=>catalogue.value?.sources.filter(row=>row.showInFeed).length||0);
const filtered=computed(()=>catalogue.value?.sources.filter(row=>
 categories.value.some(category=>row.categories.includes(category))&&
 (kind.value==='all'||row.kind===kind.value)&&
 (display.value==='all'||row.showInFeed===(display.value==='shown'))&&
 (!query.value.trim()||(row.name+' '+(row.url||'')).toLowerCase().includes(query.value.trim().toLowerCase()))
)||[]);
let active=true,request=0;
async function load(){
 if(!props.schoolId)return;const ticket=++request;loading.value=true;
 try{const result=await props.transport.call('sources.catalogue',{schoolId:props.schoolId});if(active&&ticket===request){catalogue.value=result;error.value='';}}
 catch(caught){if(active&&ticket===request)error.value=safeError(caught);}
 finally{if(active&&ticket===request)loading.value=false;}
}
function changed(kind?:'visibility'){revision.value++;emit('changed',kind);void load();}
async function toggle(row:SourceCatalogueEntry,event:Event){
 const control=event.target as HTMLInputElement;if(locked.value||!props.schoolId){control.checked=row.showInFeed;return;}
 busy.value=true;error.value='';message.value='';
 try{const result=await props.transport.call('sources.feedVisibility',{schoolId:props.schoolId,sourceId:row.id,visible:control.checked});if(!active)return;row.showInFeed=result.visible;revision.value++;emit('changed','visibility');message.value=result.visible?'已勾选，此来源公告可在公告页显示。':'已取消勾选，此来源公告不在公告页显示。';}
 catch(caught){if(active)error.value=safeError(caught);}
 finally{if(active){control.checked=row.showInFeed;busy.value=false;}}
}
async function setAll(visible:boolean){
 if(locked.value||!props.schoolId||!catalogue.value)return;busy.value=true;error.value='';message.value='';
 try{await props.transport.call('sources.feedVisibilityAll',{schoolId:props.schoolId,visible});if(!active)return;catalogue.value.sources.forEach(row=>row.showInFeed=visible);revision.value++;emit('changed','visibility');message.value=visible?'已勾选当前目录的全部来源。':'已取消当前目录的全部勾选。';await load();}
 catch(caught){if(active)error.value=safeError(caught);}
 finally{if(active)busy.value=false;}
}
async function collect(row:SourceCatalogueEntry){
 if(locked.value||!props.schoolId||!row.showInFeed)return;busy.value=true;error.value='';message.value='';
 try{
  const result=row.kind==='school'?await props.transport.call('school.refresh',{schoolId:props.schoolId}):row.kind==='public'?await props.transport.call('sources.public.refresh',{schoolId:props.schoolId,sourceId:row.id}):await props.transport.call('sources.refresh',{schoolId:props.schoolId,sourceId:row.id});
  if(!active)return;message.value=result.message;emit('changed');await load();
 }catch(caught){if(active){await load();error.value=safeError(caught);}}
 finally{if(active)busy.value=false;}
}
async function inspect(row:SourceCatalogueEntry){
 if(locked.value||!row.showInFeed||!props.schoolId)return;busy.value=true;error.value='';
 try{await props.openSchool?.(props.schoolId,{id:row.id,name:row.name});}
 catch(caught){if(active)error.value=safeError(caught);}
 finally{if(active)busy.value=false;}
}
function reset(){query.value='';display.value='all';kind.value='all';categories.value=[...noticeCategories];}
onMounted(()=>void load());onUnmounted(()=>{active=false;request++;});
</script>
<template>
 <section class="feature-surface website-sources" aria-labelledby="website-sources-title">
  <header class="feature-heading"><div><span class="panel-kicker">公告来源</span><h1 id="website-sources-title">来源中心</h1></div><button class="text-button" @click="emit('back')">返回公告</button></header>
  <p class="source-reading-school">当前阅读学校：{{schoolName||'尚未选择'}}<template v-if="catalogue"> · 已勾选 {{shown}}/{{catalogue.sources.length}} 个来源</template></p>
  <p class="muted">学校来源默认勾选，公共来源和我的来源默认不勾选。只有勾选的来源才会在公告页显示，设置仅对本人当前阅读学校生效。</p>
  <div class="source-tabs" role="group" aria-label="来源视图">
   <button :aria-pressed="tab==='all'" :class="{active:tab==='all'}" @click="tab='all'">全部来源</button>
   <button :aria-pressed="tab==='schools'" :class="{active:tab==='schools'}" @click="tab='schools';schoolVisited=true">浏览学校</button>
   <button :aria-pressed="tab==='personal'" :class="{active:tab==='personal'}" @click="tab='personal';personalVisited=true">管理我的来源</button>
  </div>
  <div class="source-actions"><button class="text-button" :disabled="locked||!catalogue?.sources.length" @click="setAll(true)">全部勾选</button><button class="text-button" :disabled="locked||!catalogue?.sources.length" @click="setAll(false)">全部取消勾选</button><button class="text-button" :disabled="locked||loading" @click="load">重新读取目录</button></div>
  <p v-if="error" class="error-message" role="alert">{{error}}</p><p v-if="message" role="status">{{message}}</p>
  <section v-if="tab==='all'" aria-label="全部公告来源">
   <form class="feed-filters" @submit.prevent>
    <label class="filter-label" for="source-keyword">查找来源</label><div class="search-row"><input id="source-keyword" v-model="query" type="search" maxlength="100" placeholder="来源名称或网址"><button class="text-button" type="button" @click="reset">清除筛选</button></div>
    <details class="filter-options"><summary>分类与显示状态</summary><fieldset><legend>分类（匹配任一已勾选标签；全不选则不显示）</legend><div><button class="text-button" type="button" @click="categories=[...noticeCategories]">全选分类</button><button class="text-button" type="button" @click="categories=[]">全不选分类</button></div><label v-for="category in noticeCategories" :key="category" class="category-option"><input v-model="categories" type="checkbox" :value="category">{{categoryNames[category]}}</label></fieldset>
     <div class="source-toolbar"><label>显示状态<select v-model="display" aria-label="来源勾选状态"><option value="all">全部来源</option><option value="shown">已勾选</option><option value="hidden">未勾选</option></select></label><label>来源类型<select v-model="kind" aria-label="来源类型筛选"><option value="all">全部类型</option><option value="school">学校来源</option><option value="public">公共来源</option><option value="personal">我的来源</option></select></label></div>
    </details>
   </form>
   <p v-if="loading" class="muted" role="status">正在读取来源目录…</p>
   <p v-if="catalogue" class="muted small">符合筛选 {{filtered.length}} 个，共 {{catalogue.sources.length}} 个来源。浏览和筛选不会触发采集。</p>
   <p v-if="catalogue&&!filtered.length&&!loading" class="empty-state">没有符合条件的来源，请修改关键词或分类筛选。</p>
   <div class="school-source-grid">
    <article v-for="row in filtered" :key="row.id" class="source-card" :data-source-id="row.id">
     <span class="source-status" :class="'source-status-'+row.state">{{states[row.state]}}</span>
     <h2>{{row.name}}</h2><p class="muted small">{{sourceKinds[row.kind]}} · {{categoryLabel(row.categories)}}</p>
     <label class="source-display"><input type="checkbox" :aria-label="'在公告页显示'+row.name" :checked="row.showInFeed" :disabled="locked" @change="toggle(row,$event)">在公告页显示此来源</label>
     <p class="small">{{row.message}}</p>
     <p v-if="sourceDiagnosis(row.errorCode)" class="source-diagnosis small">{{sourceDiagnosis(row.errorCode)!.title}} · {{sourceDiagnosis(row.errorCode)!.advice}}</p>
     <p class="muted small">最近检查：{{displaySourceTime(row.checkedAt)}}<template v-if="row.count!==null"> · 上次读取 {{row.count}} 条</template></p>
     <p v-if="row.verifiedAt" class="muted small">接入验证：{{displaySourceTime(row.verifiedAt)}}。读取状态可能随原站变化。</p>
     <p v-if="row.nextRefreshAt" class="muted small">下次可采集：{{displaySourceTime(row.nextRefreshAt)}}</p>
     <div class="source-actions"><a v-if="safeOriginal(row.url)" :href="safeOriginal(row.url)!" target="_blank" rel="noopener noreferrer">查看原站</a><button v-if="openSchool" class="text-button" :disabled="locked||!row.showInFeed" @click="inspect(row)">查看该来源公告</button><button v-if="row.collectable" class="text-button" :disabled="locked||!row.showInFeed" @click="collect(row)">{{row.kind==='school'?'刷新本校公告':'立即采集'}}</button></div>
    </article>
   </div>
  </section>
  <fieldset class="source-panels" :disabled="busy||schoolBusy||personalBusy">
   <SchoolSourcesPanel v-if="schoolVisited" v-show="tab==='schools'" :transport="transport" :school-id="schoolId" :school-name="schoolName" :revision="revision" :open-school="openSchool" @busy="schoolBusy=$event" @changed="changed" />
   <PersonalSourcesPanel v-if="personalVisited" v-show="tab==='personal'" :transport="transport" :school-id="schoolId" :school-name="schoolName" :revision="revision" :open-source="openSchool&&schoolId?source=>openSchool!(schoolId!,source):undefined" @busy="personalBusy=$event" @changed="changed" />
  </fieldset>
 </section>
</template>
