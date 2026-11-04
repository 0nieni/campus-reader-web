import assert from 'node:assert/strict';
import {test} from 'node:test';
import {prepareBrief,validateBrief} from '../src/notice-brief';
import {modelUsage} from '../src/model-protocols';
const body='申报班级须符合申请条件。\n请于2026年10月21日下午17:00前发送材料至cityjssz@bjtu.edu.cn，证明材料单独放在一个Word文件中；纸质版送九教北103室。\n2026年10月18日';
const prepared=prepareBrief(body),proof=(id:string,quote:string)=>[{paragraphId:id,quote}];
const value=()=>({publishedDate:{value:'2026-10-18',precision:'date',evidence:proof('p0003','2026年10月18日')},keyDates:[{label:'材料提交',kind:'deadline',rawText:'2026年10月21日17:00前',end:{value:'2026-10-21T17:00:00+08:00',precision:'minute'},evidence:proof('p0002',prepared.paragraphs[1]!.text)}],requirements:[{text:'证明材料单独放在一个Word文件中。',evidence:proof('p0002',prepared.paragraphs[1]!.text)}],submission:{text:'发送至cityjssz@bjtu.edu.cn，纸质版送九教北103室。',evidence:proof('p0002',prepared.paragraphs[1]!.text)}});
test('brief facts retain exact evidence, material format and electronic/paper submissions',()=>{const result=validateBrief(JSON.stringify(value()),prepared,'2026-10-18T00:00:00Z');assert.equal(result.keyDates[0]!.end!.value,'2026-10-21T17:00:00+08:00');assert.ok(result.submission!.text.includes('cityjssz@bjtu.edu.cn'));});
test('brief validation rejects invented values, missing proof, title/HTML injection and date conflicts',()=>{
 for(const change of [(v:any)=>v.submission.text='发送至invented@example.test',(v:any)=>v.submission.text='纸质版送九教北104室。',(v:any)=>v.keyDates[0].end.value='2027-10-21T17:00:00+08:00',(v:any)=>v.keyDates[0].evidence[0].paragraphId='p9999',(v:any)=>v.title='rewrite title',(v:any)=>v.requirements[0].text='<script>run()</script>']){const invalid=value();change(invalid);assert.throws(()=>validateBrief(JSON.stringify(invalid),prepared,'2026-10-18'),{code:'BRIEF_EVIDENCE'});}
 assert.throws(()=>validateBrief(JSON.stringify(value()),prepared,'2026-10-19'),{code:'BRIEF_DATE_CONFLICT'});assert.throws(()=>validateBrief('{}',prepared));
 assert.throws(()=>validateBrief(JSON.stringify(value()),prepared,'2026-10-18T23:00:00Z'),{code:'BRIEF_DATE_CONFLICT'});
});
test('quality gates reject navigation, authentication, oversize and flat unverified pages without cropping contacts',()=>{
 for(const text of ['首页 硕士招生 博士招生 首页 内容 版权所有','请输入密码进入统一身份认证','内容'.repeat(7000)])assert.throws(()=>prepareBrief(text),{code:'BRIEF_QUALITY'});
 assert.ok(prepareBrief(body).body.includes('cityjssz@bjtu.edu.cn'));assert.equal(prepareBrief(body).contentHash,prepared.contentHash);
});
test('multi-stage dates retain conditions and use publication year rather than examination title year',()=>{
 const p=prepareBrief('2027年硕士考试网上报名事项。\n报名缴费截止2026年10月24日22:00。\n2026年10月26日至10月31日审核。对材料不符合要求的特殊情况考生，补充材料截止10月31日12:00。');
 const result=validateBrief(JSON.stringify({keyDates:[{label:'报名缴费',kind:'deadline',rawText:'2026年10月24日22:00',end:{value:'2026-10-24T22:00:00+08:00',precision:'minute'},evidence:proof('p0002',p.paragraphs[1]!.text)},{label:'审核',kind:'period',rawText:'2026年10月26日至10月31日',start:{value:'2026-10-26',precision:'date'},end:{value:'2026-10-31',precision:'date'},evidence:proof('p0003',p.paragraphs[2]!.text)},{label:'补充材料',kind:'deadline',rawText:'10月31日12:00',conditions:'仅对材料不符合要求的特殊情况考生。',end:{value:'2026-10-31T12:00:00+08:00',precision:'minute'},evidence:proof('p0003',p.paragraphs[2]!.text)}],requirements:[]}),p,'2026-10-08');assert.equal(result.keyDates.length,3);assert.ok(result.keyDates[2]!.conditions);
 const fabricated={keyDates:[{label:'报名缴费',kind:'deadline',rawText:'2026年10月24日',end:{value:'2026-10-24T00:00:00+08:00',precision:'minute'},evidence:proof('p0002',p.paragraphs[1]!.text)}],requirements:[]};assert.throws(()=>validateBrief(JSON.stringify(fabricated),p,'2026-10-08'));
 const noCondition={keyDates:[{...result.keyDates[2]!,conditions:undefined}],requirements:[]};assert.throws(()=>validateBrief(JSON.stringify(noCondition),p,'2026-10-08'),{code:'BRIEF_EVIDENCE'});
});
test('provider usage is explicit and missing/zero/malformed usage never becomes free',()=>{assert.equal(modelUsage('openai-chat',{}),undefined);assert.equal(modelUsage('openai-chat',{usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}}),undefined);assert.deepEqual(modelUsage('openai-chat',{usage:{prompt_tokens:12,completion_tokens:8,total_tokens:20}}),{inputTokens:12,outputTokens:8,totalTokens:20});});

