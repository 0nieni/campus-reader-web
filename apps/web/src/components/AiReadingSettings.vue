<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import type { AiPreferences, AiMemoryState, AiMemorySlot, AiMemoryItem } from '@campus/contracts';
import type { Transport, ReadingSettingsChange } from '../lib/transport';
import { ClientError, safeError } from '../lib/errors';
const props = defineProps<{transport:Transport;schoolId:string|null;memorySnapshot?:AiMemoryState|null}>();
const emit = defineEmits<{changed:[change:ReadingSettingsChange]}>();
const preferences=ref<AiPreferences|null>(null),memory=ref<AiMemoryState|null>(null),memoryEnabled=ref(true);
const interests=ref(''),goals=ref(''),learningEnabled=ref(false),error=ref(''),note=ref('');
const busy=ref(false),loading=ref(false);
const memoryNames:Record<AiMemorySlot,string>={major:'专业',year:'年级',interests:'兴趣',response_style:'回答偏好',goal:'近期目标',progress:'当前进展'};
let active=true,epoch=0,unsubscribe:(()=>void)|undefined;
function current(ticket: number) { return active && ticket === epoch; }
function sourceTime(value: string | null) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '未提供'; }
function applyPreferences(value: AiPreferences) { preferences.value = value; interests.value = value.interests.join('，'); goals.value = value.goals; learningEnabled.value = value.learningEnabled; }
function applyMemory(value: AiMemoryState) {
  if (value.schoolId !== props.schoolId) return;
  if (memory.value && memory.value.version > value.version) return;
  memory.value = value; memoryEnabled.value = value.enabled;
  expireMemory();
}
function expireMemory() {
  if (!memory.value) return;
  const items = memory.value.items.filter(item => !item.expiresAt || Date.parse(item.expiresAt) > Date.now());
  if (items.length !== memory.value.items.length) memory.value = { ...memory.value, items };
}
function progressGoal(item: AiMemoryItem) {
  const goalId = item.goalId || (item.id === 'progress' ? 'goal' : undefined);
  const goal = goalId && memory.value?.items.find(value => value.slot === 'goal' && value.id === goalId);
  return goal ? `所属目标：${goal.text}` : '未关联目标';
}
async function mutation(work: (ticket: number) => Promise<void>) {
  if (busy.value || loading.value || !props.schoolId) return;
  const ticket = epoch; busy.value = true; error.value = ''; note.value = '';
  try { await work(ticket); } catch (caught) { if (current(ticket)) error.value = safeError(caught); }
  finally { if (current(ticket)) busy.value = false; }
}
async function changeMemory(action: 'configure' | 'forget' | 'clear', id?: string) {
  if (!memory.value) return;
  const enabled = memoryEnabled.value;
  await mutation(async ticket => {
    const schoolId = props.schoolId!, version = memory.value!.version;
    try {
      const value = action === 'configure'
        ? await props.transport.call('ai.memory.configure', { schoolId, enabled, version })
        : action === 'forget'
          ? await props.transport.call('ai.memory.forget', { schoolId, id: id!, version })
          : await props.transport.call('ai.memory.clear', { schoolId, version });
      if (!current(ticket)) return;
      applyMemory(value);
      note.value = action === 'configure' ? value.enabled ? '已开启自动记忆。' : '已关闭自动记忆。' : action === 'forget' ? '已删除这条自动记忆。' : '已清空自动记忆，手动偏好已保留。';
    } catch (caught) {
      if (!current(ticket)) return;
      if (!(caught instanceof ClientError) || caught.code !== 'MEMORY_CONFLICT') throw caught;
      const latest = await props.transport.call('ai.memory.get', { schoolId });
      if (!current(ticket)) return;
      applyMemory(latest); note.value = '记忆已在其他页面更新，已加载最新记忆，请核对后重新操作。';
    } finally {
      if (current(ticket) && memory.value) memoryEnabled.value = memory.value.enabled;
    }
    if (current(ticket)) emit('changed', { schoolId: props.schoolId!, kind: 'memory' });
  });
}
async function savePreferences() {
  if (!preferences.value) return;
  await mutation(async ticket => {
    const schoolId = props.schoolId!;
    try {
      const value = await props.transport.call('ai.profile.save', { schoolId, interests: [...new Set(interests.value.split(/[,，]/).map(s => s.trim()).filter(Boolean))], goals: goals.value.trim(), learningEnabled: learningEnabled.value, version: preferences.value!.version });
      if (!current(ticket)) return;
      applyPreferences(value); note.value = '偏好已保存。';
    } catch (caught) {
      if (!current(ticket)) return;
      if (!(caught instanceof ClientError) || caught.code !== 'PROFILE_CONFLICT') throw caught;
      const latest = await props.transport.call('ai.profile.get', { schoolId });
      if (!current(ticket)) return;
      applyPreferences(latest); note.value = '偏好已在其他页面更新，已加载最新版本，请重新填写后保存。';
    }
    if (current(ticket)) emit('changed', { schoolId: props.schoolId!, kind: 'profile' });
  });
}
async function clearBehavior() {
  await mutation(async ticket => {
    const value = await props.transport.call('ai.profile.clearBehavior', { schoolId: props.schoolId! });
    if (!current(ticket)) return;
    applyPreferences(value); note.value = '已清除行为学习记录，手动偏好已保留。';
    if (current(ticket)) emit('changed', { schoolId: props.schoolId!, kind: 'profile' });
  });
}

