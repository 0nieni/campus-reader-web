<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { AiConnection, GatewayActions, Notice, ReadingPackage, ReadingTask } from "@campus/contracts";
import type { Transport } from "../lib/transport";
import { safeError } from "../lib/errors";
import { renderMarkdown, downloadFile } from "../lib/markdown";
const props = defineProps<{ transport: Transport; schoolId: string | null; selection: Notice[] }>();
const emit = defineEmits<{ remove: [id: string]; back: [] }>();
const status = ref<GatewayActions["ai.status"]["output"] | null>(null), tasks = ref<ReadingTask[]>([]), pack = ref<ReadingPackage | null>(null), task = ref<ReadingTask | null>(null);
const service = ref<"official" | "byok">("official"), provider = ref<AiConnection["provider"]>("deepseek"), model = ref(""), apiKey = ref("");
const kind = ref<"summary" | "outline" | "answer">("summary"), question = ref(""), error = ref(""), note = ref(""), busy = ref(false), paused = ref(true), showGuide = ref(false), resolution = ref<"" | "charged" | "not_charged">("");
const rendered = computed(() => task.value?.result ? renderMarkdown(task.value.result) : "");
const diagnosis = ref<GatewayActions['ai.diagnose']['output'] | null>(null), diagnosing = ref(false);
async function diagnose() {
  if (busy.value || diagnosing.value) return;
  const ticket = epoch; diagnosing.value = true; diagnosis.value = null;
  try { const value = await props.transport.call('ai.diagnose', {}); if (active && ticket === epoch) diagnosis.value = value; }
  catch (caught) { if (active && ticket === epoch) error.value = safeError(caught); }
  finally { diagnosing.value = false; }
}
const stateNames = { ready: "已暂停 / 可继续", running: "正在处理", complete: "已完成", failed: "未完成", uncertain: "状态待核查", cancelled: "已取消" };
let active = true, epoch = 0, requestId = "", testRequestId = "";
const validSelection = computed(() => Boolean(props.schoolId && props.selection.length && props.selection.length <= 8));
const canStart = computed(() => validSelection.value && pack.value && !busy.value && (kind.value !== "answer" || question.value.trim()) && (service.value === "official" ? status.value?.officialConfigured && (status.value?.quota.remaining || 0) > 0 : model.value.trim() && apiKey.value));
function invalidate() { epoch++; paused.value = true; busy.value = false; pack.value = null; task.value = null; requestId = ""; error.value = ""; }
watch(() => props.selection.map(item => item.id).join(","), invalidate);
watch([service, provider, model, kind, question], () => { requestId = ""; });
watch([provider, model, apiKey], () => { testRequestId = ""; });
async function refreshStatus() {
  const ticket = epoch;
  try { const value = await props.transport.call("ai.status", {}); if (active && ticket === epoch) status.value = value; }
  catch (caught) { if (active && ticket === epoch) error.value = safeError(caught); }
}
async function recent() {
  if (!props.schoolId) return;
  const ticket = epoch;
  try { const value = await props.transport.call("ai.list", { schoolId: props.schoolId }); if (active && ticket === epoch) tasks.value = value.tasks; }
  catch (caught) { if (active && ticket === epoch) error.value = safeError(caught); }
}
async function preview() {
  if (!props.schoolId || !validSelection.value) return;
  const ticket = ++epoch; busy.value = true; error.value = ""; pack.value = null; task.value = null; requestId = "";
  try { const value = await props.transport.call("ai.preview", { schoolId: props.schoolId, itemIds: props.selection.map(item => item.id) }); if (active && ticket === epoch) pack.value = value; }
  catch (caught) { if (active && ticket === epoch) error.value = safeError(caught); }
  finally { if (active && ticket === epoch) busy.value = false; }
}
async function exportDocs() {
  if (!props.schoolId || !validSelection.value) return;
  const ticket = epoch; error.value = "";
  try {
    const value = await props.transport.call("ai.export", { schoolId: props.schoolId, itemIds: props.selection.map(item => item.id) });
    if (!active || ticket !== epoch) return;
    downloadFile("校园公告.md", value.docs.map(doc => doc.markdown).join("\n\n---\n\n"));
    downloadFile("公告资料清单.json", JSON.stringify(value.manifest, null, 2), "application/json;charset=utf-8");
    note.value = "已下载资料；本人下载的文件不会随云端结果自动删除。";
  } catch (caught) { if (active && ticket === epoch) error.value = safeError(caught); }
}
async function run() {
  if (!task.value || busy.value) return;
  if (task.value.service === "byok" && !apiKey.value) { error.value = "续跑需要在本页重新填写 API Key。"; return; }
  const ticket = epoch; paused.value = false; busy.value = true; error.value = "";
  try {
    while (active && ticket === epoch && !paused.value && task.value?.state === "ready") {
      const value: ReadingTask = await props.transport.call("ai.step", { taskId: task.value.id, step: task.value.step, ...(task.value.service === "byok" ? { connection: { provider: provider.value, model: model.value.trim(), apiKey: apiKey.value } } : {}) });
      if (!active || ticket !== epoch) return;
      task.value = value;
    }
  } catch (caught) { if (active && ticket === epoch) error.value = safeError(caught); }
  finally { if (active && ticket === epoch) { busy.value = false; paused.value = true; void refreshStatus(); void recent(); } }
}
async function start() {
  if (!canStart.value || !props.schoolId) return;
  const ticket = epoch; busy.value = true; error.value = "";
  requestId ||= crypto.randomUUID();
  try {
    const value = await props.transport.call("ai.start", { schoolId: props.schoolId, itemIds: props.selection.map(item => item.id), fingerprint: pack.value!.fingerprint, requestId, service: service.value, ...(service.value === "byok" ? { provider: provider.value, model: model.value.trim() } : {}), task: kind.value, question: question.value.trim() });
    if (!active || ticket !== epoch) return;
    task.value = value; busy.value = false; await run();
  } catch (caught) { if (active && ticket === epoch) error.value = safeError(caught); }
  finally { if (active && ticket === epoch) busy.value = false; }
}
async function testConnection() {
  if (!props.schoolId || !model.value.trim() || !apiKey.value || busy.value) return;
  const ticket = ++epoch; busy.value = true; error.value = ""; pack.value = null; task.value = null;
  testRequestId ||= crypto.randomUUID();
  try {
    const value = await props.transport.call("ai.test", { schoolId: props.schoolId, requestId: testRequestId, provider: provider.value, model: model.value.trim() });
    if (!active || ticket !== epoch) return;
    task.value = value; busy.value = false; await run();
  } catch (caught) { if (active && ticket === epoch) error.value = safeError(caught); }
  finally { if (active && ticket === epoch) busy.value = false; }
}
async function restore(id: string) {
  paused.value = true; const ticket = ++epoch; busy.value = true; error.value = "";
  try {
    const value = await props.transport.call("ai.task", { taskId: id });
    if (!active || ticket !== epoch) return;
    task.value = value; resolution.value = "";
    if (value.service === "byok") { provider.value = value.provider as AiConnection["provider"]; model.value = value.model; }
  } catch (caught) { if (active && ticket === epoch) { error.value = safeError(caught); task.value = null; } }
  finally { if (active && ticket === epoch) busy.value = false; }
}
async function cancel() {
  if (!task.value) return;
  paused.value = true; const id = task.value.id, ticket = epoch;
  try { const value = await props.transport.call("ai.cancel", { taskId: id }); if (active && ticket === epoch) task.value = value; }
  catch (caught) { if (active && ticket === epoch) error.value = safeError(caught); }
  finally { if (active && ticket === epoch) void refreshStatus(); }
}
async function resolve() {
  if (!task.value || !resolution.value) return;
  const ticket = epoch; busy.value = true;
  try { const value = await props.transport.call("ai.resolve", { taskId: task.value.id, charged: resolution.value === "charged" }); if (active && ticket === epoch) { task.value = value; resolution.value = ""; await refreshStatus(); } }
  catch (caught) { if (active && ticket === epoch) error.value = safeError(caught); }
  finally { if (active && ticket === epoch) busy.value = false; }
}
function expire() {
  if (task.value && Date.parse(task.value.expireAt) <= Date.now()) { epoch++; paused.value = true; busy.value = false; task.value = null; pack.value = null; note.value = "个人阅读结果已满 24 小时，已从当前页面移除。"; }
  tasks.value = tasks.value.filter(item => Date.parse(item.expireAt) > Date.now());
}
const timer = setInterval(expire, 1000);
onMounted(() => { void refreshStatus(); void recent(); });
onUnmounted(() => { active = false; epoch++; paused.value = true; apiKey.value = ""; question.value = ""; pack.value = null; task.value = null; tasks.value = []; clearInterval(timer); });
</script>
<template>
  <section class="feature-surface ai-surface" aria-labelledby="ai-title">
    <div class="feature-heading"><div><h1 id="ai-title">AI 阅读</h1><p>只阅读本次选定资料，回答附来源；日期不明时保留待核对。</p></div><button class="text-button" @click="emit('back')">返回公告选资料</button></div>
    <div class="ai-columns"><div class="ai-controls">
      <h2>本次资料 <small>{{ selection.length }}/8</small></h2>
      <p v-if="!selection.length" class="small">请先在公告列表勾选 1～8 篇资料，私人邮件不会自动选择。</p>
      <ul class="selection-list"><li v-for="item in selection" :key="item.id"><span>{{ item.title }}</span><button class="text-button" :disabled="busy" @click="emit('remove', item.id)">移除</button></li></ul>
      <div class="action-row"><button class="secondary" :disabled="!validSelection || busy" @click="preview">预览阅读资料</button><button class="text-button" :disabled="!validSelection || busy" @click="exportDocs">下载 MD / JSON</button></div>
      <fieldset class="service-options"><legend>使用方式</legend><label><input v-model="service" type="radio" value="official" :disabled="busy" />官方 AI</label><label><input v-model="service" type="radio" value="byok" :disabled="busy" />我的 API</label></fieldset>
      <div v-if="service === 'official'" class="quota-note">
        <template v-if="status"><strong>今日可用 {{ status.quota.remaining }} / {{ status.quota.limit }} 次</strong><p>已用 {{ status.quota.used }} · 进行中预占 {{ status.quota.held }}；北京时间零点恢复。</p><p v-if="!status.officialConfigured">官方模型尚未配置，请完成云端设置或选择“我的 API”。</p><p v-else>模型：{{ status.officialModel }}；同一阅读任务分批和汇总共计一次。</p></template>
        <p v-else>额度尚未读取，请检查 AI 云函数与集合配置。</p><button class="text-button" @click="refreshStatus">刷新额度</button>
        <button class="text-button" :disabled="busy || diagnosing" @click="diagnose">{{ diagnosing ? '正在检查…' : '检查官方 AI 连接（不调用模型）' }}</button>
        <p v-if="diagnosis" role="status">{{ diagnosis.message }}（{{ diagnosis.code }}）</p>
      </div>
      <div v-else class="connection-form">
        <label for="ai-provider">服务商</label><select id="ai-provider" v-model="provider" :disabled="busy"><option value="deepseek">DeepSeek · api.deepseek.com</option><option value="openai">OpenAI · api.openai.com</option></select>
        <label for="ai-model">模型 ID</label><input id="ai-model" v-model="model" maxlength="100" :disabled="busy" placeholder="填写服务商支持的 Chat Completions 模型" autocomplete="off" />
        <label for="ai-key">API Key</label><input id="ai-key" v-model="apiKey" type="password" maxlength="512" :disabled="busy" autocomplete="off" spellcheck="false" placeholder="只在当前阅读页内存中使用" />
        <button class="text-button" @click="apiKey = ''; paused = true">清除 Key 并暂停</button>
        <button class="secondary" :disabled="busy || !schoolId || !model.trim() || !apiKey" @click="testConnection">测试 API（少量用量）</button>
        <p class="small">连接测试最多请求 64 个输出 token，不发送公告、不扣官方次数。</p>
        <p class="small">通过云端调用所选官方端点。离开阅读页、刷新或退出后需重填；不会保存到任务或浏览器存储。用量由服务商按账号计费，不扣官方次数。</p>
      </div>
      <label class="control-label" for="reading-kind">阅读任务</label><select id="reading-kind" v-model="kind" :disabled="busy"><option value="summary">摘要与要点</option><option value="outline">提纲与准备事项</option><option value="answer">针对资料提问</option></select>
      <label class="control-label" for="reading-question">问题或关注点{{ kind === 'answer' ? '（必填）' : '（可选）' }}</label><textarea id="reading-question" v-model="question" :disabled="busy" maxlength="1500" rows="3" placeholder="例如：报名对象和材料提交时间是什么？" />
      <p v-if="pack" class="small">{{ pack.docs.length }} 篇资料，预计 {{ pack.batches }} 次、最多 {{ pack.maxCalls }} 次模型调用（含中间汇总）。附件正文未读取。个人结果创建后 24 小时到期。</p>
      <button class="primary start-reading" :disabled="!canStart" @click="start">{{ busy ? '正在处理…' : service === 'official' ? '开始官方阅读（本任务 1 次额度）' : '开始 API 阅读（按服务商计费）' }}</button>
      <p v-if="!pack" class="small">先预览资料，再开始阅读。不会自动调用模型。</p>
      <p v-if="error" class="error-message" role="alert">{{ error }}</p><p v-if="note" class="small" role="status">{{ note }}</p>
      <details class="recent-tasks"><summary @click="recent">最近 24 小时阅读任务</summary><button class="text-button" @click="recent">刷新任务</button><p v-if="!tasks.length" class="small">暂无可读取任务，或尚未连接任务服务。</p><button v-for="item in tasks" :key="item.id" class="recent-task" :disabled="busy" @click="restore(item.id)">{{ stateNames[item.state] }} · {{ item.title }}</button></details>
    </div><div class="ai-output">
      <section v-if="task" class="task-status" aria-live="polite"><h2>{{ stateNames[task.state] }} <small>{{ Math.min(task.step, task.totalSteps) }}/{{ task.totalSteps }}</small></h2><p>{{ task.message }}</p><p class="task-id">任务编号：{{ task.id }}</p><p class="small">{{ task.service === 'official' ? '官方 AI' : `我的 API · ${task.provider}` }} · {{ task.model }} · 到期：{{ new Date(task.expireAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) }}（北京时间）</p>
        <p v-if="task.failureCode" class="small">失败原因：{{ task.failureCode }}</p>
        <div class="action-row"><button v-if="busy" class="secondary" @click="paused = true">本批后暂停</button><button v-if="task.state === 'ready' && !busy" class="secondary" @click="run">继续阅读</button><button class="text-button" :disabled="busy" @click="restore(task.id)">刷新任务状态</button><button v-if="!['complete','failed','cancelled'].includes(task.state)" class="text-button" @click="cancel">取消任务</button></div>
        <div v-if="['uncertain','cancelled'].includes(task.state) && task.quotaHeld" class="quota-resolution"><p>请先在服务商控制台核查本任务是否处理；此操作只结算预占，不会重发请求。</p><select v-model="resolution" aria-label="核查处理结果"><option value="" disabled>我已核查，选择结果</option><option value="charged">已处理，计入一次官方额度</option><option value="not_charged">确认未处理，释放预占</option></select><button class="secondary" :disabled="!resolution || busy" @click="resolve">确认结算</button></div>
      </section>
      <section v-if="task?.result" class="ai-result"><div class="action-row"><h2>阅读结果</h2><button class="text-button" @click="downloadFile('公告阅读结果.md', task.result!)">下载结果 MD</button></div><div class="markdown-content" v-html="rendered" /><p class="small">结果只依据提供的资料。提醒和日历需另行校验时间；本人下载文件不受云端到期删除控制。</p></section>
      <section v-if="pack" class="package-preview"><h2>资料预览</h2><p class="small">{{ pack.docs.length }} 篇 · {{ pack.manifest.context_chars }} 字符（不是精确 token 数）</p><details v-for="doc in pack.docs" :key="doc.itemId"><summary>{{ doc.reference }} · {{ doc.title }}</summary><pre>{{ doc.markdown }}</pre></details><button class="text-button" @click="showGuide = !showGuide">{{ showGuide ? '收起阅读说明' : '查看 AI 阅读说明' }}</button><pre v-if="showGuide">{{ pack.guide }}</pre></section>
      <div v-if="!pack && !task" class="empty-state"><h2>把公告读成清晰的要点</h2><p>从左侧确认本次资料和使用方式，再开始阅读。</p></div>
    </div></div>
  </section>
</template>
