<script setup lang="ts">
import {onMounted,onUnmounted,ref,watch} from 'vue';
import type {SourceDisplayState} from '@campus/contracts';
import type {Transport} from '../lib/transport';
import {safeError} from '../lib/errors';
const props=defineProps<{transport:Transport;schoolId:string|null;schoolName:string;revision:number;disabled?:boolean}>();
const emit=defineEmits<{changed:[];busy:[value:boolean]}>();
const summary=ref<SourceDisplayState|null>(null),busy=ref(false),error=ref('');let active=true,request=0;
async function load(){
 if(!props.schoolId)return;const ticket=++request;
 try{const result=await props.transport.call('sources.displayState',{schoolId:props.schoolId});if(active&&ticket===request){summary.value=result;error.value='';}}
 catch(caught){if(active&&ticket===request)error.value=safeError(caught);}
}
async function setAll(visible:boolean){
 if(busy.value||props.disabled||!props.schoolId)return;request++;busy.value=true;error.value='';
 try{const result=await props.transport.call('sources.feedVisibilityAll',{schoolId:props.schoolId,visible});if(!active)return;summary.value=result;emit('changed');}
 catch(caught){if(active)error.value=safeError(caught);}
 finally{if(active)busy.value=false;}
}
onMounted(()=>void load());watch(()=>props.revision,()=>void load());onUnmounted(()=>{active=false;request++;});
watch(busy,value=>emit('busy',value),{flush:'sync'});
</script>
<template>
 <div v-if="schoolId" class="source-display-controls" aria-label="本校来源显示设置">
  <p>{{schoolName}} · <span v-if="summary">已开启 {{summary.shown}}/{{summary.total}} 个来源</span><span v-else>{{error?'显示设置暂不可用':'读取显示设置中…'}}</span></p>
  <div class="source-actions"><button class="text-button" :disabled="busy||disabled||!summary?.total" @click="setAll(true)">本校全部显示</button><button class="text-button" :disabled="busy||disabled||!summary?.total" @click="setAll(false)">本校全部隐藏</button></div>
  <p class="muted small">同时设置本校内置来源与个人来源，仅影响本人主页显示。</p>
  <p v-if="error" class="error-message" role="alert">{{error}} <button class="text-button" :disabled="busy" @click="load">重试显示设置</button></p>
  <p v-if="busy" role="status">正在保存本校显示设置…</p>
 </div>
</template>
