import {expect,it,vi} from 'vitest';
import {flushPromises,mount,type VueWrapper} from '@vue/test-utils';
import type {SourceCatalogueEntry} from '@campus/contracts';
import WebsiteSourcesPanel from '../src/components/WebsiteSourcesPanel.vue';
import type {Transport} from '../src/lib/transport';
import {ClientError} from '../src/lib/errors';
function fixture(options:{failSave?:boolean;failCollect?:boolean}={}){
 const sources:SourceCatalogueEntry[]=[{id:'school',name:'本校教务通知',kind:'school',schoolId:'bjtu',url:'https://school.example.edu.cn/notices',categories:['school'],showInFeed:true,collectable:true,state:'unchecked',checkedAt:null,count:null,message:'尚未检查'},{id:'public',name:'计算机竞赛公告',kind:'public',schoolId:'bjtu',url:'https://contest.example.org/notices',categories:['competition'],showInFeed:false,collectable:true,state:'unchecked',checkedAt:null,count:null,message:'接入前已验证'},{id:'personal',name:'我的学院来源',kind:'personal',schoolId:'bjtu',url:'https://mine.example.edu.cn/notices',categories:['college'],showInFeed:false,collectable:true,state:'unchecked',checkedAt:null,count:null,message:'尚未采集'}];
 const call=vi.fn(async(action:string,input:Record<string,unknown>)=>{
  if(action==='sources.catalogue')return{sources:sources.map(row=>({...row})),total:3,shown:sources.filter(row=>row.showInFeed).length,hidden:sources.filter(row=>!row.showInFeed).length};
  if(action==='sources.feedVisibility'){if(options.failSave)throw new ClientError('SAVE_FAILED','保存未完成');sources.find(row=>row.id===input.sourceId)!.showInFeed=Boolean(input.visible);return{visible:input.visible};}
  if(action==='sources.feedVisibilityAll'){sources.forEach(row=>row.showInFeed=Boolean(input.visible));return{total:3,shown:input.visible?3:0,hidden:input.visible?0:3};}
  if(action==='sources.public.refresh'){if(options.failCollect)throw new ClientError('LEXMOUNT_NOT_CONFIGURED','Lexmount 尚未正确配置');return{count:2,message:'已采集 2 条',stats:{newCount:2,existingCount:0,failedSources:0,skippedCount:0}};}
  throw new Error('Unexpected action '+action);
 });
 return{sources,call,transport:{call} as unknown as Transport};
}
const button=(wrapper:VueWrapper,label:string)=>wrapper.findAll('button').find(node=>node.text()===label)!;
it('shows school, public and personal sources together, with shared categories and keyword/checked filters',async()=>{
 const {transport,call}=fixture(),wrapper=mount(WebsiteSourcesPanel,{props:{transport,schoolId:'bjtu',schoolName:'北京交通大学'}});await flushPromises();
 expect(wrapper.findAll('[data-source-id]')).toHaveLength(3);expect(wrapper.text()).toContain('已勾选 1/3');
 expect((wrapper.get('[data-source-id=school] input').element as HTMLInputElement).checked).toBe(true);expect((wrapper.get('[data-source-id=public] input').element as HTMLInputElement).checked).toBe(false);
 await wrapper.get('#source-keyword').setValue('计算机');expect(wrapper.findAll('[data-source-id]')).toHaveLength(1);
 await button(wrapper,'清除筛选').trigger('click');await wrapper.get('select[aria-label="来源勾选状态"]').setValue('shown');expect(wrapper.findAll('[data-source-id]')).toHaveLength(1);
 await wrapper.get('select[aria-label="来源勾选状态"]').setValue('all');await button(wrapper,'全不选分类').trigger('click');expect(wrapper.findAll('[data-source-id]')).toHaveLength(0);
 await wrapper.get('input[value=competition]').setValue(true);expect(wrapper.findAll('[data-source-id]')).toHaveLength(1);
 expect(call.mock.calls.every(([action])=>action==='sources.catalogue')).toBe(true);wrapper.unmount();
});
it('requires an explicit check before opening a public source and saves the independent display preference',async()=>{
 const {transport,call}=fixture(),open=vi.fn(async()=>{}),wrapper=mount(WebsiteSourcesPanel,{props:{transport,schoolId:'bjtu',schoolName:'北京交通大学',openSchool:open}});await flushPromises();
 const card=wrapper.get('[data-source-id=public]');expect(card.findAll('button').find(node=>node.text()==='查看该来源公告')!.attributes('disabled')).toBeDefined();
 await card.get('input').setValue(true);await flushPromises();expect(call).toHaveBeenCalledWith('sources.feedVisibility',{schoolId:'bjtu',sourceId:'public',visible:true});
 await card.findAll('button').find(node=>node.text()==='查看该来源公告')!.trigger('click');await flushPromises();expect(open).toHaveBeenCalledWith('bjtu',{id:'public',name:'计算机竞赛公告'});expect(wrapper.emitted('changed')).toHaveLength(1);wrapper.unmount();
});
it('restores the checkbox after a failed save and preserves a configuration error after reloading collection state',async()=>{
 const failing=fixture({failSave:true}),first=mount(WebsiteSourcesPanel,{props:{transport:failing.transport,schoolId:'bjtu',schoolName:'北京交通大学'}});await flushPromises();await first.get('[data-source-id=public] input').setValue(true);await flushPromises();expect((first.get('[data-source-id=public] input').element as HTMLInputElement).checked).toBe(false);expect(first.emitted('changed')).toBeUndefined();first.unmount();
 const {transport}=fixture({failCollect:true}),wrapper=mount(WebsiteSourcesPanel,{props:{transport,schoolId:'bjtu',schoolName:'北京交通大学'}});await flushPromises();await wrapper.get('[data-source-id=public] input').setValue(true);await flushPromises();await wrapper.get('[data-source-id=public]').findAll('button').find(node=>node.text()==='立即采集')!.trigger('click');await flushPromises();expect(wrapper.get('[role=alert]').text()).toContain('Lexmount 尚未正确配置');wrapper.unmount();
});
