import {expect,it,vi} from 'vitest';
import {flushPromises,mount} from '@vue/test-utils';
import WebsiteSourcesPanel from '../src/components/WebsiteSourcesPanel.vue';
import type {Transport} from '../src/lib/transport';
it('saves, tests and collects a source without automatically generating summaries or using AI quota',async()=>{
 let source:any=null;const call=vi.fn(async(action:string,input:any)=>{
  if(action==='sources.list')return{sources:source?[source]:[]};
  if(action==='school.list')return{schools:[{id:'bjtu',name:'北京交通大学',status:'ready'}],nextCursor:null};
  if(action==='school.sources')return{school:{id:'bjtu',name:'北京交通大学',status:'ready'},coverage:'公开栏目',sources:[]};
  if(action==='sources.displayState')return{total:1,shown:1,hidden:0};
  if(action==='sources.save'){source={...input.source,id:'mine',enabled:true,count:0,lastSuccessAt:null,message:'尚未采集'};return{id:'mine'};}
  if(action==='sources.test')return{count:1,titles:['学院活动公告'],message:'连接成功，尚未导入'};
  if(action==='sources.refresh')return{count:1,message:'已导入1条公告'};
  throw new Error('Unexpected action');
 });
 const transport={call} as unknown as Transport;
 const wrapper=mount(WebsiteSourcesPanel,{props:{transport,schoolId:'bjtu',schoolName:'北京交通大学'}});await flushPromises();
  await wrapper.findAll('button').find(b=>b.text()==='管理我的来源')!.trigger('click');await flushPromises();
 expect(wrapper.text()).toContain('不提供免费摘要');
 await wrapper.get('button.primary').trigger('click');
 await wrapper.get('input[placeholder="例如：某学院通知公告"]').setValue('学院公开通知');
 await wrapper.get('input[type=url]').setValue('https://notice.example.edu.cn/list.htm');
 await wrapper.findAll('.source-check input')[1]!.setValue(true);
 await wrapper.get('form').trigger('submit.prevent');await flushPromises();
 expect(wrapper.text()).toContain('学院公开通知');expect(wrapper.text()).toContain('先测试连接');
 const button=(label:string)=>wrapper.findAll('button').find(b=>b.text()===label)!;
 await button('测试连接').trigger('click');await flushPromises();expect(wrapper.find('.source-preview').text()).toContain('学院活动公告');
 await button('更新来源').trigger('click');await flushPromises();expect(wrapper.emitted('changed')).toHaveLength(2);
 expect(call.mock.calls.some(([action])=>action.startsWith('ai.')||action==='school.summarize')).toBe(false);
 const saved=call.mock.calls.find(([action])=>action==='sources.save')![1];expect(saved).not.toHaveProperty('ownerOpenid');expect(saved.schoolId).toBe('bjtu');
 wrapper.unmount();
});
