import { defineStore } from "pinia";
import { ref } from "vue";
import type {
  AuthSession,
  Notice,
  NoticeDetail,
  School,
  WorkspaceSession,
  FeedFilters,
  SchoolSync,
} from "@campus/contracts";
import type { Transport } from "../lib/transport";
import { noticeCategories } from '@campus/contracts';
import { ClientError, safeError } from "../lib/errors";

/** Dependency injection is for regression tests; the application only installs the real transport. */
export function workspaceStore(transport: Transport) {
  return defineStore("workspace", () => {
    const auth = ref<AuthSession | null>(null);
    const workspace = ref<WorkspaceSession | null>(null);
    const schools = ref<School[]>([]);
    const schoolCursor = ref<string | null>(null);
    const schoolSync = ref<SchoolSync | null>(null);
    const items = ref<Notice[]>([]);
    const detail = ref<NoticeDetail | null>(null);
    const nextCursor = ref<string | null>(null);
    const hiddenSourceCount=ref(0);
    const filters = ref<FeedFilters>({categories:[...noticeCategories]});
    const error = ref("");
    const loading = ref(false);
    const detailLoading = ref(false);
    const schoolsLoading = ref(false), catalogueReady = ref(false), catalogueError = ref('');
    const refreshingSchool = ref(false), pendingUpdates = ref(false);
    let epoch = 0;
    let detailEpoch = 0;
    let sessionEpoch = 0, schoolEpoch = 0;
    let selectingSchool = false;
    let signingIn=false;
    let feedRequest = 0;
    let activeFeed: Promise<void> | null = null;
    let sourceJob: { ticket:number; promise:Promise<void> } | null = null;
    type CachedPage = { schoolId:string; items:Notice[]; nextCursor:string|null; expiresAt:number;hiddenSourceCount:number };
    // Metadata only, in this authenticated browser session. Never Storage/CDN.
    const feedCache = new Map<string,CachedPage>();
    const cloneNotices = (rows:Notice[]) => rows.map(row=>({...row,categories:[...row.categories]}));
    function cacheKey(schoolId:string) {
      return JSON.stringify([auth.value?.uid,schoolId,filters.value.sourceId||'',filters.value.keyword||'',filters.value.period||'all',[...(filters.value.categories??noticeCategories)].sort()]);
    }
    function restoreFeedCache(schoolId:string) {
      const key=cacheKey(schoolId),cached=feedCache.get(key);
      if(!cached)return;
      if(cached.expiresAt<=Date.now() || cached.items.some(row=>row.publishedAt&&Date.parse(row.publishedAt)<Date.now()-365*86400000)){feedCache.delete(key);return;}
      feedCache.delete(key);feedCache.set(key,cached);
      items.value=cloneNotices(cached.items);nextCursor.value=cached.nextCursor;hiddenSourceCount.value=cached.hiddenSourceCount;
    }
    function rememberFeed(schoolId:string) {
      if(!auth.value||items.value.length>100)return;
      const key=cacheKey(schoolId);
      feedCache.delete(key);feedCache.set(key,{schoolId,items:cloneNotices(items.value),nextCursor:nextCursor.value,expiresAt:Date.now()+5*60000,hiddenSourceCount:hiddenSourceCount.value});
      while(feedCache.size>8)feedCache.delete(feedCache.keys().next().value!);
    }
    function clear() {
      epoch++;
      detailEpoch++;
      sessionEpoch++;schoolEpoch++;feedRequest++;feedCache.clear();activeFeed=null;sourceJob=null;selectingSchool=false;
      auth.value = null;
      workspace.value = null;
      schools.value = [];
      schoolCursor.value = null;
      schoolSync.value = null;
      items.value = [];
      detail.value = null;
      nextCursor.value = null;
      hiddenSourceCount.value=0;
      filters.value = {categories:[...noticeCategories]};
      loading.value = false;
      detailLoading.value = false;
      schoolsLoading.value=false;catalogueReady.value=false;catalogueError.value='';refreshingSchool.value=false;pendingUpdates.value=false;
    }
    function failure(caught: unknown) {
      if (
        caught instanceof ClientError &&
        ["UNAUTHENTICATED", "FORBIDDEN"].includes(caught.code)
      )
        clear();
      error.value = safeError(caught);
    }
    function loadFeed(more = false, preserveDetail = false, preserveList = false, keepCached = false):Promise<void> {
      const schoolId = workspace.value?.school?.id;
      if(more&&pendingUpdates.value)return Promise.resolve();
      if (!schoolId || loading.value || selectingSchool) return activeFeed || Promise.resolve();
      const ticket = epoch;
      const request=++feedRequest;
      loading.value = true;
      error.value = "";
      if (!more) {
        if(!preserveList)items.value = [];
        if (!preserveDetail) detail.value = null;
        if(!preserveList)nextCursor.value = null;
        if (!preserveDetail) detailEpoch++;
      }
      const work=(async()=>{try {
        const page = await transport.call("feed.list", {
          schoolId,
          ...filters.value,
          ...(more && nextCursor.value ? { cursor: nextCursor.value } : {}),
        });
        if (ticket !== epoch || request!==feedRequest) return;
        hiddenSourceCount.value=page.hiddenSourceCount??0;
        if(keepCached&&items.value.length&&page.items.length>=Math.min(20,items.value.length)) {
          // Keep the previously read pages and cursor until the visitor accepts
          // an update. Do not collapse a restored five-page list to page one.
          if(JSON.stringify(cloneNotices(items.value.slice(0,20)))!==JSON.stringify(cloneNotices(page.items)))pendingUpdates.value=true;
          return;
        }
        items.value = more ? [...items.value, ...page.items] : page.items;
        nextCursor.value = page.nextCursor;
        pendingUpdates.value=false;rememberFeed(schoolId);
      } catch (caught) {
        if (ticket === epoch && request===feedRequest) failure(caught);
      } finally {
        if (ticket === epoch && request===feedRequest) loading.value = false;
      }})();
      activeFeed=work;
      const done=()=>{if(activeFeed===work)activeFeed=null;};void work.then(done,done);
      return work;
    }
    async function loadSchools(more = false) {
      const ticket = sessionEpoch;
      const page = await transport.call(
        "school.list",
        more && schoolCursor.value ? { cursor: schoolCursor.value } : {},
      );
      if (ticket !== sessionEpoch) return;
      schools.value = more ? [...schools.value, ...page.schools] : page.schools;
      schoolCursor.value = page.nextCursor;
      catalogueReady.value=!page.nextCursor;
    }
    async function loadCatalogue() {
      const ticket=sessionEpoch;schoolsLoading.value=true;catalogueError.value='';
      try {
        await loadSchools();
        // Complete the directory before offering a missing-school request, but
        // do not put these sequential pages on the announcement critical path.
        for(let page=0;ticket===sessionEpoch&&schoolCursor.value&&page<9;page++)await loadSchools(true);
      }catch(caught){if(ticket===sessionEpoch){
        if(caught instanceof ClientError&&['UNAUTHENTICATED','FORBIDDEN'].includes(caught.code))failure(caught);
        else catalogueError.value=safeError(caught);
      }}finally{if(ticket===sessionEpoch)schoolsLoading.value=false;}
    }
    function checkSchoolSources(initialFeed:Promise<void>) {
      const schoolId=workspace.value?.school?.id,ticket=schoolEpoch;
      if(!schoolId||!workspace.value?.capabilities.schoolDirectory)return;
      if(sourceJob?.ticket===ticket)return;
      const current=()=>ticket===schoolEpoch&&workspace.value?.school?.id===schoolId;
      refreshingSchool.value=true;
      const promise=(async()=>{try {
        let result=await transport.call('school.refresh',{schoolId});
        // A different visitor may already be refreshing the same public cache.
        // Bounded polling lets a first visit pick up that result without a loop.
        for(const delay of [1500,3000,6000]) {
          if(!current())return;schoolSync.value=result;
          if(result.state!=='checking')break;
          await new Promise(resolve=>setTimeout(resolve,delay));if(!current())return;
          result=await transport.call('school.refresh',{schoolId});
        }
        if(!current())return;schoolSync.value=result;
        if(result.state!=='ready')return;
        if(workspace.value?.school)workspace.value.school.status='ready';
        await initialFeed;if(activeFeed)await activeFeed;
        if(!current())return;
        if(!items.value.length&&!loading.value)await loadFeed(false,true,true);
        else if(result.changed)pendingUpdates.value=true;
      }catch(caught){if(current()){
        if(caught instanceof ClientError&&['UNAUTHENTICATED','FORBIDDEN'].includes(caught.code))failure(caught);
        else schoolSync.value={state:'unavailable',count:0,checkedAt:null,message:safeError(caught)};
      }}finally{if(current()){refreshingSchool.value=false;sourceJob=null;}}})();
      sourceJob={ticket,promise};
    }
    function refreshSchool(background = false) {
      const schoolId=workspace.value?.school?.id;
      if(!schoolId||selectingSchool)return Promise.resolve();
      if(!items.value.length)restoreFeedCache(schoolId);
      const first=loadFeed(false,true,true,background&&items.value.length>0);
      checkSchoolSources(first);
      return first;
    }
    async function applyUpdates() {
      await loadFeed(false,true,true);
    }
    async function sourcesChanged(schoolId=workspace.value?.school?.id) {
      if(!schoolId)return;
      for(const[key,page]of feedCache)if(page.schoolId===schoolId)feedCache.delete(key);
      if(workspace.value?.school?.id!==schoolId)return;
      feedRequest++;loading.value=false;
      await loadFeed(false,true,true);
    }
    async function applyFilters(value: FeedFilters) {
      filters.value = { ...value, categories:[...(value.categories ?? noticeCategories)] };
      if(selectingSchool)return;
      epoch++;
      detailEpoch++;
      loading.value = false;
      detailLoading.value = false;
      await loadFeed();
    }
    async function noticeLabelsChanged(result: {itemId:string;schoolId:string;categories:string[];customized:boolean}) {
      if (workspace.value?.school?.id !== result.schoolId) return;
      for(const [key,page]of feedCache)if(page.schoolId===result.schoolId)feedCache.delete(key);
      feedRequest++;loading.value=false;
      if (detail.value?.id === result.itemId) {
        detail.value.categories = [...result.categories];
        detail.value.categoriesCustomized = result.customized;
      }
      await loadFeed(false,true);
    }
    async function connect() {
      clear();
      const ticket = sessionEpoch;
      loading.value = true;
      error.value = "";
      try {
        const restored = await transport.restore();
        if (ticket !== sessionEpoch) return;
        if (!restored) {
          clear();
          return;
        }
        auth.value = restored;
        const session = await transport.call("session.get", {});
        if (ticket !== sessionEpoch) return;
        workspace.value = session;
        auth.value = session.identity.kind==='guest'?session.identity:restored;
        loading.value=false;
        await Promise.all([loadCatalogue(),workspace.value.school?refreshSchool(true):Promise.resolve()]);
      } catch (caught) {
        if (ticket === sessionEpoch) failure(caught);
      } finally {
        if (ticket === sessionEpoch&&!workspace.value) loading.value = false;
      }
    }
    async function signIn(username: string, password: string) {
      if(signingIn)return;signingIn=true;
      const ticket = auth.value?.kind==='guest'?epoch:++epoch;
      error.value = "";
      loading.value = true;
      try {
        const account=await transport.signIn(username, password);
        if (ticket !== epoch) return;
        if(auth.value?.kind==='guest'){
          updateAccount(account);return;
        }
        loading.value = false;
        await connect();
      } catch (caught) {
        if (ticket === epoch) failure(caught);
      } finally {
        signingIn=false;
        if (ticket === epoch) loading.value = false;
      }
    }
    async function signOut() {
      if(auth.value?.kind==='guest'){
        error.value='';loading.value=true;
        try{await transport.signOut();updateAccount(null);}
        catch{error.value='AI账号退出未成功，请联网后重试。';}
        finally{loading.value=false;}
        return;
      }
      clear();
      error.value = "";
      loading.value = true;
      try {
        await transport.signOut();
      } catch {
        error.value =
          "本页资料已清空，但云端退出未成功。请联网重试退出，避免继续保留登录会话。";
      } finally {
        loading.value = false;
      }
    }
    async function selectSchool(schoolId: string) {
      const ticket = ++epoch;
      schoolEpoch++;sourceJob=null;refreshingSchool.value=false;pendingUpdates.value=false;selectingSchool=true;
      detailEpoch++;
      loading.value = true;
      error.value = "";
      items.value = [];
      detail.value = null;
      nextCursor.value = null;
      schoolSync.value = null;
      try {
        const session = await transport.call("school.select", { schoolId });
        if (ticket !== epoch) return;
        workspace.value = session;
        hiddenSourceCount.value=0;
        if(filters.value.sourceId){const {sourceId,...rest}=filters.value;filters.value=rest;}
      } catch (caught) {
        if (ticket === epoch) failure(caught);
      } finally {
        if (ticket === epoch){loading.value = false;selectingSchool=false;}
      }
      if (ticket === epoch && workspace.value?.school?.id === schoolId)
        await refreshSchool(true);
    }
    async function openNotice(itemId: string) {
      const schoolId = workspace.value?.school?.id;
      if (!schoolId) return;
      const ticket = epoch,
        request = ++detailEpoch;
      detail.value = null;
      detailLoading.value = true;
      error.value = "";
      try {
        const result = await transport.call("feed.detail", {
          schoolId,
          itemId,
        });
        if (ticket === epoch && request === detailEpoch) {
          detail.value = result;
          // Learning is enforced by the server's opt-in; never delay article display.
          if(workspace.value?.capabilities.ai)void transport.call('ai.behavior', { schoolId, itemId }).catch(() => {});
          const row=items.value.find(row=>row.id===itemId);
          if(row){row.title=result.title;row.summary=result.summary;row.excerpt=result.excerpt;rememberFeed(schoolId);}
        }
      } catch (caught) {
        if (ticket === epoch && request === detailEpoch) failure(caught);
      } finally {
        if (ticket === epoch && request === detailEpoch)
          detailLoading.value = false;
      }
    }
    async function refreshBrief(){
      const schoolId=workspace.value?.school?.id,itemId=detail.value?.id,ticket=epoch,request=detailEpoch;if(!schoolId||!itemId)return;
      try{const brief=await transport.call('feed.brief',{schoolId,itemId});if(ticket===epoch&&request===detailEpoch&&detail.value?.id===itemId)detail.value.brief=brief;}
      catch{if(ticket===epoch&&request===detailEpoch&&detail.value?.id===itemId)detail.value.brief={state:'failed',checkedAt:new Date().toISOString(),attachmentsRead:false,message:'摘要状态暂不可读取，可继续阅读正文。'};}
    }
    function closeNotice() {
      detailEpoch++;
      detail.value = null;
      detailLoading.value = false;
    }
    function updateAccount(session:AuthSession|null){
      if(auth.value?.kind!=='guest')return;
      const account=session?{uid:session.uid,username:session.username}:null;
      auth.value={...auth.value,account};
      if(workspace.value){workspace.value.identity={...auth.value};workspace.value.capabilities.ai=Boolean(account);}
    }
    function watchSession() {
      return transport.onSessionChange((session) => {
        if(auth.value?.kind==='guest'){
          if(session?.kind==='guest')return;
          updateAccount(session);return;
        }
        if (!session || (auth.value && auth.value.uid !== session.uid)) {
          const hadSession = Boolean(auth.value || workspace.value);
          clear();
          if (hadSession) error.value = "登录状态已变化，请重新连接本人工作区。";
        }
      });
    }
    return {
      auth,
      workspace,
      schools,
      schoolCursor,
      schoolSync,
      items,
      detail,
      nextCursor,
      hiddenSourceCount,
      filters,
      error,
      loading,
      detailLoading,
      schoolsLoading,catalogueReady,catalogueError,refreshingSchool,pendingUpdates,applyUpdates,
      clear,
      connect,
      signIn,
      signOut,
      selectSchool,
      loadFeed,
      refreshSchool,
      applyFilters,
      sourcesChanged,
      noticeLabelsChanged,
      loadSchools,
      openNotice,
      refreshBrief,
      closeNotice,
      watchSession,
    };
  });
}
