import {expect,it,vi} from 'vitest';
import {mount,flushPromises} from '@vue/test-utils';
import type {Transport} from '../src/lib/transport';
import ReminderForm from '../src/components/ReminderForm.vue';
import ReminderEmailSettings from '../src/components/ReminderEmailSettings.vue';
const email={configured:true,address:'ab***@example.test',verified:false,enabled:false,suspended:false,usedToday:0,dailyLimit:20};
it('preview mail settings never offer an active send button and do not auto-send verification',async()=>{
 const call=vi.fn(),wrapper=mount(ReminderEmailSettings,{props:{transport:{call} as unknown as Transport,state:{...email,configured:false}}});
 expect(wrapper.text()).toContain('预览环境不发送真实邮件');expect(wrapper.get('button').attributes('disabled')).toBeDefined();expect(call).not.toHaveBeenCalled();wrapper.unmount();
});
it('verification stays separate from account opt-in and only uses the current account address',async()=>{
 const call=vi.fn(async()=>({...email,usedToday:1})),wrapper=mount(ReminderEmailSettings,{props:{transport:{call} as unknown as Transport,state:email}});
 await wrapper.get('button').trigger('click');await flushPromises();expect(call).toHaveBeenCalledWith('reminders.email.verify',{});expect(call).toHaveBeenCalledTimes(1);expect(wrapper.emitted('changed')?.[0]?.[0]).toMatchObject({enabled:false});expect(wrapper.text()).toContain('再主动开启');
 await wrapper.setProps({state:{...email,verified:true}});await wrapper.findAll('button').find(b=>b.text()==='开启邮件提醒')!.trigger('click');await flushPromises();expect(call).toHaveBeenLastCalledWith('reminders.email.enable',{enabled:true});expect(wrapper.text()).toContain('历史事项不会自动开启');wrapper.unmount();
});
it('an enabled email can be turned off without changing a browser subscription',async()=>{
 const call=vi.fn(async()=>({...email,verified:true,enabled:false})),wrapper=mount(ReminderEmailSettings,{props:{transport:{call} as unknown as Transport,state:{...email,verified:true,enabled:true}}});
 await wrapper.findAll('button').find(b=>b.text()==='关闭邮件提醒')!.trigger('click');await flushPromises();expect(call.mock.calls).toEqual([['reminders.email.enable',{enabled:false}]]);wrapper.unmount();
});
it('historical items keep email off and each item can select only mail or only in-app/calendar',async()=>{
 const call=vi.fn(async()=>({reminders:[]})),wrapper=mount(ReminderForm,{props:{transport:{call} as unknown as Transport,schoolId:'bjtu',itemId:'one',title:'合成公告',reminder:{id:'old',schoolId:'bjtu',schoolName:'合成大学',itemId:'one',title:'合成公告',label:'报名',dueAt:'2027-06-20T01:30:00.000Z',days:[0],createdAt:'2026-10-20T01:00:00.000Z'}}});
 const controls=wrapper.findAll('[aria-label="发送方式"] input');expect((controls[0]!.element as HTMLInputElement).checked).toBe(true);expect((controls[1]!.element as HTMLInputElement).checked).toBe(false);
 await controls[0]!.setValue(false);await controls[1]!.setValue(true);await wrapper.get('form').trigger('submit.prevent');await flushPromises();expect(call).toHaveBeenLastCalledWith('reminders.save',expect.objectContaining({id:'old',channels:{browser:false,email:true}}));
 wrapper.unmount();
 const none=mount(ReminderForm,{props:{transport:{call} as unknown as Transport,schoolId:'bjtu',itemId:'two',title:'合成公告'}});await none.get('button').trigger('click');await none.get('input[type="datetime-local"]').setValue('2027-06-20T09:30');await none.find('[aria-label="发送方式"] input').setValue(false);expect(none.text()).toContain('仅保存站内提醒与日历事项');await none.get('form').trigger('submit.prevent');await flushPromises();expect(call).toHaveBeenLastCalledWith('reminders.save',expect.objectContaining({channels:{browser:false,email:false}}));none.unmount();
});
