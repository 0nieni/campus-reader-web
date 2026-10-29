export interface BriefEvidence {paragraphId:string;quote:string}
export interface BriefField {text:string;evidence:BriefEvidence[]}
export interface BriefTime {value:string;precision:'date'|'minute'}
export interface BriefDate {label:string;kind:'deadline'|'period'|'event';rawText:string;start?:BriefTime;end?:BriefTime;conditions?:string;evidence:BriefEvidence[]}
export interface BriefContent {publishedDate?:{value:string;precision:'date';evidence:BriefEvidence[]};audience?:BriefField;keyDates:BriefDate[];requirements:BriefField[];submission?:BriefField}
export interface NoticeBrief {
 state:'pending'|'ready'|'unavailable'|'failed'|'stale';checkedAt:string;message?:string;
 contentHash?:string;schemaVersion?:string;generatedAt?:string;content?:BriefContent;attachmentsRead:false;
}
