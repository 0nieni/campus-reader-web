import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {load} from 'cheerio/slim';
import type {WebsiteSourceInput} from '@campus/contracts';
import {AppError} from './errors';
import {approvedSchoolUrl,extractArticle,extractArticleTitle,extractNotices,fullDate,type SchoolPage,type SchoolSource} from './school-pages';
const bad=()=>new AppError('VALIDATION_FAILED','请检查来源名称、公开网址、类型和解析设置。');
export const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
export function websiteUrl(value:unknown):string {
  if(typeof value!=='string'||value.length>1800)throw bad();
  let u:URL;try{u=new URL(value);}catch{throw bad();}
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port||isIP(u.hostname)||!u.hostname.includes('.')||/\.(local|localhost|internal|test|invalid)$/.test(u.hostname)||/^(localhost|metadata|webvpn|vpn|sso|cas|auth)(\.|$)/i.test(u.hostname))throw bad();
  if([...u.searchParams.keys()].some(key=>/token|secret|password|session|cookie|ticket|authorization|api.?key/i.test(key)))throw new AppError('VALIDATION_FAILED','请使用不含登录凭据或临时令牌的公开网址。');
  u.hash='';return u.href;
}
const selectorKeys=new Set(['listItem','detailLink','title','content','publishedAt','itemsPath','titleField','urlField','contentField','dateField']);
export function sourceInput(value:unknown):WebsiteSourceInput {
  if(!value||typeof value!=='object'||Array.isArray(value))throw bad();
  const v=value as Record<string,any>;
  if(Object.keys(v).some(key=>!['name','entryUrl','type','categories','intervalMinutes','selectors','allowAi','authorized'].includes(key)))throw bad();
  if(typeof v.name!=='string'||v.name.trim().length<2||v.name.length>80||!['html_list','html_detail','rss','json_api'].includes(v.type)||!Array.isArray(v.categories)||!v.categories.length||v.categories.length>6||v.categories.some((c:unknown)=>!['school','college','competition','academic','activity','scholarship'].includes(String(c)))||!Number.isInteger(v.intervalMinutes)||v.intervalMinutes<15||v.intervalMinutes>1440||typeof v.allowAi!=='boolean'||v.authorized!==true)throw bad();
  if(!v.selectors||typeof v.selectors!=='object'||Array.isArray(v.selectors)||Object.entries(v.selectors).some(([key,val])=>!selectorKeys.has(key)||typeof val!=='string'||val.length>200||/__proto__|prototype|constructor/.test(val)))throw bad();
  return{name:v.name.trim(),entryUrl:websiteUrl(v.entryUrl),type:v.type,categories:[...new Set(v.categories as string[])],intervalMinutes:v.intervalMinutes,selectors:{...v.selectors},allowAi:v.allowAi,authorized:true};
}
export function parserSource(config:WebsiteSourceInput,id:string):SchoolSource {
  return{id,name:config.name,announcementUrl:config.entryUrl,homepage:new URL(config.entryUrl).origin+'/',exactHost:true,...(config.selectors.listItem?{listSelector:config.selectors.listItem}:{}),...(config.selectors.content?{articleSelector:config.selectors.content}:{}),...(config.selectors.publishedAt?{dateSelector:config.selectors.publishedAt}:{})};
}
export interface WebsiteEntry {url:string;title:string;publishedAt:string|null;contentText?:string}
const plain=(html:string)=>{const $=load(html);$('script,style,iframe,form').remove();return $.text().replace(/\s+/g,' ').trim().slice(0,60000);};
const field=(value:any,path:string)=>path.split('.').filter(Boolean).reduce((v,key)=>v&&typeof v==='object'&&Object.prototype.hasOwnProperty.call(v,key)?v[key]:undefined,value);
function publishedDate(value:unknown):string|null {
  if(typeof value!=='string')return null;
  if(/^20\d{2}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&fullDate(value)){
    const time=Date.parse(value);return Number.isFinite(time)?new Date(time).toISOString():null;
  }
  const date=fullDate(value);if(date)return date;
  // RSS commonly uses RFC 2822. Require an explicit year and timezone.
  if(!/\b20\d{2}\b/.test(value)||!/(?:GMT|UTC|[+-]\d{4})\s*$/.test(value))return null;
  const time=Date.parse(value);return Number.isFinite(time)?new Date(time).toISOString():null;
}
export function parseWebsite(page:SchoolPage,config:WebsiteSourceInput,id:string):WebsiteEntry[] {
  const school=parserSource(config,id),rows:WebsiteEntry[]=[];
  const push=(title:unknown,url:unknown,date:unknown,content?:unknown)=>{
    if(typeof title!=='string'||typeof url!=='string')return;
    try{const target=websiteUrl(approvedSchoolUrl(new URL(url,page.url).href,school).href);const text=plain(title);if(text.length<4||text.length>220||rows.some(row=>row.url===target))return;rows.push({url:target,title:text,publishedAt:publishedDate(date),...(typeof content==='string'&&plain(content).length>=30?{contentText:plain(content)}:{})});}catch{}
  };
  try {
    if(config.type==='html_detail') {
      const $=load(page.html),title=extractArticleTitle(page,config.selectors.title);
      const contentText=extractArticle(page,school);push(title,page.url,config.selectors.publishedAt?$(config.selectors.publishedAt).first().text():'',contentText);
    }else if(config.type==='html_list') {
      if(!config.selectors.detailLink&&!config.selectors.title){
        const entries=extractNotices(page,school).flatMap(row=>{try{return[{title:row.title,url:websiteUrl(row.url),publishedAt:row.publishedAt}];}catch{return[];}});
        if(!entries.length)throw new AppError('SOURCE_PARSE_FAILED','未找到公告，请调整解析设置或检查是否为公开列表页。');
        return entries;
      }
      const $=load(page.html);$('script,style,nav,header,footer').remove();
      $(config.selectors.listItem||'li').slice(0,30).each((_,el)=>{const root=$(el),link=root.find(config.selectors.detailLink||'a[href]').first();push(config.selectors.title?root.find(config.selectors.title).first().text():link.attr('title')||link.text(),link.attr('href'),config.selectors.publishedAt?root.find(config.selectors.publishedAt).first().text():'');});
    }else if(config.type==='rss') {
      const $=load(page.html,{xmlMode:true});$('item,entry').slice(0,30).each((_,el)=>{const row=$(el);push(row.find('title').first().text(),row.find('link').filter((_,link)=>!$(link).attr('rel')||$(link).attr('rel')==='alternate').first().attr('href')||row.find('link').first().text(),row.find('pubDate,published,updated').first().text(),row.find('content\\:encoded,content,description,summary').first().text());});
    }else {
      const data=JSON.parse(page.html),list=Array.isArray(data)?data:field(data,config.selectors.itemsPath||'data.list');
      if(Array.isArray(list))for(const row of list.slice(0,30))push(field(row,config.selectors.titleField||'title'),field(row,config.selectors.urlField||'url'),field(row,config.selectors.dateField||'publishedAt'),field(row,config.selectors.contentField||'content'));
    }
  }catch(error){if(error instanceof AppError)throw error;throw new AppError('SOURCE_PARSE_FAILED','解析设置未匹配，请调整选择器或确认接口返回格式。');}
  if(!rows.length)throw new AppError('SOURCE_PARSE_FAILED','未找到公告。请调整解析设置；登录或仅JS渲染的页面需要手动导入，本站不代为登录。');
  return rows.slice(0,30);
}
/** Most-specific matching user-agent; longest allow/disallow path wins. */
export function robotsAllowed(text:string,url:string):boolean {
  const groups:Array<{agents:string[];rules:Array<{allow:boolean;path:string}>}>=[];let group:{agents:string[];rules:Array<{allow:boolean;path:string}>}|undefined;
  for(const line of text.split(/\r?\n/)){const match=/^\s*(user-agent|allow|disallow)\s*:\s*([^#]*)/i.exec(line);if(!match)continue;const key=match[1]!.toLowerCase(),value=match[2]!.trim();if(key==='user-agent'){if(!group||group.rules.length){group={agents:[],rules:[]};groups.push(group);}group.agents.push(value.toLowerCase());}else if(group&&value)group.rules.push({allow:key==='allow',path:value});}
  const specific=groups.filter(g=>g.agents.some(a=>a!=='*'&&'campusreader'.includes(a))),chosen=specific.length?specific:groups.filter(g=>g.agents.includes('*'));
  const target=new URL(url),path=target.pathname+target.search;
  const matches=chosen.flatMap(g=>g.rules).filter(rule=>{const pattern=rule.path.split('*').map(p=>p.replace(/[.+?^{}()|[\]\\]/g,'\\$&')).join('.*').replace(/\$$/,'$');return new RegExp('^'+pattern).test(path);}).sort((a,b)=>b.path.length-a.path.length||Number(b.allow)-Number(a.allow));
  return matches[0]?.allow??true;
}
