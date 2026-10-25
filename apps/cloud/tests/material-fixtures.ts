import {CFB} from 'xlsx';
/** Minimal synthetic binary documents; no third-party or user documents. */
export function fixturePdf(text='Synthetic campus material'){
 const stream=text?`BT /F1 12 Tf 20 80 Td (${text}) Tj ET`:'';
 const parts=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
 let value='%PDF-1.4\n',offsets=[0];for(const [index,part] of parts.entries()){offsets.push(Buffer.byteLength(value));value+=`${index+1} 0 obj\n${part}\nendobj\n`;}
 const start=Buffer.byteLength(value);value+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
 return new Uint8Array(Buffer.from(value));
}
export function fixtureDoc(encrypted=false){
 const text='合成旧版 Word 申请材料\r',word=Buffer.alloc(4096),table=Buffer.alloc(4096);
 word.writeUInt16LE(0xa5ec);word.writeUInt16LE(encrypted?0x0100:0,10);word.writeUInt32LE(0x400,0x18);word.writeUInt32LE(text.length,0x4c);Buffer.from(text,'utf16le').copy(word,0x400);
 table[0]=2;table.writeUInt32LE(16,1);table.writeUInt32LE(text.length,9);table.writeUInt32LE(0x400,15);
 const cfb=CFB.utils.cfb_new();CFB.utils.cfb_add(cfb,'WordDocument',word);CFB.utils.cfb_add(cfb,'0Table',table);
 return new Uint8Array(CFB.write(cfb,{type:'buffer'}));
}
export function fixtureDocx(bomb=false){
 const cfb=CFB.utils.cfb_new();
 CFB.utils.cfb_add(cfb,'[Content_Types].xml',Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
 CFB.utils.cfb_add(cfb,'word/document.xml',Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>合成 Word 报名材料测试</w:t></w:r></w:p></w:body></w:document>'));
 if(bomb)CFB.utils.cfb_add(cfb,'word/padding.bin',Buffer.alloc(33*1024*1024));
 return new Uint8Array(CFB.write(cfb,{type:'buffer',fileType:'zip',compression:true}));
}
