import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { flushPromises, mount } from "@vue/test-utils";
import type {
  AuthSession,
  NoticeDetail,
  NoticePage,
  WorkspaceSession,
} from "@campus/contracts";
import type { Transport } from "../src/lib/transport";
import { workspaceStore } from "../src/stores/workspace";
import { ClientError } from "../src/lib/errors";
import { safeOriginal, displayTime } from "../src/lib/presentation";
import App from "../src/App.vue";
import { noticeCategories } from '@campus/contracts';

const auth: AuthSession = { uid: "test-owner", username: null };
const session: WorkspaceSession = {
  identity: auth,
  school: { id: "bjtu", name: "测试学校", status: "ready" },
  legacyLinked: false,
  capabilities: { reading: true, ai: false, operations: false },
};
const detail: NoticeDetail = {
  id: "one",
  title: "仅用于回归测试的公告",
  sourceName: "测试来源",
  publishedAt: "2026-10-15T00:00:00Z",
  categories: ["school"],
  summary: null,
  text: "<img src=x onerror=alert(1)>",
  originalUrl: "javascript:alert(1)",
  attachmentNote: "附件未读取",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture() {
  let listener: (session: AuthSession | null) => void = () => {};
  const fake: Transport = {
    restore: vi.fn(async () => auth),
    signIn: vi.fn(async () => auth),
    signOut: vi.fn(async () => {}),
    onSessionChange: vi.fn((callback) => {
      listener = callback;
      return () => {};
    }),
    call: vi.fn(async (action: string) => {
      if (action === "session.get" || action === "school.select")
        return session;
      if (action === "school.list")
        return { schools: [session.school!], nextCursor: null };
      if (action === "feed.list") return { items: [detail], nextCursor: null };
      if (action === "feed.detail") return detail;
      throw new Error("unexpected action");
    }) as Transport["call"],
  };
  return { fake, emit: (value: AuthSession | null) => listener(value) };
}
beforeEach(() => setActivePinia(createPinia()));
describe("session and data race boundaries", () => {
  it('adds a notice beside the AI action and configures its time only in reminder center', async () => {
    const {fake}=fixture();
    const state={reminders:[] as any[],watches:[],notifications:[],unread:0,checkedAt:new Date().toISOString(),more:false,pushConfigured:false,publicKey:null};
    vi.mocked(fake.call).mockImplementation(async(action:string,input:any)=>{
      if(action==='session.get')return{...session,capabilities:{...session.capabilities,reminders:true}};
      if(action==='feed.list')return{items:[detail],nextCursor:null};
      if(action==='feed.detail')return detail;
      if(action==='school.list')return{schools:[session.school!],nextCursor:null};
      if(action==='reminders.add'){state.reminders.push({id:'pending',itemId:detail.id,schoolId:'bjtu',schoolName:'测试学校',title:detail.title,label:'截止',dueAt:null,days:[],createdAt:new Date().toISOString()});return structuredClone(state);}
      if(action==='reminders.state')return structuredClone(state);
      throw new Error('unexpected '+action);
    });
    const wrapper=mount(App,{props:{transport:fake,configurationIssues:[]},global:{plugins:[createPinia()]}});await flushPromises();
    expect(wrapper.findAll('.notice-quick-actions button').map(b=>b.text())).toEqual(['加入提醒','用 AI 生成摘要']);
    await wrapper.get('.notice-remind').trigger('click');await flushPromises();
    expect(fake.call).toHaveBeenCalledWith('reminders.add',{schoolId:'bjtu',itemIds:['one']});expect(wrapper.get('.notice-remind').text()).toBe('已加入提醒');
    expect(wrapper.find('input[type=datetime-local]').exists()).toBe(false);
    await wrapper.get('.notice-open').trigger('click');await flushPromises();expect(wrapper.find('.detail-reminder-action').exists()).toBe(true);expect(wrapper.find('input[type=datetime-local]').exists()).toBe(false);wrapper.unmount();
  });
  it('changing search discards the previous page request and preserves filters for pagination', async () => {
    const { fake } = fixture();
    const store = workspaceStore(fake)();
    await store.connect();
    const late = deferred<NoticePage>();
    vi.mocked(fake.call).mockImplementation(async action => {
      if (action === 'feed.list') return late.promise;
      throw new Error('unexpected');
    });
    const old = store.loadFeed(true);
    vi.mocked(fake.call).mockResolvedValue({ items: [], nextCursor: '20' } as never);
    await store.applyFilters({ keyword: 'C++', categories: ['competition'], period: '30d' });
    late.resolve({ items: [detail], nextCursor: '40' });
    await old;
    expect(store.items).toEqual([]);
    expect(store.nextCursor).toBe('20');
    await store.loadFeed(true);
    expect(fake.call).toHaveBeenLastCalledWith('feed.list', { schoolId: 'bjtu', cursor: '20', keyword: 'C++', categories: ['competition'], period: '30d' });
    store.clear();
    expect(store.filters).toEqual({categories:[...noticeCategories]});
  });
  it('an empty auth event before login does not show an expiration warning', () => {
    const { fake, emit } = fixture(); const store = workspaceStore(fake)(); store.watchSession()
    emit(null); expect(store.error).toBe(''); expect(store.workspace).toBeNull()
  })
  it("does not read data without a real session", async () => {
    const { fake } = fixture();
    vi.mocked(fake.restore).mockResolvedValue(null);
    const store = workspaceStore(fake)();
    await store.connect();
    expect(fake.call).not.toHaveBeenCalled();
    expect(store.workspace).toBeNull();
  });
  it("restores the cloud session and reads scoped real-transport data", async () => {
    const { fake } = fixture();
    const store = workspaceStore(fake)();
    await store.connect();
    expect(fake.call).toHaveBeenCalledWith("session.get", {});
    expect(fake.call).toHaveBeenCalledWith("feed.list", { schoolId: "bjtu",categories:[...noticeCategories] });
    expect(store.items[0].id).toBe("one");
  });
  it("never turns cloud failure into mock data or a success-empty response", async () => {
    const { fake } = fixture();
    const store = workspaceStore(fake)();
    await store.connect();
    vi.mocked(fake.call).mockRejectedValue(
      new ClientError("SERVICE_UNAVAILABLE", "云端暂不可用"),
    );
    await store.loadFeed();
    expect(store.items).toEqual([]);
    expect(store.error).toBe("云端暂不可用");
  });
  it("drops a feed response that arrives after logout", async () => {
    const { fake } = fixture();
    const store = workspaceStore(fake)();
    await store.connect();
    const task = deferred<NoticePage>();
    vi.mocked(fake.call).mockImplementationOnce(() => task.promise);
    const read = store.loadFeed();
    await store.signOut();
    task.resolve({ items: [detail], nextCursor: null });
    await read;
    expect(store.items).toEqual([]);
    expect(store.auth).toBeNull();
    expect(store.workspace).toBeNull();
  });
  it("drops a detail response that arrives after closing the reader", async () => {
    const { fake } = fixture();
    const store = workspaceStore(fake)();
    await store.connect();
    const task = deferred<NoticeDetail>();
    vi.mocked(fake.call).mockImplementationOnce(() => task.promise);
    const read = store.openNotice("one");
    store.closeNotice();
    task.resolve(detail);
    await read;
    expect(store.detail).toBeNull();
    expect(store.detailLoading).toBe(false);
  });
  it("does not let the older detail request overwrite the last click", async () => {
    const { fake } = fixture();
    const store = workspaceStore(fake)();
    await store.connect();
    const old = deferred<NoticeDetail>();
    const recent = deferred<NoticeDetail>();
    vi.mocked(fake.call)
      .mockImplementationOnce(() => old.promise)
      .mockImplementationOnce(() => recent.promise);
    const first = store.openNotice("one"),
      last = store.openNotice("two");
    recent.resolve({ ...detail, id: "two" });
    await last;
    old.resolve(detail);
    await first;
    expect(store.detail?.id).toBe("two");
  });
  it("clears both cached data and in-flight work on account change", async () => {
    const { fake, emit } = fixture();
    const store = workspaceStore(fake)();
    store.watchSession();
    await store.connect();
    await store.openNotice("one");
    emit({ uid: "other-account", username: null });
    expect(store.items).toEqual([]);
    expect(store.detail).toBeNull();
    expect(store.schools).toEqual([]);
  });
  it("never renders stale data from a previous account during reconnect", async () => {
    const { fake } = fixture();
    const store = workspaceStore(fake)();
    await store.connect();
    const task = deferred<AuthSession | null>();
    vi.mocked(fake.restore).mockReturnValueOnce(task.promise);
    const work = store.connect();
    expect(store.items).toEqual([]);
    expect(store.workspace).toBeNull();
    task.resolve(null);
    await work;
  });
  it("clears private state when the gateway reports a rejected session", async () => {
    const { fake } = fixture();
    const store = workspaceStore(fake)();
    await store.connect();
    vi.mocked(fake.call).mockRejectedValue(
      new ClientError("FORBIDDEN", "无权限"),
    );
    await store.openNotice("one");
    expect(store.workspace).toBeNull();
    expect(store.items).toEqual([]);
    expect(store.error).toBe("无权限");
  });
});
describe("visible entry and untrusted content", () => {
  it('reconnects an existing login after cloud setup without requesting the password again', async () => {
    const { fake } = fixture();
    vi.mocked(fake.call).mockRejectedValueOnce(new ClientError('COLLECTION_REQUIRED', '缺少 user_profiles 集合'));
    const wrapper = mount(App, { props: { transport: fake, configurationIssues: [] }, global: { plugins: [createPinia()] } });
    await flushPromises();
    expect(wrapper.text()).toContain('缺少 user_profiles 集合');
    await wrapper.findAll('button').find(button => button.text() === '重新连接工作区')!.trigger('click');
    await flushPromises();
    expect(wrapper.find('.notice-index').exists()).toBe(true);
    expect(fake.signIn).not.toHaveBeenCalled();
    wrapper.unmount();
  });
  it('distinguishes a real SDK login from an unauthorized or unconfigured workspace', async () => {
    const { fake } = fixture()
    vi.mocked(fake.call).mockRejectedValue(new ClientError('OWNER_NOT_CONFIGURED', '工作区待配置'))
    const wrapper = mount(App, { props: { transport: fake, configurationIssues: [] }, global: { plugins: [createPinia()] } })
    await flushPromises()
    expect(wrapper.text()).toContain('云账号已登录，工作区仍待验证')
    expect(wrapper.text()).toContain(auth.uid)
    expect(wrapper.find('.notice-index').exists()).toBe(false)
    wrapper.unmount()
  })
  it("shows setup requirements and a disabled form, with no simulated notices", async () => {
    const { fake } = fixture();
    const wrapper = mount(App, {
      props: { transport: fake, configurationIssues: ["确认环境地域"] },
      global: { plugins: [createPinia()] },
    });
    await flushPromises();
    expect(wrapper.text()).toContain("网页登录待接通");
    expect(
      wrapper.find("button[type=submit]").attributes("disabled"),
    ).toBeDefined();
    expect(fake.call).not.toHaveBeenCalled();
    expect(fake.restore).not.toHaveBeenCalled();
    wrapper.unmount();
  });
  it("escapes announcement text and blocks unsafe original links", async () => {
    const { fake } = fixture();
    const wrapper = mount(App, {
      props: { transport: fake, configurationIssues: [] },
      global: { plugins: [createPinia()] },
    });
    await flushPromises();
    await wrapper.get(".notice-row button").trigger("click");
    await flushPromises();
    expect(wrapper.get(".original-text").text()).toBe(detail.text);
    expect(wrapper.find(".original-text img").exists()).toBe(false);
    expect(wrapper.find('a[href^="javascript:"]').exists()).toBe(false);
    wrapper.unmount();
  });
  it("clears password from the form as soon as login is submitted", async () => {
    const { fake } = fixture();
    vi.mocked(fake.restore).mockResolvedValue(null);
    const login = deferred<AuthSession>();
    vi.mocked(fake.signIn).mockReturnValue(login.promise);
    const wrapper = mount(App, {
      props: { transport: fake, configurationIssues: [] },
      global: { plugins: [createPinia()] },
    });
    await flushPromises();
    await wrapper.get("#username").setValue("owner");
    await wrapper.get("#password").setValue("transient-test-password");
    await wrapper.get("form").trigger("submit");
    expect((wrapper.get("#password").element as HTMLInputElement).value).toBe(
      "",
    );
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    login.resolve(auth);
    await flushPromises();
    wrapper.unmount();
  });
  it("formats displayed dates in Beijing time and handles invalid dates", () => {
    expect(displayTime("2026-10-14T17:00:00Z")).toContain("2026/10/15");
    expect(displayTime("invalid")).toBe("发布时间未标注");
    expect(safeOriginal("https://user:password@example.org")).toBeNull();
    expect(safeOriginal("https://example.org/notice?id=1")).toBe(
      "https://example.org/notice?id=1",
    );
  });
});
