import { beforeEach,expect,it,vi } from 'vitest';
import { createPinia,setActivePinia } from 'pinia';
import { mount,flushPromises } from '@vue/test-utils';
import App from '../src/App.vue';
import SchoolRequestForm from '../src/components/SchoolRequestForm.vue';
import { workspaceStore } from '../src/stores/workspace';
import type { Transport } from '../src/lib/transport';
const schools=Array.from({length:115},(_,index)=>({id:`school_${index}`,name:`学校${index}`,status:'candidate' as const}));
const session={identity:{uid:'member',username:'member@example.test'},school:null,legacyLinked:false,capabilities:{reading:true,ai:true,operations:false,schoolDirectory:true}};
function fixture() {
  const fake:Transport={restore:vi.fn(async()=>session.identity),signIn:vi.fn(),signOut:vi.fn(),onSessionChange:vi.fn(()=>()=>{}),call:vi.fn(async(action,input:any)=>{
    if(action==='session.get') return session;
    if(action==='school.list') {const offset=Number(input.cursor||0);return {schools:schools.slice(offset,offset+50),nextCursor:offset+50<schools.length?String(offset+50):null};}
    if(action==='school.select') return {...session,school:schools.find(row=>row.id===input.schoolId)};
    if(action==='school.refresh') return {state:'unavailable',count:0,checkedAt:null,message:'公开页面需要校园网，请查看学校原站。'};
    if(action==='feed.list') return {items:[],nextCursor:null};
    if(action==='school.request') return {id:'request-1',state:'submitted',message:'申请已提交'};
    throw new Error('unexpected action');
  }) as Transport['call']};return fake;
}
beforeEach(()=>setActivePinia(createPinia()));
async function openSchools(wrapper:ReturnType<typeof mount>){await wrapper.get('.profile-mini').trigger('click');await vi.dynamicImportSettled();await flushPromises();await wrapper.findAll('.account-tabs button')[1].trigger('click');await flushPromises();}
it('every login loads the complete catalog before a missing-school application; the special choice never changes saved school',async()=>{
  const fake=fixture(),wrapper=mount(App,{props:{transport:fake,configurationIssues:[]}});await flushPromises();
  expect(wrapper.find('#school').exists()).toBe(false);await openSchools(wrapper);
  expect(wrapper.findAll('#school option')).toHaveLength(117);
  expect(wrapper.find('#school').text()).toContain('学校114');
  await wrapper.find('#school').setValue('__request__');await flushPromises();
  expect(wrapper.find('#request-school').exists()).toBe(true);
  expect(vi.mocked(fake.call).mock.calls.some(([action])=>action==='school.select')).toBe(false);
  await wrapper.find('#request-school').setValue('其他大学');await wrapper.find('form.school-request').trigger('submit');await flushPromises();
  expect(fake.call).toHaveBeenCalledWith('school.request',{schoolName:'其他大学'});expect(wrapper.text()).toContain('申请已提交');wrapper.unmount();
});
it('changing school clears the previous feed and displays unavailable-source status without inventing notices',async()=>{
  const fake=fixture(),store=workspaceStore(fake)();await store.connect();await store.selectSchool('school_114');
  expect(fake.call).toHaveBeenCalledWith('school.refresh',{schoolId:'school_114'});
  expect(store.schoolSync?.state).toBe('unavailable');expect(store.items).toEqual([]);store.clear();expect(store.schoolSync).toBeNull();
});
it('a busy school application cannot be submitted twice and has no client-chosen email or recipient',async()=>{
  const fake=fixture();let finish!:(value:unknown)=>void;
  vi.mocked(fake.call).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}) as never);
  const wrapper=mount(SchoolRequestForm,{props:{transport:fake}});
  await wrapper.find('input[name=school]').setValue('其他大学');await wrapper.find('form').trigger('submit');await wrapper.find('form').trigger('submit');
  expect(fake.call).toHaveBeenCalledTimes(1);expect(fake.call).toHaveBeenCalledWith('school.request',{schoolName:'其他大学'});
  finish({id:'request-1',state:'unknown',message:'申请已记录，通知状态待确认'});await flushPromises();expect(wrapper.text()).toContain('状态待确认');wrapper.unmount();
});
it('source coverage and partial failures are visible with safe original links',async()=>{
 const fake=fixture(),original=vi.mocked(fake.call).getMockImplementation()!;
 vi.mocked(fake.call).mockImplementation((async(action,input)=>action==='school.refresh'?{state:'ready',count:8,checkedAt:null,message:'已读取1/2个公开栏目',coverage:'仅覆盖院系公开通知，不包括校内门户。',sources:[{name:'统计系通知',url:'https://www.stat.tsinghua.edu.cn/xwdt/tzgg.htm',state:'ready',count:8,message:'列表可读取'},{name:'暂不可用的栏目',url:'javascript:alert(1)',state:'unavailable',count:0,message:'需要学校登录'}]}:original(action,input)) as Transport['call']);
 const wrapper=mount(App,{props:{transport:fake,configurationIssues:[]}});await flushPromises();await openSchools(wrapper);await wrapper.find('#school').setValue('school_114');await flushPromises();
 expect(wrapper.text()).toContain('仅覆盖院系公开通知');expect(wrapper.text()).toContain('需要学校登录');expect(wrapper.find('details.school-sources a').attributes('href')).toContain('stat.tsinghua.edu.cn');expect(wrapper.findAll('details.school-sources a')[1]!.attributes('href')).toBeUndefined();wrapper.unmount();
});
