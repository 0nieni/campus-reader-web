<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, defineAsyncComponent, defineComponent, h } from "vue";
import { noticeCategories, type FeedFilters, type Notice, type Favorite } from "@campus/contracts";
const featureLoading = defineComponent(() => () => h("section", { class: "feature-surface", role: "status" }, "正在打开功能页…"));
const featureFailed = defineComponent(() => () => h("section", { class: "feature-surface", role: "alert" }, "功能页加载失败，请刷新网页后重试。"));
const BookmarksPanel = defineAsyncComponent({ loader: () => import("./components/BookmarksPanel.vue"), loadingComponent: featureLoading, errorComponent: featureFailed });
const ReadingPanel = defineAsyncComponent({ loader: () => import("./components/ReadingPanel.vue"), loadingComponent: featureLoading, errorComponent: featureFailed });
import { siteTransport as cloudTransport, setupIssues, regionNeedsVerification, isNetlify } from "./lib/site-transport";
import type { Transport } from "./lib/transport";
import { workspaceStore } from "./stores/workspace";
import { categoryNames, displayTime, safeOriginal } from "./lib/presentation";
import { safeError, ClientError } from "./lib/errors";
import InvitationPanel from './components/InvitationPanel.vue';

const props = defineProps<{
  transport?: Transport;
  configurationIssues?: string[];
}>();
const store = workspaceStore(props.transport || cloudTransport)();
const transport = props.transport || cloudTransport;
const featureTransport: Transport = { ...transport, call: (async (action, input) => {
  try { return await transport.call(action, input); }
  catch (caught) { if (caught instanceof ClientError && ["UNAUTHENTICATED", "FORBIDDEN"].includes(caught.code)) store.clear(); throw caught; }
}) as Transport["call"] };
const view = ref<"feed" | "favorites" | "ai">("feed"), selection = ref<Notice[]>([]), bookmarkBusy = ref(false);
watch(() => store.auth?.uid, () => { view.value = "feed"; selection.value = []; });
watch(() => store.workspace?.school?.id, () => { selection.value = []; });
function chooseNotice(item: Notice) {
  if (selection.value.some(row => row.id === item.id)) selection.value = selection.value.filter(row => row.id !== item.id);
  else if (selection.value.length < 8) selection.value.push(item);
  else store.error = "一次最多选择 8 篇公告。";
}
function navigate(target: "feed" | "favorites" | "ai") { store.closeNotice(); view.value = target; }
async function saveBookmark() {
  const item = store.detail, schoolId = store.workspace?.school?.id, uid = store.auth?.uid;
  if (!item || !schoolId || bookmarkBusy.value) return;
  bookmarkBusy.value = true;
  try {
    const result = await featureTransport.call("favorites.set", { schoolId, itemId: item.id, saved: !item.bookmarked });
    if (store.auth?.uid === uid && store.detail?.id === item.id && store.workspace?.school?.id === schoolId) store.detail.bookmarked = result.saved;
  } catch (caught) { if (store.auth?.uid === uid) store.error = safeError(caught); }
  finally { bookmarkBusy.value = false; }
}
async function openFavorite(item: Favorite) {
  if (!item.notice) return;
  navigate("feed");
  if (store.workspace?.school?.id !== item.schoolId) await store.selectSchool(item.schoolId);
  if (store.workspace?.school?.id === item.schoolId) await store.openNotice(item.itemId);
}
const issues = props.configurationIssues ?? setupIssues;
const username = ref("");
const password = ref("");
const copied = ref("");
// Invite token stays in memory, never in API logs, Storage, or rendered text.
const inviteToken = ref(isNetlify ? new URLSearchParams(location.hash.slice(1)).get('invite_token') || '' : '');
if (inviteToken.value) history.replaceState(null, '', location.pathname + location.search);
const keyword = ref("");
const selectedCategories = ref<string[]>([]);
const period = ref<NonNullable<FeedFilters["period"]>>("all");
const filterDetails = ref<HTMLDetailsElement | null>(null);
const appliedPeriod = computed(() => ({ "7d": "最近 7 天", "30d": "最近 30 天", "90d": "最近 90 天", all: "" })[store.filters.period || "all"]);
const isFiltered = computed(() => Boolean(store.filters.keyword || store.filters.categories?.length || (store.filters.period && store.filters.period !== "all")));
function categoryLabel(categories?: string[]) {
  return categories?.map(category => categoryNames[category] || category).join(" · ") || "";
}
watch(() => store.auth?.uid, () => {
  keyword.value = "";
  selectedCategories.value = [];
  period.value = "all";
});
async function search() {
  if (filterDetails.value) filterDetails.value.open = false;
  await store.applyFilters({ keyword: keyword.value.trim(), categories: selectedCategories.value, period: period.value });
}
async function resetFilters() {
  keyword.value = "";
  selectedCategories.value = [];
  period.value = "all";
  await store.applyFilters({});
}
const original = computed(() =>
  safeOriginal(store.detail?.originalUrl || null),
);
const date = new Intl.DateTimeFormat("zh-CN", {
  month: "long",
  day: "numeric",
  weekday: "long",
  timeZone: "Asia/Shanghai",
}).format(new Date());
let unwatch: (() => void) | undefined;
onMounted(() => {
  unwatch = store.watchSession();
  if (!issues.length) void store.connect();
});
onUnmounted(() => {
  unwatch?.();
  password.value = "";
  store.clear();
});
async function login() {
  const value = password.value;
  password.value = "";
  await store.signIn(username.value.trim(), value);
}
async function copyOriginal() {
  if (!original.value) return;
  try {
    await navigator.clipboard.writeText(original.value);
    copied.value = "原文网址已复制";
  } catch {
    copied.value = "复制未成功，请手动选中原文网址复制。";
  }
}
async function moreSchools() {
  try {
    await store.loadSchools(true);
  } catch (caught) {
    store.error = safeError(caught);
  }
}
function schoolChanged(event: Event) {
  void store.selectSchool((event.target as HTMLSelectElement).value);
}
</script>

