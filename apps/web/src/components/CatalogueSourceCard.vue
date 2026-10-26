<script setup lang="ts">
import type {SourceCatalogueEntry} from '@campus/contracts';
import {categoryNames,displaySourceTime,safeOriginal,sourceDiagnosis} from '../lib/presentation';
defineProps<{row:SourceCatalogueEntry;locked:boolean;canInspect:boolean}>();
const emit=defineEmits<{toggle:[row:SourceCatalogueEntry,event:Event];collect:[row:SourceCatalogueEntry];inspect:[row:SourceCatalogueEntry]}>();
const sourceKinds={school:'学校来源',public:'公共来源',personal:'我的来源'};
const states={unchecked:'尚未采集',ready:'最近读取成功',unavailable:'暂未读取成功'};
function categoryLabel(values:readonly string[]){return values.map(category=>categoryNames[category]||category).join(' · ');}
function statusLabel(row:SourceCatalogueEntry){return row.collectionStatus==='pending'?'待验证':row.collectionStatus==='entry_only'?'仅原站入口':states[row.state];}
</script>
<template>
 <article class="source-card" :data-source-id="row.id">
  <span class="source-status" :class="'source-status-'+row.state">{{statusLabel(row)}}</span>
  <h2>{{row.name}}</h2><p class="muted small">{{sourceKinds[row.kind]}} · {{categoryLabel(row.categories)}}</p>
  <p v-if="row.directory" class="muted small">导航序号 {{row.directory.number}} · {{row.directory.entryType}}</p>
  <label class="source-display"><input type="checkbox" :aria-label="'在公告页显示'+row.name" :checked="row.showInFeed" :disabled="locked" @change="emit('toggle',row,$event)">在公告页显示此来源</label>
  <p class="small">{{row.message}}</p>
  <details v-if="row.directory" class="small"><summary>查看导航备注与网址</summary><p>原文件备注（未实时核验）：{{row.directory.note}}</p><p>{{row.url}}</p></details>
  <p v-if="sourceDiagnosis(row.errorCode)" class="source-diagnosis small">{{sourceDiagnosis(row.errorCode)!.title}} · {{sourceDiagnosis(row.errorCode)!.advice}}</p>
  <p class="muted small">最近检查：{{displaySourceTime(row.checkedAt)}}<template v-if="row.count!==null"> · 上次读取 {{row.count}} 条</template></p>
  <p v-if="row.verifiedAt" class="muted small">接入验证：{{displaySourceTime(row.verifiedAt)}}。读取状态可能随原站变化。</p>
  <p v-if="row.nextRefreshAt" class="muted small">下次可采集：{{displaySourceTime(row.nextRefreshAt)}}</p>
  <div class="source-actions"><a v-if="safeOriginal(row.url)" :href="safeOriginal(row.url)!" target="_blank" rel="noopener noreferrer">查看原站</a><button v-if="canInspect&&(row.collectable||!row.directory)" class="text-button" :disabled="locked||!row.showInFeed" @click="emit('inspect',row)">查看该来源公告</button><button v-if="row.collectable" class="text-button" :disabled="locked||!row.showInFeed" @click="emit('collect',row)">{{row.kind==='school'?'刷新本校公告':'立即采集'}}</button></div>
 </article>
</template>