async function load(){
 const schoolId=props.schoolId,ticket=epoch;if(!schoolId)return;loading.value=true;
 const results=await Promise.allSettled([props.transport.call('ai.profile.get',{schoolId}),props.transport.call('ai.memory.get',{schoolId})]);
 if(!current(ticket))return;
 const [profile,memories]=results;
 if(profile.status==='fulfilled')applyPreferences(profile.value);
 if(memories.status==='fulfilled')applyMemory(memories.value);
 const failure=results.find(value=>value.status==='rejected');if(failure?.status==='rejected')error.value=safeError(failure.reason);
 loading.value=false;
}
function reset(){epoch++;busy.value=false;loading.value=false;preferences.value=null;memory.value=null;memoryEnabled.value=true;interests.value='';goals.value='';learningEnabled.value=false;error.value='';note.value='';}
function subscribe(){let uid:string|null|undefined;unsubscribe=props.transport.onSessionChange(session=>{const next=session?.uid??null;if(uid!==undefined&&uid===next)return;uid=next;reset();if(next)void load();});}
watch(()=>props.schoolId,()=>{reset();void load();});
watch(()=>props.transport,()=>{unsubscribe?.();reset();subscribe();void load();});
watch(()=>props.memorySnapshot,value=>{if(value)applyMemory(value);});
const timer=setInterval(expireMemory,1000);
onMounted(()=>{subscribe();void load();});
onUnmounted(()=>{active=false;epoch++;clearInterval(timer);unsubscribe?.();});
</script>
<template>
 <section class="reading-settings" aria-label="阅读偏好与AI记忆">
  <p v-if="!schoolId">请先在“我的学校”中选择学校，再设置阅读偏好。</p>
  <template v-else>
   <p>偏好和记忆按当前登录账号、当前学校保存。</p>
   <p v-if="error" class="error-message" role="alert">{{error}}</p><p v-if="note" class="assistant-note" role="status">{{note}}</p>
        <details class="preferences-section"><summary>我的阅读偏好</summary><p class="rail-caption">手动填写偏好。行为学习默认关闭。</p><label for="assistant-interests">关注话题，用逗号分隔</label><input id="assistant-interests" v-model="interests" maxlength="1000" :disabled="busy || loading || !preferences" placeholder="如 招聘，竞赛，学术活动" /><label for="assistant-goals">近期目标</label><textarea id="assistant-goals" v-model="goals" rows="2" maxlength="1000" :disabled="busy || loading || !preferences" /><label class="learning-toggle"><input v-model="learningEnabled" type="checkbox" :disabled="busy || loading || !preferences" /> 根据我主动阅读的公告学习偏好</label><div class="preference-actions"><button data-test="save-preferences" class="secondary" :disabled="busy || loading || !preferences" @click="savePreferences">保存偏好</button><button class="text-button" :disabled="busy || loading || !preferences" @click="clearBehavior">清除行为记录</button></div></details>
        <details class="memory-section" data-test="memory-section">
          <summary>AI记住的信息</summary>
          <p class="rail-caption">默认自动保存你在对话中明确说出的信息，无需逐条确认。与行为学习独立，手动偏好和你当前的明确表达优先。</p>
          <label class="learning-toggle"><input v-model="memoryEnabled" data-test="memory-enabled" type="checkbox" :disabled="busy || loading || !memory" @change="changeMemory('configure')" /> 自动记住我的信息</label>
          <p class="rail-caption">年级 365 天、近期目标 180 天、进展 30 天后到期；专业、兴趣和回答偏好无固定到期，可随时删除。到期信息不再使用，记忆不作为公告事实来源。</p>
          <p v-if="!memory" class="muted">{{ loading ? '正在读取记忆…' : '记忆尚未读取，请重新打开页面重试。' }}</p>
          <p v-else-if="!memory.items.length" class="rail-caption">暂无自动记忆。</p>
          <ul v-else class="memory-list">
            <li v-for="item in memory.items" :key="item.id">
              <strong>{{ memoryNames[item.slot] }}</strong><p>{{ item.text }}</p>
              <small v-if="item.slot === 'progress'">{{ progressGoal(item) }}</small>
              <small>{{ item.expiresAt ? `到期：${sourceTime(item.expiresAt)}（北京时间）` : '无固定到期，可随时删除' }}</small>
              <button :data-test="`forget-memory-${item.id}`" class="text-button" :disabled="busy || loading" :aria-label="`删除${memoryNames[item.slot]}记忆`" @click="changeMemory('forget', item.id)">删除</button>
            </li>
          </ul>
          <button data-test="clear-memory" class="text-button" :disabled="busy || loading || !memory?.items.length" @click="changeMemory('clear')">清空自动记忆</button>
          <p class="rail-caption">清空只删除自动记忆，保留手动填写的阅读偏好。</p>
        </details>
  </template>
 </section>
