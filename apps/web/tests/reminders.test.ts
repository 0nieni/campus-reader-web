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
it('keeps reminder center private, lets users follow titles and explicitly enable push',async()=>{
 const state=fresh(),call=vi.fn(async(action:string,input:any)=>{
  if(action==='reminders.watch.save')state.watches.push({id:'watch',schoolId:input.schoolId,schoolName:'测试大学',keyword:input.keyword,createdAt:new Date().toISOString()});
  return structuredClone(state);
 });
 const wrapper=mount(ReminderCenter,{props:{transport:{call} as unknown as Transport,schoolId:'bjtu',schoolName:'测试大学',revision:0,visible:true}});await flushPromises();
 expect(browser.enablePush).not.toHaveBeenCalled();expect(wrapper.text()).toContain('09:00、20:00');
 const button=(text:string)=>wrapper.findAll('button').find(row=>row.text()===text)!;
 await button('学校与关键词（0）').trigger('click');await wrapper.get('input[placeholder^="例如：竞赛"]').setValue('奖学金');await wrapper.get('form.watch-form').trigger('submit.prevent');await flushPromises();
 expect(call).toHaveBeenCalledWith('reminders.watch.save',{schoolId:'bjtu',keyword:'奖学金'});expect(wrapper.text()).toContain('标题包含「奖学金」');
 await button('开启此浏览器推送').trigger('click');await flushPromises();expect(browser.enablePush).toHaveBeenCalledTimes(1);expect(wrapper.text()).toContain('发送测试通知');
 expect(call.mock.calls.some(([action])=>action.startsWith('ai.'))).toBe(false);wrapper.unmount();
});
it('renders untrusted titles as text, marks notifications read and discards late results after unmount',async()=>{
 const state=fresh();state.notifications=[{id:'event',kind:'new_notice',schoolId:'bjtu',itemId:'notice',title:'<img src=x onerror=alert(1)>',message:'新公告',createdAt:new Date().toISOString(),read:false}];state.unread=1;
 let resolve:((value:ReminderState)=>void)|undefined;
 const listener=vi.fn();
 const call=vi.fn(async(action:string)=>{if(action==='reminders.read'){state.notifications[0]!.read=true;state.unread=0;}return structuredClone(state);});
 const wrapper=mount(ReminderCenter,{props:{transport:{call} as unknown as Transport,schoolId:'bjtu',schoolName:'测试大学',revision:0,visible:true,onUnread:listener}});await flushPromises();
 expect(wrapper.find('img').exists()).toBe(false);expect(wrapper.text()).toContain('<img');
 await wrapper.findAll('button').find(row=>row.text()==='标为已读')!.trigger('click');await flushPromises();expect(wrapper.emitted('unread')?.at(-1)).toEqual([0]);
 listener.mockClear();
 call.mockImplementationOnce(()=>new Promise<ReminderState>(done=>{resolve=done;}));await wrapper.setProps({revision:1});wrapper.unmount();resolve?.({...state,unread:88});await flushPromises();expect(listener).not.toHaveBeenCalled();
});
it('explains unsupported push and disables authorization while retaining site reminders',async()=>{
 browser.pushSupport.mockReturnValueOnce('此浏览器暂不支持网页推送');const state=fresh();
 const wrapper=mount(ReminderCenter,{props:{transport:{call:async()=>state} as unknown as Transport,schoolId:null,schoolName:'',revision:0,visible:true}});await flushPromises();
 expect(wrapper.text()).toContain('此浏览器暂不支持网页推送');expect(wrapper.findAll('button').find(row=>row.text()==='开启此浏览器推送')!.attributes('disabled')).toBeDefined();expect(browser.enablePush).not.toHaveBeenCalled();wrapper.unmount();
});
