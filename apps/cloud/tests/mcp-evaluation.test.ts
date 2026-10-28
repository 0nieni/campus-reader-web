import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {NetlifyDB} from '@netlify/database-dev';
import {getDatabase} from '@netlify/database';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {anonymousWorkspaces} from '../src/anonymous-workspace';
import {postgresStorage,type SqlPool} from '../src/postgres-storage';
import {mcpAuthorization} from '../src/mcp-auth';
import {mcpWorkspaceTools} from '../src/mcp-tools';
import {createCampusMcpHttp} from '../src/mcp-http';

// Deterministic tool-answer verification, not a claim about any LLM's accuracy.
test('ten independent read-only MCP evaluation answers are verified via the official client',async t=>{
 const server=new NetlifyDB({logger(){}}),connectionString=await server.start(),native=getDatabase({connectionString}).pool,pool=native as unknown as SqlPool;
 const now=()=>Date.parse('2026-10-28T04:00:00Z'),origin='https://evaluation.example',db=postgresStorage(pool),client=new Client({name:'read-only-evaluation',version:'1'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});
 try{
  await server.applyMigrations(fileURLToPath(new URL('../../../netlify/database/migrations',import.meta.url)));
  const guest=(await anonymousWorkspaces(pool,{now}).create('mcp-evaluation')).guest,auth=mcpAuthorization(pool,{origin,now}),tools=mcpWorkspaceTools(pool,{auth,now});
  for(const [id,name]of [['eval_north','MCP评估北校'],['eval_south','MCP评估南校']])await db.collection('schools').doc(id).set({name,status:'ready'});
  await db.collection('sources').doc('eval_source').set({name:'MCP评估教务处',scope:'school',schoolIds:['eval_north','eval_south']});
  const notices=[{id:'north-project',school:'eval_north',title:'北校课程项目报名',text:'报名截止2027-05-20。材料交至北楼203室。',url:true},{id:'south-team',school:'eval_south',title:'南校团队赛报名',text:'比赛总名额64，每队4人，报名截止2027-05-22。',url:true},{id:'north-extra',school:'eval_north',title:'北校材料补充通知',text:'',url:false}];
  for(const item of notices)await db.collection('items').doc(item.id).set({scope:'school',schoolIds:[item.school],sourceId:'eval_source',sourceName:'MCP评估教务处',title:item.title,contentText:item.text,originalUrl:item.url?'https://example.test/evaluation/'+item.id:'',status:'published',publishedAt:'2026-10-27T00:00:00Z',categories:['school']});
  const full=await auth.createManual(guest,{name:'Fixture setup',scopes:['announcements:read','bookmarks:write','reminders:write']}),setup=(await auth.resolve(full.token))!;
  for(const item of notices)await tools('campus_set_bookmark',{schoolId:item.school,itemId:item.id,saved:true,requestId:'setup-bookmark-'+item.id},setup);
  for(const [id,due]of [['north-project','2027-05-18T09:00:00+08:00'],['south-team','2027-05-17T09:00:00+08:00']]){const item=notices.find(row=>row.id===id)!;await tools('campus_save_reminder',{schoolId:item.school,itemId:id,label:item.title,dueAt:due,days:[0],requestId:'setup-reminder-'+id},setup);}
  await auth.revoke(guest,full.connection.id);
  const issued=await auth.createManual(guest,{name:'Evaluation read only',scopes:['announcements:read','bookmarks:read','reminders:read']}),handler=createCampusMcpHttp({pool,auth,tools,address:()=> 'evaluation',now});
  await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+issued.token}},fetch:(input,init)=>handler(new Request(input,init))}));
  let calls=0;const call=async(name:string,args:Record<string,unknown>={})=>{assert.ok(!/set_bookmark|add_reminders|save_reminder|remove_reminder/.test(name));calls++;const result=await client.callTool({name,arguments:args});assert.ok(!result.isError,JSON.stringify(result));return(result.structuredContent as any).data;};
  const school=async(keyword:string)=>(await call('campus_list_schools',{keyword,limit:1})).items[0].id;
  const find=async(keyword:string,title:string)=>{const schoolId=await school(keyword),found=(await call('campus_search_announcements',{schoolId,keyword:title,limit:1})).items[0];return call('campus_read_announcement',{schoolId,itemId:found.id});};
  const all=async(name:string)=>{const rows:any[]=[];let cursor='0';do{const page=await call(name,{limit:1,cursor});rows.push(...page.items);cursor=page.nextCursor;}while(cursor);return rows;};
  const details=async()=>Promise.all((await all('campus_list_bookmarks')).map(row=>call('campus_read_announcement',{schoolId:row.schoolId,itemId:row.itemId})));
  const solvers=[
   async()=>String((await find('MCP评估北校','课程项目')).text.match(/2027-05-20/)[0]),
   async()=>String((await find('MCP评估北校','课程项目')).originalUrl),
   async()=>String((await details()).find(row=>row.id==='north-project').text.match(/北楼203室/)[0]),
   async()=>{const notice=await find('MCP评估北校','课程项目'),reminder=(await all('campus_list_reminders')).find(row=>row.itemId===notice.id);return String((Date.parse(notice.text.match(/2027-05-20/)[0]+'T00:00:00+08:00')-Date.parse(reminder.dueAt)+9*3600000)/86400000);},
   async()=>{const rows=await all('campus_list_reminders');for(const row of rows)await call('campus_read_announcement',{schoolId:row.schoolId,itemId:row.itemId});return rows.sort((a,b)=>Date.parse(a.dueAt)-Date.parse(b.dueAt))[0].title;},
   async()=>{const bookmarks=await all('campus_list_bookmarks'),reminders=await all('campus_list_reminders');return String(bookmarks.filter(row=>reminders.some(r=>r.itemId===row.itemId&&r.dueAt)).length);},
   async()=>String((await details()).find(row=>!row.bodyAvailable).title),
   async()=>{const a=await find('MCP评估北校','课程项目'),b=await find('MCP评估南校','团队赛');assert.equal(a.sourceName,b.sourceName);return a.sourceName;},
   async()=>String((await find('MCP评估南校','团队赛')).text.match(/总名额(\d+)/)[1]),
   async()=>String((await details()).filter(row=>row.bodyAvailable&&row.originalUrl).length)
  ];
  const xml=await readFile(new URL('../../../docs/mcp-evaluation.xml',import.meta.url),'utf8'),pairs=[...xml.matchAll(/<qa_pair><question>(.*?)<\/question><answer>(.*?)<\/answer><\/qa_pair>/gs)];assert.equal(pairs.length,10);
  for(const [index,pair]of pairs.entries())await t.test(pair[1]!,async()=>{const before=calls;assert.equal(await solvers[index]!(),pair[2]);assert.ok(calls-before>=2);});
 }finally{await client.close();await native.end();await server.stop();}
});
