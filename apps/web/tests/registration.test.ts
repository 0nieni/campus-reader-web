import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mount,flushPromises} from '@vue/test-utils';
import {createPinia,setActivePinia} from 'pinia';
import App from '../src/App.vue';
import RegistrationForm from '../src/components/RegistrationForm.vue';
import type {Transport} from '../src/lib/transport';
import {ClientError} from '../src/lib/errors';
const mounted:ReturnType<typeof mount>[]=[];
const session={uid:'synthetic-user',username:'fixture@example.test'};
function transport():Transport{return {restore:vi.fn(async()=>null),signIn:vi.fn(async()=>session),signOut:vi.fn(async()=>{}),signUp:vi.fn(async()=>({verificationRequired:true as const})),confirmEmail:vi.fn(async()=>session),onSessionChange:vi.fn(()=>()=>{}),call:vi.fn(async(action:string)=>{if(action==='session.get')return {identity:session,school:null,capabilities:{reading:true,ai:true}};if(action==='school.list')return {schools:[],nextCursor:null};throw Error('Unexpected '+action);}) as Transport['call']};}
function open(t:Transport){const wrapper=mount(App,{props:{transport:t,configurationIssues:[]},global:{plugins:[createPinia()]}});mounted.push(wrapper);return wrapper;}
beforeEach(()=>{setActivePinia(createPinia());history.replaceState(null,'','/');});
afterEach(()=>{mounted.splice(0).forEach(w=>w.unmount());localStorage.removeItem('campus-reader:theme');delete document.documentElement.dataset.theme;vi.restoreAllMocks();history.replaceState(null,'','/');});

it('registering clears passwords immediately and waits for email verification without reading any workspace',async()=>{
  const t=transport();let finish!:(value:{verificationRequired:true})=>void;t.signUp=vi.fn(()=>new Promise<{verificationRequired:true}>(resolve=>{finish=resolve;}));
  const w=open(t);await flushPromises();await w.findAll('.auth-tabs button')[1].trigger('click');
  await w.get('#register-email').setValue('fixture@example.test');await w.get('#register-password').setValue('synthetic-password');await w.get('#register-confirmation').setValue('synthetic-password');
  await w.get('[data-test=registration-form]').trigger('submit');
  expect((w.get('#register-password').element as HTMLInputElement).value).toBe('');expect((w.get('#register-confirmation').element as HTMLInputElement).value).toBe('');
  expect(t.signUp).toHaveBeenCalledWith('fixture@example.test','synthetic-password');expect(t.call).not.toHaveBeenCalled();expect(w.get('[data-test=registration-form] button[type=submit]').attributes('disabled')).toBeDefined();
  finish({verificationRequired:true});await flushPromises();expect(w.text()).toContain('下一步，确认你的邮箱');expect(w.text()).not.toContain('本站不开放注册');expect(t.signIn).not.toHaveBeenCalled();expect(localStorage.length).toBe(0);
});
it('invalid or mismatched passwords never reach registration; upstream errors never expose secrets',async()=>{
  const t=transport(),w=mount(RegistrationForm,{props:{transport:t}});mounted.push(w);
  await w.get('#register-password').setValue('short');await w.get('#register-confirmation').setValue('different');await w.get('form').trigger('submit');expect(t.signUp).not.toHaveBeenCalled();
  await w.get('#register-email').setValue('fixture@example.test');await w.get('#register-password').setValue('synthetic-password');await w.get('#register-confirmation').setValue('synthetic-password');
  vi.mocked(t.signUp!).mockRejectedValue(Error('provider token=private'));await w.get('form').trigger('submit');await flushPromises();expect(w.text()).not.toContain('private');expect(w.text()).toContain('连接失败');expect((w.get('#register-password').element as HTMLInputElement).value).toBe('');
});
it('leaving registration discards the draft and ignores a later response',async()=>{
  const t=transport();let finish!:(value:{verificationRequired:true})=>void;t.signUp=vi.fn(()=>new Promise<{verificationRequired:true}>(resolve=>{finish=resolve;}));const w=open(t);await flushPromises();await w.findAll('.auth-tabs button')[1].trigger('click');
  await w.get('#register-email').setValue('fixture@example.test');await w.get('#register-password').setValue('synthetic-password');await w.get('#register-confirmation').setValue('synthetic-password');await w.get('[data-test=registration-form]').trigger('submit');
  await w.findAll('.auth-tabs button')[0].trigger('click');finish({verificationRequired:true});await flushPromises();expect(w.find('#register-password').exists()).toBe(false);expect(w.text()).not.toContain('下一步，确认你的邮箱');expect(w.html()).not.toContain('synthetic-password');
});
it('confirmation tokens are stripped from the URL and block workspace requests until verification succeeds',async()=>{
  history.replaceState(null,'','/#confirmation_token=synthetic-confirmation');const t=transport();let finish!:(value:typeof session)=>void;t.confirmEmail=vi.fn(()=>new Promise<typeof session>(resolve=>{finish=resolve;}));const w=open(t);await flushPromises();
  expect(location.hash).toBe('');expect(w.text()).not.toContain('synthetic-confirmation');expect(t.confirmEmail).toHaveBeenCalledWith('synthetic-confirmation');expect(t.restore).not.toHaveBeenCalled();expect(t.call).not.toHaveBeenCalled();
  vi.mocked(t.restore).mockResolvedValue(session);finish(session);await flushPromises();expect(t.call).toHaveBeenCalledWith('session.get',{});expect(w.text()).toContain('先选择你的学校');
});
it('invalid confirmation stops at a controlled message and returns to login without loading data',async()=>{
  history.replaceState(null,'','/#confirmation_token=expired-fixture');const t=transport();vi.mocked(t.confirmEmail!).mockRejectedValue(new ClientError('CONFIRMATION_FAILED','链接已失效，请返回登录。'));const w=open(t);await flushPromises();
  expect(w.text()).toContain('链接已失效');expect(t.call).not.toHaveBeenCalled();await w.get('.confirmation-panel button').trigger('click');expect(w.find('#password').exists()).toBe(true);expect(w.text()).not.toContain('expired-fixture');
});
it('a confirmation link arriving in the already-open login page is also consumed without a reload',async()=>{
  const t=transport(),w=open(t);await flushPromises();vi.mocked(t.restore).mockResolvedValue(session);
  history.replaceState(null,'','/#confirmation_token=same-page-fixture');window.dispatchEvent(new Event('hashchange'));await flushPromises();
  expect(t.confirmEmail).toHaveBeenCalledWith('same-page-fixture');expect(location.hash).toBe('');expect(w.text()).toContain('先选择你的学校');
});
it('theme switching stores only a visual preference and restores it for a subsequent page',async()=>{
  const w=open(transport());await flushPromises();const before=document.documentElement.dataset.theme;await w.get('.theme-toggle').trigger('click');expect(document.documentElement.dataset.theme).not.toBe(before);const chosen=document.documentElement.dataset.theme;expect(localStorage.getItem('campus-reader:theme')).toBe(chosen);expect(localStorage.length).toBe(1);w.unmount();
  open(transport());await flushPromises();expect(document.documentElement.dataset.theme).toBe(chosen);
});