<template>
  <div class="application">
    <header class="masthead">
      <a
        class="brand"
        href="#"
        aria-label="校园阅览室首页"
        @click.prevent="navigate('feed')"
      >
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <path
            d="M4 7c5-2 9-1 12 2 3-3 7-4 12-2v20c-5-2-9-1-12 1-3-2-7-3-12-1V7Z"
          />
          <path d="M16 9v19M8 13h4m-4 5h4m8-5h4m-4 5h4" />
        </svg>
        <span>校园阅览室<small>把校园信息，读得更清楚</small></span>
      </a>
      <div class="header-right">
        <span class="today">{{ date }}</span
        ><span class="private-label">个人工作区</span>
      </div>
    </header>

    <InvitationPanel v-if="inviteToken" :token="inviteToken" @complete="inviteToken = ''; store.connect()" />
    <main v-else-if="!store.workspace" class="entry">
      <section class="entry-intro" aria-labelledby="entry-title">
        <span class="section-label"
          ><span class="line" /> 校园公告与竞赛助手</span
        >
        <h1 id="entry-title">值得关注的消息，<br />留一处认真阅读。</h1>
        <p class="intro-copy">
          学校公告、竞赛活动和重要时间，汇集到你自己的阅览室。每一条信息，都能回到原始来源。
        </p>
        <div class="reading-mark" aria-hidden="true">
          <div class="paper-back"></div>
          <div class="paper-front">
            <span class="paper-label">校园阅览室</span>
            <div class="paper-title">一份公告，<br />一条清晰的线索。</div>
            <span class="paper-rule"></span
            ><span class="paper-rule short"></span
            ><span class="paper-stamp">保留原文<br />有据可查</span>
          </div>
        </div>
        <p class="privacy-note">仅本人访问 · 原有资料保留</p>
      </section>

      <section class="login-panel" aria-labelledby="login-title">
        <span class="panel-kicker">开始阅读</span>
        <h2 id="login-title">进入你的工作区</h2>
        <p class="muted">使用已配置的本人账号登录。</p>
        <p v-if="regionNeedsVerification && !issues.length" class="account-help">暂按 SDK 默认上海地域连接，尚未验证。若环境连接失败，请核实地域与访问来源。</p>
        <div v-if="store.auth" class="setup-note" role="status">
          <strong>云账号已登录，工作区仍待验证</strong>
          <p>登录账号 UID：<span class="identity-value">{{ store.auth.uid }}</span></p>
          <button class="text-button" :disabled="store.loading" @click="store.connect()">重新连接工作区</button>
          <button class="text-button" @click="store.signOut()">退出当前云账号</button>
        </div>
        <div v-if="issues.length" class="setup-note" role="status">
          <strong>网页登录待接通</strong>
          <p>首次使用需要完成账号与环境配置。</p>
          <details>
            <summary>查看待配置项</summary>
            <ul>
              <li v-for="issue in issues" :key="issue">{{ issue }}</li>
            </ul>
            <p>完成后重启网页服务，再连接本人工作区。</p>
          </details>
        </div>
        <form @submit.prevent="login">
          <label for="username">{{ isNetlify ? '登录邮箱' : '用户名' }}</label
          ><input
            id="username"
            v-model="username"
            autocomplete="username"
            required
            maxlength="254"
            :disabled="issues.length > 0 || store.loading"
            :placeholder="isNetlify ? '输入受邀邮箱' : '输入本人用户名'"
          />
          <label for="password">密码</label
          ><input
            id="password"
            v-model="password"
            autocomplete="current-password"
            type="password"
            required
            maxlength="256"
            :disabled="issues.length > 0 || store.loading"
            placeholder="输入密码"
          />
          <p v-if="store.error" class="error-message" role="alert">
            {{ store.error }}
          </p>
          <button
            class="primary login-button"
            type="submit"
            :disabled="issues.length > 0 || store.loading"
          >
            {{ store.loading ? "正在连接…" : "登录工作区"
            }}<span aria-hidden="true">↗</span>
          </button>
        </form>
        <p v-if="!issues.length" class="account-help">
          {{ isNetlify ? '请先接受本站发送的账号邀请并设置密码；本站不开放注册。' : '没有账号或忘记密码，请在本人云开发控制台管理账号。这里不提供公开注册。' }}
        </p>
        <p class="login-footnote">
          登录后才会读取公告和个人资料。<br />连接失败会明确提示，不显示演示数据。
        </p>
      </section>
    </main>

    <main
      v-else
      class="workspace"
      :class="{ 'show-detail': view === 'feed' && (store.detail || store.detailLoading), 'feature-view': view !== 'feed' }"
    >
      <aside class="navigation" aria-label="工作区导航">
        <div class="workspace-name">我的阅览室</div>
        <button class="nav-item" :class="{ active: view === 'feed' }" @click="navigate('feed')">
          <span aria-hidden="true">▤</span> 公告
        </button>
        <button class="nav-item" :class="{ active: view === 'favorites' }" @click="navigate('favorites')"><span aria-hidden="true">☆</span>收藏</button>
        <button class="nav-item" :class="{ active: view === 'ai' }" @click="navigate('ai')"><span aria-hidden="true">✧</span>AI 阅读{{ selection.length ? `（${selection.length}）` : '' }}</button>
        <div class="navigation-note">
          勾选公告后进入 AI 阅读。<br />关键词查找不消耗 AI 次数。
        </div>
        <div class="nav-bottom">
          <span>仅本人访问</span
          ><button class="text-button" @click="store.signOut()">
            退出登录
          </button>
        </div>
      </aside>
      <section v-if="view === 'feed'" class="notice-index" aria-labelledby="notice-title">
        <div class="index-heading">
          <div>
            <span class="panel-kicker">校园消息</span>
            <h1 id="notice-title">公告</h1>
          </div>
          <button
            class="text-button"
            :disabled="store.loading || !store.workspace.school"
            @click="store.loadFeed()"
          >
            刷新
          </button>
        </div>
        <label class="school-label" for="school">我的学校</label>
        <select
          id="school"
          :value="store.workspace.school?.id || ''"
          :disabled="store.loading"
          @change="schoolChanged"
        >
          <option value="" disabled>请选择学校</option>
          <option
            v-for="school in store.schools"
            :key="school.id"
            :value="school.id"
          >
            {{ school.name
            }}{{
              school.status === "ready"
                ? ""
                : school.status === "candidate"
                  ? "（待核验）"
                  : "（未接入）"
            }}
          </option>
        </select>
        <button
          v-if="store.schoolCursor"
          class="text-button more-schools"
          @click="moreSchools"
        >
          加载更多学校
        </button>
        <p
          v-if="
            store.workspace.school && store.workspace.school.status !== 'ready'
          "
          class="muted small"
        >
          该学校尚未完成来源接入，可能暂时没有公告。
        </p>
        <form class="feed-filters" @submit.prevent="search">
          <label for="notice-keyword" class="filter-label">查找公告</label>
          <div class="search-row">
            <input id="notice-keyword" v-model="keyword" maxlength="100" placeholder="标题、正文或摘要关键词" :disabled="!store.workspace.school" />
            <button class="primary" type="submit" :disabled="!store.workspace.school">查找</button>
          </div>
          <details ref="filterDetails" class="filter-options">
            <summary>分类与时间<span v-if="isFiltered"> · 已筛选</span></summary>
            <fieldset>
              <legend>分类（可多选，匹配其中任一类）</legend>
              <label v-for="category in noticeCategories" :key="category" class="category-option">
                <input v-model="selectedCategories" type="checkbox" :value="category" />{{ categoryNames[category] }}
              </label>
            </fieldset>
            <label class="filter-label" for="notice-period">时间范围</label>
            <select id="notice-period" v-model="period">
              <option value="all">保留期内全部（365 天）</option>
              <option value="7d">最近 7 天</option>
              <option value="30d">最近 30 天</option>
              <option value="90d">最近 90 天</option>
            </select>
            <p class="filter-help">发布时间未标注时，按发现或入库时间筛选。</p>
            <button class="text-button" type="submit" :disabled="!store.workspace.school">应用筛选</button>
          </details>
          <div v-if="isFiltered" class="applied-filters" role="status">
            <span>{{ store.filters.keyword ? `“${store.filters.keyword}” · ` : "" }}{{ categoryLabel(store.filters.categories) || "全部分类" }}{{ appliedPeriod ? ` · ${appliedPeriod}` : "" }}</span>
            <button class="text-button" type="button" @click="resetFilters">清除筛选</button>
          </div>
        </form>
        <p v-if="store.error" class="error-message" role="alert">
          {{ store.error }}
        </p>
        <div class="notice-scroll" :aria-busy="store.loading">
          <p
            v-if="store.loading && !store.items.length"
            class="empty-state"
            role="status"
          >
            正在读取真实公告…
          </p>
          <div v-else-if="!store.items.length" class="empty-state">
            <h3>
              {{
                store.workspace.school
                  ? isFiltered ? "没有匹配的公告" : "当前暂无可显示的公告"
                  : "先选择你的学校"
              }}
            </h3>
            <p>
              {{
                store.error
                  ? "请排查上方错误后重试。"
                  : store.workspace.school
                    ? isFiltered ? "试试其他关键词，或清除分类与时间筛选。" : "可稍后刷新，或检查学校来源是否已接入。"
                    : "学校偏好会保存到本人账号。"
              }}
            </p>
          </div>
          <article
            v-for="item in store.items"
            :key="item.id"
            class="notice-row"
            :class="{ selected: store.detail?.id === item.id }"
          >
            <button
              @click="
                copied = '';
                store.openNotice(item.id);
              "
            >
              <div class="notice-meta">
                <span>{{ categoryLabel(item.categories) || "公告" }}</span
                ><time>{{ displayTime(item.publishedAt) }}</time>
              </div>
              <h2>{{ item.title }}</h2>
              <p v-if="item.summary">{{ item.summary }}</p>
              <span class="source-name">{{ item.sourceName }}</span>
            </button>
            <label class="selection-toggle"><input type="checkbox" :checked="selection.some(row => row.id === item.id)" :disabled="selection.length >= 8 && !selection.some(row => row.id === item.id)" @change="chooseNotice(item)" />用于 AI 阅读</label>
          </article>
          <button
            v-if="store.nextCursor"
            class="load-more"
            :disabled="store.loading"
            @click="store.loadFeed(true)"
          >
            {{ store.loading ? "正在读取…" : "加载更多公告" }}
          </button>
        </div>
        <div class="index-footer">
          {{
            store.items.length
              ? `已读取 ${store.items.length} 条`
              : "真实云端资料"
          }}<span>北京时间</span>
        </div>
      </section>
      <section
        v-if="view === 'feed'"
        class="reader"
        aria-label="公告阅读区"
        :aria-busy="store.detailLoading"
      >
        <button
          v-if="store.detail || store.detailLoading"
          class="text-button mobile-back"
          @click="store.closeNotice()"
        >
          ← 返回公告
        </button>
        <p v-if="store.detailLoading" class="empty-state" role="status">
          正在打开公告…
        </p>
        <article v-else-if="store.detail" class="notice-body">
          <span class="section-label">公告原文</span>
          <h1>{{ store.detail.title }}</h1>
          <p class="byline">
            {{ store.detail.sourceName }}<br />{{
              displayTime(store.detail.publishedAt)
            }}
            · 北京时间
          </p>
          <div class="action-row detail-actions"><button class="secondary" :disabled="bookmarkBusy" @click="saveBookmark">{{ store.detail.bookmarked ? '取消收藏' : '收藏公告' }}</button><button class="text-button" @click="chooseNotice(store.detail)">{{ selection.some(row => row.id === store.detail!.id) ? '从 AI 选择中移除' : '选入 AI 阅读' }}</button><button v-if="selection.length" class="text-button" @click="navigate('ai')">阅读已选 {{ selection.length }} 篇</button></div>
          <div class="original-source" v-if="original">
            <a :href="original" target="_blank" rel="noopener noreferrer"
              >打开原文 ↗</a
            ><button class="text-button" @click="copyOriginal">复制网址</button
            ><span class="original-url">{{ original }}</span>
            <p v-if="copied" class="small" role="status">{{ copied }}</p>
          </div>
          <p v-else class="muted small">这份资料未提供可打开的原文网址。</p>
          <section v-if="store.detail.summary" class="existing-summary">
            <h2>已有摘要</h2>
            <p>{{ store.detail.summary }}</p>
          </section>
          <div class="original-text">
            {{ store.detail.text || "尚未提供正文，请查看公告原文。" }}
          </div>
          <p class="attachment-note">{{ store.detail.attachmentNote }}</p>
        </article>
        <div v-else class="reader-empty">
          <svg viewBox="0 0 64 64" aria-hidden="true">
            <path
              d="M9 13c9-3 17-2 23 4 6-6 14-7 23-4v39c-9-3-17-2-23 3-6-5-14-6-23-3V13Z"
            />
            <path d="M32 17v38M16 25h9m-9 9h9m14-9h9m-9 9h9" />
          </svg>
          <h2>选一条消息，展开阅读</h2>
          <p>原文、来源和已有摘要会显示在这里。</p>
        </div>
      </section>
      <BookmarksPanel v-if="view === 'favorites'" :transport="featureTransport" :school-id="store.workspace.school?.id || null" @open="openFavorite" />
      <ReadingPanel v-if="view === 'ai'" :transport="featureTransport" :school-id="store.workspace.school?.id || null" :selection="selection" @remove="selection = selection.filter(item => item.id !== $event)" @back="navigate('feed')" />
    </main>
    <footer v-if="!store.workspace" class="page-footer">
      <span>校园阅览室</span><span>阅读有来源，重要信息不遗漏。</span>
    </footer>
  </div>
</template>
