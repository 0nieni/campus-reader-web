import assert from 'node:assert/strict';
import {test} from 'node:test';
import {competitionDirectory,competitionNavigationSummary,directoryCollectionStatus} from '../src/competition-directory';
import {competitionSources} from '../src/competition-sources';

test('the full navigation retains all 203 linked projects, independent IDs and repeated URLs',()=>{
 assert.equal(competitionNavigationSummary.totalProjects,214);
 assert.equal(competitionNavigationSummary.unlinkedProjects.length,11);
 assert.equal(competitionDirectory.length,203);
 assert.equal(new Set(competitionDirectory.map(row=>row.id)).size,203);
 assert.equal(new Set(competitionDirectory.map(row=>row.entryUrl)).size,196);
 assert.deepEqual([...competitionDirectory.map(row=>row.number),...competitionNavigationSummary.unlinkedProjects.map(row=>row.number)].sort((a,b)=>a-b),Array.from({length:214},(_,i)=>i+1));
 const first=competitionDirectory.find(row=>row.number===207)!,second=competitionDirectory.find(row=>row.number===208)!;
 assert.notEqual(first.id,second.id);assert.notEqual(first.name,second.name);assert.equal(first.entryUrl,second.entryUrl);
 assert.equal(competitionDirectory.filter(row=>row.entryUrl==='https://ucc.fltrp.com/').length,5);
 for(const row of competitionDirectory){assert.ok(['http:','https:'].includes(new URL(row.entryUrl).protocol));assert.ok(row.name);assert.ok(row.entryType);}
});

test('directory inclusion does not promote unverified links to a collector or a live availability claim',()=>{
 assert.equal(competitionSources.length,5);assert.equal(new Set(competitionSources.map(row=>row.entryUrl)).size,4);
 for(const source of competitionSources){const entry=competitionDirectory.find(row=>row.id===source.id)!;assert.ok(entry);assert.equal(entry.entryUrl,source.entryUrl);assert.equal(entry.name,source.name);}
 const pdf=competitionDirectory.find(row=>row.number===20)!,wechat=competitionDirectory.find(row=>row.number===21)!;
 assert.equal(directoryCollectionStatus(pdf),'entry_only');assert.equal(directoryCollectionStatus(wechat),'entry_only');
 assert.equal(directoryCollectionStatus(competitionDirectory.find(row=>row.number===1)!),'pending');
 assert.ok(!competitionSources.some(row=>row.id===pdf.id));
});

test('trailing navigation annotations remain original file notes rather than live availability claims',()=>{
 assert.match(competitionDirectory.find(row=>row.number===32)!.note,/无具体公告/);
 assert.match(competitionDirectory.find(row=>row.number===45)!.note,/无法访问/);
 assert.match(competitionDirectory.find(row=>row.number===161)!.note,/首页有公告/);
});
