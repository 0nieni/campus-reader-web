import type {ItemRow} from './repository';
import {isPrivate} from './scope';

export const SUMMARY_VERSION='extractive-v1';
export type FreeSummary={text:string;basis:'body'|'title'};
const clean=(text:string)=>text.replace(/https?:\/\/\S+/g,'').replace(/\s+/g,' ').trim();
const length=(text:string)=>Array.from(text).length;
export function shortText(text:string):string {
  const chars=Array.from(clean(text));
  return chars.length<=50?chars.join(''):chars.slice(0,49).join('').replace(/[，、；：\s]+$/,'')+'…';
}
/** Extract facts without a model call, guessed dates or generated instructions. */
export function extractSummary(body:string,title:string):FreeSummary {
  const sentences=body.split(/[\n。！？!?]+/).map(clean).filter(text=>length(text)>=8)
    .filter(text=>text!==clean(title)&&!/^((发布时间|发布日期|浏览次数|阅读次数|点击次数|来源|作者|编辑|责任编辑|附件|打印|关闭|分享|上一[篇条]|下一[篇条])\s*[:：]|各.{0,20}[：:]?$)/.test(text));
  if(!sentences.length)return{text:shortText(title||'暂无可读取的公告内容'),basis:'title'};
  const ranked=sentences.map((text,index)=>({text,index,score:(/截止|报名|提交|申请|招聘|举办|竞赛|讲座|公示|安排|时间|对象|领取|申报|招生/.test(text)?4:0)+(/\d|[一二三四五六七八九十]+月/.test(text)?1:0)-index*.03})).sort((a,b)=>b.score-a.score);
  const first=ranked[0]!.text;
  // Use complete source sentences where possible; an ellipsis explicitly marks truncation.
  const second=ranked.find(row=>row.text!==first&&length(first+'；'+row.text)<=50)?.text;
  return{text:shortText(first+(second?'；'+second:'')),basis:'body'};
}
export function noticeSummary(row:ItemRow):FreeSummary|null {
  if(isPrivate(row))return row.summary?.oneLine?{text:row.summary.oneLine,basis:'body'}:null;
  if(row.contentText?.trim())return extractSummary(row.contentText,row.title||'');
  if(row.autoSummary?.version===SUMMARY_VERSION)return{text:shortText(row.autoSummary.text),basis:row.autoSummary.basis};
  if(row.summary?.oneLine?.trim())return{text:shortText(row.summary.oneLine),basis:'body'};
  return extractSummary('',row.title||'');
}
