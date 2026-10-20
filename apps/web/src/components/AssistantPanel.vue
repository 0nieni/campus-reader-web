<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { AiChatTurn, AiConversation, AiConnection, AiPreferences, AiRecommendations, GatewayActions, Notice, RecommendedNotice } from '@campus/contracts';
import type { Transport } from '../lib/transport';
import { ClientError, safeError } from '../lib/errors';
import { downloadFile, renderMarkdown } from '../lib/markdown';
const props = defineProps<{ transport: Transport; schoolId: string | null; selection: Notice[] }>();
const emit = defineEmits<{ remove: [id: string]; back: []; advanced: [] }>();
const status = ref<GatewayActions['ai.status']['output'] | null>(null);
const preferences = ref<AiPreferences | null>(null), recommendations = ref<AiRecommendations | null>(null), chat = ref<AiConversation | null>(null);
const interests = ref(''), goals = ref(''), learningEnabled = ref(false), query = ref(''), question = ref('');
const service = ref<'official' | 'byok'>('official'), provider = ref<AiConnection['provider']>('deepseek'), model = ref(''), apiKey = ref('');
const localSources = ref<Notice[]>([]), dismissed = ref<RecommendedNotice | null>(null), error = ref(''), note = ref('');
const busy = ref(false), loading = ref(false), cancelling = ref(false), resolutions = ref<Record<string, string>>({});
const stateNames = { ready: '等待继续', running: '正在回答', complete: '已完成', failed: '未完成', uncertain: '状态待核查', cancelled: '已取消' };
const readNames = { body: '已读正文', title_only: '仅标题', snippet_only: '仅摘要', unavailable: '正文不可用' };
let active = true, epoch = 0, stopped = true, createRequestId = '', sendRequestId = '', sendSignature = '';
const selected = computed(() => [...new Map([...props.selection, ...localSources.value].map(item => [item.id, item])).values()]);
const unresolved = computed(() => chat.value?.turns.some(turn => ['ready', 'running', 'uncertain'].includes(turn.state) || turn.quotaHeld));
const canExport = computed(() => Boolean(chat.value?.turns.some(turn => turn.result) && !busy.value && !loading.value));
const canSend = computed(() => Boolean(props.schoolId && !loading.value && !busy.value && !unresolved.value && question.value.trim() && question.value.length <= 1500 && selected.value.length <= 8 && (service.value === 'official' ? status.value?.officialConfigured && (status.value?.quota.remaining || 0) > 0 : model.value.trim() && apiKey.value)));
function current(ticket: number) { return active && ticket === epoch; }
function safeLink(value: string | null) { try { const url = new URL(value || ''); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; } }
function sourceTime(value: string | null) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '未提供'; }
function applyPreferences(value: AiPreferences) { preferences.value = value; interests.value = value.interests.join('，'); goals.value = value.goals; learningEnabled.value = value.learningEnabled; }
function applyChat(value: AiConversation | null) {
  if (value && (value.schoolId !== props.schoolId || Date.parse(value.expireAt) <= Date.now())) { chat.value = null; note.value = '对话已满 24 小时，请开始新对话。'; return; }
  chat.value = value;
  const pending = value?.turns.find(turn => ['ready', 'running'].includes(turn.state));
  if (pending?.service === 'byok' && ['deepseek', 'openai'].includes(pending.provider)) {
    if (provider.value !== pending.provider || model.value.trim() !== pending.model) apiKey.value = '';
    service.value = 'byok'; provider.value = pending.provider as AiConnection['provider']; model.value = pending.model;
    if (!apiKey.value) note.value = '继续 API 回答前，请在使用设置中重新填写 Key。';
  }
}
function replaceTurn(value: AiChatTurn) {
  if (!chat.value) return;
  const index = chat.value.turns.findIndex(turn => turn.id === value.id);
  if (index < 0) chat.value.turns.push(value); else chat.value.turns[index] = value;
}
function releaseSearchSelection(turn?: AiChatTurn) {
  if (!turn?.search) return;
  localSources.value = [];
  for (const item of props.selection) emit('remove', item.id);
}
async function load() {
  const schoolId = props.schoolId, ticket = epoch;
  if (!schoolId) return;
  loading.value = true;
  const results = await Promise.allSettled([
    props.transport.call('ai.status', {}), props.transport.call('ai.profile.get', { schoolId }),
    props.transport.call('ai.recommend', { schoolId }), props.transport.call('ai.chat.latest', { schoolId }),
  ]);
  if (!current(ticket)) return;
  const [quota, profile, recs, latest] = results;
  if (quota.status === 'fulfilled') status.value = quota.value;
  if (profile.status === 'fulfilled') applyPreferences(profile.value);
  if (recs.status === 'fulfilled') recommendations.value = recs.value;
  if (latest.status === 'fulfilled') applyChat(latest.value.conversation);
  const failure = results.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') error.value = safeError(failure.reason);
  loading.value = false;
}
async function refreshQuota(ticket: number) {
  if (!current(ticket)) return;
  try { const value = await props.transport.call('ai.status', {}); if (current(ticket)) status.value = value; }
  catch (caught) { if (current(ticket)) error.value = safeError(caught); }
}
async function mutation(work: (ticket: number) => Promise<void>) {
  if (busy.value || loading.value || !props.schoolId) return;
  const ticket = epoch; busy.value = true; error.value = ''; note.value = '';
  try { await work(ticket); } catch (caught) { if (current(ticket)) error.value = safeError(caught); }
  finally { if (current(ticket)) busy.value = false; }
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
    await refreshRecommendations(ticket);
  });
}
async function refreshRecommendations(ticket: number) {
  if (!current(ticket) || !props.schoolId) return;
  recommendations.value = null; dismissed.value = null;
  const value = await props.transport.call('ai.recommend', { schoolId: props.schoolId });
  if (current(ticket)) recommendations.value = value;
}
async function clearBehavior() {
  await mutation(async ticket => {
    const value = await props.transport.call('ai.profile.clearBehavior', { schoolId: props.schoolId! });
    if (!current(ticket)) return;
    applyPreferences(value); note.value = '已清除行为学习记录，手动偏好已保留。';
    await refreshRecommendations(ticket);
  });
}
async function search() {
  await mutation(async ticket => { const value = await props.transport.call('ai.recommend', { schoolId: props.schoolId!, query: query.value.trim(), search: true }); if (current(ticket)) recommendations.value = value; });
}
function isSelected(id: string) { return selected.value.some(item => item.id === id); }
function recordBehavior(itemId: string) {
  if (!props.schoolId || !active) return;
  // The server owns opt-in enforcement. Opening a source must not wait for learning.
  void props.transport.call('ai.behavior', { schoolId: props.schoolId, itemId }).catch(() => {});
}
function toggleSource(item: Notice) {
  if (busy.value || loading.value) return;
  if (isSelected(item.id)) { localSources.value = localSources.value.filter(value => value.id !== item.id); if (props.selection.some(value => value.id === item.id)) emit('remove', item.id); }
  else if (selected.value.length < 8) { localSources.value.push(item); recordBehavior(item.id); }
  else note.value = '每次最多选择 8 篇公告。';
}
async function dismiss(item: RecommendedNotice, undo = false) {
  await mutation(async ticket => {
    await props.transport.call('ai.dismiss', { schoolId: props.schoolId!, itemId: item.id, dismissed: !undo });
    if (!current(ticket) || !recommendations.value) return;
    if (undo) { recommendations.value.items.unshift(item); dismissed.value = null; }
    else { recommendations.value.items = recommendations.value.items.filter(value => value.id !== item.id); dismissed.value = item; }
  });
}
async function recover(ticket: number, conversationId: string) {
  if (!current(ticket)) return;
  try { const value = await props.transport.call('ai.chat.get', { conversationId }); if (current(ticket)) applyChat(value); }
  catch (caught) { if (current(ticket)) error.value = safeError(caught); }
}
async function stepTurn(ticket: number, turnId: string) {
  if (!current(ticket) || !chat.value) return;
  const conversationId = chat.value.id;
  for (let count = 0; count < 64 && current(ticket) && !stopped; count++) {
    const turn = chat.value?.turns.find(value => value.id === turnId);
    if (!turn || turn.state !== 'ready') break;
    if (turn.service === 'byok' && (!apiKey.value || !model.value.trim() || provider.value !== turn.provider || model.value.trim() !== turn.model)) { error.value = '继续回答前，请填写该任务使用的服务商、模型和 API Key。'; break; }
    try {
      const value = await props.transport.call('ai.chat.step', { conversationId, turnId, step: turn.step, ...(turn.service === 'byok' ? { connection: { provider: provider.value, model: model.value.trim(), apiKey: apiKey.value } } : {}) });
      if (!current(ticket) || stopped) return;
      replaceTurn(value);
      if (value.state === 'ready' && value.step <= turn.step) { stopped = true; note.value = '本批状态尚未推进，请刷新对话状态后再继续。'; break; }
    } catch (caught) {
      if (!current(ticket)) return;
      stopped = true;
      error.value = safeError(caught);
      await recover(ticket, conversationId);
      if (!current(ticket)) return;
      note.value = '已查询对话状态。请核查后手动继续，未重复调用模型。';
      break;
    }
  }
  if (current(ticket)) { stopped = true; await refreshQuota(ticket); }
}
async function send() {
  if (!canSend.value) return;
  await mutation(async ticket => {
    const text = question.value.trim(), itemIds = selected.value.map(item => item.id);
    const signature = JSON.stringify([props.schoolId, text, itemIds, service.value, provider.value, model.value.trim()]);
    if (signature !== sendSignature) { sendRequestId = crypto.randomUUID(); sendSignature = signature; }
    if (!chat.value) {
      createRequestId ||= crypto.randomUUID();
      const value = await props.transport.call('ai.chat.create', { schoolId: props.schoolId!, requestId: createRequestId });
      if (!current(ticket)) return;
      applyChat(value);
      if (!chat.value) return;
    }
    const conversationId = chat.value.id;
    try {
      const value = await props.transport.call('ai.chat.send', { conversationId, requestId: sendRequestId, question: text, ...(itemIds.length ? { itemIds } : {}), service: service.value, ...(service.value === 'byok' ? { provider: provider.value, model: model.value.trim() } : {}) });
      if (!current(ticket)) return;
      replaceTurn(value);
      releaseSearchSelection(value);
      question.value = ''; sendRequestId = ''; sendSignature = ''; stopped = false;
      await stepTurn(ticket, value.id);
    } catch (caught) {
      if (!current(ticket)) return;
      stopped = true; error.value = safeError(caught); await recover(ticket, conversationId);
      if (current(ticket)) {
        const restored = chat.value?.turns.find(turn => turn.id === sendRequestId);
        if (restored) { releaseSearchSelection(restored); question.value = ''; sendRequestId = ''; sendSignature = ''; }
        note.value = '已查询对话状态。未确认的问题可再次点击发送，系统会核对同一次请求。';
      }
    }
  });
}
async function resume(turn: AiChatTurn) {
  await mutation(async ticket => { stopped = false; await stepTurn(ticket, turn.id); });
}
async function refreshChat() {
  if (!chat.value) return;
  await mutation(async ticket => { await recover(ticket, chat.value!.id); await refreshQuota(ticket); });
}
async function cancel(turn: AiChatTurn) {
  if (!chat.value || cancelling.value) return;
  stopped = true; cancelling.value = true; const ticket = epoch, conversationId = chat.value.id;
  try { const value = await props.transport.call('ai.chat.cancel', { conversationId, turnId: turn.id }); if (current(ticket)) replaceTurn(value); }
  catch (caught) { if (current(ticket)) { error.value = safeError(caught); await recover(ticket, conversationId); } }
  finally { if (current(ticket)) { cancelling.value = false; await refreshQuota(ticket); } }
}
async function resolve(turn: AiChatTurn) {
  const resolution = resolutions.value[turn.id]; if (!resolution || !chat.value) return;
  await mutation(async ticket => { const value = await props.transport.call('ai.chat.resolve', { conversationId: chat.value!.id, turnId: turn.id, charged: resolution === 'charged' }); if (current(ticket)) { replaceTurn(value); delete resolutions.value[turn.id]; await refreshQuota(ticket); } });
}
function newConversation() {
  if (busy.value || unresolved.value) return;
  stopped = true; chat.value = null; createRequestId = ''; sendRequestId = ''; sendSignature = ''; question.value = ''; note.value = '已开始新对话。';
}
async function clearConversation() {
  if (!chat.value) return;
  await mutation(async ticket => { const value = await props.transport.call('ai.chat.clear', { conversationId: chat.value!.id }); if (current(ticket) && value.cleared) { chat.value = null; createRequestId = ''; sendRequestId = ''; sendSignature = ''; note.value = '云端对话已清除。'; } });
}
function exportConversation() {
  if (!canExport.value || !chat.value || Date.parse(chat.value.expireAt) <= Date.now()) return;
  const value = chat.value;
  const lines = ['# 校园阅读对话', '', `创建时间：${sourceTime(value.createdAt)}（北京时间）`, `云端到期：${sourceTime(value.expireAt)}（北京时间）`, '', '导出不会延长云端保存时间；下载文件由本人保管。', ''];
  for (const turn of value.turns) {
    lines.push('## 问题', '', turn.question, '', '## 回答', '', turn.result || turn.message, '', `状态：${stateNames[turn.state]}`, '');
    if (turn.references.length) {
      lines.push('### 来源', '');
      for (const source of turn.references) lines.push(`- [${source.reference}] ${source.title}${safeLink(source.originalUrl) ? ` ${safeLink(source.originalUrl)}` : '（原文链接未提供）'}`);
      lines.push('');
    }
  }
  downloadFile('校园阅读对话.md', lines.join('\n'));
  note.value = '已导出当前对话。下载文件不会随云端到期自动删除。';
}
function reset() {
  epoch++; stopped = true; busy.value = false; loading.value = false; cancelling.value = false; status.value = null; preferences.value = null; recommendations.value = null; chat.value = null; localSources.value = []; dismissed.value = null; interests.value = ''; goals.value = ''; learningEnabled.value = false; apiKey.value = ''; model.value = ''; question.value = ''; query.value = ''; error.value = ''; note.value = ''; resolutions.value = {}; createRequestId = ''; sendRequestId = ''; sendSignature = '';
}
watch(() => props.schoolId, () => { reset(); void load(); });
const timer = setInterval(() => {
  if (chat.value && Date.parse(chat.value.expireAt) <= Date.now()) { epoch++; stopped = true; busy.value = false; loading.value = false; cancelling.value = false; chat.value = null; apiKey.value = ''; createRequestId = ''; sendRequestId = ''; sendSignature = ''; note.value = '个人对话已满 24 小时，已从当前页面移除。'; }
}, 1000);
onMounted(load);
onUnmounted(() => { active = false; reset(); clearInterval(timer); });
</script>

