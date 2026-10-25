import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
// SHA-256 of the exact <style> contents supplied in login(1).html and index(1).html.
// A visual redesign needs a deliberate new reference, not an accidental palette edit.
it('retains both supplied template stylesheets byte-for-byte',()=>{
  for(const [file,expected] of [['template-login.css','b65c4787d185f8eec7a7fe689e641c2be70a60219401d2e4251aecefbe96a189'],['template-portal.css','6534e550cdb6bbbc0ed004db1790020a31321163a7c80fe7ae208d95da4fd206']]){
    expect(createHash('sha256').update(readFileSync(new URL('../src/'+file,import.meta.url))).digest('hex')).toBe(expected);
  }
});
