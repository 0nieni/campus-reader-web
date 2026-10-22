<script setup lang="ts">
import {computed,onMounted,onUnmounted,ref,watch} from 'vue';
import {noticeCategories,type Notice,type Reminder,type ReminderState} from '@campus/contracts';
import type {Transport} from '../lib/transport';
import {categoryNames} from '../lib/presentation';
import {safeError} from '../lib/errors';
const props=defineProps<{transport:Transport;schoolId:string|null;schoolName:string;reminders:Reminder[]}>();
const emit=defineEmits<{added:[state:ReminderState]}>();
const keyword=ref(''),categories=ref<string[]>([...noticeCategories]),items=ref<Notice[]>([]),selected=ref<string[]>([]),cursor=ref<string|null>(null),loading=ref(false),adding=ref(false),error=ref(''),collapsed=ref(false);
const existing=computed(()=>new Set(props.reminders.filter(r=>r.schoolId===props.schoolId).map(r=>r.itemId)));
const tagsText=(values:string[])=>values.map(value=>categoryNames[value]||value).join('、');
let active=true,epoch=0,media:MediaQueryList|undefined;
async function load(more=false){
 const school=props.schoolId,ticket=++epoch;error.value='';loading.value=true;
 if(!more){items.value=[];cursor.value=null;}
 if(!school){loading.value=false;return;}
 try{
  const result=await props.transport.call('feed.list',{schoolId:school,keyword:keyword.value.trim(),categories:[...categories.value],period:'all',...(more&&cursor.value?{cursor:cursor.value}:{})});
  if(active&&ticket===epoch&&props.schoolId===school){items.value=more?[...items.value,...result.items]:result.items;cursor.value=result.nextCursor;}
 }catch(caught){if(active&&ticket===epoch)error.value=safeError(caught);}finally{if(active&&ticket===epoch)loading.value=false;}
}
function choose(itemId:string){
 if(existing.value.has(itemId)||adding.value)return;
 if(selected.value.includes(itemId))selected.value=selected.value.filter(id=>id!==itemId);
 else if(selected.value.length<20)selected.value.push(itemId);
 else error.value='一次最多勾选20篇公告，请先加入当前选择。';
}
async function add(){
 if(adding.value||!props.schoolId||!selected.value.length)return;
 const school=props.schoolId;adding.value=true;error.value='';
 try{const result=await props.transport.call('reminders.add',{schoolId:school,itemIds:[...selected.value]});if(active&&school===props.schoolId){selected.value=[];emit('added',result);}}
 catch(caught){if(active&&school===props.schoolId)error.value=safeError(caught);}
 finally{if(active)adding.value=false;}
}
function selectCategories(all:boolean){categories.value=all?[...noticeCategories]:[];void load();}
function screenChanged(event:MediaQueryListEvent){collapsed.value=event.matches;}
watch(()=>props.schoolId,()=>{selected.value=[];void load();});
watch(existing,value=>{selected.value=selected.value.filter(id=>!value.has(id));});
onMounted(()=>{media=window.matchMedia?.('(max-width: 800px)');collapsed.value=media?.matches||false;media?.addEventListener('change',screenChanged);void load();});
onUnmounted(()=>{active=false;epoch++;media?.removeEventListener('change',screenChanged);selected.value=[];items.value=[];});
</script>
<template>
 <aside class="reminder-picker" aria-labelledby="reminder-picker-title">
  <header class="picker-heading"><div><h2 id="reminder-picker-title">选择公告</h2><p class="small muted">{{schoolName||'请先返回公告页选择学校'}}</p></div><button class="text-button picker-toggle" :aria-expanded="!collapsed" @click="collapsed=!collapsed">{{collapsed?'展开':'收起'}}</button></header>
  <div v-show="!collapsed" class="picker-body">
   <form class="picker-search" @submit.prevent="load()"><label for="reminder-notice-search" class="small">搜索公告关键词</label><div><input id="reminder-notice-search" v-model="keyword" type="search" maxlength="100" placeholder="输入关键词"><button class="secondary" :disabled="!schoolId||loading">搜索</button></div></form>
   <details class="picker-filters"><summary>标签筛选（{{categories.length}}／{{noticeCategories.length}}）</summary><div class="action-row"><button class="text-button" :disabled="loading" @click="selectCategories(true)">全选标签</button><button class="text-button" :disabled="loading" @click="selectCategories(false)">全不选标签</button></div><div class="picker-tags"><label v-for="category in noticeCategories" :key="category"><input v-model="categories" type="checkbox" :value="category" @change="load()">{{categoryNames[category]}}</label></div></details>
   <p v-if="error" class="error-message" role="alert">{{error}}</p>
   <div class="picker-results" :aria-busy="loading">
    <p v-if="loading&&!items.length" class="picker-empty" role="status">正在读取公告…</p>
    <p v-else-if="!items.length" class="picker-empty">{{schoolId?'没有匹配公告，请调整关键词或标签。':'选择学校后即可勾选公告。'}}</p>
    <label v-for="item in items" :key="item.id" class="picker-notice" :class="{added:existing.has(item.id)}"><input type="checkbox" :checked="existing.has(item.id)||selected.includes(item.id)" :disabled="adding||existing.has(item.id)" @change="choose(item.id)"><span><span class="picker-title">{{item.title}}</span><span class="small muted">{{existing.has(item.id)?'已加入提醒中心':tagsText(item.categories)}}</span></span></label>
    <button v-if="cursor" class="load-more" :disabled="loading||adding" @click="load(true)">{{loading?'正在读取…':'加载更多公告'}}</button>
   </div>
   <footer class="picker-footer"><div><span>已选 {{selected.length}} 篇</span><button v-if="selected.length" class="text-button" :disabled="adding" @click="selected=[]">清空选择</button></div><button class="primary" :disabled="adding||!selected.length" @click="add">{{adding?'正在加入…':'加入所选公告'}}</button><p class="small muted">加入后在左侧逐篇设置时间。仅显示已采集、当前账号可读的公告。</p></footer>
  </div>
 </aside>
</template>