<template>
  <section class="feature-surface assistant-surface" aria-labelledby="assistant-title">
    <header class="feature-heading assistant-heading"><div><h1 id="assistant-title">校园阅读搭子</h1><p>一起读懂校园消息，需要时再想想下一步。</p></div><button class="text-button" @click="emit('back')">返回公告</button></header>
    <div class="assistant-layout">
      <div class="assistant-dialogue">
        <div class="dialogue-toolbar"><span v-if="status" class="quota-line">官方今日剩余 <strong>{{ status.quota.remaining }} / {{ Math.min(status.quota.limit, 3) }}</strong><small> 已用 {{ status.quota.used }}，预占 {{ status.quota.held }}</small></span><span v-else class="muted">{{ loading ? '正在读取额度…' : '额度尚未读取' }}</span><div><button data-test="export-conversation" class="text-button" :disabled="!canExport" @click="exportConversation">导出对话</button><button class="text-button" :disabled="busy || loading || unresolved" @click="newConversation">新对话</button><button class="text-button" :disabled="busy || loading || !chat" @click="clearConversation">清除对话</button></div></div>
        <div class="assistant-stream" role="log" aria-label="阅读对话" aria-live="polite" aria-relevant="additions text" :aria-busy="busy">
          <div v-if="!chat?.turns.length" class="assistant-welcome"><div class="companion-mark" aria-hidden="true">阅</div><h2>今天想读懂哪件校园事？</h2><p>可以选篇公告问问，也可以说说你的目标。先把眼前的问题弄清楚，需要时一起想想下一步；资料没写清的，我会说明。</p><p class="welcome-note">打开页面不会调用模型。官方每个问题最多使用 1 次额度，每天最多 3 次。</p></div>
          <article v-for="turn in chat?.turns || []" :key="turn.id" class="conversation-turn">
            <div class="question-bubble"><span class="speaker">你</span><p>{{ turn.question }}</p></div>
            <div class="answer-block"><span class="speaker">阅读搭子 <small>{{ stateNames[turn.state] }}</small></span><div v-if="turn.result" class="markdown-content" v-html="renderMarkdown(turn.result)" /><p v-else class="turn-message">{{ turn.message }}</p>
              <p v-if="turn.search" class="turn-search-status" role="status">{{ turn.search.message }}</p>
              <p class="turn-meta">{{ turn.service === 'official' ? '官方 AI' : '我的 API' }} · {{ turn.model }}<template v-if="turn.totalSteps"> · {{ Math.min(turn.step, turn.totalSteps) }}/{{ turn.totalSteps }} 批</template></p>
              <ul v-if="turn.references.length" class="answer-references"><li v-for="source in turn.references" :key="source.reference"><a v-if="safeLink(source.originalUrl)" :href="safeLink(source.originalUrl)" target="_blank" rel="noopener noreferrer">[{{ source.reference }}] {{ source.title }}</a><span v-else>[{{ source.reference }}] {{ source.title }}（原文链接不可用）</span></li></ul>
              <div class="turn-actions"><button v-if="turn.state === 'ready' && !busy" class="secondary" :disabled="loading" @click="resume(turn)">继续回答</button><button v-if="['ready', 'running'].includes(turn.state) || (turn.quotaHeld &amp;&amp; !['uncertain', 'cancelled'].includes(turn.state))" data-test="cancel" class="text-button" :disabled="cancelling" @click="cancel(turn)">取消回答</button><button v-if="turn.quotaHeld || ['ready', 'running', 'uncertain', 'cancelled'].includes(turn.state)" class="text-button" :disabled="busy || loading" @click="refreshChat">刷新对话状态</button></div>
              <div v-if="['uncertain', 'cancelled'].includes(turn.state) && turn.quotaHeld" class="quota-resolution"><p>请在服务商控制台核查是否处理，再结算预占。此操作不会重发问题。</p><label :for="`resolve-${turn.id}`">核查结果</label><select :id="`resolve-${turn.id}`" v-model="resolutions[turn.id]" :disabled="busy"><option value="">请选择</option><option value="charged">已处理，计入一次额度</option><option value="not_charged">确认未处理，释放预占</option></select><button class="secondary" :disabled="busy || !resolutions[turn.id]" @click="resolve(turn)">确认结算</button></div>
            </div>
          </article>
        </div>
        <div v-if="selected.length" class="context-strip" aria-label="本次引用资料"><span>本次资料 {{ selected.length }}/8</span><button v-for="item in selected" :key="item.id" class="source-chip" :disabled="busy || loading" :aria-label="`移除资料 ${item.title}`" @click="toggleSource(item)">{{ item.title }} <span aria-hidden="true">×</span></button></div>
        <form class="assistant-composer" @submit.prevent="send"><label class="visually-hidden" for="assistant-question">问题</label><textarea id="assistant-question" v-model="question" maxlength="1500" rows="3" :disabled="busy || loading || !schoolId" placeholder="问问报名材料，也可以说“再找找本校比赛”…" @keydown.ctrl.enter.prevent="send" @keydown.meta.enter.prevent="send" /><div class="composer-bottom"><span>{{ question.length }}/1500 <small>Ctrl / ⌘ + Enter 发送</small></span><button type="submit" data-test="send" class="primary" :disabled="!canSend">{{ busy ? '正在处理…' : '发送' }}</button></div></form>
        <p v-if="!schoolId" class="assistant-note">先选择一所学校，再和阅读搭子聊天。</p><p v-else-if="status && service === 'official' && !status.officialConfigured" class="assistant-note">官方模型尚未配置，可在使用设置中填写自己的 API。</p><p v-else-if="status && service === 'official' && status.quota.remaining <= 0" class="assistant-note">今日官方额度已用完或预占，北京时间零点恢复。也可使用自己的 API。</p>
        <p v-if="error" class="error-message" role="alert">{{ error }}</p><p v-if="note" class="assistant-note" role="status">{{ note }}</p><p v-if="chat" class="expiry-note">对话于 {{ new Date(chat.expireAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) }}（北京时间）到期。回答依据已提供的资料，重要日期请核对原文。</p>
        <details class="assistant-settings"><summary>使用设置与高级阅读</summary><fieldset :disabled="busy || loading"><legend>回答服务</legend><label><input v-model="service" type="radio" value="official" /> 官方 AI</label><label><input v-model="service" type="radio" value="byok" /> 我的 API</label></fieldset><div v-if="service === 'byok'" class="byok-fields"><label for="assistant-provider">服务商</label><select id="assistant-provider" v-model="provider" :disabled="busy"><option value="deepseek">DeepSeek</option><option value="openai">OpenAI</option></select><label for="assistant-model">模型 ID</label><input id="assistant-model" v-model="model" maxlength="100" :disabled="busy" autocomplete="off" /><label for="assistant-key">API Key</label><input id="assistant-key" v-model="apiKey" type="password" maxlength="512" :disabled="busy" autocomplete="off" spellcheck="false" /><button type="button" class="text-button" @click="apiKey = ''; stopped = true">清除 Key 并暂停</button><p>Key 仅保留在本页内存，只随处理批次发送。离开、刷新或切换学校后需重填；用量由服务商计费。</p></div><button class="text-button" :disabled="busy" @click="emit('advanced')">打开高级资料阅读与导出</button></details>
      </div>
      <aside class="assistant-rail" aria-label="公告与阅读偏好">
        <section class="source-section"><h2>值得留意的公告</h2><p class="rail-caption">{{ recommendations?.coverage || '从本校已收录的公开公告中发现资料' }}</p><form class="source-search" @submit.prevent="search"><label class="visually-hidden" for="assistant-search">搜索公告</label><input id="assistant-search" v-model="query" maxlength="200" :disabled="busy || loading" placeholder="输入想找的校园消息" /><button type="submit" data-test="search" class="secondary" :disabled="busy || loading || !schoolId">搜索</button></form><p v-if="recommendations?.search.message" class="search-status" role="status">{{ recommendations.search.message }}</p><p v-if="!loading && !recommendations?.items.length" class="rail-caption">暂无匹配的公告，可修改关键词后主动搜索。</p>
          <article v-for="item in recommendations?.items || []" :key="item.id" class="recommendation"><div class="source-meta"><span>{{ item.sourceName }}</span><span>{{ readNames[item.readState] }}</span></div><h3><a v-if="safeLink(item.originalUrl)" :href="safeLink(item.originalUrl)" target="_blank" rel="noopener noreferrer" @click="recordBehavior(item.id)">{{ item.title }}</a><span v-else>{{ item.title }}</span></h3><p class="source-dates"><span>发布时间：{{ sourceTime(item.publishedAt) }}</span><span>正文检查：{{ sourceTime(item.checkedAt) }}</span></p><p v-if="item.summary" class="source-summary">{{ item.summary }}</p><p class="source-reason">{{ item.reason }}</p><div class="source-actions"><button data-test="select-source" class="text-button" :disabled="busy || loading || !item.allowAi" :aria-pressed="isSelected(item.id)" @click="toggleSource(item)">{{ isSelected(item.id) ? '已选为资料' : item.allowAi ? '选为聊天资料' : '不允许 AI 阅读' }}</button><button data-test="dismiss-source" class="text-button dismiss-button" :disabled="busy || loading" @click="dismiss(item)">不感兴趣</button></div></article><div v-if="dismissed" class="dismissed-note"><span>已隐藏这条推荐</span><button data-test="undo-dismiss" class="text-button" :disabled="busy || loading" @click="dismiss(dismissed, true)">撤销</button></div>
        </section>
        <details class="preferences-section"><summary>我的阅读偏好</summary><p class="rail-caption">手动填写偏好。行为学习默认关闭。</p><label for="assistant-interests">关注话题，用逗号分隔</label><input id="assistant-interests" v-model="interests" maxlength="1000" :disabled="busy || loading || !preferences" placeholder="如 招聘，竞赛，学术活动" /><label for="assistant-goals">近期目标</label><textarea id="assistant-goals" v-model="goals" rows="2" maxlength="1000" :disabled="busy || loading || !preferences" /><label class="learning-toggle"><input v-model="learningEnabled" type="checkbox" :disabled="busy || loading || !preferences" /> 根据我主动阅读的公告学习偏好</label><div class="preference-actions"><button data-test="save-preferences" class="secondary" :disabled="busy || loading || !preferences" @click="savePreferences">保存偏好</button><button class="text-button" :disabled="busy || loading || !preferences" @click="clearBehavior">清除行为记录</button></div></details>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.assistant-surface { background: #fff; }
.assistant-heading { margin-bottom: 0; }
.assistant-layout { display: grid; grid-template-columns: minmax(0, 1fr) 310px; gap: 36px; }
.assistant-dialogue { min-width: 0; padding-top: 18px; }
.dialogue-toolbar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 12px; padding-bottom: 18px; border-bottom: 1px solid #e0e7f1; }
.quota-line { color: #627188; }.quota-line strong { color: #235ed7; font-weight: 600; }.quota-line small { white-space: nowrap; }
.assistant-stream { min-height: 340px; max-height: 65dvh; overflow-y: auto; overscroll-behavior: contain; padding: 24px 8px 24px 0; }
.assistant-welcome { max-width: 460px; margin: 36px auto; padding: 0 14px; }.companion-mark { width: 42px; height: 46px; border-left: 3px solid #235ed7; background: #edf3ff; display: grid; place-content: center; color: #235ed7; font-size: 24px; margin-bottom: 20px; }.assistant-welcome h2 { font-size: 23px; line-height: 1.5; margin-bottom: 12px; }.assistant-welcome p { line-height: 1.9; font-size: 14px; }.assistant-welcome .welcome-note { font-size: 12px; margin-top: 20px; }
.conversation-turn + .conversation-turn { margin-top: 32px; }.question-bubble { margin-left: 12%; padding: 13px 18px; background: #edf3ff; border-radius: 10px 10px 2px 10px; }.question-bubble p { color: #173766; white-space: pre-wrap; overflow-wrap: anywhere; }.speaker { display: block; font-size: 12px; font-weight: 600; margin-bottom: 7px; color: #627188; }.speaker small { margin-left: 8px; }.answer-block { padding: 22px 6px 0; }.turn-message { font-size: 14px; }.turn-meta { font-size: 11px; margin-top: 12px; }.answer-references { margin: 12px 0; padding-left: 20px; font-size: 12px; }.answer-references li { margin: 5px 0; }.turn-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 10px; }.quota-resolution { margin-top: 16px; padding: 14px; background: #f4f7fc; font-size: 12px; }.quota-resolution label { display: block; margin-top: 8px; }.quota-resolution select { max-width: 100%; margin: 6px 8px 6px 0; }
.context-strip { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 11px; margin: 12px 0; color: #627188; }.source-chip { max-width: 100%; overflow: hidden; text-overflow: ellipsis; padding: 4px 9px; border: 1px solid #d8e4f6; border-radius: 4px; background: #f5f8ff; color: #235ed7; font-size: 12px; }.source-chip span { margin-left: 7px; }
.assistant-composer { border: 1px solid #b9cce9; border-radius: 8px; padding: 12px 14px; box-shadow: 0 3px 10px #17376605; }.assistant-composer:focus-within { border-color: #235ed7; box-shadow: 0 0 0 2px #235ed712; }.assistant-composer textarea { width: 100%; padding: 0; border: 0; resize: vertical; min-height: 76px; font: inherit; line-height: 1.7; color: #173766; background: transparent; }.assistant-composer textarea:focus { outline: none; }.composer-bottom { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 7px; }.composer-bottom > span { font-size: 11px; color: #627188; }.composer-bottom small { margin-left: 7px; font-size: 10px; }.composer-bottom .primary { padding: 7px 23px; border-radius: 4px; font-size: 13px; }
.turn-search-status { font-size: 12px; line-height: 1.7; color: #627188; margin-top: 10px; }
.assistant-note { font-size: 12px; margin-top: 10px; }.expiry-note { font-size: 11px; margin-top: 15px; }.assistant-settings { font-size: 12px; margin-top: 18px; color: #627188; padding-bottom: 24px; }.assistant-settings summary, .preferences-section summary { cursor: pointer; }.assistant-settings fieldset { border: 0; padding: 12px 0; display: flex; gap: 18px; }.assistant-settings legend { padding: 8px 0 0; }.byok-fields { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 10px; align-items: center; padding: 8px 0 14px; }.byok-fields p, .byok-fields button { grid-column: 1 / -1; }.byok-fields button { justify-self: start; }.byok-fields input, .byok-fields select, .preferences-section input:not([type=checkbox]), .preferences-section textarea, .source-search input, .quota-resolution select { width: 100%; min-width: 0; border: 1px solid #d4dfef; border-radius: 4px; padding: 8px 10px; font: inherit; color: #173766; background: #fff; }
.assistant-rail { min-width: 0; border-left: 1px solid #e0e7f1; padding: 25px 0 25px 26px; }.assistant-rail h2 { font-size: 17px; }.rail-caption { font-size: 12px; line-height: 1.8; margin: 8px 0 14px; }.source-search { display: flex; gap: 7px; }.source-search input { font-size: 12px; }.source-search button { white-space: nowrap; padding: 6px 10px; }.search-status { font-size: 11px; margin: 9px 0; }.recommendation { padding: 18px 0; border-bottom: 1px solid #e7edf6; }.source-meta { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px; font-size: 11px; color: #78849a; }.recommendation h3 { font-size: 15px; font-weight: 600; line-height: 1.7; margin-top: 7px; }.recommendation h3 a { color: #173766; text-decoration: none; }.recommendation h3 a:hover { text-decoration: underline; }.source-dates { display: grid; gap: 2px; margin-top: 7px; font-size: 10px; color: #78849a; }.source-summary { font-size: 12px; margin-top: 8px; line-height: 1.85; }.source-reason { font-size: 11px; color: #496c9e; margin-top: 9px; border-left: 2px solid #d4e1f7; padding-left: 8px; }.source-actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; margin-top: 10px; }.source-actions .text-button { font-size: 11px; padding: 2px 0; }.source-actions .dismiss-button { color: #78849a; }.dismissed-note { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; font-size: 11px; color: #627188; }.preferences-section { margin-top: 25px; font-size: 12px; }.preferences-section summary { color: #173766; font-weight: 600; }.preferences-section > label:not(.learning-toggle) { display: block; margin: 14px 0 6px; }.preferences-section textarea { resize: vertical; }.learning-toggle { display: flex; align-items: start; gap: 7px; margin-top: 14px; color: #627188; }.learning-toggle input { margin-top: 4px; }.preference-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 15px; }.preference-actions button { font-size: 11px; }.muted { color: #627188; }.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
textarea:focus-visible { outline: 3px solid #89b0ff; outline-offset: 2px; }.assistant-composer textarea:focus-visible { outline: none; }
@media (max-width: 1100px) { .assistant-layout { grid-template-columns: minmax(0, 1fr) 260px; gap: 22px; }.assistant-rail { padding-left: 20px; }.quota-line small { display: block; } }
@media (max-width: 850px) { .assistant-layout { grid-template-columns: minmax(0, 1fr); gap: 10px; }.assistant-rail { border-left: 0; border-top: 1px solid #e0e7f1; padding: 24px 0; }.assistant-stream { max-height: 60dvh; min-height: 300px; }.assistant-welcome { margin: 20px auto; }.composer-bottom small { display: none; }.question-bubble { margin-left: 5%; }.assistant-heading h1 { font-size: 25px; } }
</style>