test('minute evidence associates each clock with its own date rather than another milestone',()=>{
 const p=prepareBrief('2026年11月1日09:00开始报名，2026年11月5日17:00截止。');
 const validate=(time:string)=>validateBrief(JSON.stringify({keyDates:[{label:'报名',kind:'deadline',rawText:p.body,end:{value:time,precision:'minute'},evidence:proof('p0001',p.body)}],requirements:[]}),p,'2026-10-30');
 for(const time of ['2026-11-01T09:00:00+08:00','2026-11-05T17:00:00+08:00'])assert.doesNotThrow(()=>validate(time));
 for(const time of ['2026-11-05T09:00:00+08:00','2026-11-01T17:00:00+08:00'])assert.throws(()=>validate(time),{code:'BRIEF_EVIDENCE'});
 const range=prepareBrief('2026年11月1日09:00至17:00可以报名。');
 assert.doesNotThrow(()=>validateBrief(JSON.stringify({keyDates:[{label:'报名',kind:'period',rawText:range.body,start:{value:'2026-11-01T09:00:00+08:00',precision:'minute'},end:{value:'2026-11-01T17:00:00+08:00',precision:'minute'},evidence:proof('p0001',range.body)}],requirements:[]}),range,'2026-10-30'));
});

test('official dotted dates and an unambiguous calendar year in the same evidence paragraph are supported',()=>{
 const dotted=prepareBrief('更新时间：2026.9.24, 15:09');
 assert.doesNotThrow(()=>validateBrief(JSON.stringify({publishedDate:{value:'2026-09-24',precision:'date',evidence:proof('p0001',dotted.body)},keyDates:[],requirements:[]}),dotted));
 const p=prepareBrief('2027年硕士考试通知。\n学院在2026年9月22日上午9:00发送复试通知，9月24日上午8:00发送待录取通知。');
 const value=(year:string)=>JSON.stringify({keyDates:[{label:'发送待录取通知',kind:'event',rawText:'9月24日上午8:00发送待录取通知',start:{value:year+'-09-24T08:00:00+08:00',precision:'minute'},evidence:proof('p0002','9月24日上午8:00发送待录取通知')}],requirements:[]});
 assert.doesNotThrow(()=>validateBrief(value('2026'),p));assert.throws(()=>validateBrief(value('2027'),p),{code:'BRIEF_EVIDENCE'});
 const ambiguous=prepareBrief('2025年9月22日发送第一轮通知，2026年9月22日发送第二轮通知，9月24日上午8:00发送待录取通知。');
 const altered=JSON.parse(value('2026'));altered.keyDates[0].evidence[0].paragraphId='p0001';assert.throws(()=>validateBrief(JSON.stringify(altered),ambiguous),{code:'BRIEF_EVIDENCE'});
});

