import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {mount,flushPromises} from '@vue/test-utils';
import {createPinia,setActivePinia} from 'pinia';
import type {AuthSession,WorkspaceSession,AnonymousState,AnonymousImport} from '@campus/contracts';
import type {Transport} from '../src/lib/transport';
import {workspaceStore} from '../src/stores/workspace';
import {ClientError} from '../src/lib/errors';
import AnonymousIdentityPanel from '../src/components/AnonymousIdentityPanel.vue';
import ReminderEmailSettings from '../src/components/ReminderEmailSettings.vue';
import App from '../src/App.vue';
const guest:AuthSession={uid:'guest_'+'a'.repeat(32),username:'匿名访客',kind:'guest',account:null};
const account:AuthSession={uid:'synthetic-account',username:'member@example.test'};
const school={id:'bjtu',name:'合成学校',status:'ready' as const};
const imported:AnonymousImport={schoolId:'bjtu',bookmarks:2,tags:1,sources:3,reminders:1,skipped:0,emailReverificationRequired:true,pushReauthorizationRequired:true};
function fixture(){
 let listener:(session:AuthSession|null)=>void=()=>{};
 const state:AnonymousState={id:'a'.repeat(32),identity:guest,transferExpiresAt:null};
 const session:WorkspaceSession={identity:{...guest},school,legacyLinked:false,capabilities:{reading:true,ai:false,operations:false}};
 const item={id:'notice',title:'合成公告',sourceName:'合成来源',publishedAt:new Date().toISOString(),categories:['school'],summary:null,excerpt:'合成正文'};
 const transport:Transport={anonymous:{state:vi.fn(async()=>state),createTransfer:vi.fn(async()=>({code:'CR-'+'x'.repeat(43),expiresAt:new Date(Date.now()+1800000).toISOString()})),cancelTransfer:vi.fn(async()=>{}),importTransfer:vi.fn(async()=>imported)},
  restore:vi.fn(async()=>({...guest})),signIn:vi.fn(async()=>{listener(account);return account;}),signOut:vi.fn(async()=>{listener(null);}),onSessionChange:callback=>{listener=callback;return()=>{};},
  call:vi.fn(async action=>{if(action==='session.get')return structuredClone(session);if(action==='school.list')return{schools:[school],nextCursor:null};if(action==='feed.list')return{items:[item],nextCursor:null};throw new Error('unexpected action '+action);}) as Transport['call']};
 return{transport,emit:(value:AuthSession|null)=>listener(value)};
}
beforeEach(()=>{setActivePinia(createPinia());history.replaceState(null,'','/');});
afterEach(()=>{vi.unstubAllGlobals();});
it('AI sign-in and sign-out preserve guest reading data, filters, selection and identity',async()=>{
 const {transport,emit}=fixture(),store=workspaceStore(transport)(),stop=store.watchSession();await store.connect();await store.applyFilters({keyword:'合成'});
 const before=store.items[0],uid=store.auth!.uid;await store.signIn('member@example.test','synthetic-password');
 expect(store.auth).toMatchObject({uid,kind:'guest',account});expect(store.workspace!.capabilities.ai).toBe(true);expect(store.items[0]).toBe(before);expect(store.filters.keyword).toBe('合成');
 expect(transport.restore).toHaveBeenCalledTimes(1);expect(vi.mocked(transport.call).mock.calls.filter(([a])=>a==='session.get')).toHaveLength(1);
 emit({uid:'another-account',username:'another@example.test'});expect(store.auth!.account!.uid).toBe('another-account');expect(store.items[0]).toBe(before);
 await store.signOut();expect(store.auth).toMatchObject({uid,kind:'guest',account:null});expect(store.workspace!.school).toEqual(school);expect(store.workspace!.capabilities.ai).toBe(false);expect(store.items[0]).toBe(before);stop();
});
it('legacy account restoration preserves the trusted login email when gateway metadata omits it',async()=>{
 const {transport}=fixture(),original=vi.mocked(transport.call).getMockImplementation()!;
 vi.mocked(transport.restore).mockResolvedValue(account);vi.mocked(transport.call).mockImplementation((async(action,input)=>action==='session.get'?{identity:{uid:account.uid,username:null},school:null,legacyLinked:false,capabilities:{reading:true,ai:true,operations:false}}:original(action,input)) as Transport['call']);
 const store=workspaceStore(transport)();await store.connect();expect(store.auth!.username).toBe(account.username);
});
it('a guest AI login does not discard a reading request already in progress',async()=>{
 const {transport}=fixture(),store=workspaceStore(transport)();await store.connect();let finish!:(value:any)=>void;
 const original=vi.mocked(transport.call).getMockImplementation()!;
 vi.mocked(transport.call).mockImplementation((async(action,input)=>action==='feed.list'?new Promise(resolve=>{finish=resolve;}):original(action,input)) as Transport['call']);
 const reading=store.applyFilters({keyword:'pending'});await store.signIn(account.username!,'synthetic-password');finish({items:[{id:'later',title:'合成新公告',sourceName:'合成来源',publishedAt:null,categories:['school'],summary:null}],nextCursor:null});await reading;expect(store.items[0]!.id).toBe('later');expect(store.auth!.kind).toBe('guest');
});
it('a same-page confirmation opened from AI login returns to AI in the anonymous workspace',async()=>{
 const {transport}=fixture(),original=vi.mocked(transport.call).getMockImplementation()!;let confirmed=false;
 transport.confirmEmail=vi.fn(async()=>{confirmed=true;return account;});vi.mocked(transport.restore).mockImplementation(async()=>({...guest,account:confirmed?account:null}));
 vi.mocked(transport.call).mockImplementation((async(action,input)=>action==='session.get'?{identity:{...guest,account:confirmed?account:null},school,legacyLinked:false,capabilities:{reading:true,ai:confirmed,operations:false}}:original(action,input)) as Transport['call']);
 const wrapper=mount(App,{props:{transport,configurationIssues:[]},global:{plugins:[createPinia()],stubs:{AssistantPanel:{template:'<section class="synthetic-ai">AI已打开</section>'}}}});
 await flushPromises();await wrapper.findAll('button.nav-link').find(b=>b.text().includes('AI 阅读'))!.trigger('click');history.replaceState(null,'','/#confirmation_token=synthetic-confirmation');window.dispatchEvent(new Event('hashchange'));await flushPromises();expect(wrapper.find('.login-template').exists()).toBe(false);expect(wrapper.find('.synthetic-ai').exists()).toBe(true);expect(location.hash).toBe('');wrapper.unmount();
});
it('anonymous browsing opens immediately and AI login returns to the chosen notices',async()=>{
 const {transport}=fixture(),pinia=createPinia();
 const wrapper=mount(App,{props:{transport,configurationIssues:[]},global:{plugins:[pinia],stubs:{AssistantPanel:{props:['selection'],template:'<section class="synthetic-ai">已选 {{selection.length}} 篇</section>'}}}});
 await flushPromises();expect(wrapper.find('.portal-template').exists()).toBe(true);expect(wrapper.find('.login-template').exists()).toBe(false);
 await wrapper.findAll('button').find(b=>b.text()==='加入ai搭子')!.trigger('click');
 await wrapper.findAll('button.nav-link').find(b=>b.text().includes('AI 阅读'))!.trigger('click');await flushPromises();expect(wrapper.find('.login-template').exists()).toBe(true);expect(wrapper.text()).toContain('返回匿名浏览');
 expect(vi.mocked(transport.call).mock.calls.some(([a])=>a.startsWith('ai.'))).toBe(false);
 await wrapper.get('#username').setValue('member@example.test');await wrapper.get('#password').setValue('synthetic-password');await wrapper.get('form').trigger('submit');await flushPromises();
 expect(wrapper.find('.login-template').exists()).toBe(false);expect(wrapper.get('.synthetic-ai').text()).toContain('已选 1 篇');
 await wrapper.findAll('button.nav-link').find(b=>b.text()==='退出登录')!.trigger('click');await flushPromises();expect(wrapper.find('.portal-template').exists()).toBe(true);expect(wrapper.text()).toContain('合成公告');wrapper.unmount();
});
it('transfer UI generates and explicitly copies a short-lived code, revokes it and never saves it in browser storage',async()=>{
 const {transport}=fixture(),writeText=vi.fn(async()=>{});vi.stubGlobal('navigator',{clipboard:{writeText}});
 const wrapper=mount(AnonymousIdentityPanel,{props:{transport}});await flushPromises();expect(wrapper.text()).toContain('a'.repeat(32));
 await wrapper.findAll('button').find(b=>b.text()==='生成一次性迁移码')!.trigger('click');await flushPromises();
 expect(wrapper.get('#anonymous-export').element).toHaveProperty('value','CR-'+'x'.repeat(43));
 await wrapper.findAll('button').find(b=>b.text()==='复制迁移码')!.trigger('click');await flushPromises();expect(writeText).toHaveBeenCalledWith('CR-'+'x'.repeat(43));
 expect(JSON.stringify({...localStorage})).not.toContain('CR-');expect(JSON.stringify({...sessionStorage})).not.toContain('CR-');
 await wrapper.findAll('button').find(b=>b.text()==='撤销迁移码')!.trigger('click');await flushPromises();expect(transport.anonymous!.cancelTransfer).toHaveBeenCalledTimes(1);expect(wrapper.find('#anonymous-export').exists()).toBe(false);wrapper.unmount();
});
it('transfer import stays pending once, surfaces invalid codes and clears code after success',async()=>{
 const {transport}=fixture();let reject!:(error:unknown)=>void;
 vi.mocked(transport.anonymous!.importTransfer).mockImplementationOnce(()=>new Promise((_resolve,no)=>{reject=no;}));
 const wrapper=mount(AnonymousIdentityPanel,{props:{transport}});await flushPromises();await wrapper.get('#anonymous-import').setValue('CR-fixture');await wrapper.get('form').trigger('submit');await wrapper.get('form').trigger('submit');expect(transport.anonymous!.importTransfer).toHaveBeenCalledTimes(1);
 reject(new ClientError('TRANSFER_INVALID','迁移码已过期'));await flushPromises();expect(wrapper.get('[role="alert"]').text()).toBe('迁移码已过期');expect(wrapper.emitted('imported')).toBeUndefined();
 await wrapper.get('form').trigger('submit');await flushPromises();expect(wrapper.emitted('imported')?.[0]).toEqual([imported]);expect(wrapper.get('#anonymous-import').element).toHaveProperty('value','');wrapper.unmount();
});
it('guest mail settings save a typed address before explicit verification and never enable mail automatically',async()=>{
 const {transport}=fixture(),state={identityKind:'guest' as const,configured:true,address:null,verified:false,enabled:false,suspended:false,usedToday:0,dailyLimit:20};
 vi.mocked(transport.call).mockResolvedValue({...state,address:'ty***@example.test'} as never);
 const wrapper=mount(ReminderEmailSettings,{props:{transport,state}});await wrapper.get('input[type="email"]').setValue('typed@example.test');await wrapper.get('form').trigger('submit');await flushPromises();
 expect(transport.call).toHaveBeenCalledWith('reminders.email.bind',{email:'typed@example.test'});expect(transport.call).toHaveBeenCalledTimes(1);expect(wrapper.emitted('changed')?.[0]?.[0]).toMatchObject({enabled:false,verified:false});expect(wrapper.text()).toContain('验证当前邮箱');wrapper.unmount();
});
it('the first-school action opens the school tab directly inside the anonymous workspace',async()=>{
 const {transport}=fixture(),original=vi.mocked(transport.call).getMockImplementation()!;
 vi.mocked(transport.call).mockImplementation((async(action,input)=>action==='session.get'?{identity:guest,school:null,legacyLinked:false,capabilities:{reading:true,ai:false,operations:false}}:original(action,input)) as Transport['call']);
 const wrapper=mount(App,{props:{transport,configurationIssues:[]},global:{plugins:[createPinia()],stubs:{AccountSettingsDialog:{props:['initialTab'],template:'<section class="synthetic-settings">{{initialTab}}</section>'}}}});
 await flushPromises();await wrapper.findAll('button').find(b=>b.text()==='打开个人工作区选择学校')!.trigger('click');await flushPromises();expect(wrapper.get('.synthetic-settings').text()).toBe('school');wrapper.unmount();
});
