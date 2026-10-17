import { afterEach, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import ReadingPanel from "../src/components/ReadingPanel.vue";
import BookmarksPanel from "../src/components/BookmarksPanel.vue";
import { renderMarkdown } from "../src/lib/markdown";
import type { Transport } from "../src/lib/transport";
import type { ReadingTask, Notice } from "@campus/contracts";
const notice: Notice = { id: "one", title: "测试公告", sourceName: "测试来源", categories: ["competition"], publishedAt: null, summary: null };
const task: ReadingTask = { id: "task-id", schoolId: "bjtu", service: "byok", provider: "deepseek", model: "fixture-model", task: "summary", state: "ready", step: 0, totalSteps: 2, title: "测试任务", result: null, message: "等待继续", expireAt: new Date(Date.now() + 86400000).toISOString(), createdAt: new Date().toISOString(), quotaHeld: false };
function transport() {
  const fake: Transport = { restore: vi.fn(), signIn: vi.fn(), signOut: vi.fn(), onSessionChange: vi.fn(), call: vi.fn(async action => {
    if (action === "ai.status") return { quota: { limit: 5, used: 0, held: 0, remaining: 5 }, officialConfigured: false, officialModel: null, providers: [] };
    if (action === "ai.list") return { tasks: [] };
    if (action === "ai.preview") return { docs: [{ itemId: "one", title: "测试公告", reference: "R1", markdown: "正文" }], guide: "阅读说明", manifest: { context_chars: 2 }, batches: 2, fingerprint: "fixture-hash" };
    if (action === "ai.start" || action === "ai.test") return task;
    throw new Error("unexpected action");
  }) as Transport["call"] };
  return fake;
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it("Markdown renders readable structure without executable HTML, remote images or unsafe links", () => {
  const html = renderMarkdown('# 摘要\n\n<script>alert(1)</script>\n\n![spy](https://evil.example/a)\n\n[危险](javascript:alert(1))\n\n[来源](https://www.bjtu.edu.cn/a)\n\n[凭据](https://u:secret@example.com/a)');
  const host = document.createElement('div'); host.innerHTML = html;
  expect(host.querySelector('h1')?.textContent).toBe('摘要');
  expect(host.querySelector('script,img')).toBeNull();
  expect(host.querySelector('a[href^="javascript:"]')).toBeNull();
  expect(host.querySelector('a[href*="secret"]')).toBeNull();
  expect(host.querySelector('a[href="https://www.bjtu.edu.cn/a"]')?.getAttribute('rel')).toBe('noopener noreferrer');
});
it("BYOK starts only after preview; key appears only in the current step call and is lost on leaving", async () => {
  const fake = transport(); let resolve!: (value: ReadingTask) => void;
  const pending = new Promise<ReadingTask>(r => { resolve = r; });
  vi.mocked(fake.call).mockImplementation(async action => {
    if (action === 'ai.status') return { quota: { remaining: 5, limit: 5, used: 0, held: 0 }, officialConfigured: false } as never;
    if (action === 'ai.list') return { tasks: [] } as never;
    if (action === 'ai.preview') return { docs: [], guide: 'guide', manifest: {}, batches: 2, fingerprint: 'fixture-hash' } as never;
    if (action === 'ai.start') return task as never;
    if (action === 'ai.step') return pending as never;
    throw new Error('unexpected');
  });
  const wrapper = mount(ReadingPanel, { props: { transport: fake, schoolId: 'bjtu', selection: [notice] } });
  await flushPromises();
  await wrapper.find('input[value="byok"]').setValue();
  await wrapper.find('#ai-model').setValue('fixture-model');
  await wrapper.find('#ai-key').setValue('fixture-key-only-in-memory');
  expect(wrapper.find('.start-reading').attributes('disabled')).toBeDefined();
  await wrapper.findAll('button').find(b => b.text() === '预览阅读资料')!.trigger('click'); await flushPromises();
  await wrapper.find('.start-reading').trigger('click'); await flushPromises();
  const startCall = vi.mocked(fake.call).mock.calls.find(([action]) => action === 'ai.start');
  expect(JSON.stringify(startCall)).not.toContain('fixture-key-only-in-memory');
  expect(fake.call).toHaveBeenCalledWith('ai.step', { taskId: task.id, step: 0, connection: { provider: 'deepseek', model: 'fixture-model', apiKey: 'fixture-key-only-in-memory' } });
  wrapper.unmount(); resolve({ ...task, step: 1 }); await flushPromises();
  expect(vi.mocked(fake.call).mock.calls.filter(([action]) => action === 'ai.step')).toHaveLength(1);
  const reopened = mount(ReadingPanel, { props: { transport: fake, schoolId: 'bjtu', selection: [notice] } }); await flushPromises();
  await reopened.find('input[value="byok"]').setValue();
  expect((reopened.find('#ai-key').element as HTMLInputElement).value).toBe(''); reopened.unmount();
});
it("expired results are removed from the open page", async () => {
  vi.useFakeTimers(); const fake = transport();
  const expires = new Date(Date.now() + 1000).toISOString();
  vi.mocked(fake.call).mockImplementation(async action => {
    if (action === 'ai.list') return { tasks: [{ ...task, state: 'complete', result: 'R1 result', expireAt: expires }] } as never;
    if (action === 'ai.task') return { ...task, state: 'complete', result: 'R1 result', expireAt: expires } as never;
    if (action === 'ai.status') return { quota: {}, officialConfigured: false } as never;
    throw new Error('unexpected');
  });
  const wrapper = mount(ReadingPanel, { props: { transport: fake, schoolId: 'bjtu', selection: [] } }); await flushPromises();
  await wrapper.find('.recent-task').trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('R1 result'); await vi.advanceTimersByTimeAsync(1000);
  expect(wrapper.text()).not.toContain('R1 result'); expect(wrapper.text()).toContain('已满 24 小时'); wrapper.unmount();
});
it("favorites distinguish unavailable records and switch between school and all-owner scope", async () => {
  const fake = transport();
  vi.mocked(fake.call).mockResolvedValue({ items: [{ itemId: 'one', schoolId: 'bjtu', schoolName: '测试学校', savedAt: 'now', notice: null }], nextCursor: null } as never);
  const wrapper = mount(BookmarksPanel, { props: { transport: fake, schoolId: 'bjtu' } }); await flushPromises();
  expect(fake.call).toHaveBeenCalledWith('favorites.list', { schoolId: 'bjtu' });
  expect(wrapper.find('.favorite-open').attributes('disabled')).toBeDefined();
  await wrapper.find('input[type="checkbox"]').setValue(true); await flushPromises();
  expect(fake.call).toHaveBeenLastCalledWith('favorites.list', {}); wrapper.unmount();
});