test('calendar parsing preserves spaces separating numeric dates and clocks without accepting numeric prefixes',()=>{
 for(const line of ['报名截止2026-11-05 17:00','报名截止2026.11.05 17:00','报名截止2026 年 11 月 05 日 17:00']){
  const p=prepareBrief(line),result={keyDates:[{label:'报名截止',kind:'deadline',rawText:line,end:{value:'2026-11-05T17:00:00+08:00',precision:'minute'},evidence:proof('p0001',line)}],requirements:[]};
  assert.doesNotThrow(()=>validateBrief(JSON.stringify(result),p));
 }
 const p=prepareBrief('报名编号2026-11-0517:00，未公布截止时间。');
 assert.throws(()=>validateBrief(JSON.stringify({keyDates:[{label:'报名',kind:'deadline',rawText:p.body,end:{value:'2026-11-05T17:00:00+08:00',precision:'minute'},evidence:proof('p0001',p.body)}],requirements:[]}),p),{code:'BRIEF_EVIDENCE'});
});

test('later explicit years do not rewrite earlier range endpoints',()=>{
 const p=prepareBrief('报名时间为12月25日至2027年1月5日。');
 const range={keyDates:[{label:'报名时间',kind:'period',rawText:p.body,start:{value:'2026-12-25',precision:'date'},end:{value:'2027-01-05',precision:'date'},evidence:proof('p0001',p.body)}],requirements:[]};
 assert.doesNotThrow(()=>validateBrief(JSON.stringify(range),p,'2026-12-01'));
});
test('quote whitespace cannot split a source number into different numeric claims',()=>{
 const room=prepareBrief('请将纸质版材料送至九教北103室。');
 const altered={submission:{text:'请送至九教北10室。',evidence:proof('p0001','请将纸质版材料送至九教北10 3室。')},keyDates:[],requirements:[]};
 assert.throws(()=>validateBrief(JSON.stringify(altered),room),{code:'BRIEF_EVIDENCE'});
 altered.submission.text='请送至九教北103室。';assert.doesNotThrow(()=>validateBrief(JSON.stringify(altered),room));
 altered.submission.evidence=proof('p0001','  ');assert.throws(()=>validateBrief(JSON.stringify(altered),room),{code:'BRIEF_EVIDENCE'});
});

test('a shortened date retains its own adjacent explicit year instead of an earlier date year',()=>{
 const p=prepareBrief('2025年12月1日发布预通知，报名截止2026年11月5日。');
 const output=(year:string)=>JSON.stringify({keyDates:[{label:'报名截止',kind:'deadline',rawText:'11月5日',end:{value:year+'-11-05',precision:'date'},evidence:proof('p0001','11月5日')}],requirements:[]});
 assert.doesNotThrow(()=>validateBrief(output('2026'),p,'2026-01-01'));
 assert.throws(()=>validateBrief(output('2025'),p,'2026-01-01'),{code:'BRIEF_EVIDENCE'});
});

test('evidence matching skips partial numeric occurrences before a later standalone date',()=>{
 const p=prepareBrief('审核11月5日完成，报名1月5日截止。');
 assert.doesNotThrow(()=>validateBrief(JSON.stringify({keyDates:[{label:'报名截止',kind:'deadline',rawText:'1月5日',end:{value:'2026-01-05',precision:'date'},evidence:proof('p0001','1月5日')}],requirements:[]}),p,'2026-01-01'));
});
