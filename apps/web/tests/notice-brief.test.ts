import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {mount,flushPromises} from '@vue/test-utils';
import type {NoticeBrief,BriefDate} from '../../../packages/contracts/src/notice-brief';
import NoticeBriefPanel from '../src/components/NoticeBrief.vue';
import {briefDateStatus} from '../src/lib/notice-brief-time';
const proof=[{paragraphId:'p0001',quote:'仅限符合补交要求的考生，10月31日12:00前提交。'}];
const ready:NoticeBrief={state:'ready',checkedAt:'2026-10-30T04:00:00Z',attachmentsRead:false,contentHash:'synthetic',content:{audience:{text:'符合补交要求的考生。',evidence:proof},keyDates:[{label:'补交材料',kind:'deadline',rawText:'10月31日12:00前',end:{value:'2026-10-31T12:00:00+08:00',precision:'minute'},conditions:'仅限符合补交要求的考生。',evidence:proof}],requirements:[1,2,3,4].map(number=>({text:'材料要求'+number,evidence:proof})),submission:{text:'电子版发送至office@example.test。',evidence:proof}}};
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-30T04:00:00Z'));});afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
it('renders factual fields, separate conditions, expandable requirements and keyboard-native proof without HTML',async()=>{
 const wrapper=mount(NoticeBriefPanel,{props:{brief:ready}});expect(wrapper.get('h2').text()).toBe('公告摘要');expect(wrapper.text()).toContain('发布日期原文未明确');expect(wrapper.text()).toContain('仅限符合补交要求');expect(wrapper.text()).not.toContain('材料要求4');expect(wrapper.get('details summary').text()).toBe('查看原文依据');
 await wrapper.get('.brief-toggle').trigger('click');expect(wrapper.text()).toContain('材料要求4');expect(wrapper.get('.brief-toggle').attributes('aria-expanded')).toBe('true');expect(wrapper.findAll('blockquote')).toHaveLength(1);expect(wrapper.text()).toContain('本摘要未读取附件');wrapper.unmount();
});
it('per-node time states distinguish expired registration, current review and conditional supplementary deadline',()=>{
 const at=Date.parse('2026-10-30T04:00:00Z'),dates:BriefDate[]=[{label:'报名',kind:'deadline',rawText:'',end:{value:'2026-10-24T22:00:00+08:00',precision:'minute'},evidence:proof},{label:'审核',kind:'period',rawText:'',start:{value:'2026-10-26',precision:'date'},end:{value:'2026-10-31',precision:'date'},evidence:proof},ready.content!.keyDates[0]!];
 expect(dates.map(date=>briefDateStatus(date,at).text)).toEqual(['已截止','进行中','尚未截止']);expect(briefDateStatus({...dates[0]!,end:{value:'2026-10-30',precision:'date'}},at).text).toBe('今日截止，原文未明确时刻');
});
it('recomputes deadline state using server clock without a new model or network call',async()=>{
 const refresh=vi.fn(async()=>{}),brief=structuredClone(ready);brief.content!.keyDates[0]!.end={value:'2026-10-30T12:01:00+08:00',precision:'minute'};
 const wrapper=mount(NoticeBriefPanel,{props:{brief,refresh}});expect(wrapper.get('.brief-status').text()).toBe('尚未截止');await vi.advanceTimersByTimeAsync(60001);expect(wrapper.get('.brief-status').text()).toBe('已截止');expect(refresh).not.toHaveBeenCalled();wrapper.unmount();
});
it('pending polls are bounded, pause while hidden, stop on completion and unmount',async()=>{
 const refresh=vi.fn(async()=>{}),wrapper=mount(NoticeBriefPanel,{props:{brief:{state:'pending',checkedAt:ready.checkedAt,attachmentsRead:false},refresh}});await vi.advanceTimersByTimeAsync(3000);expect(refresh).toHaveBeenCalledTimes(1);
 vi.spyOn(document,'hidden','get').mockReturnValue(true);document.dispatchEvent(new Event('visibilitychange'));await vi.advanceTimersByTimeAsync(6000);expect(refresh).toHaveBeenCalledTimes(1);vi.spyOn(document,'hidden','get').mockReturnValue(false);document.dispatchEvent(new Event('visibilitychange'));await vi.advanceTimersByTimeAsync(3000);expect(refresh).toHaveBeenCalledTimes(2);
 await wrapper.setProps({brief:ready});await vi.advanceTimersByTimeAsync(6000);expect(refresh).toHaveBeenCalledTimes(2);wrapper.unmount();await vi.advanceTimersByTimeAsync(100000);expect(refresh).toHaveBeenCalledTimes(2);
});
it('pending eventually stops polling and failures retain a readable status',async()=>{
 const refresh=vi.fn(async()=>{}),wrapper=mount(NoticeBriefPanel,{props:{brief:{state:'pending',checkedAt:ready.checkedAt,attachmentsRead:false},refresh}});await vi.advanceTimersByTimeAsync(120000);expect(refresh.mock.calls.length).toBeLessThanOrEqual(20);expect(wrapper.text()).toContain('稍后重新打开');await wrapper.setProps({brief:{state:'failed',checkedAt:ready.checkedAt,attachmentsRead:false,message:'摘要暂未完成，可先阅读正文。'}});await flushPromises();expect(wrapper.get('[role=status]').text()).toContain('可先阅读正文');wrapper.unmount();
});
