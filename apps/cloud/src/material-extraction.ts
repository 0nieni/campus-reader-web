import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { load } from 'cheerio/slim';
import { approvedSchoolUrl, type SchoolPage, type SchoolSource } from './school-pages';

export interface MaterialText { state: 'ready'|'no_text'|'protected'|'limited'|'failed'|'unsupported'; text: string; message: string }
export interface AttachmentCandidate { url: string; filename: string }
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const parserRequire = createRequire(import.meta.url);

export function attachmentCandidates(page: SchoolPage, source: SchoolSource): AttachmentCandidate[] {
  const $ = load(page.html), rows: AttachmentCandidate[] = [];
  $('script,style,nav,header,footer').remove();
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href') || '', label = $(element).text().replace(/\s+/g,' ').trim();
    if (!href || /^(?:javascript|data|file):/i.test(href)) return;
    try {
      const url = approvedSchoolUrl(new URL(href,page.url).href,source);
      let name = decodeURIComponent(url.pathname.split('/').pop() || '');
      const named = /([^/\\<>]{1,180}\.(?:pdf|docx?|xlsx?))\b/i.exec(label)?.[1];
      if (named) name = named;
      if (!/\.(?:pdf|docx?|xlsx?)$/i.test(name)) return;
      if (!rows.some(row=>row.url===url.href)) rows.push({url:url.href,filename:name.replace(/[\r\n\0/\\]/g,'_').slice(0,200)});
    } catch { /* Only document links inside the approved source scope. */ }
  });
  return rows;
}

