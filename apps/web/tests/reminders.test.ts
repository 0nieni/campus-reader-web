import {expect,it,vi,afterEach} from 'vitest';
import {mount,flushPromises} from '@vue/test-utils';
import ReminderForm from '../src/components/ReminderForm.vue';
import ReminderCenter from '../src/components/ReminderCenter.vue';
import type {Transport} from '../src/lib/transport';
import type {ReminderState} from '@campus/contracts';
const browser=vi.hoisted(()=>({pushSupport:vi.fn(()=>''),currentPush:vi.fn(async()=>null),enablePush:vi.fn(async()=>({endpoint:'https://fcm.googleapis.com/fake'})),disablePush:vi.fn(async()=>{})}));
vi.mock('../src/lib/browser-push',()=>browser);
const fresh=():ReminderState=>({reminders:[],watches:[],notifications:[],unread:0,checkedAt:new Date().toISOString(),more:false,pushConfigured:true,publicKey:'synthetic-public'});
afterEach(()=>{vi.clearAllMocks();});
it('requires manual Beijing date confirmation and does not start AI or request notification permission',async()=>{
 const state=fresh(),call=vi.fn(async()=>state),wrapper=mount(ReminderForm,{props:{transport:{call} as unknown as Transport,schoolId:'bjtu',itemId:'public_fixture',title:'报名公告'}});
 expect(call).not.toHaveBeenCalled();await wrapper.get('button.secondary').trigger('click');
 await wrapper.get('input[type=datetime-local]').setValue('2027-01-20T09:30');
 await wrapper.get('form').trigger('submit.prevent');await flushPromises();
 expect(call).toHaveBeenCalledWith('reminders.save',expect.objectContaining({schoolId:'bjtu',itemId:'public_fixture',dueAt:'2027-01-20T01:30:00.000Z',days:[7,3,1,0]}));
 expect(wrapper.text()).toContain('已保存');expect(wrapper.emitted('saved')).toHaveLength(1);expect(browser.enablePush).not.toHaveBeenCalled();wrapper.unmount();
});
it('shows only messages and individual time reminders, while push requires explicit authorization',async()=>{
 const state=fresh(),call=vi.fn(async(action:string,input:any)=>{
  if(action==='feed.list')return{items:[],nextCursor:null};
  if(action==='reminders.state')state.deviceCount=browser.enablePush.mock.calls.length?1:0;
  return structuredClone(state);
 });
 const wrapper=mount(ReminderCenter,{props:{transport:{call} as unknown as Transport,schoolId:'bjtu',schoolName:'测试大学',revision:0,visible:true}});await flushPromises();
 expect(browser.enablePush).not.toHaveBeenCalled();expect(wrapper.text()).toContain('09:00、20:00');
 const button=(text:string)=>wrapper.findAll('button').find(row=>row.text()===text)!;
 expect(wrapper.findAll('.reminder-tabs button').map(b=>b.text())).toEqual(['消息通知','时间提醒（0）']);
 expect(wrapper.text()).not.toContain('学校与关键词');expect(wrapper.find('.watch-form').exists()).toBe(false);
 await button('开启此浏览器推送').trigger('click');await flushPromises();expect(browser.enablePush).toHaveBeenCalledTimes(1);expect(wrapper.text()).toContain('发送测试通知');expect(wrapper.text()).toContain('已开启 1 个浏览器');
 expect(call.mock.calls.some(([action])=>action.startsWith('ai.')||action.startsWith('reminders.watch.'))).toBe(false);wrapper.unmount();
});
it('renders untrusted titles as text, marks notifications read and discards late results after unmount',async()=>{
 const state=fresh();state.notifications=[{id:'event',kind:'new_notice',schoolId:'bjtu',itemId:'notice',title:'<img src=x onerror=alert(1)>',message:'新公告',createdAt:new Date().toISOString(),read:false}];state.unread=1;
 let resolve:((value:ReminderState)=>void)|undefined;
 const listener=vi.fn();
 const call=vi.fn(async(action:string)=>{if(action==='feed.list')return{items:[],nextCursor:null};if(action==='reminders.read'){state.notifications[0]!.read=true;state.unread=0;}return structuredClone(state);});
 const wrapper=mount(ReminderCenter,{props:{transport:{call} as unknown as Transport,schoolId:'bjtu',schoolName:'测试大学',revision:0,visible:true,onUnread:listener}});await flushPromises();
 expect(wrapper.find('img').exists()).toBe(false);expect(wrapper.text()).toContain('<img');
 await wrapper.findAll('button').find(row=>row.text()==='标为已读')!.trigger('click');await flushPromises();expect(wrapper.emitted('unread')?.at(-1)).toEqual([0]);
 listener.mockClear();
 call.mockImplementationOnce(()=>new Promise<ReminderState>(done=>{resolve=done;}));await wrapper.setProps({revision:1});wrapper.unmount();resolve?.({...state,unread:88});await flushPromises();expect(listener).not.toHaveBeenCalled();
});
it('keeps pending and past reminders out of calendar export and sets each pending notice separately',async()=>{
 const state=fresh();
 const base={schoolId:'bjtu',label:'报名截止',days:[],schoolName:'测试大学',createdAt:new Date().toISOString()};
 state.reminders=[{...base,id:'pending',itemId:'one',title:'待设时间公告',dueAt:null},{...base,id:'past',itemId:'two',title:'已到时公告',dueAt:'2020-01-01T00:00:00.000Z'}];
 const call=vi.fn(async(action:string,input:any)=>{
  if(action==='feed.list')return{items:[],nextCursor:null};
  if(action==='reminders.save')state.reminders=state.reminders.map(r=>r.id===input.id?{...r,...JSON.parse(JSON.stringify(input))}:r);
  return structuredClone(state);
 });
 const wrapper=mount(ReminderCenter,{props:{transport:{call} as unknown as Transport,schoolId:'bjtu',schoolName:'测试大学',revision:0,visible:true}});await flushPromises();
 const button=(text:string)=>wrapper.findAll('button').find(row=>row.text()===text)!;
 await button('时间提醒（2）').trigger('click');
 expect(wrapper.text()).toContain('待设置 1 条 · 可导出 0 条');expect(wrapper.text()).toContain('请先为待设置');
 expect(button('导出全部日历').attributes('disabled')).toBeDefined();
 expect(wrapper.findAll('button').filter(b=>b.text()==='导出日历').every(b=>b.attributes('disabled')!==undefined)).toBe(true);
 await button('设置时间').trigger('click');expect((wrapper.get('input[type=datetime-local]').element as HTMLInputElement).value).toBe('');
 await wrapper.get('input[type=datetime-local]').setValue('2027-06-20T09:30');await wrapper.get('.reminder-form').trigger('submit.prevent');await flushPromises();
 expect(call).toHaveBeenCalledWith('reminders.save',expect.objectContaining({id:'pending',itemId:'one',dueAt:'2027-06-20T01:30:00.000Z'}));
 expect(wrapper.text()).toContain('待设置 0 条 · 可导出 1 条');expect(button('导出全部日历').attributes('disabled')).toBeUndefined();
 expect(call.mock.calls.some(([action])=>action==='reminders.export')).toBe(false);wrapper.unmount();
});
it('explains unsupported push and disables authorization while retaining site reminders',async()=>{
 browser.pushSupport.mockReturnValueOnce('此浏览器暂不支持网页推送');const state=fresh();
 const wrapper=mount(ReminderCenter,{props:{transport:{call:async()=>state} as unknown as Transport,schoolId:null,schoolName:'',revision:0,visible:true}});await flushPromises();
 expect(wrapper.text()).toContain('此浏览器暂不支持网页推送');expect(wrapper.findAll('button').find(row=>row.text()==='开启此浏览器推送')!.attributes('disabled')).toBeDefined();expect(browser.enablePush).not.toHaveBeenCalled();wrapper.unmount();
});
it('labels minute registration honestly and provides setup instructions for all three device families',async()=>{
 const state=fresh();state.deliveryMode='minute';state.queueConfigured=true;state.deviceCount=3;
 state.reminders=[{id:'scheduled',schoolId:'bjtu',itemId:'one',title:'系统提醒公告',schoolName:'测试大学',label:'截止',days:[0],dueAt:'2027-06-20T01:30:00.000Z',createdAt:new Date().toISOString(),delivery:{status:'scheduled',nextAt:'2027-06-20T01:30:00.000Z'}}];
 const call=vi.fn(async(action:string)=>action==='feed.list'?{items:[],nextCursor:null}:JSON.parse(JSON.stringify(state)));
 const wrapper=mount(ReminderCenter,{props:{transport:{call} as unknown as Transport,schoolId:'bjtu',schoolName:'测试大学',revision:0,visible:true}});await flushPromises();
 expect(wrapper.text()).toContain('按设定时间登记后台提醒');expect(wrapper.text()).toContain('Windows');expect(wrapper.text()).toContain('iPhone／iPad');expect(wrapper.text()).toContain('安卓');expect(wrapper.text()).toContain('3 个浏览器');
 await wrapper.findAll('button').find(b=>b.text()==='时间提醒（1）')!.trigger('click');expect(wrapper.text()).toContain('已登记后台提醒');expect(wrapper.text()).not.toContain('09:00、20:00');
 state.queueConfigured=false;state.reminders[0]!.delivery!.status='unconfigured';await wrapper.findAll('button').find(b=>b.text()==='检查提醒')!.trigger('click');await flushPromises();expect(wrapper.text()).toContain('分钟提醒服务待配置');wrapper.unmount();
});
