import type {School} from '@campus/contracts';
import type {SchoolSource} from './school-pages';

export interface PublicSchoolSource extends SchoolSource { key:string; label:string }
interface Entry { key:string; label:string; url:string; listSelector?:string; articleSelector?:string; dateSelector?:string; homepage?:string }
interface Coverage { note:string; entries:Entry[] }
const entry=(key:string,label:string,url:string,articleSelector?:string):Entry=>({key,label,url,...(articleSelector?{articleSelector}:{})});
// Reviewed official public columns, not a claim of access to the campus portal.
// URLs and selectors are server constants; browser inputs cannot add fetch hosts.
const reviewed:Record<string,Coverage>={
 bjtu:{note:'覆盖学校主站、本科生院、计算机学院和文件所列创新创业中心的公开通知。创新创业中心专题目前仅展示2024年历史通知且列表无发布日期，不代表近期更新；校内登录内容不在采集范围。',entries:[entry('directory','目录公开公告入口','https://www.bjtu.edu.cn/tzgg/'),{...entry('bjtu-bksy','北京交通大学 · 本科生院通知公告','https://bksy.bjtu.edu.cn/Admin/PageList.ashx?pc=271891'),dateSelector:'.spTime'},entry('bjtu-cs-tzgg','北京交通大学 · 计算机学院通知公告','https://cs.bjtu.edu.cn/tzgg/index.htm'),{...entry('bjtu-innovation','北京交通大学 · 创新创业教育中心（历史通知栏目）','https://bksy.bjtu.edu.cn/center/cc/638521937252901248.html'),listSelector:'.textright_news'}]},
 school_001:{note:'覆盖教务部公开通知；学校主站旧公告数据较旧，校内门户内容不在采集范围。',entries:[entry('teaching','教务部 · 通知公告','https://dean.pku.edu.cn/web/notice.php','.newsinfo_box')]},
 school_002:{note:'覆盖以下院系的公开通知和学术活动；学校信息门户需要登录，未接入校内公告。',entries:[entry('statistics','统计与数据科学系 · 通知公告','https://www.stat.tsinghua.edu.cn/xwdt/tzgg.htm'),entry('psychology','心理与认知科学系 · 学术活动','https://www.pcs.tsinghua.edu.cn/xwdt/xshd.htm')]},
 school_003:{note:'覆盖本科生院公开通知，不包括需校内登录的内容。',entries:[entry('teaching','本科生院 · 通知公告','http://jiaowu.ruc.edu.cn/gnsz/sylb/tzggconfig/index.htm','.page-detail .content')]},
 school_004:{note:'覆盖教务部学生专区和新闻网公开通知；i北航登录门户不采集。',entries:[entry('teaching','教务部 · 学生专区','https://jiaowu.buaa.edu.cn/tzgg/xszq.htm'),entry('notices','新闻网 · 通知公告','https://news.buaa.edu.cn/tzgg.htm')]},
 school_007:{note:'覆盖教务部公开通知；指向学校登录平台的链接不采集。',entries:[entry('teaching','教务部 · 通知公告','https://jwb.bnu.edu.cn/tzgg/','.m-details .txt')]},
 school_011:{note:'覆盖教务处公开通知。',entries:[entry('teaching','教务处 · 通知通告','https://jwc.ustb.edu.cn/tztg/index.htm','.articlePage .article')]},
 school_013:{note:'补充后勤部公开通知；新闻网入口暂时不稳定。',entries:[entry('logistics','后勤部 · 通知公告','https://hq.bupt.edu.cn/tzgg.htm')]},
 school_014:{note:'补充教务快讯，原信息公开栏目不代表学生日常公告。',entries:[entry('teaching','教务处 · 教务快讯','https://jwc.bjfu.edu.cn/jwkx/index.html','#con_c')]},
 school_019:{note:'仅覆盖招生就业处公开信息；研究生院原入口连接不稳定。',entries:[entry('admissions','招生就业处 · 公开通知','https://aeo.uibe.edu.cn/','.mainWrap .content')]},
 school_021:{note:'仅覆盖网络信息中心公开通知；数字校园登录门户不采集。',entries:[entry('it','网络信息中心 · 通知公告','https://nic.ccom.edu.cn/xw/tzgg.htm')]},
 school_036:{note:'补充教务处公开通知。',entries:[entry('teaching','教务处 · 通知公告','https://jwc.dlmu.edu.cn/index/tzgg.htm')]},
 school_040:{note:'覆盖本科生院公开信息，首页其他校园新闻不作为公告导入。',entries:[entry('teaching','本科生院 · 公开通知','https://hituc.hit.edu.cn/')]},
 school_043:{note:'补充本科生院学生通知，信息公开制度文件不作为日常公告导入。',entries:[entry('teaching','本科生院 · 学生通知','https://bksy.nefu.edu.cn/gztz/xstz.htm')]},
 school_052:{note:'补充本科生院公开通知。',entries:[entry('teaching','本科生院 · 公开通知','https://bksy.shu.edu.cn/')]},
 school_054:{note:'覆盖本科生院公告通知，不把校园新闻栏目作为公告。',entries:[entry('teaching','本科生院 · 公告通知','https://jw.nju.edu.cn/ggtz/list.htm')]},
 school_055:{note:'仅覆盖研究生院学生工作公开通知，校内门户不采集。',entries:[entry('graduate','研究生院 · 学生工作通知','https://seugs.seu.edu.cn/26668/list.htm')]},
 school_056:{note:'仅覆盖研究生院公开通知，校内文件系统不采集。',entries:[entry('graduate','研究生院 · 通知公告','https://yjs.suda.edu.cn/35703/list.htm')]},
 school_057:{note:'覆盖教务处公开通知。',entries:[entry('teaching','教务处 · 公开通知','https://aao.nuaa.edu.cn/')]},
 school_058:{note:'仅覆盖研究生院培养工作公开通知。',entries:[entry('graduate','研究生院 · 培养工作通知','https://gs.njust.edu.cn/tzgg/list.htm')]},
 school_064:{note:'已更新学校官网域名，覆盖官网首页公开通知；独立公告栏目暂不可用。',entries:[{...entry('notices','学校官网 · 首页公开通知','https://www.nnu.edu.cn/'),homepage:'https://www.nnu.edu.cn/'}]},
 school_065:{note:'仅覆盖工程师学院公开通知；不接入指向学校VPN的内部教学链接。',entries:[entry('engineering','工程师学院 · 公开通知','https://pi.zju.edu.cn/qbtz/list.htm')]},
 school_070:{note:'补充教务处教学通知，不把采购公告作为学生教学通知。',entries:[entry('teaching','教务处 · 教学通知','https://jwch.fzu.edu.cn/jxtz.htm')]},
 school_080:{note:'补充本科生院公开通知，校内门户不采集。',entries:[entry('teaching','本科生院 · 通知公告','https://bksy.hzau.edu.cn/jgsz/tzgg.htm')]},
 school_084:{note:'覆盖本科生院可公开读取的通知；指向OA受限页面的通知暂不支持正文读取。',entries:[entry('teaching','本科生院 · 教学运行通知','https://bksy.csu.edu.cn/tztg/jxyxyxxhjsbgs.htm')]},
 school_087:{note:'覆盖教务部公开通知，学校门户内部公告不采集。',entries:[entry('teaching','教务部 · 通知通告','https://jwb.sysu.edu.cn/newscenter/notice')]},
 school_088:{note:'覆盖学校官网教学科研通知，不导入综合新闻。',entries:[entry('teaching','学校官网 · 教学科研通知','https://www.scut.edu.cn/new/9011/list.htm')]},
 school_090:{note:'仅覆盖研究生院公开通知，教务登录系统不采集。',entries:[entry('graduate','研究生院 · 通知公告','https://yjsy.scnu.edu.cn/tzgg/')]},
 school_097:{note:'已更新为学校官网公开通知栏目。',entries:[entry('notices','学校官网 · 通知公告','https://www.swjtu.edu.cn/index/tzgg.htm')]},
 school_102:{note:'覆盖学生工作部和研究生招生公开通知；学校主站动态列表暂未接入。',entries:[entry('students','学生工作部 · 通知公告','https://xgc.xzu.edu.cn/xwgg/tzgg.htm'),entry('admissions','研究生招生 · 通知公告','https://yjszs.xzu.edu.cn/tzgg.htm')]},
 school_103:{note:'覆盖教务处公开教学通知，OA内部公告不采集。',entries:[entry('teaching','教务处 · 教学通知','https://due.xjtu.edu.cn/jxxx/jxtz2.htm')]},
 school_107:{note:'覆盖教务处公开通知，原通知系统提示页不作为公告。',entries:[entry('teaching','教务处 · 通知公告','https://jwc.xidian.edu.cn/tzgg.htm')]},
 school_109:{note:'覆盖教务处公开通知，OA会议安排不作为学生公告来源。',entries:[entry('teaching','教务处 · 公开通知','https://jwc.snnu.edu.cn/')]},
 school_110:{note:'已更新至当前最新通知栏目，包含采购公示；不把历史页面当作近期公告。',entries:[entry('notices','学校官网 · 最新通知','https://www.fmmu.edu.cn/tongzhi/zxtz.htm')]},
 school_111:{note:'覆盖学生工作部公开通知与资助公示，未标注完整年份的日期不会推断。',entries:[{...entry('students','学生工作部 · 通知与资助','https://xgb.lzu.edu.cn/','#news'),listSelector:'.notice-list,.dynamic-list'}]},
};
// Body containers inspected on the official article pages. Avoid broad body/div
// fallbacks that would send menus or unrelated navigation to the AI service.
const articleSelectors:Record<string,string>={
 school_015:'.article',school_023:'.article',school_026:'.postbody',school_030:'.gp-article',school_046:'.Article_content',
 school_050:'.content',school_079:'.TRS_UEDITOR',school_085:'.gp-content',school_089:'.informationContent',school_105:'#articleDiv',school_112:'.table_article',
};
export function schoolSources(school:School):{note:string;sources:PublicSchoolSource[]} {
 const coverage=reviewed[school.id];
 const entries=coverage?.entries || (school.announcementUrl?[entry('directory','目录公开公告入口',school.announcementUrl)]:[]);
 return {note:coverage?.note || '当前仅接入目录所列入口，可能无法覆盖学校全部公告；正文和附件可用性以原站为准。',sources:entries.slice(0,4).map(e=>({id:school.id,name:school.name,key:e.key,label:e.label,announcementUrl:e.url,homepage:e.homepage||school.homepage||e.url,...(e.listSelector?{listSelector:e.listSelector}:{}),...(e.dateSelector?{dateSelector:e.dateSelector}:{}),...((e.articleSelector||articleSelectors[school.id])?{articleSelector:e.articleSelector||articleSelectors[school.id]}:{})}))};
}
// Keep imported source identities so saved choices and historical notices survive.
const bjtuLegacyIds:Record<string,string>={'bjtu-bksy':'1233ab626ac140af0003a85f00e57db2','bjtu-cs-tzgg':'15ff78a66acb889d000bcdb945e4c113'};
export const publicSourceId=(schoolId:string,key:string)=>schoolId==='bjtu'&&bjtuLegacyIds[key]?bjtuLegacyIds[key]:key==='directory'?`directory_${schoolId}`:`directory_${schoolId}__${key}`;
/** The old BJTU main-site card and directory card describe the same column.
 * Only these server-reviewed identities are aliases; duplicate competitions are independent. */
export function noticeSourceAliases(schoolId:string,sourceId:string):string[]{
 const main=['directory_bjtu','15ff78a66ac1382a00034f3869d0aa1c'];
 return schoolId==='bjtu'&&main.includes(sourceId)?main:[sourceId];
}
