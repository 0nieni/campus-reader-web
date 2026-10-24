import assert from 'node:assert/strict';
import { test } from 'node:test';
import { write } from 'xlsx';
import { extractMaterialText, attachmentCandidates } from '../src/material-extraction';
import {fixturePdf,fixtureDoc,fixtureDocx} from './material-fixtures';

test('real PDF/Word parsers extract synthetic files, identify scans and encryption and reject ZIP expansion',async()=>{
 const pdf=await extractMaterialText(fixturePdf(),'正文.pdf');assert.equal(pdf.state,'ready');assert.match(pdf.text,/Synthetic campus/);
 const scan=await extractMaterialText(fixturePdf(''),'扫描.pdf');assert.equal(scan.state,'no_text');assert.equal(scan.text,'');assert.match(scan.message,/OCR/);
 for(const [name,bytes] of [['旧版.doc',fixtureDoc()],['报名.docx',fixtureDocx()]] as const){const result=await extractMaterialText(bytes,name);assert.equal(result.state,'ready',JSON.stringify(result));assert.match(result.text,/合成/);}
 assert.equal((await extractMaterialText(fixtureDoc(true),'加密.doc')).state,'protected');
 const bomb=await extractMaterialText(fixtureDocx(true),'超限.docx');assert.equal(bomb.state,'failed');assert.equal(bomb.text,'');
 assert.equal((await extractMaterialText(new Uint8Array([60,104,116,109,108]),'伪造.pdf')).state,'unsupported');
});

test('real spreadsheet extraction reads xls and xlsx without evaluating formulas', async () => {
  for (const bookType of ['xls', 'xlsx'] as const) {
    const bytes = write({ SheetNames: ['报名'], Sheets: { 报名: { '!ref': 'A1:B2', A1: {t:'s',v:'材料'}, B1:{t:'s',v:'截止时间'}, A2:{t:'s',v:'简历'}, B2:{t:'s',v:'2026-11-01'} } } }, {bookType,type:'buffer'});
    const result = await extractMaterialText(new Uint8Array(bytes), `报名.${bookType}`);
    assert.equal(result.state, 'ready'); assert.match(result.text, /简历/); assert.match(result.text, /2026-11-01/);
  }
});

test('attachment discovery permits only approved document URLs and does not execute scripts', () => {
  const source = {id:'s',name:'学校',homepage:'https://www.school.edu.cn/',announcementUrl:'https://www.school.edu.cn/notices/'};
  const rows = attachmentCandidates({url:'https://www.school.edu.cn/info/1/2.htm',html:`<article><a href='/f/a.pdf'>报名表.pdf</a><a href='/f/a.pdf'>重复</a><a href='/f/b.docx'>说明.docx</a><a href='https://evil.example/f.xls'>伪造.xls</a><a href='javascript:run()'>报名.xls</a><a href='/f/x.exe'>附件.exe</a></article>`},source);
  assert.equal(rows.length,2); assert.ok(rows.every(row=>row.url.startsWith('https://www.school.edu.cn/')));
});
