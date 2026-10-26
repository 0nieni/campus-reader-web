import type {WebsiteSourceInput} from '@campus/contracts';
export interface CompetitionSource {id:string;name:string;entryUrl:string;categories:string[];projects:Array<{number:number;name:string}>;verifiedAt:string;verifiedCount:number;selectors?:Record<string,string>}
/** Only columns verified with Lexmount and the production list/body parsers. */
export const competitionSources:readonly CompetitionSource[]=[
 {id:'competition_011',name:'中国大学生计算机设计大赛',entryUrl:'https://jsjds.blcu.edu.cn/dsdt.htm',categories:['competition'],projects:[{number:11,name:'中国大学生计算机设计大赛'}],verifiedAt:'2026-10-25T12:46:02.549Z',verifiedCount:11},
 {id:'competition_160',name:'中国大学生GIS软件开发竞赛',entryUrl:'https://contest.geoscene.cn/news',categories:['competition'],projects:[{number:160,name:'中国大学生GIS软件开发竞赛'}],verifiedAt:'2026-10-25T12:48:08.143Z',verifiedCount:14},
 {id:'competition_157',name:'全国大学生数字媒体科技作品及创意竞赛',entryUrl:'https://www.cmit.cn/html/xinwenzhongxin/list-8-1.html',categories:['competition'],projects:[{number:157,name:'全国大学生数字媒体科技作品及创意竞赛'}],selectors:{content:'.content-wrap'},verifiedAt:'2026-10-25T13:43:40.868Z',verifiedCount:2},
 {id:'competition_207',name:'“挑战杯”全国大学生课外学术科技作品竞赛',entryUrl:'https://www.tiaozhanbei.net/tzb/notice',categories:['competition'],projects:[{number:207,name:'“挑战杯”全国大学生课外学术科技作品竞赛'}],verifiedAt:'2026-10-25T12:48:42.569Z',verifiedCount:15},
 {id:'competition_208',name:'“挑战杯”全国大学生创业计划大赛',entryUrl:'https://www.tiaozhanbei.net/tzb/notice',categories:['competition'],projects:[{number:208,name:'“挑战杯”全国大学生创业计划大赛'}],verifiedAt:'2026-10-25T12:48:42.569Z',verifiedCount:15},
];
export function competitionConfig(source:Pick<CompetitionSource,'name'|'entryUrl'|'categories'|'selectors'>):WebsiteSourceInput{return{name:source.name,entryUrl:source.entryUrl,type:'html_list',categories:source.categories,intervalMinutes:60,selectors:source.selectors||{},allowAi:true,authorized:true};}
