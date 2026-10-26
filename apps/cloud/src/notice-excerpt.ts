import type {ItemRow} from './repository';
/** A bounded quote from already-authorized material; never an AI summary. */
export function noticeExcerpt(row:ItemRow,now=Date.now()):string|null {
 for(const expiry of [row.materialExpiresAt,row.aiSearchExpiresAt])if(expiry&&(!Number.isFinite(Date.parse(expiry))||Date.parse(expiry)<=now))return null;
 if(typeof row.contentText!=='string')return null;
 const title=String(row.title||'').trim();
 const text=row.contentText.replace(/\r\n?/g,'\n').split(/\n+/).map(line=>line.replace(/[\s\u200b\ufeff]+/g,' ').trim()).filter(line=>line&&line!==title&&!/^(?:发布时间|发布日期|阅读次数|浏览次数)\s*[:：]/.test(line)).join(' ');
 if(text.length<30)return null;
 if(text.length<=120)return text;
 return text.slice(0,120).trimEnd()+'…';
}
