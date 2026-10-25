<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, nextTick, defineAsyncComponent, defineComponent, h } from "vue";
import { noticeCategories, type FeedFilters, type Notice, type Favorite } from "@campus/contracts";
const featureLoading = defineComponent(() => () => h("section", { class: "feature-surface", role: "status" }, "正在打开功能页…"));
const featureFailed = defineComponent(() => () => h("section", { class: "feature-surface", role: "alert" }, "功能页加载失败，请刷新网页后重试。"));
const BookmarksPanel = defineAsyncComponent({ loader: () => import("./components/BookmarksPanel.vue"), loadingComponent: featureLoading, errorComponent: featureFailed });
const AssistantPanel = defineAsyncComponent({ loader: () => import('./components/AssistantPanel.vue'), loadingComponent: featureLoading, errorComponent: featureFailed });
const WebsiteSourcesPanel = defineAsyncComponent({loader:()=>import('./components/WebsiteSourcesPanel.vue'),loadingComponent:featureLoading,errorComponent:featureFailed});
import { siteTransport as cloudTransport, setupIssues, regionNeedsVerification, isNetlify } from "./lib/site-transport";
import type { ProviderChange,Transport } from "./lib/transport";
import { workspaceStore } from "./stores/workspace";
import { categoryNames, displayTime, safeOriginal } from "./lib/presentation";
import { safeError, ClientError } from "./lib/errors";
import InvitationPanel from './components/InvitationPanel.vue';
import SchoolRequestForm from './components/SchoolRequestForm.vue';
import NoticeLabelsEditor from './components/NoticeLabelsEditor.vue';
import RegistrationForm from './components/RegistrationForm.vue';
import EmailConfirmationPanel from './components/EmailConfirmationPanel.vue';
import {usePageTemplate} from './lib/page-template';
import TemplateIcon from './components/TemplateIcon.vue';
import PasswordRecoveryPanel from './components/PasswordRecoveryPanel.vue';
const AccountSettingsDialog=defineAsyncComponent(()=>import('./components/AccountSettingsDialog.vue'));
const accountOpen=ref(false),providerChange=ref<ProviderChange|null>(null),assistantFeedback=ref('');
const accountOpener=ref<HTMLElement|null>(null);
function openAccount(event:MouseEvent){accountOpener.value=event.currentTarget instanceof HTMLElement?event.currentTarget:null;accountOpen.value=true;}
const ReminderCenter=defineAsyncComponent({loader:()=>import('./components/ReminderCenter.vue'),loadingComponent:featureLoading,errorComponent:featureFailed});
import type {ReminderNotification,ReminderState} from '@campus/contracts';

