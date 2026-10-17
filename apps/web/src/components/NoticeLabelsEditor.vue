<script setup lang="ts">
import {onUnmounted,ref,watch} from 'vue';
import {noticeCategories} from '@campus/contracts';
import type {Transport} from '../lib/transport';
import {categoryNames} from '../lib/presentation';
import {safeError} from '../lib/errors';
const props=defineProps<{transport:Transport;schoolId:string;itemId:string;categories:string[];customized:boolean}>();
const emit=defineEmits<{saved:[value:{schoolId:string;itemId:string;categories:string[];customized:boolean}]}>();
const selected=ref([...props.categories]),busy=ref(false),message=ref('');
let active=true;
watch(()=>props.categories,value=>{selected.value=[...value];});
onUnmounted(()=>{active=false;});
async function save(reset=false) {
  if(busy.value || (!reset && !selected.value.length))return;
  busy.value=true;message.value='';
  try {
    const result=await props.transport.call('feed.labels.set',{schoolId:props.schoolId,itemId:props.itemId,categories:reset?null:[...selected.value]});
    if(!active)return;
    selected.value=[...result.categories];message.value=reset?'已恢复默认标签。':'个人标签已保存。';
    emit('saved',{...result,schoolId:props.schoolId,itemId:props.itemId});
  }catch(error){if(active)message.value=safeError(error);}
  finally{if(active)busy.value=false;}
}
</script>
<template>
  <details class="notice-label-editor">
    <summary>修改公告标签{{customized?' · 已自定义':''}}</summary>
    <p class="muted small">标签仅影响你的公告显示与筛选，不会修改其他用户的标签。至少保留一个标签。</p>
    <fieldset :disabled="busy">
      <legend>这条公告的标签（可多选）</legend>
      <label v-for="category in noticeCategories" :key="category" class="category-option"><input v-model="selected" type="checkbox" :value="category">{{categoryNames[category]}}</label>
    </fieldset>
    <div class="action-row"><button class="secondary" type="button" :disabled="busy || !selected.length" @click="save()">{{busy?'正在保存…':'保存标签'}}</button><button class="text-button" type="button" :disabled="busy || !customized" @click="save(true)">恢复默认标签</button></div>
    <p v-if="!selected.length" class="small">请选择至少一个标签。</p>
    <p v-if="message" class="small" role="status">{{message}}</p>
  </details>
</template>
<style scoped>
.notice-label-editor{margin:20px 0;padding:16px 0;border-top:1px solid #dce4ef;border-bottom:1px solid #dce4ef;}
summary{cursor:pointer;color:#285b9c;}
fieldset{margin:12px 0;border:0;padding:0;}
legend{font-size:13px;margin-bottom:10px;}
.category-option{display:inline-flex;align-items:center;gap:5px;margin:0 16px 10px 0;}
</style>
