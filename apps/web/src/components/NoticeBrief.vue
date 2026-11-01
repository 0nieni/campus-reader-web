<script setup lang="ts">
import {computed,onMounted,onUnmounted,ref,watch} from 'vue';
import type {NoticeBrief,BriefEvidence} from '../../../../packages/contracts/src/notice-brief';
import {briefDateStatus} from '../lib/notice-brief-time';
const props=defineProps<{brief:NoticeBrief;refresh?:()=>Promise<void>}>();
const expanded=ref(false),clock=ref(Date.now()),offset=ref(0),pollingEnded=ref(false);
let active=true,timer:ReturnType<typeof setTimeout>|undefined,tick:ReturnType<typeof setInterval>|undefined,calls=0;const until=Date.now()+90000;
watch(()=>props.brief.checkedAt,value=>{const at=Date.parse(value);offset.value=Number.isFinite(at)?at-Date.now():0;clock.value=Date.now();},{immediate:true});
watch(()=>props.brief.contentHash,()=>{expanded.value=false;});
const content=computed(()=>props.brief.state==='ready'?props.brief.content:null);
const requirements=computed(()=>expanded.value?content.value?.requirements||[]:(content.value?.requirements||[]).slice(0,3));
const evidence=computed(()=>{const c=content.value;if(!c)return[];const rows:BriefEvidence[]=[...(c.publishedDate?.evidence||[]),...(c.audience?.evidence||[]),...c.keyDates.flatMap(row=>row.evidence),...c.requirements.flatMap(row=>row.evidence),...(c.submission?.evidence||[])];return rows.filter((row,index)=>rows.findIndex(value=>value.paragraphId===row.paragraphId&&value.quote===row.quote)===index);});
const serverNow=computed(()=>clock.value+offset.value);
function stop(){if(timer)clearTimeout(timer);timer=undefined;}
function schedule(){stop();if(!active||props.brief.state!=='pending'||!props.refresh||document.hidden)return;if(calls>=20||Date.now()>=until){pollingEnded.value=true;return;}timer=setTimeout(async()=>{if(!active||document.hidden)return;calls++;try{await props.refresh?.();}catch{/* The store supplies a safe state; the original article remains readable. */}if(active)schedule();},3000);}
function visibility(){clock.value=Date.now();if(document.hidden)stop();else schedule();}
watch(()=>props.brief.state,()=>schedule());
onMounted(()=>{document.addEventListener('visibilitychange',visibility);tick=setInterval(()=>{if(!document.hidden)clock.value=Date.now();},30000);schedule();});
onUnmounted(()=>{active=false;stop();if(tick)clearInterval(tick);document.removeEventListener('visibilitychange',visibility);});
</script>
<template>
 <section class="notice-brief" aria-label="公告摘要" :aria-busy="brief.state==='pending'">
  <h2 class="brief-title">公告摘要</h2>
  <template v-if="content">
   <dl class="brief-fields">
    <div class="brief-field"><dt>发布日期</dt><dd>{{content.publishedDate?.value||'原文未明确'}}</dd></div>
    <div class="brief-field"><dt>适用对象</dt><dd>{{content.audience?.text||'原文未明确，请核对正文。'}}</dd></div>
    <div class="brief-field"><dt>关键时间</dt><dd><p v-if="!content.keyDates.length">原文未明确。</p><div v-for="(date,index) in content.keyDates" :key="index" class="brief-date"><p>{{date.label}}：{{date.rawText}}</p><p v-if="date.conditions" class="brief-condition">适用条件：{{date.conditions}}</p><strong class="brief-status" :data-state="briefDateStatus(date,serverNow).kind">{{briefDateStatus(date,serverNow).text}}</strong></div></dd></div>
    <div v-if="requirements.length" class="brief-field"><dt>办理要求</dt><dd><ul><li v-for="(row,index) in requirements" :key="index">{{row.text}}</li></ul><button v-if="content.requirements.length>3" type="button" class="brief-toggle" :aria-expanded="expanded" @click="expanded=!expanded">{{expanded?'收起要求':'展开全部要求'}}</button></dd></div>
    <div v-if="content.submission" class="brief-field"><dt>提交方式</dt><dd>{{content.submission.text}}</dd></div>
   </dl>
   <div class="brief-provenance"><details><summary>查看原文依据</summary><blockquote v-for="(row,index) in evidence" :key="index">{{row.quote}}</blockquote></details><span>依据公告正文整理 · 本摘要未读取附件</span></div>
  </template>
  <p v-else class="brief-message" role="status">{{brief.message||(brief.state==='pending'?'摘要正在整理，可先阅读正文。':'摘要暂不可用，请先阅读正文。')}}</p>
  <p v-if="brief.state==='pending'&&pollingEnded" class="brief-message">暂未整理完成，可稍后重新打开公告查看。</p>
 </section>
</template>
<style scoped>
.notice-brief{margin:22px 0;padding:18px;border:1px solid var(--purple-line,#e7e0f0);border-radius:11px;background:#f7f3ff;color:var(--ink,#35435e);font-size:14px;line-height:1.8;overflow-wrap:anywhere;}
.notice-brief .brief-title{margin:0 0 12px;font-size:16px;line-height:1.5;font-weight:600;color:var(--purple,#7541d9);}
.brief-fields{margin:0;}.brief-field{display:grid;grid-template-columns:82px minmax(0,1fr);gap:14px;margin:10px 0;}.brief-field dt{color:var(--muted,#85899e);}.brief-field dd{margin:0;min-width:0;}.brief-field p{margin:0;}.brief-field ul{margin:0;padding-left:18px;}.brief-field li+li{margin-top:6px;}.brief-date+.brief-date{margin-top:12px;}.brief-condition{font-size:13px;color:var(--muted,#85899e);}.brief-status{display:block;margin-top:4px;font-size:13px;font-weight:600;}.brief-status[data-state=closed]{color:#b43e28;}.brief-status[data-state=active],.brief-status[data-state=today]{color:#5c379e;}.brief-status[data-state=unknown]{color:var(--muted,#85899e);}
.brief-provenance{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap;margin-top:20px;border-top:1px solid var(--purple-line,#e7e0f0);padding-top:11px;font-size:12px;color:var(--muted,#85899e);}.brief-provenance details{flex:1;min-width:130px;}.brief-provenance summary,.brief-toggle{color:var(--purple,#7541d9);cursor:pointer;}.brief-provenance blockquote{margin:10px 0;border-left:2px solid var(--purple-line,#e7e0f0);padding-left:10px;white-space:pre-wrap;}.brief-toggle{border:0;background:transparent;font:inherit;padding:5px 0;}.brief-toggle:focus-visible,.brief-provenance summary:focus-visible{outline:2px solid var(--purple,#7541d9);outline-offset:3px;}.notice-brief .brief-message{margin:0;font-size:14px;}
@media(max-width:600px){.notice-brief{padding:16px;}.brief-field{grid-template-columns:minmax(0,1fr);gap:2px;margin:14px 0;}.brief-provenance{display:block;}.brief-provenance>span{display:block;margin-top:7px;}}
</style>
