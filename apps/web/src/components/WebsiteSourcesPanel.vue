<script setup lang="ts">
import {ref} from 'vue';
import type {Transport} from '../lib/transport';
import SchoolSourcesPanel from './SchoolSourcesPanel.vue';
import PersonalSourcesPanel from './PersonalSourcesPanel.vue';
import SourceDisplayControls from './SourceDisplayControls.vue';
defineProps<{transport:Transport;schoolId:string|null;schoolName:string;openSchool?:(schoolId:string,source?:{id:string;name:string})=>Promise<void>}>();
const emit=defineEmits<{changed:[kind?:'visibility'];back:[]}>();
const tab=ref<'school'|'personal'>('school');
const personalVisited=ref(false);
const revision=ref(0);
const dataRevision=ref(0);
const schoolBusy=ref(false),personalBusy=ref(false),bulkBusy=ref(false);
function changed(kind?:'visibility'){revision.value++;emit('changed',kind);}
function bulkChanged(){dataRevision.value++;changed('visibility');}
</script>
<template>
 <section class="feature-surface website-sources" aria-labelledby="website-sources-title">
  <header class="feature-heading"><div><span class="panel-kicker">公告来源</span><h1 id="website-sources-title">来源中心</h1></div><button class="text-button" @click="emit('back')">返回公告</button></header>
  <p class="source-reading-school">当前阅读学校：{{schoolName||'尚未选择'}}</p>
  <SourceDisplayControls :transport="transport" :school-id="schoolId" :school-name="schoolName" :revision="revision" :disabled="schoolBusy||personalBusy" @busy="bulkBusy=$event" @changed="bulkChanged" />
  <div class="source-tabs" role="group" aria-label="来源类型">
   <button :aria-pressed="tab==='school'" :class="{active:tab==='school'}" @click="tab='school'">学校来源</button>
   <button :aria-pressed="tab==='personal'" :class="{active:tab==='personal'}" @click="tab='personal';personalVisited=true">我的来源</button>
  </div>
  <fieldset class="source-panels" :disabled="bulkBusy">
   <SchoolSourcesPanel v-show="tab==='school'" :key="`school:${schoolId}`" :transport="transport" :school-id="schoolId" :school-name="schoolName" :revision="dataRevision" :open-school="openSchool" @busy="schoolBusy=$event" @changed="changed" />
   <PersonalSourcesPanel v-if="personalVisited" v-show="tab==='personal'" :key="`personal:${schoolId}`" :transport="transport" :school-id="schoolId" :school-name="schoolName" :revision="dataRevision" :open-source="openSchool&&schoolId?source=>openSchool!(schoolId!,source):undefined" @busy="personalBusy=$event" @changed="changed" />
  </fieldset>
 </section>
</template>
