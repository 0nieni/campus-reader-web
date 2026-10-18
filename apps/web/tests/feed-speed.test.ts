import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {createPinia,setActivePinia} from 'pinia';
import {flushPromises,mount} from '@vue/test-utils';
import type {Notice,NoticePage,SchoolSync,WorkspaceSession} from '@campus/contracts';
import type {Transport} from '../src/lib/transport';
import {workspaceStore} from '../src/stores/workspace';
import {ClientError} from '../src/lib/errors';
import App from '../src/App.vue';
const a={id:'a',name:'甲大学',status:'ready' as const},b={id:'b',name:'乙大学',status:'ready' as const};
const auth={uid:'member-a',username:'member@example.test'};
const session:WorkspaceSession={identity:auth,school:a,legacyLinked:false,capabilities:{reading:true,ai:false,operations:false,schoolDirectory:true}};
const notice=(id='a'):Notice=>({id,title:`${id}公告`,sourceName:'学校公开来源',publishedAt:'2026-10-18T00:00:00Z',categories:['school'],summary:null});
const page=(id='a'):NoticePage=>({items:[notice(id)],nextCursor:null});
const ready:SchoolSync={state:'ready',count:1,checkedAt:'2026-10-18T00:00:00Z',message:'公开列表已检查',changed:false};
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};}
function fixture(){
 const call=vi.fn(async(action:string,input:any)=>{
  if(action==='session.get')return session;
  if(action==='school.list')return{schools:[a,b],nextCursor:null};
  if(action==='school.select')return{...session,school:input.schoolId==='a'?a:b};
  if(action==='feed.list')return page(input.schoolId);
  if(action==='school.refresh')return ready;
  if(action==='feed.detail')return{...notice(input.itemId),text:'已打开的公告正文',originalUrl:null,attachmentNote:'未读附件'};
  throw new Error('Unexpected action');
 });
 const transport:Transport={restore:vi.fn(async()=>auth),signIn:vi.fn(),signOut:vi.fn(),onSessionChange:vi.fn(()=>()=>{}),call:call as Transport['call']};
 return{transport,call,normal:call.getMockImplementation()!};
}
beforeEach(()=>setActivePinia(createPinia()));afterEach(()=>vi.restoreAllMocks());
it('keeps source beside tags, hides old free summaries and routes summarizing to AI without automatically calling a model',async()=>{
 const{transport,call,normal}=fixture();
 call.mockImplementation((action,input)=>action==='feed.list'?Promise.resolve({items:[{...notice(),summary:'旧免费摘要'}],nextCursor:null}):normal(action,input));
 const wrapper=mount(App,{props:{transport,configurationIssues:[]}});await flushPromises();
 expect(wrapper.find('.notice-origin').text()).toContain('学校公开来源');
 expect(wrapper.text()).not.toContain('旧免费摘要');
 expect(call.mock.calls.some(([action])=>action==='school.summarize'||action==='ai.start'||action==='ai.step')).toBe(false);
 wrapper.unmount();
});
it('renders saved notices while both the directory and source refresh are unresolved',async()=>{
 const{transport,call,normal}=fixture(),catalogue=deferred<any>(),source=deferred<SchoolSync>();
 call.mockImplementation((action,input)=>action==='school.list'?catalogue.promise:action==='school.refresh'?source.promise:normal(action,input));
 const wrapper=mount(App,{props:{transport,configurationIssues:[]}});await flushPromises();
 expect(wrapper.text()).toContain('a公告');expect(wrapper.text()).toContain('正在后台检查');
 expect(wrapper.find('.notice-scroll').attributes('aria-busy')).toBe('false');
 expect(wrapper.find('#school option[value="__request__"]').exists()).toBe(false);
 catalogue.resolve({schools:[a,b],nextCursor:null});source.resolve(ready);await flushPromises();
 expect(wrapper.find('#school option[value="__request__"]').exists()).toBe(true);wrapper.unmount();
});
it.each([true,false])('a first empty school receives collected notices regardless of response order (source first=%s)',async sourceFirst=>{
 const{transport,call,normal}=fixture(),source=deferred<SchoolSync>(),first=deferred<NoticePage>();let lists=0;
 call.mockImplementation((action,input)=>action==='school.refresh'?source.promise:action==='feed.list'?(++lists===1?first.promise:Promise.resolve(page('new'))):normal(action,input));
 const store=workspaceStore(transport)(),connected=store.connect();await flushPromises();
 if(sourceFirst){source.resolve({...ready,changed:true});await flushPromises();expect(lists).toBe(1);first.resolve({items:[],nextCursor:null});}
 else{first.resolve({items:[],nextCursor:null});await connected;expect(store.refreshingSchool).toBe(true);source.resolve({...ready,changed:true});}
 await connected;await flushPromises();expect(store.items[0]?.id).toBe('new');expect(store.pendingUpdates).toBe(false);expect(lists).toBe(2);
});
it('source updates do not replace a reading list or open article until the visitor accepts',async()=>{
 const{transport,call,normal}=fixture(),source=deferred<SchoolSync>();let updated=false;
 call.mockImplementation((action,input)=>action==='school.refresh'?source.promise:action==='feed.list'&&updated?Promise.resolve(page('new')):normal(action,input));
 const store=workspaceStore(transport)();await store.connect();await store.openNotice('a');updated=true;source.resolve({...ready,changed:true});await flushPromises();
 expect(store.items[0]?.id).toBe('a');expect(store.detail?.id).toBe('a');expect(store.pendingUpdates).toBe(true);
 const calls=call.mock.calls.length;await store.loadFeed(true);expect(call.mock.calls.length).toBe(calls);
 await store.applyUpdates();expect(store.items[0]?.id).toBe('new');expect(store.detail?.id).toBe('a');expect(store.pendingUpdates).toBe(false);
});
it('switching back restores cached pages immediately and revalidation does not collapse pagination',async()=>{
 const{transport,call,normal}=fixture(),revalidate=deferred<NoticePage>();const first=Array.from({length:20},(_,i)=>notice(`a${i}`));let mode='initial';
 call.mockImplementation((action,input)=>{
  if(action==='feed.list'&&input.schoolId==='a')return mode==='revalidate'?revalidate.promise:Promise.resolve(input.cursor?{items:[notice('a20')],nextCursor:'40'}:{items:first,nextCursor:'20'});
  return normal(action,input);
 });
 const store=workspaceStore(transport)();await store.connect();await flushPromises();await store.loadFeed(true);expect(store.items).toHaveLength(21);
 await store.selectSchool('b');mode='revalidate';const switching=store.selectSchool('a');await flushPromises();
 expect(store.items).toHaveLength(21);expect(store.nextCursor).toBe('40');expect(store.loading).toBe(true);
 revalidate.resolve({items:first,nextCursor:'20'});await switching;await flushPromises();expect(store.items).toHaveLength(21);expect(store.nextCursor).toBe('40');expect(store.pendingUpdates).toBe(false);
 expect(localStorage.length).toBe(0);expect(sessionStorage.length).toBe(0);
});
it('expired memory pages and a signed-out account cannot restore cached notices',async()=>{
 let now=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>now);
 const{transport,call,normal}=fixture(),later=deferred<NoticePage>();let wait=false;
 call.mockImplementation((action,input)=>action==='feed.list'&&input.schoolId==='a'&&wait?later.promise:normal(action,input));
 const store=workspaceStore(transport)();await store.connect();await flushPromises();await store.selectSchool('b');now+=5*60000+1;wait=true;
 const switching=store.selectSchool('a');await flushPromises();expect(store.items).toEqual([]);
 later.resolve(page());await switching;await store.signOut();expect(store.items).toEqual([]);expect(store.workspace).toBeNull();
 const next=deferred<NoticePage>();call.mockImplementation((action,input)=>action==='feed.list'?next.promise:normal(action,input));const reconnecting=store.connect();await flushPromises();expect(store.items).toEqual([]);next.resolve(page());await reconnecting;
});
it('late source responses cannot revive state after logout, while catalogue loading survives filter changes',async()=>{
 const{transport,call,normal}=fixture(),source=deferred<SchoolSync>(),catalogue=deferred<any>();
 call.mockImplementation((action,input)=>action==='school.refresh'?source.promise:action==='school.list'?catalogue.promise:normal(action,input));
 const store=workspaceStore(transport)(),connected=store.connect();await flushPromises();await store.applyFilters({categories:[]});
 catalogue.resolve({schools:[a,b],nextCursor:null});await connected;expect(store.catalogueReady).toBe(true);expect(store.schools).toHaveLength(2);
 await store.signOut();source.resolve({...ready,changed:true});await flushPromises();expect(store.pendingUpdates).toBe(false);expect(store.schoolSync).toBeNull();expect(store.items).toEqual([]);
});
it('a source authentication failure clears the visible list and memory cache',async()=>{
 const{transport,call,normal}=fixture(),source=deferred<SchoolSync>();
 call.mockImplementation((action,input)=>action==='school.refresh'?source.promise:normal(action,input));
 const store=workspaceStore(transport)();await store.connect();expect(store.items).toHaveLength(1);
 // The promise rejection is handled by the background check, never unhandled.
 source.resolve(ready);await flushPromises();call.mockImplementation((action,input)=>action==='school.refresh'?Promise.reject(new ClientError('UNAUTHENTICATED','会话已失效')):normal(action,input));
 await store.refreshSchool();await flushPromises();expect(store.auth).toBeNull();expect(store.items).toEqual([]);
});
it('personal label changes invalidate saved filter variants before returning to a school',async()=>{
 const{transport,call,normal}=fixture();let edited=false,wait=false;const later=deferred<NoticePage>();
 call.mockImplementation((action,input)=>{
  if(action==='feed.list'&&input.schoolId==='a')return wait?later.promise:Promise.resolve({items:[{...notice(),categories:edited?['academic']:['school']}],nextCursor:null});
  return normal(action,input);
 });
 const store=workspaceStore(transport)();await store.connect();await flushPromises();await store.applyFilters({categories:['school']});
 await store.applyFilters({});edited=true;await store.noticeLabelsChanged({itemId:'a',schoolId:'a',categories:['academic'],customized:true});
 await store.selectSchool('b');await store.applyFilters({categories:['school']});wait=true;
 const switching=store.selectSchool('a');await flushPromises();expect(store.items).toEqual([]);
 later.resolve({items:[],nextCursor:null});await switching;await flushPromises();
});
it('a new account cannot see a prior account cache while its own first page is pending',async()=>{
 const{transport,call,normal}=fixture(),later=deferred<NoticePage>();let changed=false;
 call.mockImplementation((action,input)=>changed&&action==='session.get'?Promise.resolve({...session,identity:{uid:'member-b',username:null}}):changed&&action==='feed.list'?later.promise:normal(action,input));
 const store=workspaceStore(transport)();await store.connect();await flushPromises();await store.signOut();changed=true;
 vi.mocked(transport.restore).mockResolvedValue({uid:'member-b',username:null});
 const next=store.connect();await flushPromises();expect(store.auth?.uid).toBe('member-b');expect(store.items).toEqual([]);
 later.resolve(page('member-b-notice'));await next;await flushPromises();expect(store.items[0]?.id).toBe('member-b-notice');
});
