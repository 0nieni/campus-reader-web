import {expect,it,vi} from 'vitest';
import {flushPromises,mount} from '@vue/test-utils';
import WebsiteSourcesPanel from '../src/components/WebsiteSourcesPanel.vue';
import type {Transport} from '../src/lib/transport';
import App from '../src/App.vue';
import {createPinia} from 'pinia';
import {workspaceStore} from '../src/stores/workspace';
vi.mock('../src/lib/site-transport',()=>({siteTransport:{},setupIssues:[],regionNeedsVerification:false,isNetlify:true}));

const schools=[{id:'bjtu',name:'北京交通大学',status:'ready',homepage:'https://bjtu.edu.cn/'},{id:'other',name:'另一所大学',status:'candidate',homepage:'https://other.example.edu.cn/'}];
function catalogue(id:string){return{school:schools.find(s=>s.id===id),coverage:'仅覆盖公开教学通知',sources:[{id:'public_'+id,name:id==='bjtu'?'本校教务通知':'外校教务通知',url:'https://notice.example.edu.cn/',state:'unchecked',checkedAt:null,count:null,message:'尚未检查'}]};}
function fixture(extra?:(action:string,input:any)=>unknown){
 const call=vi.fn(async(action:string,input:any)=>{
  const result=extra?.(action,input);if(result!==undefined)return result;
  if(action==='school.list')return{schools,nextCursor:null};
  if(action==='school.sources')return catalogue(input.schoolId);
  if(action==='sources.displayState')return{total:1,shown:1,hidden:0};
  if(action==='sources.list')return{sources:[]};
  throw new Error('Unexpected action '+action);
 });
 return{call,transport:{call} as unknown as Transport};
}
const button=(wrapper:any,label:string)=>wrapper.findAll('button').find((b:any)=>b.text()===label)!;
it('browses schools without selecting or collecting, then explicitly requests a school switch',async()=>{
 const {call,transport}=fixture();const open=vi.fn(async()=>{});
 const wrapper=mount(WebsiteSourcesPanel,{props:{transport,schoolId:'bjtu',schoolName:'北京交通大学',openSchool:open}});await flushPromises();
 expect(wrapper.text()).toContain('本校教务通知');expect(wrapper.text()).toContain('尚未检查');
 await wrapper.get('input[aria-label="搜索学校"]').setValue('另一所');
 expect(wrapper.findAll('.school-choice')).toHaveLength(1);
 await button(wrapper,'另一所大学').trigger('click');await flushPromises();
 expect(wrapper.text()).toContain('外校教务通知');expect(wrapper.text()).toContain('当前阅读学校：北京交通大学');
 expect(call.mock.calls.some(([a])=>['school.select','school.refresh','sources.refresh'].includes(a)||a.startsWith('ai.'))).toBe(false);
 await button(wrapper,'切换到该校并查看公告').trigger('click');await flushPromises();expect(open).toHaveBeenCalledExactlyOnceWith('other');wrapper.unmount();
});
it('discards a late school result and keeps the latest browsed school',async()=>{
 let resolve!:(v:unknown)=>void;const late=new Promise(r=>resolve=r);let calls=0;
 const {transport}=fixture((a,i)=>a==='school.sources'&&i.schoolId==='bjtu'&&++calls===1?late:undefined);
 const wrapper=mount(WebsiteSourcesPanel,{props:{transport,schoolId:'bjtu',schoolName:'北京交通大学'}});await flushPromises();
 await button(wrapper,'另一所大学').trigger('click');await flushPromises();resolve(catalogue('bjtu'));await flushPromises();
 expect(wrapper.text()).toContain('外校教务通知');expect(wrapper.text()).not.toContain('本校教务通知');wrapper.unmount();
});
it('shows switch failure without changing the reading school and prevents repeated submission',async()=>{
 let reject!:(v:Error)=>void;const pending=new Promise<void>((_,r)=>reject=r);const open=vi.fn(()=>pending);
 const {transport}=fixture();const wrapper=mount(WebsiteSourcesPanel,{props:{transport,schoolId:'bjtu',schoolName:'北京交通大学',openSchool:open}});await flushPromises();
 await button(wrapper,'另一所大学').trigger('click');await flushPromises();
 const action=button(wrapper,'切换到该校并查看公告');await action.trigger('click');await action.trigger('click');expect(open).toHaveBeenCalledTimes(1);
 reject(new Error('切换失败'));await flushPromises();expect(wrapper.find('[role=alert]').exists()).toBe(true);expect(wrapper.text()).toContain('当前阅读学校：北京交通大学');wrapper.unmount();
});
it('refreshes only the reading school and reloads the saved source status',async()=>{
 let refreshed=false;const {transport,call}=fixture(a=>{if(a==='school.refresh'){refreshed=true;return{state:'ready',count:2,checkedAt:'2026-10-24T00:00:00Z',message:'已更新'};}if(a==='school.sources'&&refreshed){const data=catalogue('bjtu');data.sources[0]={...data.sources[0],state:'ready',message:'列表可读'};return data;}});
 const wrapper=mount(WebsiteSourcesPanel,{props:{transport,schoolId:'bjtu',schoolName:'北京交通大学'}});await flushPromises();
 await button(wrapper,'刷新本校公告').trigger('click');await flushPromises();expect(wrapper.text()).toContain('最近读取成功');expect(wrapper.emitted('changed')).toHaveLength(1);
 expect(call).toHaveBeenCalledWith('school.refresh',{schoolId:'bjtu'});wrapper.unmount();
});
it('filters personal sources and exposes their AI permission and last successful collection',async()=>{
 const {transport}=fixture(a=>a==='sources.list'?{sources:[{id:'one',name:'学院通知',enabled:true,type:'rss',entryUrl:'https://one.example.edu.cn/',categories:['college'],intervalMinutes:60,selectors:{},allowAi:false,authorized:true,lastSuccessAt:'2026-10-23T12:00:00Z',count:3,message:'已采集'},{id:'two',name:'竞赛通知',enabled:false,type:'html_list',entryUrl:'https://two.example.edu.cn/',categories:['competition'],intervalMinutes:60,selectors:{},allowAi:true,authorized:true,lastSuccessAt:null,count:0,message:'未采集'}]}:undefined);
 const wrapper=mount(WebsiteSourcesPanel,{props:{transport,schoolId:'bjtu',schoolName:'北京交通大学'}});await flushPromises();await button(wrapper,'我的来源').trigger('click');await flushPromises();
 const personal=wrapper.get('section[aria-label="个人来源管理"]');
 expect(personal.findAll('.source-card')).toHaveLength(2);expect(personal.text()).toContain('不允许 AI 阅读');expect(personal.text()).toContain('2026/10/23');
 await wrapper.get('input[aria-label="搜索个人来源"]').setValue('竞赛');expect(personal.findAll('.source-card')).toHaveLength(1);
 await wrapper.get('select[aria-label="来源启用状态"]').setValue('enabled');expect(personal.findAll('.source-card')).toHaveLength(0);wrapper.unmount();
});
it('loads every school page and offers the homepage when a school has no sources',async()=>{
 const {transport,call}=fixture((a,i)=>{
  if(a==='school.list')return i.cursor?{schools:[schools[1]],nextCursor:null}:{schools:[schools[0]],nextCursor:'50'};
  if(a==='school.sources'&&i.schoolId==='other')return{...catalogue('other'),sources:[]};
 });
 const wrapper=mount(WebsiteSourcesPanel,{props:{transport,schoolId:'bjtu',schoolName:'北京交通大学'}});await flushPromises();
 await button(wrapper,'另一所大学').trigger('click');await flushPromises();
 expect(wrapper.text()).toContain('该校尚未配置公告来源');expect(wrapper.find('a[href="https://other.example.edu.cn/"]').exists()).toBe(true);
 expect(wrapper.findAll('.school-source-card')).toHaveLength(0);expect(call).toHaveBeenCalledWith('school.list',{cursor:'50'});wrapper.unmount();
});
it('retries a failed catalogue request without refreshing websites or falsely showing success',async()=>{
 let broken=true;const {transport,call}=fixture(a=>{if(a==='school.sources'&&broken)return Promise.reject(new Error('不可用'));});
 const wrapper=mount(WebsiteSourcesPanel,{props:{transport,schoolId:'bjtu',schoolName:'北京交通大学'}});await flushPromises();
 expect(wrapper.find('[role=alert]').exists()).toBe(true);expect(wrapper.findAll('.school-source-card')).toHaveLength(0);
 broken=false;await button(wrapper,'重试来源目录').trigger('click');await flushPromises();expect(wrapper.text()).toContain('本校教务通知');expect(call.mock.calls.some(([a])=>a==='school.refresh')).toBe(false);wrapper.unmount();
});
it('edits, toggles and confirms removal of personal sources while keeping the school catalogue read-only',async()=>{
 let source:any={id:'mine',name:'个人通知',enabled:true,type:'rss',entryUrl:'https://mine.example.edu.cn/',categories:['college'],intervalMinutes:60,selectors:{},allowAi:false,authorized:true,lastSuccessAt:null,count:0,message:'未采集'};
 const {transport,call}=fixture((a,i)=>{
  if(a==='sources.list')return{sources:source?[source]:[]};
  if(a==='sources.save'){source={...source,...i.source};return{id:'mine'};}
  if(a==='sources.toggle'){source.enabled=i.enabled;return{enabled:i.enabled};}
  if(a==='sources.remove'){source=null;return{removed:true};}
 });
 const wrapper=mount(WebsiteSourcesPanel,{props:{transport,schoolId:'bjtu',schoolName:'北京交通大学'}});await flushPromises();
 expect(button(wrapper,'编辑')).toBeUndefined();await button(wrapper,'我的来源').trigger('click');await flushPromises();
 await button(wrapper,'编辑').trigger('click');expect(wrapper.get('input[type=url]').attributes('readonly')).toBeDefined();
 await wrapper.get('input[placeholder="例如：某学院通知公告"]').setValue('更新后的个人通知');await wrapper.get('form').trigger('submit.prevent');await flushPromises();expect(wrapper.text()).toContain('更新后的个人通知');
 await button(wrapper,'停用').trigger('click');await flushPromises();expect(button(wrapper,'立即采集').attributes('disabled')).toBeDefined();
 await button(wrapper,'启用').trigger('click');await flushPromises();expect(button(wrapper,'立即采集').attributes('disabled')).toBeUndefined();
 await button(wrapper,'移除').trigger('click');expect(call.mock.calls.some(([a])=>a==='sources.remove')).toBe(false);
 await button(wrapper,'确认移除').trigger('click');await flushPromises();expect(wrapper.text()).toContain('还没有添加网站来源');wrapper.unmount();
});
it('keeps collection completion and draft state when switching source tabs during a request',async()=>{
 let resolve!:(v:unknown)=>void;const pending=new Promise(r=>resolve=r);
 const source={id:'mine',name:'个人通知',enabled:true,type:'rss',entryUrl:'https://mine.example.edu.cn/',categories:['school'],intervalMinutes:60,selectors:{},allowAi:true,authorized:true,lastSuccessAt:null,count:0,message:'尚未采集'};
 const {transport}=fixture(a=>a==='sources.list'?{sources:[source]}:a==='sources.refresh'?pending:undefined);
 const wrapper=mount(WebsiteSourcesPanel,{props:{transport,schoolId:'bjtu',schoolName:'北京交通大学'}});await flushPromises();
 await button(wrapper,'我的来源').trigger('click');await flushPromises();await button(wrapper,'立即采集').trigger('click');await button(wrapper,'学校来源').trigger('click');
 resolve({count:1,message:'采集完成'});await flushPromises();expect(wrapper.emitted('changed')).toHaveLength(1);
 await button(wrapper,'我的来源').trigger('click');await flushPromises();expect(wrapper.text()).toContain('采集完成');wrapper.unmount();
});
it.each([false,true])('App keeps browsing separate from school selection; selection failure=%s',async(fail)=>{
 let current=schools[0];let selectCount=0;
 const {transport,call}=fixture((a,i)=>{
  if(a==='session.get')return{identity:{uid:'source-test',username:null},school:current,legacyLinked:false,capabilities:{reading:true,ai:false,operations:false,websiteSources:true}};
  if(a==='feed.list')return{items:[{id:'notice-'+i.schoolId,title:'本地验收公告 '+i.schoolId,sourceName:'测试来源',publishedAt:null,categories:['school'],summary:null}],nextCursor:null};
  if(a==='school.select'){selectCount++;if(fail)return Promise.reject(new Error('暂时无法切校'));current=schools[1];return{identity:{uid:'source-test',username:null},school:current,legacyLinked:false,capabilities:{reading:true,ai:false,operations:false,websiteSources:true}};}
 });
 Object.assign(transport,{restore:async()=>({uid:'source-test',username:null}),onSessionChange:()=>()=>{}});
 const wrapper=mount(App,{props:{transport,configurationIssues:[]},global:{plugins:[createPinia()]}});await flushPromises();
 await wrapper.findAll('.nav-item').find(b=>b.text().includes('公告来源'))!.trigger('click');await vi.waitFor(()=>expect(wrapper.find('input[aria-label="搜索学校"]').exists()).toBe(true));await flushPromises();
 await button(wrapper,'另一所大学').trigger('click');await flushPromises();expect(selectCount).toBe(0);expect(wrapper.text()).toContain('当前阅读学校：北京交通大学');
 await button(wrapper,'切换到该校并查看公告').trigger('click');await flushPromises();expect(selectCount).toBe(1);
 if(fail){expect(wrapper.text()).toContain('当前阅读学校：北京交通大学');expect(wrapper.find('.website-sources [role=alert]').exists()).toBe(true);}
 else{expect(wrapper.find('.website-sources').exists()).toBe(false);expect(wrapper.text()).toContain('本地验收公告 other');}
 expect(call.mock.calls.some(([a])=>a.startsWith('ai.'))).toBe(false);wrapper.unmount();
});
it('does not navigate back to feed when a slow school switch finishes after the visitor leaves sources',async()=>{
 let release!:(v:unknown)=>void;const pending=new Promise(r=>release=r);let current=schools[0];
 const session=()=>({identity:{uid:'source-test',username:null},school:current,legacyLinked:false,capabilities:{reading:true,ai:false,operations:false,websiteSources:true}});
 const {transport}=fixture((a,i)=>{
  if(a==='session.get')return session();
  if(a==='school.select'){current=schools[1];return session();}
  if(a==='feed.list')return i.schoolId==='other'?pending:{items:[],nextCursor:null};
  if(a==='favorites.list')return{items:[],nextCursor:null};
 });
 Object.assign(transport,{restore:async()=>({uid:'source-test',username:null}),onSessionChange:()=>()=>{}});
 const wrapper=mount(App,{props:{transport,configurationIssues:[]},global:{plugins:[createPinia()]}});await flushPromises();
 await wrapper.findAll('.nav-item').find(b=>b.text().includes('公告来源'))!.trigger('click');await vi.waitFor(()=>expect(wrapper.find('input[aria-label="搜索学校"]').exists()).toBe(true));await flushPromises();
 await button(wrapper,'另一所大学').trigger('click');await flushPromises();await button(wrapper,'切换到该校并查看公告').trigger('click');await flushPromises();
 await wrapper.findAll('.nav-item').find(b=>b.text().includes('收藏'))!.trigger('click');await flushPromises();
 release({items:[],nextCursor:null});await flushPromises();expect(wrapper.findAll('.nav-item').find(b=>b.text().includes('收藏'))!.classes()).toContain('active');wrapper.unmount();
});
it('saves an independent home-display preference on school and personal source cards',async()=>{
 const {transport,call}=fixture((a,i)=>{
  if(a==='sources.feedVisibility')return{visible:i.visible};
  if(a==='sources.list')return{sources:[{id:'mine',name:'个人通知',enabled:true,type:'rss',entryUrl:'https://mine.example.edu.cn/',categories:['school'],intervalMinutes:60,selectors:{},allowAi:true,authorized:true,lastSuccessAt:null,count:0,message:'尚未采集',showInFeed:false}]};
 });
 const wrapper=mount(WebsiteSourcesPanel,{props:{transport,schoolId:'bjtu',schoolName:'北京交通大学'}});await flushPromises();
 const school=wrapper.get('.school-source-card input[aria-label="在主页公告中显示"]');expect((school.element as HTMLInputElement).checked).toBe(true);
 await school.setValue(false);await flushPromises();expect(call).toHaveBeenCalledWith('sources.feedVisibility',{schoolId:'bjtu',sourceId:'public_bjtu',visible:false});expect(wrapper.emitted('changed')).toHaveLength(1);
 await button(wrapper,'我的来源').trigger('click');await flushPromises();const personal=wrapper.get('section[aria-label="个人来源管理"] input[aria-label="在主页公告中显示"]');expect((personal.element as HTMLInputElement).checked).toBe(false);
 await personal.setValue(true);await flushPromises();expect(call).toHaveBeenCalledWith('sources.feedVisibility',{schoolId:'bjtu',sourceId:'mine',visible:true});
 expect(call.mock.calls.some(([a])=>a==='sources.toggle'||a.startsWith('ai.'))).toBe(false);wrapper.unmount();
});
it('restores a display switch on save failure and does not emit a feed change',async()=>{
 const {transport}=fixture(a=>a==='sources.feedVisibility'?Promise.reject(new Error('保存失败')):undefined);
 const wrapper=mount(WebsiteSourcesPanel,{props:{transport,schoolId:'bjtu',schoolName:'北京交通大学'}});await flushPromises();
 const control=wrapper.get('.school-source-card input[aria-label="在主页公告中显示"]');await control.setValue(false);await flushPromises();
 expect((control.element as HTMLInputElement).checked).toBe(true);expect(wrapper.find('[role=alert]').exists()).toBe(true);expect(wrapper.emitted('changed')).toBeUndefined();wrapper.unmount();
});
it.each(['leave-during-save','cached-other-school'])('invalidates display preferences in stable App scope: %s',async(scenario)=>{
 let visible=true,current=scenario==='cached-other-school'?schools[1]:schools[0];
 let release!:()=>void;const pending=new Promise<void>(r=>release=r);
 const session=()=>({identity:{uid:'source-test',username:null},school:current,legacyLinked:false,capabilities:{reading:true,ai:false,operations:false,websiteSources:true}});
 const notices=(schoolId:string)=>Array.from({length:20},(_,i)=>({id:`${schoolId}-${i}`,title:i===0&&visible?'待隐藏公告':`保留公告${i}`,sourceName:'测试来源',publishedAt:null,categories:['school'],summary:null}));
 const {transport}=fixture((a,i)=>{
  if(a==='session.get')return session();
  if(a==='school.select'){current=schools.find(s=>s.id===i.schoolId)!;return session();}
  if(a==='feed.list')return{items:notices(i.schoolId),nextCursor:null};
  if(a==='sources.feedVisibility')return(scenario==='leave-during-save'?pending:Promise.resolve()).then(()=>{visible=i.visible;return{visible};});
 });
 Object.assign(transport,{restore:async()=>({uid:'source-test',username:null}),onSessionChange:()=>()=>{}});
 const pinia=createPinia();const wrapper=mount(App,{props:{transport,configurationIssues:[]},global:{plugins:[pinia]}});await flushPromises();
 const store=workspaceStore(transport)(pinia);
 if(scenario==='cached-other-school')await store.selectSchool('bjtu');
 await wrapper.findAll('.nav-item').find(b=>b.text().includes('公告来源'))!.trigger('click');await vi.waitFor(()=>expect(wrapper.find('input[aria-label="搜索学校"]').exists()).toBe(true));await flushPromises();
 if(scenario==='cached-other-school'){await button(wrapper,'另一所大学').trigger('click');await flushPromises();}
 await wrapper.get('.school-source-card input[aria-label="在主页公告中显示"]').setValue(false);
 if(scenario==='leave-during-save'){await button(wrapper,'返回公告').trigger('click');release();await flushPromises();}
 else{await flushPromises();await button(wrapper,'切换到该校并查看公告').trigger('click');await flushPromises();}
 expect(wrapper.find('.website-sources').exists()).toBe(false);expect(wrapper.text()).not.toContain('待隐藏公告');expect(store.pendingUpdates).toBe(false);wrapper.unmount();
});
it('shows a school-wide display count and sends one bulk mutation for all sources',async()=>{
 let shown=1;const {transport,call}=fixture((a,i)=>{
  if(a==='sources.displayState')return{total:2,shown,hidden:2-shown};
  if(a==='sources.feedVisibilityAll'){shown=i.visible?2:0;return{total:2,shown,hidden:2-shown};}
 });
 const wrapper=mount(WebsiteSourcesPanel,{props:{transport,schoolId:'bjtu',schoolName:'北京交通大学'}});await flushPromises();expect(wrapper.text()).toContain('已开启 1/2 个来源');
 await button(wrapper,'本校全部隐藏').trigger('click');await flushPromises();expect(wrapper.text()).toContain('已开启 0/2 个来源');expect(call).toHaveBeenCalledWith('sources.feedVisibilityAll',{schoolId:'bjtu',visible:false});
 expect(call.mock.calls.filter(([a])=>a==='sources.feedVisibilityAll')).toHaveLength(1);expect(call.mock.calls.some(([a])=>a==='sources.feedVisibility')).toBe(false);wrapper.unmount();
});
it('opens an individual source without changing its home display preference',async()=>{
 const open=vi.fn(async()=>{});const {transport,call}=fixture();const wrapper=mount(WebsiteSourcesPanel,{props:{transport,schoolId:'bjtu',schoolName:'北京交通大学',openSchool:open}});await flushPromises();
 await button(wrapper,'查看该来源公告').trigger('click');await flushPromises();expect(open).toHaveBeenCalledExactlyOnceWith('bjtu',{id:'public_bjtu',name:'本校教务通知'});expect(call.mock.calls.some(([a])=>a==='sources.feedVisibility')).toBe(false);wrapper.unmount();
});
it('explains verified source failures and displays collection details and minute-level check time',async()=>{
 const {transport}=fixture(a=>a==='school.sources'?{...catalogue('bjtu'),sources:[{...catalogue('bjtu').sources[0],state:'unavailable',errorCode:'SOURCE_LOGIN_REQUIRED',checkedAt:'2026-10-24T03:03:00Z',stats:{newCount:0,existingCount:0,failedSources:1,skippedCount:0}}]}:undefined);
 const wrapper=mount(WebsiteSourcesPanel,{props:{transport,schoolId:'bjtu',schoolName:'北京交通大学'}});await flushPromises();expect(wrapper.text()).toContain('需要登录或校园网');expect(wrapper.text()).toContain('失败 1 个来源');expect(wrapper.text()).toContain('11:03');wrapper.unmount();
});
it('explains hidden sources on an empty home feed and links to source management',async()=>{
 const {transport}=fixture(a=>{
  if(a==='session.get')return{identity:{uid:'source-test',username:null},school:schools[0],legacyLinked:false,capabilities:{reading:true,ai:false,operations:false,websiteSources:true}};
  if(a==='feed.list')return{items:[],nextCursor:null,hiddenSourceCount:2};
 });Object.assign(transport,{restore:async()=>({uid:'source-test',username:null}),onSessionChange:()=>()=>{}});
 const wrapper=mount(App,{props:{transport,configurationIssues:[]},global:{plugins:[createPinia()]}});await flushPromises();expect(wrapper.text()).toContain('有 2 个来源已关闭主页显示');
 await button(wrapper,'管理来源').trigger('click');await vi.waitFor(()=>expect(wrapper.find('.website-sources').exists()).toBe(true));wrapper.unmount();
});
it('App preserves an explicit source filter when searching and clears it when viewing all sources or switching school',async()=>{
 let current=schools[0];const session=()=>({identity:{uid:'source-test',username:null},school:current,legacyLinked:false,capabilities:{reading:true,ai:false,operations:false,websiteSources:true}});
 const {transport,call}=fixture((a,i)=>{
  if(a==='session.get')return session();
  if(a==='school.select'){current=schools.find(s=>s.id===i.schoolId)!;return session();}
  if(a==='feed.list')return{items:[],nextCursor:null,hiddenSourceCount:1};
 });Object.assign(transport,{restore:async()=>({uid:'source-test',username:null}),onSessionChange:()=>()=>{}});
 const pinia=createPinia(),wrapper=mount(App,{props:{transport,configurationIssues:[]},global:{plugins:[pinia]}});await flushPromises();
 await button(wrapper,'管理来源').trigger('click');await vi.waitFor(()=>expect(wrapper.find('.school-source-card').exists()).toBe(true));await flushPromises();await button(wrapper,'查看该来源公告').trigger('click');await flushPromises();
 expect(wrapper.get('.source-filter-banner').text()).toContain('本校教务通知');expect(wrapper.text()).toContain('主页显示设置不变');
 await wrapper.get('#notice-keyword').setValue('竞赛');await wrapper.get('form.feed-filters').trigger('submit.prevent');await flushPromises();expect(call.mock.calls.filter(([a])=>a==='feed.list').at(-1)![1]).toMatchObject({sourceId:'public_bjtu',keyword:'竞赛'});
 await button(wrapper,'查看全部来源').trigger('click');await flushPromises();expect(wrapper.find('.source-filter-banner').exists()).toBe(false);expect(call.mock.calls.filter(([a])=>a==='feed.list').at(-1)![1]).not.toHaveProperty('sourceId');
 const store=workspaceStore(transport)(pinia);await store.applyFilters({...store.filters,sourceId:'public_bjtu'});await store.selectSchool('other');expect(store.filters.sourceId).toBeUndefined();wrapper.unmount();
});
it('keeps a personal source collection button disabled only until the advertised cooldown expires',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-24T03:00:00Z'));
 const {transport}=fixture(a=>a==='sources.list'?{sources:[{id:'mine',name:'个人通知',enabled:true,type:'rss',entryUrl:'https://mine.example.edu.cn/',categories:['school'],intervalMinutes:60,selectors:{},allowAi:true,authorized:true,lastSuccessAt:null,count:0,message:'尚未采集',nextRefreshAt:'2026-10-24T03:00:02Z'}]}:undefined);
 const wrapper=mount(WebsiteSourcesPanel,{props:{transport,schoolId:'bjtu',schoolName:'北京交通大学'}});
 try{await flushPromises();await button(wrapper,'我的来源').trigger('click');await flushPromises();expect(button(wrapper,'立即采集').attributes('disabled')).toBeDefined();expect(wrapper.text()).toContain('11:00');await vi.advanceTimersByTimeAsync(3000);expect(button(wrapper,'立即采集').attributes('disabled')).toBeUndefined();}
 finally{wrapper.unmount();vi.useRealTimers();}
});
it('keeps the previous summary and source choices after bulk saving fails',async()=>{
 const {transport}=fixture(a=>a==='sources.feedVisibilityAll'?Promise.reject(new Error('save failed')):undefined);
 const wrapper=mount(WebsiteSourcesPanel,{props:{transport,schoolId:'bjtu',schoolName:'北京交通大学'}});await flushPromises();await button(wrapper,'本校全部隐藏').trigger('click');await flushPromises();expect(wrapper.text()).toContain('已开启 1/1 个来源');expect((wrapper.get('.school-source-card input[type=checkbox]').element as HTMLInputElement).checked).toBe(true);expect(wrapper.emitted('changed')).toBeUndefined();wrapper.unmount();
});
it('serializes single-source and school-wide display changes so old responses cannot reverse card state',async()=>{
 let releaseSingle!:(value:unknown)=>void,releaseBulk!:(value:unknown)=>void;const single=new Promise(r=>releaseSingle=r),bulk=new Promise(r=>releaseBulk=r);
 const {transport,call}=fixture((a,i)=>a==='sources.feedVisibility'?single:a==='sources.feedVisibilityAll'?bulk:undefined);
 const wrapper=mount(WebsiteSourcesPanel,{props:{transport,schoolId:'bjtu',schoolName:'北京交通大学'}});await flushPromises();
 await wrapper.get('.school-source-card input[type=checkbox]').setValue(false);await flushPromises();expect(button(wrapper,'本校全部显示').attributes('disabled')).toBeDefined();await button(wrapper,'本校全部显示').trigger('click');expect(call.mock.calls.some(([a])=>a==='sources.feedVisibilityAll')).toBe(false);
 releaseSingle({visible:false});await flushPromises();await button(wrapper,'本校全部显示').trigger('click');await flushPromises();expect(wrapper.get('.source-panels').attributes('disabled')).toBeDefined();releaseBulk({total:1,shown:1,hidden:0});await flushPromises();expect(wrapper.get('.source-panels').attributes('disabled')).toBeUndefined();expect((wrapper.get('.school-source-card input[type=checkbox]').element as HTMLInputElement).checked).toBe(true);wrapper.unmount();
});
it('keeps personal controls locked until the post-bulk source reload completes',async()=>{
 let release!:(value:unknown)=>void,count=0;const pending=new Promise(r=>release=r);
 const source={id:'mine',name:'个人通知',enabled:true,type:'rss',entryUrl:'https://mine.example.edu.cn/',categories:['school'],intervalMinutes:60,selectors:{},allowAi:true,authorized:true,lastSuccessAt:null,count:0,message:'尚未采集',showInFeed:false};
 const {transport}=fixture(a=>a==='sources.list'?(++count===1?{sources:[source]}:pending):a==='sources.feedVisibilityAll'?{total:2,shown:2,hidden:0}:undefined);
 const wrapper=mount(WebsiteSourcesPanel,{props:{transport,schoolId:'bjtu',schoolName:'北京交通大学'}});await flushPromises();await button(wrapper,'我的来源').trigger('click');await flushPromises();await button(wrapper,'本校全部显示').trigger('click');await flushPromises();
 const control=wrapper.get('section[aria-label="个人来源管理"] .source-display input');expect(control.attributes('disabled')).toBeDefined();expect(button(wrapper,'本校全部隐藏').attributes('disabled')).toBeDefined();release({sources:[{...source,showInFeed:true}]});await flushPromises();expect((wrapper.get('section[aria-label="个人来源管理"] .source-display input').element as HTMLInputElement).checked).toBe(true);wrapper.unmount();
});