</template>
<style scoped>
.reading-settings{font-size:14px;line-height:1.8;}.reading-settings details{margin-top:24px;}.reading-settings summary{font-weight:600;cursor:pointer;color:var(--ink,#173766);}.reading-settings label{display:block;margin:16px 0 6px;}.reading-settings input:not([type=checkbox]),.reading-settings textarea{width:100%;box-sizing:border-box;}.reading-settings .learning-toggle{display:flex;align-items:flex-start;gap:10px;}.learning-toggle input{margin-top:5px;}.preference-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:16px;}.rail-caption{font-size:13px;color:var(--muted,#627188);}
.reading-settings input:not([type=checkbox]),.reading-settings textarea{font:inherit;color:var(--ink,#173766);background:#fff;border:1px solid var(--line,#dce3f0);border-radius:8px;padding:11px 13px;min-height:44px;}.reading-settings textarea{min-height:84px;resize:vertical;}.reading-settings input:focus-visible,.reading-settings textarea:focus-visible{outline:2px solid var(--purple,#8b5cf6);outline-offset:2px;}
.memory-section { margin-top: 25px; font-size: 12px; }.memory-section summary { color: #173766; font-weight: 600; cursor: pointer; }.memory-list { list-style: none; padding: 0; margin: 12px 0; }.memory-list li { padding: 12px 0; border-bottom: 1px solid #e7edf6; overflow-wrap: anywhere; }.memory-list p { margin: 6px 0; line-height: 1.8; white-space: pre-wrap; }.memory-list small { display: block; color: #627188; line-height: 1.7; }.memory-list .text-button { margin-top: 6px; font-size: 11px; }
</style>
