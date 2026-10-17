import {beforeEach,expect,it,vi} from 'vitest';
import {createPinia,setActivePinia} from 'pinia';
import {mount,flushPromises} from '@vue/test-utils';
import {noticeCategories} from '@campus/contracts';
import type {Transport} from '../src/lib/transport';
import NoticeLabelsEditor from '../src/components/NoticeLabelsEditor.vue';
import App from '../src/App.vue';
const session={identity:{uid:'label-member',username:null},school:{id:'bjtu',name:'北京交通大学',status:'ready'},legacyLinked:false,capabilities:{reading:true,ai:true,operations:false,noticeLabels:true}};
function fixture(){return {restore:vi.fn(async()=>session.identity),signIn:vi.fn(),signOut:vi.fn(),onSessionChange:vi.fn(()=>()=>{}),call:vi.fn(async(action:string,input:any)=>{
 if(action==='session.get'||action==='school.select')return session;
 if(action==='school.list')return {schools:[session.school],nextCursor:null};
 if(action==='feed.list')return {items:input.categories.length?[{id:'one',title:'测试公告',sourceName:'来源',categories:['school'],publishedAt:null,summary:null}]:[],nextCursor:null};
 if(action==='feed.labels.set')return {categories:input.categories??['school'],customized:input.categories!==null};
 throw new Error('unexpected');
}) as Transport['call']} as Transport;}
beforeEach(()=>setActivePinia(createPinia()));
it('all seven filters start checked; changing a box applies immediately, none returns no notices and reset selects all',async()=>{
 const fake=fixture(),wrapper=mount(App,{props:{transport:fake,configurationIssues:[]}});await flushPromises();
 const boxes=wrapper.findAll('.filter-options input[type=checkbox]');expect(boxes).toHaveLength(7);expect(boxes.every(b=>(b.element as HTMLInputElement).checked)).toBe(true);
 await boxes[0]!.setValue(false);await flushPromises();expect(fake.call).toHaveBeenLastCalledWith('feed.list',{schoolId:'bjtu',categories:noticeCategories.filter(c=>c!=='school')});
 await wrapper.findAll('button').find(b=>b.text()==='全不选')!.trigger('click');await flushPromises();expect(fake.call).toHaveBeenLastCalledWith('feed.list',{schoolId:'bjtu',categories:[]});expect(wrapper.findAll('.notice-row')).toHaveLength(0);expect(wrapper.text()).toContain('请勾选至少一个标签');
 await wrapper.findAll('button').find(b=>b.text()==='清除筛选')!.trigger('click');await flushPromises();expect(fake.call).toHaveBeenLastCalledWith('feed.list',{schoolId:'bjtu',categories:[...noticeCategories]});wrapper.unmount();
});
it('label editing sends only the notice and category choices, requires one label and supports restoring defaults',async()=>{
 const fake=fixture(),wrapper=mount(NoticeLabelsEditor,{props:{transport:fake,schoolId:'bjtu',itemId:'one',categories:['school'],customized:true}});
 await wrapper.find('input[value=school]').setValue(false);expect(wrapper.find('button.secondary').attributes('disabled')).toBeDefined();
 await wrapper.find('input[value=competition]').setValue(true);await wrapper.find('button.secondary').trigger('click');await flushPromises();
 expect(fake.call).toHaveBeenCalledWith('feed.labels.set',{schoolId:'bjtu',itemId:'one',categories:['competition']});expect(wrapper.emitted('saved')?.[0]?.[0]).toMatchObject({categories:['competition'],customized:true});
 await wrapper.findAll('button').find(b=>b.text()==='恢复默认标签')!.trigger('click');await flushPromises();expect(fake.call).toHaveBeenLastCalledWith('feed.labels.set',{schoolId:'bjtu',itemId:'one',categories:null});wrapper.unmount();
});
it('a late save from an unmounted notice/account cannot update the current reader',async()=>{
 const fake=fixture();let finish!:(v:any)=>void;vi.mocked(fake.call).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}) as never);
 const wrapper=mount(NoticeLabelsEditor,{props:{transport:fake,schoolId:'bjtu',itemId:'one',categories:['school'],customized:false}});
 await wrapper.find('button.secondary').trigger('click');wrapper.unmount();finish({categories:['competition'],customized:true});await flushPromises();expect(wrapper.emitted('saved')).toBeUndefined();
});