// Trusted parser program only. Untrusted file bytes travel through structured
// clone, never code interpolation. A worker bounds CPU, heap and ZIP expansion.
const parserProgram = String.raw`
const {parentPort,workerData}=require('node:worker_threads');
(async()=>{
 const bytes=Buffer.from(workerData.bytes),name=workerData.filename.toLowerCase(),cap=200000;
 const output=(state,text,message)=>parentPort.postMessage({state,text,message});
 let text='',limited=false;
 const zip=bytes[0]===0x50&&bytes[1]===0x4b;
 const pdf=bytes.subarray(0,1024).includes(Buffer.from('%PDF-'));
 const ole=bytes.subarray(0,8).equals(Buffer.from([208,207,17,224,161,177,26,225]));
 let entries=[];
 if(zip){
  const imported=await import(workerData.modules.yauzl),yauzl=imported.default||imported;
  entries=await new Promise((resolve,reject)=>yauzl.fromBuffer(bytes,{lazyEntries:true,validateEntrySizes:true,strictFileNames:true},(error,reader)=>{
   if(error)return reject(error);let size=0,names=[];
   reader.on('error',reject);reader.on('end',()=>resolve(names));
   reader.on('entry',entry=>{
    size+=entry.uncompressedSize;
    if(entry.generalPurposeBitFlag&1){reader.close();return reject(Error('encrypted archive'));}
    if(size>40*1024*1024||entry.uncompressedSize>32*1024*1024||names.length>=2000||entry.fileName.split('/').includes('..')){reader.close();return reject(Error('archive limit'));}
    names.push(entry.fileName);reader.readEntry();
   });reader.readEntry();
  }));
 }
 if(ole){
  const imported=await import(workerData.modules.xlsx),xlsx=imported.CFB?imported:imported.default,cfb=xlsx.CFB.read(bytes,{type:'buffer'});
  const word=xlsx.CFB.find(cfb,'WordDocument');
  if(xlsx.CFB.find(cfb,'EncryptedPackage')||(word&&word.content.length>12&&(Buffer.from(word.content).readUInt16LE(10)&0x0100)))throw Error('encrypted document');
 }
 if(pdf){
  const {getDocumentProxy}=await import(workerData.modules.unpdf);
  const doc=await getDocumentProxy(new Uint8Array(bytes),{isEvalSupported:false,maxImageSize:16777216,disableFontFace:true,useSystemFonts:false,verbosity:0});
  try{
   limited=doc.numPages>200;
   for(let number=1;number<=Math.min(doc.numPages,200);number++){
    const page=await doc.getPage(number),content=await page.getTextContent();
    text+='\n[第 '+number+' 页]\n'+content.items.map(item=>typeof item.str==='string'?item.str+(item.hasEOL?'\n':' '):'').join('');
    if(text.length>cap){limited=true;break;}
   }
   if(!text.replace(/\[第 \d+ 页\]/g,'').trim())return output('no_text','','扫描件或无可提取文字，已保留原文件；本版不进行 OCR。');
  }finally{await doc.loadingTask.destroy();}
 }else if((zip&&entries.includes('word/document.xml'))||(ole&&/\.doc$/.test(name))){
  const imported=await import(workerData.modules.word),Word=imported.default||imported;
  const doc=await new Word().extract(bytes);
  text=[doc.getBody(),doc.getHeaders(),doc.getFootnotes(),doc.getEndnotes(),doc.getTextboxes()].filter(Boolean).join('\n');
 }else if((zip&&entries.includes('xl/workbook.xml'))||(ole&&/\.xls$/.test(name))){
  const imported=await import(workerData.modules.xlsx),xlsx=imported.read?imported:imported.default;
  const book=xlsx.read(bytes,{type:'buffer',cellFormula:false,cellHTML:false,bookVBA:false,sheetRows:10001});
  for(const title of book.SheetNames){
   const sheet=book.Sheets[title];if(!sheet||!sheet['!ref'])continue;
   const range=xlsx.utils.decode_range(sheet['!ref']),full=sheet['!fullref']?xlsx.utils.decode_range(sheet['!fullref']):range;
   limited=limited||full.e.r>9999||full.e.c>199;range.e.r=Math.min(range.e.r,9999);range.e.c=Math.min(range.e.c,199);
   text+='\n[工作表 '+title+']\n'+xlsx.utils.sheet_to_csv(sheet,{FS:'\t',RS:'\n',blankrows:false,range}).slice(0,cap);
   if(text.length>cap){limited=true;break;}
  }
 }else return output('unsupported','','文件内容不是可支持的 PDF、Word 或 Excel。');
 limited=limited||text.length>cap;text=text.slice(0,cap).replace(/\u0000/g,'').trim();
 output(limited?'limited':text?'ready':'no_text',text,limited?'文本超过页数、行列或字符上限，仅提取部分；完整原文件已保存。':text?'文本已提取。':'未提取到文字，原文件已保存。');
})().catch(error=>parentPort.postMessage({state:/password|encrypted/i.test(String(error&&error.message))?'protected':'failed',text:'',message:/password|encrypted/i.test(String(error&&error.message))?'文件加密，已保留原文件。':'文本提取失败或文件超出安全限制，已保留原文件。'}));
`;

export async function extractMaterialText(bytes: Uint8Array, filename: string): Promise<MaterialText> {
  if (bytes.byteLength>MAX_FILE_BYTES) return {state:'failed',text:'',message:'文件超过 10 MiB 采集上限。'};
  const modules = Object.fromEntries(Object.entries({unpdf:'unpdf',word:'word-extractor',xlsx:'xlsx',yauzl:'yauzl'}).map(([key,name])=>[key,pathToFileURL(parserRequire.resolve(name)).href]));
  return new Promise(resolve=>{
    let settled=false;
    const worker=new Worker(parserProgram,{eval:true,execArgv:[],workerData:{bytes,filename,modules},resourceLimits:{maxOldGenerationSizeMb:192}});
    const finish=(result:MaterialText)=>{if(settled)return;settled=true;clearTimeout(timer);void worker.terminate();resolve(result);};
    const timer=setTimeout(()=>finish({state:'failed',text:'',message:'提取超时，已保留原文件。'}),15000);
    worker.once('message',(value:MaterialText)=>finish(value));
    worker.once('error',()=>finish({state:'failed',text:'',message:'提取超出资源限制或解析失败，已保留原文件。'}));
    worker.once('exit',()=>{if(!settled)finish({state:'failed',text:'',message:'提取未完成，已保留原文件。'});});
  });
}
