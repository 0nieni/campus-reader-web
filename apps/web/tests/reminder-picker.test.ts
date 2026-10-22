import {it,expect,vi} from 'vitest';
import {mount,flushPromises} from '@vue/test-utils';
import {noticeCategories,type Notice,type ReminderState} from '@campus/contracts';
import type {Transport} from '../src/lib/transport';
import ReminderNoticePicker from '../src/components/ReminderNoticePicker.vue';
const notice=(id:string):Notice=>({id,title:'公告'+id,sourceName:'测试来源',publishedAt:null,categories:['competition'],summary:null});
const empty=():ReminderState=>({reminders:[],notifications:[],watches:[],unread:0,checkedAt:new Date().toISOString(),more:false,pushConfigured:false,publicKey:null});
it('searches with tags and pagination, preserves checked items and adds them without a time',async()=>{
 const state=empty(),call=vi.fn(async(action:string,input:any)=>{
  if(action==='reminders.add')return state;
  return{items:[notice(input.cursor?'three':input.keyword?'two':'one')],nextCursor:input.cursor?null:'next'};
 });
 const wrapper=mount(ReminderNoticePicker,{props:{transport:{call} as unknown as Transport,schoolId:'bjtu',schoolName:'测试大学',reminders:[]}});await flushPromises();
 await wrapper.get('.picker-notice input').setValue(true);
 await wrapper.get('input[type=search]').setValue('竞赛');await wrapper.get('form').trigger('submit.prevent');await flushPromises();
 expect(call).toHaveBeenLastCalledWith('feed.list',{schoolId:'bjtu',keyword:'竞赛',categories:[...noticeCategories],period:'all'});
 await wrapper.findAll('.picker-tags input')[0]!.setValue(false);await flushPromises();
 await wrapper.get('.picker-notice input').setValue(true);
 await wrapper.get('.load-more').trigger('click');await flushPromises();
 expect(call).toHaveBeenLastCalledWith('feed.list',expect.objectContaining({cursor:'next',keyword:'竞赛',categories:noticeCategories.filter(c=>c!=='school')}));
 await wrapper.findAll('.picker-notice input')[1]!.setValue(true);
 await wrapper.get('.picker-footer .primary').trigger('click');await flushPromises();
 expect(call).toHaveBeenLastCalledWith('reminders.add',{schoolId:'bjtu',itemIds:['one','two','three']});expect(wrapper.emitted('added')).toEqual([[state]]);expect(wrapper.text()).toContain('已选 0 篇');wrapper.unmount();
});
it('marks previously added notices and ignores a late school request',async()=>{
 let resolve!:(value:any)=>void;
 const call=vi.fn(async(_action:string,input:any)=>input.schoolId==='bjtu'?new Promise(done=>{resolve=done;}):{items:[notice('new')],nextCursor:null});
 const wrapper=mount(ReminderNoticePicker,{props:{transport:{call} as unknown as Transport,schoolId:'bjtu',schoolName:'测试大学',reminders:[]}});
 await wrapper.setProps({schoolId:'school_001',reminders:[{id:'pending',schoolId:'school_001',schoolName:'另校',itemId:'new',dueAt:null,label:'截止',days:[],title:'公告new',createdAt:new Date().toISOString()}]});await flushPromises();
 resolve({items:[notice('old')],nextCursor:null});await flushPromises();
 expect(wrapper.text()).toContain('公告new');expect(wrapper.text()).not.toContain('公告old');expect(wrapper.text()).toContain('已加入提醒中心');expect(wrapper.get('.picker-notice input').attributes('disabled')).toBeDefined();wrapper.unmount();
});
