import assert from 'node:assert/strict';
import { test } from 'node:test';
import {fileURLToPath} from 'node:url';
import {NetlifyDB} from '@netlify/database-dev';
import {getDatabase} from '@netlify/database';
import {postgresRepository} from '../src/postgres-repository';
import {postgresStorage,type SqlPool} from '../src/postgres-storage';
import {createGateway} from '../src/gateway';
import {bookmarksService} from '../src/bookmarks';
test('personal notice labels preserve authorization, account isolation and filter pagination in real local SQL',async t=>{
  const server=new NetlifyDB({logger(){}}),connectionString=await server.start(),pool=getDatabase({connectionString}).pool;
  (pool as unknown as {options:{max:number}}).options.max=1;
  const sql=pool as unknown as SqlPool,repo=postgresRepository(sql),db=postgresStorage(sql);
  const call=(owner:string,action:string,input={})=>createGateway(repo,{ownerUid:owner,dataOwnerId:owner},Date.now,{bookmarks:bookmarksService(db,repo)})({action,input},{uid:owner,isAnonymous:false});
  const data=async(owner:string,action:string,input={})=>{const result=await call(owner,action,input);assert.ok(result.ok,JSON.stringify(result));return result.data as any;};
  const keyword='个人标签回归';
  const base={scope:'school',schoolIds:['bjtu'],status:'published',categories:['school'],publishedAt:new Date().toISOString(),sourceId:'fixture',contentText:'标签回归测试正文，不使用真实模型。'};
  try {
    await server.applyMigrations(fileURLToPath(new URL('../../../netlify/database/migrations',import.meta.url)));
    for(const owner of ['member_a','member_b']) await repo.selectSchool(owner,'bjtu');
    for(let index=0;index<25;index++) await db.collection('items').doc(`label_${String(index).padStart(3,'0')}`).set({...base,title:`${keyword}${index}`});
    await db.collection('items').doc('label_private').set({...base,title:keyword+'私人邮件',scope:'private',categories:['mail'],ownerOpenid:'member_a'});
    await db.collection('items').doc('label_other_school').set({...base,title:keyword+'其他学校',schoolIds:['school_001']});
    await t.test('editing changes only the caller display and query; original content and access metadata remain intact',async()=>{
      await data('member_a','feed.labels.set',{schoolId:'bjtu',itemId:'label_000',categories:['competition','activity','competition']});
      const a=await data('member_a','feed.detail',{schoolId:'bjtu',itemId:'label_000'}),b=await data('member_b','feed.detail',{schoolId:'bjtu',itemId:'label_000'});
      assert.deepEqual(a.categories,['competition','activity']);assert.equal(a.categoriesCustomized,true);assert.deepEqual(a.defaultCategories,['school']);
      assert.deepEqual(b.categories,['school']);assert.equal(b.categoriesCustomized,false);assert.deepEqual((await repo.item('label_000'))!.categories,['school']);
      const filtered=await data('member_a','feed.list',{schoolId:'bjtu',keyword,categories:['competition']});assert.deepEqual(filtered.items.map((r:any)=>r.id),['label_000']);
      assert.deepEqual((await data('member_b','feed.list',{schoolId:'bjtu',keyword,categories:['competition']})).items,[]);
      await data('member_a','favorites.set',{schoolId:'bjtu',itemId:'label_000',saved:true});
      assert.deepEqual((await data('member_a','favorites.list',{})).items[0].notice.categories,['competition','activity']);
    });
    await t.test('effective labels filter before pagination and no selection produces no rows',async()=>{
      const page=await data('member_a','feed.list',{schoolId:'bjtu',keyword,categories:['school']});assert.equal(page.items.length,20);assert.equal(page.nextCursor,'20');
      const next=await data('member_a','feed.list',{schoolId:'bjtu',keyword,categories:['school'],cursor:page.nextCursor});assert.equal(next.items.length,4);assert.equal(next.nextCursor,null);
      assert.ok(![...page.items,...next.items].some((row:any)=>row.id==='label_000'));
      assert.deepEqual(await data('member_a','feed.list',{schoolId:'bjtu',keyword,categories:[]}),{items:[],nextCursor:null});
    });
    await t.test('a personal mail label cannot make a public notice private or reveal another account mail',async()=>{
      await data('member_a','feed.labels.set',{schoolId:'bjtu',itemId:'label_001',categories:['mail']});
      assert.ok((await data('member_b','feed.detail',{schoolId:'bjtu',itemId:'label_001'})).id);
      await data('member_a','feed.labels.set',{schoolId:'bjtu',itemId:'label_private',categories:['school']});
      assert.equal((await call('member_b','feed.detail',{schoolId:'bjtu',itemId:'label_private'})).ok,false);
      assert.equal((await call('member_b','feed.labels.set',{schoolId:'bjtu',itemId:'label_private',categories:['school']})).ok,false);
      assert.deepEqual((await repo.item('label_private'))!.categories,['mail']);
    });
    await t.test('forged ownership, cross-school notices, empty/invalid labels are rejected; restore removes only the caller override',async()=>{
      for(const input of [
        {schoolId:'bjtu',itemId:'label_000',categories:['school'],owner:'member_b'},
        {schoolId:'bjtu',itemId:'label_other_school',categories:['school']},
        {schoolId:'bjtu',itemId:'label_000',categories:[]},
        {schoolId:'bjtu',itemId:'label_000',categories:['<script>']},
      ])assert.equal((await call('member_a','feed.labels.set',input)).ok,false);
      const restored=await data('member_a','feed.labels.set',{schoolId:'bjtu',itemId:'label_000',categories:null});assert.deepEqual(restored,{categories:['school'],customized:false});
      assert.equal(await repo.selectedSchool('member_a'),'bjtu');assert.equal((await data('member_a','favorites.list')).items.length,1);
    });
  }finally{await pool.end();await server.stop();}
});
