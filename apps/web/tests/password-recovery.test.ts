import {afterEach,expect,it,vi} from 'vitest';
import {mount,flushPromises} from '@vue/test-utils';
import {createPinia} from 'pinia';
import App from '../src/App.vue';
import AccountSettingsDialog from '../src/components/AccountSettingsDialog.vue';
import PasswordRecoveryPanel from '../src/components/PasswordRecoveryPanel.vue';
import type {Transport} from '../src/lib/transport';
const user={uid:'synthetic-member',username:'member@example.test'};
const mounted:ReturnType<typeof mount>[]=[];
function transport():Transport{return{restore:vi.fn(async()=>user),signIn:vi.fn(),signOut:vi.fn(),onSessionChange:vi.fn(()=>()=>{}),requestPasswordRecovery:vi.fn(async()=>{}),recoverPassword:vi.fn(async()=>user),call:vi.fn(async action=>{if(action==='session.get')return{identity:user,school:null,capabilities:{reading:true,ai:true}};if(action==='school.list')return{schools:[],nextCursor:null};throw Error('Unexpected '+action);}) as Transport['call']};}
afterEach(()=>{mounted.splice(0).forEach(w=>w.unmount());vi.useRealTimers();history.replaceState(null,'','/');});
it('current-account reset mail cannot be repeated while pending or during the cooldown',async()=>{
 const t=transport();let finish!:()=>void;t.requestPasswordRecovery=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));const w=mount(AccountSettingsDialog,{props:{transport:t,username:user.username}});mounted.push(w);
 expect(w.text()).toContain(user.username);await w.get('.account-section button').trigger('click');await w.get('.account-section button').trigger('click');expect(t.requestPasswordRecovery).toHaveBeenCalledTimes(1);expect(t.requestPasswordRecovery).toHaveBeenCalledWith();
 finish();await flushPromises();expect(w.get('.account-section button').attributes('disabled')).toBeDefined();expect(w.text()).toContain('查看收件箱');expect(t.call).not.toHaveBeenCalled();
});
it('recovery links are removed from the URL and block workspace reads until the new password is saved',async()=>{
 history.replaceState(null,'','/#recovery_token=synthetic-recovery');const t=transport();let finish!:(value:typeof user)=>void;t.recoverPassword=vi.fn(()=>new Promise<typeof user>(resolve=>{finish=resolve;}));const w=mount(App,{props:{transport:t,configurationIssues:[]},global:{plugins:[createPinia()]}});mounted.push(w);await flushPromises();
 expect(location.hash).toBe('');expect(w.html()).not.toContain('synthetic-recovery');expect(t.restore).not.toHaveBeenCalled();expect(t.call).not.toHaveBeenCalled();
 await w.get('#recovery-password').setValue('synthetic-password');await w.get('#recovery-confirm').setValue('synthetic-password');await w.get('.recovery-panel form').trigger('submit');expect((w.get('#recovery-password').element as HTMLInputElement).value).toBe('');expect((w.get('#recovery-confirm').element as HTMLInputElement).value).toBe('');expect(t.call).not.toHaveBeenCalled();
 finish(user);await flushPromises();expect(t.call).toHaveBeenCalledWith('session.get',{});expect(w.find('.portal-template').exists()).toBe(true);
});
it('a same-page recovery link clears an existing workspace before showing the reset form',async()=>{
 const t=transport(),w=mount(App,{props:{transport:t,configurationIssues:[]},global:{plugins:[createPinia()]}});mounted.push(w);await flushPromises();expect(w.find('.portal-template').exists()).toBe(true);vi.mocked(t.call).mockClear();
 history.replaceState(null,'','/#recovery_token=same-page-fixture');window.dispatchEvent(new Event('hashchange'));await flushPromises();expect(location.hash).toBe('');expect(w.find('.portal-template').exists()).toBe(false);expect(w.find('#recovery-password').exists()).toBe(true);expect(t.call).not.toHaveBeenCalled();
});
it('invalid or mismatched new passwords never reach Identity, and leaving discards delayed results',async()=>{
 const t=transport(),w=mount(PasswordRecoveryPanel,{props:{transport:t,token:'fixture'}});mounted.push(w);
 await w.get('#recovery-password').setValue('short');await w.get('#recovery-confirm').setValue('different');await w.get('form').trigger('submit');expect(t.recoverPassword).not.toHaveBeenCalled();
 let finish!:(value:typeof user)=>void;t.recoverPassword=vi.fn(()=>new Promise<typeof user>(resolve=>{finish=resolve;}));await w.get('#recovery-password').setValue('synthetic-password');await w.get('#recovery-confirm').setValue('synthetic-password');await w.get('form').trigger('submit');w.unmount();finish(user);await flushPromises();expect(w.emitted('complete')).toBeUndefined();
});