const props = defineProps<{
  transport?: Transport;
  configurationIssues?: string[];
}>();
const store = workspaceStore(props.transport || cloudTransport)();
const transport = props.transport || cloudTransport;
usePageTemplate(computed(()=>Boolean(store.workspace)));
const sidebarCollapsed=ref(false),showPassword=ref(false),rememberAccount=ref(false),authHint=ref('');
const searchInput=ref<HTMLInputElement|null>(null),readerDialog=ref<HTMLElement|null>(null);
const avatarLetter=computed(()=>(store.auth?.username?.trim()[0]||'阅').toUpperCase());
const pageName=computed(()=>({feed:'首页',favorites:'我的收藏',ai:'AI 阅读',sources:'公告来源',reminders:'提醒中心'})[view.value]);
function noticeIcon(item:Notice){return item.categories.includes('competition')?'cup':item.categories.includes('academic')?'book':item.categories.includes('activity')?'cal':'doc';}
function noticeDate(value:string|null){return value&&Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',timeZone:'Asia/Shanghai'}).format(new Date(value)).replace('/','.'): '未标注';}
function noticeYear(value:string|null){return value&&Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat('zh-CN',{year:'numeric',timeZone:'Asia/Shanghai'}).format(new Date(value)).replace('年',''):'';}
let focusBeforeReader:HTMLElement|null=null,previousOverflow='';
watch(()=>Boolean(store.detail||store.detailLoading),async open=>{if(open){focusBeforeReader=document.activeElement instanceof HTMLElement?document.activeElement:null;previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';await nextTick();readerDialog.value?.focus();}else{document.body.style.overflow=previousOverflow;await nextTick();focusBeforeReader?.isConnected&&focusBeforeReader.focus();}},{flush:'post'});
function readerKeys(event:KeyboardEvent){if(event.key==='Escape'){event.preventDefault();store.closeNotice();}if(event.key!=='Tab')return;const controls=Array.from(readerDialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')||[]).filter(el=>el.getClientRects().length);const first=controls[0],last=controls.at(-1);if(!first){event.preventDefault();return;}if(event.shiftKey&&(document.activeElement===first||document.activeElement===readerDialog.value)){event.preventDefault();last?.focus();}else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===readerDialog.value)){event.preventDefault();first.focus();}}
async function searchShortcut(event:KeyboardEvent){if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'&&store.workspace&&!accountOpen.value){event.preventDefault();if(view.value!=='feed')navigate('feed');await nextTick();searchInput.value?.focus();}}
const authMode=ref<'login'|'register'>('login');
const canRegister=Boolean(transport.signUp);
let sourceFeatureSession=0;
watch(()=>store.auth?.uid,()=>{sourceFeatureSession++;},{flush:'sync'});
const featureTransport: Transport = { ...transport, call: (async (action, input) => {
  const ticket=sourceFeatureSession;
  try {
    const result=await transport.call(action,input);
    if(['sources.feedVisibility','sources.feedVisibilityAll'].includes(action)&&ticket===sourceFeatureSession)await store.sourcesChanged((input as {schoolId:string}).schoolId);
    return result;
  }
  catch (caught) { if (ticket===sourceFeatureSession&&caught instanceof ClientError && ["UNAUTHENTICATED", "FORBIDDEN"].includes(caught.code)) store.clear(); throw caught; }
}) as Transport["call"] };
const view = ref<"feed" | "favorites" | "ai" | "sources" | "reminders">("feed"), selection = ref<Notice[]>([]), bookmarkBusy = ref(false);
const unreadReminders=ref(0),reminderRevision=ref(0);
const reminderKeys=ref<string[]>([]),addingReminder=ref(''),reminderFeedback=ref('');
let requestedReminders=new URLSearchParams(location.search).get('view')==='reminders';
const requestingSchool = ref(false), schoolQuery = ref('');
const matchingSchools = computed(() => store.schools.filter(school=>school.name.includes(schoolQuery.value.trim())));
watch(() => store.auth?.uid,()=>{requestingSchool.value=false;schoolQuery.value='';accountOpen.value=false;providerChange.value=null;assistantFeedback.value='';});
watch(() => store.auth?.uid, () => { view.value = "feed"; selection.value = []; unreadReminders.value=0;reminderKeys.value=[];reminderFeedback.value='';addingReminder.value=''; });
watch(()=>store.workspace?.capabilities.reminders,enabled=>{if(enabled&&requestedReminders){navigate('reminders');requestedReminders=false;}});
watch(() => store.workspace?.school?.id, () => { selection.value = [];reminderFeedback.value='';assistantFeedback.value=''; });
function applyReminderState(state:ReminderState){unreadReminders.value=state.unread;reminderKeys.value=state.reminders.map(r=>`${r.schoolId}/${r.itemId}`);}
function alreadyReminded(itemId:string){return reminderKeys.value.includes(`${store.workspace?.school?.id}/${itemId}`);}
async function addReminder(item:Notice){
 const schoolId=store.workspace?.school?.id,uid=store.auth?.uid;if(!schoolId||!uid||addingReminder.value||alreadyReminded(item.id))return;
 addingReminder.value=item.id;reminderFeedback.value='';
 try{const result=await featureTransport.call('reminders.add',{schoolId,itemIds:[item.id]});if(store.auth?.uid===uid){applyReminderState(result);reminderRevision.value++;if(store.workspace?.school?.id===schoolId)reminderFeedback.value='已加入提醒中心，请在“时间提醒”中设置时间。';}}
 catch(caught){if(store.auth?.uid===uid)store.error=safeError(caught);}
 finally{if(store.auth?.uid===uid)addingReminder.value='';}
}
function addToAssistant(item:Notice){
 if(selection.value.some(row=>row.id===item.id))return;
 if(selection.value.length>=8){store.error='一次最多选择 8 篇公告。';return;}
 selection.value.push(item);assistantFeedback.value='已将“'+item.title+'”加入ai搭子，共 '+selection.value.length+' 篇。';
}
function chooseNotice(item: Notice) {
  if (selection.value.some(row => row.id === item.id)) selection.value = selection.value.filter(row => row.id !== item.id);
  else if (selection.value.length < 8) selection.value.push(item);
  else store.error = "一次最多选择 8 篇公告。";
}
let sourceNavigationEpoch=0;
watch(()=>store.auth?.uid,()=>{sourceNavigationEpoch++;},{flush:'sync'});
function navigate(target: "feed" | "favorites" | "ai" | "sources" | "reminders") { sourceNavigationEpoch++;store.closeNotice(); view.value = target; }
async function openSourceSchool(schoolId:string,source?:{id:string;name:string}) {
  const uid=store.auth?.uid,ticket=sourceNavigationEpoch;
  if(store.workspace?.school?.id!==schoolId)await store.selectSchool(schoolId);
  if(!uid||store.auth?.uid!==uid||ticket!==sourceNavigationEpoch)return;
  if(store.workspace?.school?.id!==schoolId)throw new ClientError('SCHOOL_SWITCH_FAILED',store.error||'切换学校失败，请稍后重试。');
  if(source||store.filters.sourceId){
    const {sourceId,...rest}=store.filters;sourceFilterName.value=source?.name||'';
    await store.applyFilters(source?{...rest,sourceId:source.id}:rest);
    if(store.auth?.uid!==uid||ticket!==sourceNavigationEpoch)return;
  }
  selection.value=[];navigate('feed');
}
function sourceCenterChanged(kind?:'visibility') {
  // Visibility mutations invalidate their own school's cache in the stable
  // transport above, including when the source page has already unmounted.
  if(kind==='visibility')return;
  selection.value=[];void store.sourcesChanged();
}
async function openReminder(event:ReminderNotification){
  const uid=store.auth?.uid;navigate('feed');
  if(store.workspace?.school?.id!==event.schoolId)await store.selectSchool(event.schoolId);
  if(store.auth?.uid===uid&&store.workspace?.school?.id===event.schoolId)await store.openNotice(event.itemId);
}
function pushNavigation(event:MessageEvent){if(event.data?.type==='open-reminders'){if(store.workspace?.capabilities.reminders)navigate('reminders');else requestedReminders=true;}}
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
try{const remembered=localStorage.getItem('campus-reader:login-email');if(remembered){username.value=remembered;rememberAccount.value=true;}}catch{}
const copied = ref("");
// Invite token stays in memory, never in API logs, Storage, or rendered text.
const inviteToken = ref(isNetlify ? new URLSearchParams(location.hash.slice(1)).get('invite_token') || '' : '');
const recoveryToken=ref((isNetlify||transport.recoverPassword)?new URLSearchParams(location.hash.slice(1)).get('recovery_token')||'':'');
const confirmationToken=ref(!recoveryToken.value&&(isNetlify||transport.confirmEmail)?new URLSearchParams(location.hash.slice(1)).get('confirmation_token')||'':'');
if (inviteToken.value||confirmationToken.value||recoveryToken.value) history.replaceState(null, '', location.pathname + location.search);
function receiveConfirmationLink(){
  const params=new URLSearchParams(location.hash.slice(1));
  const recovery=transport.recoverPassword?params.get('recovery_token'):null,confirmation=transport.confirmEmail?params.get('confirmation_token'):null;
  if(!recovery&&!confirmation)return;
  password.value='';store.clear();recoveryToken.value=recovery||'';confirmationToken.value=recovery?'':confirmation||'';
  history.replaceState(null,'',location.pathname+location.search);
}
const keyword = ref("");
const sourceFilterName=ref('');
watch(()=>store.workspace?.school?.id,()=>{sourceFilterName.value='';});
const selectedCategories = ref<string[]>([...noticeCategories]);
const period = ref<NonNullable<FeedFilters["period"]>>("all");
const filterDetails = ref<HTMLDetailsElement | null>(null);
const appliedPeriod = computed(() => ({ "7d": "最近 7 天", "30d": "最近 30 天", "90d": "最近 90 天", all: "" })[store.filters.period || "all"]);
const isFiltered = computed(() => Boolean(store.filters.sourceId||store.filters.keyword || (store.filters.categories && store.filters.categories.length < noticeCategories.length) || (store.filters.period && store.filters.period !== "all")));
function categoryLabel(categories?: string[]) {
  return categories?.map(category => categoryNames[category] || category).join(" · ") || "";
}
watch(() => store.auth?.uid, () => {
  keyword.value = "";
  selectedCategories.value = [...noticeCategories];
  period.value = "all";
});
async function search() {
  if (filterDetails.value) filterDetails.value.open = false;
  await store.applyFilters({ ...store.filters,keyword: keyword.value.trim(), categories: selectedCategories.value, period: period.value });
}
async function filterCategories(value?:string[]) {
  if(value)selectedCategories.value=[...value];
  await store.applyFilters({...store.filters,categories:[...selectedCategories.value]});
}
async function resetFilters() {
  keyword.value = "";
  selectedCategories.value = [...noticeCategories];
  period.value = "all";
  await store.applyFilters({});
}
async function clearSourceFilter(){const {sourceId,...rest}=store.filters;sourceFilterName.value='';await store.applyFilters(rest);}
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
  window.addEventListener('hashchange',receiveConfirmationLink);
  window.addEventListener('keydown',searchShortcut);
  navigator.serviceWorker?.addEventListener('message',pushNavigation);
  unwatch = store.watchSession();
  if (!issues.length&&!inviteToken.value&&!confirmationToken.value&&!recoveryToken.value) void store.connect();
});
onUnmounted(() => {
  window.removeEventListener('hashchange',receiveConfirmationLink);
  window.removeEventListener('keydown',searchShortcut);
  if(store.detail||store.detailLoading)document.body.style.overflow=previousOverflow;
  navigator.serviceWorker?.removeEventListener('message',pushNavigation);
  unwatch?.();
  password.value = "";
  store.clear();
});
async function login() {
  const value = password.value;
  try{if(rememberAccount.value)localStorage.setItem('campus-reader:login-email',username.value.trim());else localStorage.removeItem('campus-reader:login-email');}catch{}
  password.value = "";
  await store.signIn(username.value.trim(), value);
}
function changeAuthMode(mode:'login'|'register'){password.value='';showPassword.value=false;authHint.value='';store.error='';authMode.value=mode;}
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
  const id = (event.target as HTMLSelectElement).value;
  requestingSchool.value = id === '__request__';
  if (!requestingSchool.value) void store.selectSchool(id);
}
</script>

<template>
  <div v-if="!store.workspace" class="page login-template">
    <section class="visual" aria-label="校园阅览室介绍">
      <div class="brand"><div class="brandmark"><TemplateIcon name="planet" /></div><div><div class="brand-name">校园阅览室</div><div class="brand-sub">校园信息门户</div></div></div>
      <div class="visual-copy"><div class="overline">A CAMPUS CONNECTED</div><h1>让每一份热爱<br>都有回响。</h1><p>校园资讯、学术活动与成长机会，<br>从校园阅览室开始。</p><div class="visual-art"><span class="star s1">✦</span><span class="star s2">✧</span><span class="star s3">✦</span><div class="orbit"></div><div class="orbit two"></div><div class="planet"></div></div></div>
      <div class="visual-foot">校园阅览室 · 探索 · 连接 · 成长</div>
    </section>
    <main class="form-side">
      <div class="locale"><TemplateIcon name="globe" />简体中文</div>
      <PasswordRecoveryPanel v-if="recoveryToken" :key="recoveryToken" :token="recoveryToken" :transport="transport" @complete="recoveryToken='';store.connect()" @back="recoveryToken='';store.signOut();changeAuthMode('login')" />
      <EmailConfirmationPanel v-else-if="confirmationToken" :key="confirmationToken" :token="confirmationToken" :transport="transport" @complete="confirmationToken='';store.connect()" @back="confirmationToken='';changeAuthMode('login')" />
      <InvitationPanel v-else-if="inviteToken" :token="inviteToken" @complete="inviteToken='';store.connect()" />
      <div v-else class="form-wrap">
        <div class="welcome">{{authMode==='register'?'CREATE ACCOUNT':'WELCOME BACK'}}</div><h2 id="login-title">{{authMode==='register'?'创建你的账号':'欢迎回来'}}</h2><p class="sub">{{authMode==='register'?'验证邮箱，开启你的独立校园阅览室。':'登录你的校园账号，继续探索校园。'}}</p>
        <p v-if="!props.transport && regionNeedsVerification && !issues.length" class="account-help">暂按 SDK 默认上海地域连接，尚未验证。若环境连接失败，请核实地域与访问来源。</p>
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

        <RegistrationForm v-if="authMode==='register'&&canRegister&&!store.auth" :transport="transport" :disabled="issues.length>0||store.loading" @sent="username=$event" @back="changeAuthMode('login')" />
        <template v-else>
          <form @submit.prevent="login">
            <div class="field"><div class="field-head"><label for="username">{{canRegister||isNetlify?'登录邮箱':'账号'}}</label></div><div class="input-box"><TemplateIcon name="user" /><input id="username" v-model="username" :type="canRegister||isNetlify?'email':'text'" autocomplete="username" required maxlength="254" :disabled="issues.length>0||store.loading" :placeholder="canRegister||isNetlify?'请输入登录邮箱':'请输入账号'" /></div></div>
            <div class="field"><div class="field-head"><label for="password">登录密码</label><button class="forgot" type="button" @click="authHint='请联系站点管理员，从账号管理中向你的邮箱发送密码重置邮件。'">忘记密码？</button></div><div class="input-box"><TemplateIcon name="lock" /><input id="password" v-model="password" :type="showPassword?'text':'password'" autocomplete="current-password" required maxlength="256" :disabled="issues.length>0||store.loading" placeholder="请输入登录密码" /><button type="button" class="toggle-pass" :aria-label="showPassword?'隐藏密码':'显示密码'" :aria-pressed="showPassword" @click="showPassword=!showPassword"><TemplateIcon :name="showPassword?'eye':'eye-closed'" /></button></div></div>
            <div class="options"><label class="remember"><input v-model="rememberAccount" type="checkbox" />记住账号</label><span class="secure"><TemplateIcon name="lock" />安全加密登录</span></div>
            <p v-if="store.error" class="error-message" role="alert">{{store.error}}</p><p v-if="authHint" class="auth-feedback" role="status">{{authHint}}</p>
            <button class="submit" type="submit" :disabled="issues.length>0||store.loading">{{store.loading?'正在连接…':'登 录'}} <span aria-hidden="true">→</span></button>
          </form>
          <div v-if="canRegister" class="register">还没有账号？<button class="switch-mode" type="button" @click="changeAuthMode('register')">注册账号</button></div>
          <p v-else class="register">{{isNetlify?'请先接受账号邀请，再使用邮箱登录。':'请使用已配置的本人账号登录。'}}</p>
        </template>
      </div>
      <div class="copyright">校园阅览室 · 信息有来源，各账号数据独立</div>
    </main>
  </div>
  <div v-else class="shell portal-template" :class="{collapsed:sidebarCollapsed}">
    <header class="topbar" :inert="accountOpen"><div class="brand"><div class="brandmark"><TemplateIcon name="planet" /></div><div><div class="brand-name">校园阅览室</div><div class="brand-sub">校园信息门户</div></div></div><div class="top-actions"><span class="term">{{date}}</span><button v-if="store.workspace.capabilities.reminders" class="icon-btn" type="button" aria-label="通知" @click="navigate('reminders')"><span v-if="unreadReminders" class="notification-dot"></span><TemplateIcon name="bell" /></button><div class="avatar" aria-label="当前账号">{{avatarLetter}}</div></div></header>
    <div class="layout" :inert="accountOpen">
      <aside class="sidebar" aria-label="工作区导航">
        <div class="side-label">校园空间</div>
        <nav class="nav">
          <button class="nav-link" :class="{active:view==='feed'}" @click="navigate('feed')"><TemplateIcon name="grid" /><span class="nav-text">首页</span></button>
          <button class="nav-link" :class="{active:view==='favorites'}" @click="navigate('favorites')"><TemplateIcon name="saved" /><span class="nav-text">我的收藏</span></button>
          <button v-if="store.workspace.capabilities.reminders" class="nav-link" :class="{active:view==='reminders'}" @click="navigate('reminders')"><TemplateIcon name="bell" /><span class="nav-text">提醒中心<span v-if="unreadReminders">（{{unreadReminders}}）</span></span></button>
          <button v-if="store.workspace.capabilities.websiteSources" class="nav-link" :class="{active:view==='sources'}" @click="navigate('sources')"><TemplateIcon name="globe" /><span class="nav-text">公告来源</span></button>
          <button class="nav-link" :class="{active:view==='ai'}" @click="navigate('ai')"><TemplateIcon name="sparkle" /><span class="nav-text">AI 阅读{{selection.length?'（'+selection.length+'）':''}}</span></button>
          <div class="sidebar-spacer"></div><button class="nav-link" @click="store.signOut()"><TemplateIcon name="logout" /><span class="nav-text">退出登录</span></button>
        </nav>
        <div class="side-bottom"><button class="collapse-btn" :aria-label="sidebarCollapsed?'展开侧栏':'收起侧栏'" @click="sidebarCollapsed=!sidebarCollapsed"><TemplateIcon name="collapse" /><span class="collapse-text">{{sidebarCollapsed?'展开侧栏':'收起侧栏'}}</span></button><button type="button" class="profile-mini" aria-haspopup="dialog" :aria-expanded="accountOpen" aria-label="打开个人工作区设置" @click="openAccount"><div class="avatar">{{avatarLetter}}</div><div class="profile-meta"><strong>个人工作区</strong><span>{{store.workspace.school?.name||'请选择学校'}}</span></div></button></div>
      </aside>
      <main class="main">
        <template v-if="view==='feed'">
          <div class="main-head"><div><div class="eyebrow">校园门户 <span>/</span> <span>{{pageName}}</span></div><h1 class="page-title" id="notice-title">首页</h1><p class="page-desc">发现校园动态，连接学术与成长。</p></div><div class="head-date">北京时间<strong>{{date}}</strong></div></div>
          <form class="searchbar" @submit.prevent="search"><TemplateIcon name="search" /><input id="notice-keyword" ref="searchInput" v-model="keyword" type="search" aria-label="搜索校园信息" placeholder="搜索校园信息…" maxlength="100" :disabled="!store.workspace.school" /><kbd class="shortcut">⌘ K</kbd></form>
          <section class="hero"><div class="hero-content"><div class="hero-kicker"><span class="hero-icon"><TemplateIcon name="bell" /></span>校园公告</div><h2>欢迎来到校园阅览室</h2><p>查看最新通知、学术讲座和竞赛活动，及时掌握重要信息。</p><a class="hero-link" href="#notice-feed">浏览公告 <span>→</span></a></div></section>
          <div v-if="store.filters.sourceId" class="feed-update source-filter-banner" role="status"><span>仅查看：{{sourceFilterName||store.filters.sourceId}}。主页显示设置不变。</span><button class="text-button" @click="clearSourceFilter">查看全部来源</button></div>
          <details class="feed-settings"><summary>分类与时间<span v-if="isFiltered"> · 已筛选</span></summary><div class="feed-settings-body">
          <form class="feed-filters" @submit.prevent="search">
          <details ref="filterDetails" class="filter-options">
            <summary>分类与时间<span v-if="isFiltered"> · 已筛选</span></summary>
            <fieldset>
              <legend>分类（匹配任一已勾选标签；全不选则不显示）</legend>
              <div><button class="text-button" type="button" @click="filterCategories([...noticeCategories])">全选</button><button class="text-button" type="button" @click="filterCategories([])">全不选</button></div>
              <label v-for="category in noticeCategories" :key="category" class="category-option">
                <input v-model="selectedCategories" type="checkbox" :value="category" @change="filterCategories()" />{{ categoryNames[category] }}
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
            <span>{{ store.filters.keyword ? `“${store.filters.keyword}” · ` : "" }}{{ categoryLabel(store.filters.categories) || "未选择标签（不显示公告）" }}{{ appliedPeriod ? ` · ${appliedPeriod}` : "" }}</span>
            <button class="text-button" type="button" @click="resetFilters">清除筛选</button>
          </div>


          </form></div></details>
        <p v-if="store.error" class="error-message" role="alert">
          {{ store.error }}
        </p>
        <p v-if="reminderFeedback" class="feed-update" role="status">{{reminderFeedback}}<button class="text-button" @click="navigate('reminders')">前往提醒中心</button></p>
        <div v-if="store.pendingUpdates" class="feed-update" role="status">
          <span>公告有更新，可刷新列表；当前阅读内容已保留。</span>
          <button class="text-button" :disabled="store.loading" @click="store.applyUpdates()">显示更新</button>
        </div>
        <p v-else-if="store.refreshingSchool && store.items.length" class="muted small" role="status">已显示保存的公告，正在后台检查学校来源…</p>
        <p class="muted small">浏览和采集不扣次数；生成摘要请使用 AI 阅读，每人每天 3 次。</p>

<p v-if="assistantFeedback" class="feed-update" role="status">{{assistantFeedback}}<button class="text-button" @click="navigate('ai')">查看已加入资料</button></p>
          <div class="section-head" id="notice-feed"><h2 class="section-title">校园动态</h2><span class="section-note">已读取 {{store.items.length}} 条<button class="text-button" :disabled="store.loading||store.refreshingSchool||!store.workspace.school" @click="store.refreshSchool()">{{store.refreshingSchool?'检查更新中…':'刷新'}}</button></span></div>
          <div class="feed notice-scroll" :aria-busy="store.loading">
            <div v-if="store.loading&&!store.items.length" class="empty" role="status">正在读取真实公告…</div>
            <div v-else-if="!store.items.length&&store.refreshingSchool" class="empty" role="status">还没有匹配的已保存公告，正在检查学校公开来源…</div>
            <div v-else-if="!store.items.length" class="empty"><TemplateIcon name="doc" /><span>{{store.workspace.school?(isFiltered?'没有匹配的公告':'当前暂无可显示的公告'):'先选择你的学校'}}</span><button v-if="!store.workspace.school" class="text-button" @click="openAccount">打开个人工作区选择学校</button><p>{{store.error?'请排查上方错误后重试。':store.workspace.school?(store.filters.categories?.length===0?'请勾选至少一个标签后查看公告。':'可修改筛选条件，或稍后刷新。'):'学校偏好会保存到本人账号。'}}</p><div v-if="store.hiddenSourceCount&&store.workspace.capabilities.websiteSources" class="hidden-sources-hint"><p>有 {{store.hiddenSourceCount}} 个来源已关闭主页显示，可前往来源中心检查设置。</p><button class="text-button" @click="navigate('sources')">管理来源</button></div></div>
            <article v-for="item in store.items" :key="item.id" class="notice notice-row">
              <button class="notice-open" @click="copied='';store.openNotice(item.id)"><span class="notice-icon"><TemplateIcon :name="noticeIcon(item)" /></span><span class="notice-copy"><span class="notice-title" role="heading" aria-level="2">{{item.title}}</span><span class="notice-meta"><span class="notice-origin"><span class="notice-category">{{categoryLabel(item.categories)||'公告'}}</span><span class="notice-source">{{item.sourceName}}</span></span></span></span><time class="notice-date" :title="displayTime(item.publishedAt)">{{noticeDate(item.publishedAt)}}<span>{{noticeYear(item.publishedAt)}}</span></time></button>
              <div class="notice-card-footer"><div class="notice-quick-actions"><button v-if="store.workspace.capabilities.reminders" class="text-button notice-remind" :disabled="Boolean(addingReminder)||alreadyReminded(item.id)" @click="addReminder(item)">{{alreadyReminded(item.id)?'已加入提醒':addingReminder===item.id?'正在加入…':'加入提醒'}}</button><button class="text-button notice-read" :disabled="selection.some(row=>row.id===item.id)" @click="addToAssistant(item)">{{selection.some(row=>row.id===item.id)?'已加入ai搭子':'加入ai搭子'}}</button></div></div>
            </article>
            <button v-if="store.nextCursor" class="load-more" :disabled="store.loading||store.pendingUpdates" @click="store.loadFeed(true)">{{store.loading?'正在读取…':'加载更多公告'}}</button>
          </div><div class="bottom-note">真实云端资料 · 北京时间 · 各账号数据独立</div>
        </template>
      <BookmarksPanel v-if="view === 'favorites'" :transport="featureTransport" :school-id="store.workspace.school?.id || null" @open="openFavorite" />
      <ReminderCenter v-if="store.workspace.capabilities.reminders" v-show="view==='reminders'" :key="`reminders:${store.auth?.uid}`" :transport="featureTransport" :school-id="store.workspace.school?.id||null" :school-name="store.workspace.school?.name||''" :revision="reminderRevision" :visible="view==='reminders'" @unread="unreadReminders=$event" @changed="applyReminderState" @open="openReminder" @back="navigate('feed')" />
      <WebsiteSourcesPanel v-if="view === 'sources'" :key="`${store.auth?.uid}:${store.workspace.school?.id}`" :transport="featureTransport" :school-id="store.workspace.school?.id || null" :school-name="store.workspace.school?.name || ''" :open-school="openSourceSchool" @changed="sourceCenterChanged" @back="navigate('feed')" />
      <AssistantPanel v-if="view === 'ai'" :key="`assistant:${store.auth?.uid}:${store.workspace.school?.id}`" :transport="featureTransport" :school-id="store.workspace.school?.id || null" :selection="selection" :provider-change="providerChange" @remove="selection = selection.filter(item => item.id !== $event)" @back="navigate('feed')" />

      </main>
    </div>
    <AccountSettingsDialog v-if="accountOpen" :key="store.auth?.uid" :transport="featureTransport" :username="store.auth?.username||null" :opener="accountOpener" @close="accountOpen=false" @providers-changed="providerChange=$event"><template #school>        <label class="school-label" for="school">我的学校</label>
        <input v-if="store.schools.length > 10" v-model="schoolQuery" aria-label="搜索学校" placeholder="输入学校名称筛选" maxlength="80" class="school-search">
        <select
          id="school"
          :value="requestingSchool ? '__request__' : store.workspace.school?.id || ''"
          :disabled="store.loading"
          @change="schoolChanged"
        >
          <option value="" disabled>请选择学校</option>
          <option v-if="store.workspace.school && !store.schools.some(school=>school.id===store.workspace!.school!.id)" :value="store.workspace.school.id">{{store.workspace.school.name}}</option>
          <option
            v-for="school in matchingSchools"
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
          <option v-if="store.workspace.capabilities.schoolDirectory && store.catalogueReady && !store.schoolsLoading" value="__request__">没有找到自己的学校？联系客服添加</option>
        </select>
        <SchoolRequestForm v-if="requestingSchool" :key="store.auth?.uid" :transport="featureTransport" />
        <p v-if="store.schoolsLoading" class="muted small" role="status">学校目录正在加载，已有公告可先阅读…</p>
        <p v-else-if="store.schools.length > 10" class="muted small">目录共 {{store.schools.length}} 所学校{{schoolQuery.trim() ? `，匹配 ${matchingSchools.length} 所` : ''}}。</p>
        <p v-if="store.catalogueError" class="muted small" role="status">学校目录暂未完整加载：{{store.catalogueError}}。可稍后重新连接工作区。</p>
        <button
          v-if="store.schoolCursor"
          class="text-button more-schools"
          :disabled="store.schoolsLoading"
          @click="moreSchools"
        >
          加载更多学校
        </button>
        <p v-if="store.schoolSync" class="muted small" role="status">{{store.schoolSync.message}}</p>
        <p v-else-if="store.workspace.school && store.workspace.school.status !== 'ready'" class="muted small">该学校公开公告入口待核验，可能暂时没有可读取的公告。</p>
        <details v-if="store.schoolSync?.sources?.length" class="school-sources small">
          <summary>已接入的公告来源与覆盖范围</summary>
          <p class="muted">{{store.schoolSync.coverage}}</p>
          <ul>
            <li v-for="source in store.schoolSync.sources" :key="source.url">
              <a :href="safeOriginal(source.url) || undefined" target="_blank" rel="noopener noreferrer">{{source.name}}</a>
              <span> · {{source.state === 'ready' ? `${source.count} 条` : '暂不可用'}}</span>
              <p class="muted">{{source.message}}</p>
            </li>
          </ul>
        </details>
        <p v-if="safeOriginal(store.workspace.school?.announcementUrl || null)" class="small"><a :href="safeOriginal(store.workspace.school?.announcementUrl || null)!" target="_blank" rel="noopener noreferrer">查看目录原始入口 ↗</a></p>

</template></AccountSettingsDialog>
    <section v-if="view==='feed'&&(store.detail||store.detailLoading)" ref="readerDialog" class="overlay show reader" role="dialog" aria-modal="true" aria-label="公告阅读区" tabindex="-1" :aria-busy="store.detailLoading" @click.self="store.closeNotice()" @keydown="readerKeys">
      <article class="modal notice-body"><p v-if="store.detailLoading" class="empty" role="status">正在打开公告…</p><template v-else-if="store.detail">
        <div class="modal-top"><div class="modal-badge"><TemplateIcon :name="noticeIcon(store.detail)" /></div><div><div class="modal-cat">{{store.detail.sourceName}}</div><h2>{{store.detail.title}}</h2></div><span class="modal-date">{{displayTime(store.detail.publishedAt)}}</span></div><div class="modal-rule"></div>
        <div class="modal-body">
          <div class="action-row detail-actions"><button class="secondary" :disabled="bookmarkBusy" @click="saveBookmark">{{ store.detail.bookmarked ? '取消收藏' : '收藏公告' }}</button><button class="text-button" @click="chooseNotice(store.detail)">{{ selection.some(row => row.id === store.detail!.id) ? '从 AI 选择中移除' : '选入 AI 阅读' }}</button><button v-if="selection.length" class="text-button" @click="navigate('ai')">阅读已选 {{ selection.length }} 篇</button></div>
          <NoticeLabelsEditor v-if="store.workspace.capabilities.noticeLabels && store.workspace.school" :key="`${store.auth?.uid}:${store.detail.id}`" :transport="featureTransport" :school-id="store.workspace.school.id" :item-id="store.detail.id" :categories="store.detail.categories" :customized="Boolean(store.detail.categoriesCustomized)" @saved="store.noticeLabelsChanged" />
          <div v-if="store.workspace.capabilities.reminders" class="detail-reminder-action"><button class="secondary" :disabled="Boolean(addingReminder)||alreadyReminded(store.detail.id)" @click="addReminder(store.detail)">{{alreadyReminded(store.detail.id)?'已加入提醒中心':'加入提醒'}}</button><button class="text-button" @click="navigate('reminders')">前往提醒中心设置时间</button></div>
          <div class="original-source" v-if="original">
            <a :href="original" target="_blank" rel="noopener noreferrer"
              >打开原文 ↗</a
            ><button class="text-button" @click="copyOriginal">复制网址</button
            ><span class="original-url">{{ original }}</span>
            <p v-if="copied" class="small" role="status">{{ copied }}</p>
          </div>
          <p v-else class="muted small">这份资料未提供可打开的原文网址。</p>
          <div class="original-text">
            {{ store.detail.text || "尚未提供正文，请查看公告原文。" }}
          </div>
          <p class="attachment-note">{{ store.detail.attachmentNote }}</p>
          <section v-if="store.detail.materialArchive" class="material-files" aria-label="已保存的资料">
            <h2>资料库</h2>
            <p class="small muted">最早到期：{{ displayTime(store.detail.materialArchive.expiresAt) }} · 北京时间。到期后按来源许可重新采集。</p>
            <ul>
              <li v-for="file in store.detail.materialArchive.files" :key="file.id">
                <a v-if="file.available && store.workspace.school" :href="`/.netlify/functions/material-file?schoolId=${encodeURIComponent(store.workspace.school.id)}&itemId=${encodeURIComponent(store.detail.id)}&fileId=${encodeURIComponent(file.id)}`">{{ file.filename }} ↓</a>
                <span v-else>{{ file.filename }}</span>
                <p class="small muted">{{ file.message }}<template v-if="file.expiresAt"> · 保存至 {{ displayTime(file.expiresAt) }}</template></p>
              </li>
            </ul>
          </section>

        </div></template><div class="modal-actions"><button class="close-btn mobile-back" @click="store.closeNotice()">返回公告</button></div>
      </article>
    </section>
  </div>
</template>
