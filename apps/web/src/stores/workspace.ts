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
    const filters = ref<FeedFilters>({categories:[...noticeCategories]});
    const error = ref("");
    const loading = ref(false);
    const detailLoading = ref(false);
    let epoch = 0;
    let detailEpoch = 0;
    function clear() {
      epoch++;
      detailEpoch++;
      auth.value = null;
      workspace.value = null;
      schools.value = [];
      schoolCursor.value = null;
      schoolSync.value = null;
      items.value = [];
      detail.value = null;
      nextCursor.value = null;
      filters.value = {categories:[...noticeCategories]};
      loading.value = false;
      detailLoading.value = false;
    }
    function failure(caught: unknown) {
      if (
        caught instanceof ClientError &&
        ["UNAUTHENTICATED", "FORBIDDEN"].includes(caught.code)
      )
        clear();
      error.value = safeError(caught);
    }
    async function loadFeed(more = false, preserveDetail = false) {
      const schoolId = workspace.value?.school?.id;
      if (!schoolId || loading.value) return;
      const ticket = epoch;
      loading.value = true;
      error.value = "";
      if (!more) {
        items.value = [];
        if (!preserveDetail) detail.value = null;
        nextCursor.value = null;
        if (!preserveDetail) detailEpoch++;
      }
      try {
        const page = await transport.call("feed.list", {
          schoolId,
          ...filters.value,
          ...(more && nextCursor.value ? { cursor: nextCursor.value } : {}),
        });
        if (ticket !== epoch) return;
        items.value = more ? [...items.value, ...page.items] : page.items;
        nextCursor.value = page.nextCursor;
      } catch (caught) {
        if (ticket === epoch) failure(caught);
      } finally {
        if (ticket === epoch) loading.value = false;
      }
    }
    async function loadSchools(more = false) {
      const ticket = epoch;
      const page = await transport.call(
        "school.list",
        more && schoolCursor.value ? { cursor: schoolCursor.value } : {},
      );
      if (ticket !== epoch) return;
      schools.value = more ? [...schools.value, ...page.schools] : page.schools;
      schoolCursor.value = page.nextCursor;
    }
    async function refreshSchool() {
      const schoolId = workspace.value?.school?.id, ticket = epoch;
      if (!schoolId || loading.value) return;
      if (workspace.value?.capabilities.schoolDirectory) {
        loading.value = true;
        try {
          const result = await transport.call('school.refresh',{schoolId});
          if (ticket !== epoch) return;
          schoolSync.value = result;
          if (result.state === 'ready' && workspace.value?.school) workspace.value.school.status = 'ready';
        } catch (caught) { if (ticket === epoch) schoolSync.value = {state:'unavailable',count:0,checkedAt:null,message:safeError(caught)}; }
        finally { if (ticket === epoch) loading.value = false; }
      }
      if (ticket === epoch) await loadFeed();
    }
    async function applyFilters(value: FeedFilters) {
      epoch++;
      detailEpoch++;
      loading.value = false;
      detailLoading.value = false;
      filters.value = { ...value, categories:[...(value.categories ?? noticeCategories)] };
      await loadFeed();
    }
    async function noticeLabelsChanged(result: {itemId:string;schoolId:string;categories:string[];customized:boolean}) {
      if (workspace.value?.school?.id !== result.schoolId) return;
      if (detail.value?.id === result.itemId) {
        detail.value.categories = [...result.categories];
        detail.value.categoriesCustomized = result.customized;
      }
      await loadFeed(false,true);
    }
    async function connect() {
      clear();
      const ticket = epoch;
      loading.value = true;
      error.value = "";
      try {
        const restored = await transport.restore();
        if (ticket !== epoch) return;
        if (!restored) {
          clear();
          return;
        }
        auth.value = restored;
        const session = await transport.call("session.get", {});
        if (ticket !== epoch) return;
        workspace.value = session;
        await loadSchools();
        // The complete supplied directory must be visible before offering a
        // missing-school application. Bounded pages; no unbounded catalog loop.
        for (let page = 0; ticket === epoch && schoolCursor.value && page < 9; page++) await loadSchools(true);
      } catch (caught) {
        if (ticket === epoch) failure(caught);
      } finally {
        if (ticket === epoch) loading.value = false;
      }
      if (ticket === epoch && workspace.value?.school) await refreshSchool();
    }
    async function signIn(username: string, password: string) {
      const ticket = ++epoch;
      error.value = "";
      loading.value = true;
      try {
        await transport.signIn(username, password);
        if (ticket !== epoch) return;
        loading.value = false;
        await connect();
      } catch (caught) {
        if (ticket === epoch) failure(caught);
      } finally {
        if (ticket === epoch) loading.value = false;
      }
    }
    async function signOut() {
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
      } catch (caught) {
        if (ticket === epoch) failure(caught);
      } finally {
        if (ticket === epoch) loading.value = false;
      }
      if (ticket === epoch && workspace.value?.school?.id === schoolId)
        await refreshSchool();
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
        if (ticket === epoch && request === detailEpoch) detail.value = result;
      } catch (caught) {
        if (ticket === epoch && request === detailEpoch) failure(caught);
      } finally {
        if (ticket === epoch && request === detailEpoch)
          detailLoading.value = false;
      }
    }
    function closeNotice() {
      detailEpoch++;
      detail.value = null;
      detailLoading.value = false;
    }
    function watchSession() {
      return transport.onSessionChange((session) => {
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
      filters,
      error,
      loading,
      detailLoading,
      clear,
      connect,
      signIn,
      signOut,
      selectSchool,
      loadFeed,
      refreshSchool,
      applyFilters,
      noticeLabelsChanged,
      loadSchools,
      openNotice,
      closeNotice,
      watchSession,
    };
  });
}
