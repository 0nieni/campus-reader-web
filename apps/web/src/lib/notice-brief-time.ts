import type {BriefDate,BriefTime} from '../../../../packages/contracts/src/notice-brief';
const beijingDay=(at:number)=>new Date(at+8*3600000).toISOString().slice(0,10);
export function briefDateStatus(date:BriefDate,now:number):{kind:string;text:string}{
 const end=date.end,start=date.start,today=beijingDay(now);
 const before=(value:BriefTime)=>value.precision==='date'?today<value.value:now<Date.parse(value.value);
 const after=(value:BriefTime)=>value.precision==='date'?today>value.value:now>=Date.parse(value.value);
 if(end&&after(end))return{kind:'closed',text:'已截止'};
 if(start&&before(start))return{kind:'upcoming',text:'尚未开始'};
 if(end?.precision==='date'&&end.value===today)return{kind:'today',text:'今日截止，原文未明确时刻'};
 if(start&&end&&!before(start)&&!after(end))return{kind:'active',text:'进行中'};
 if(date.kind==='deadline'&&end)return{kind:'upcoming',text:'尚未截止'};
 return{kind:'unknown',text:'时间待确认'};
}
