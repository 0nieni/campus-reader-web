import type {ScheduledReminder} from '@campus/contracts';
const stamp=(value:string)=>new Date(value).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
const escape=(value:string)=>value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'').replace(/\\/g,'\\\\').replace(/\r\n|\r|\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,');
// RFC 5545 folds at 75 octets without splitting a UTF-8 character.
export function foldCalendarLine(line:string){
  let result='',part='',bytes=0;
  for(const character of line){const size=Buffer.byteLength(character);if(bytes+size>75){result+=part+'\r\n';part=' ';bytes=1;}part+=character;bytes+=size;}
  return result+part;
}
export function reminderCalendar(reminders:ScheduledReminder[],now:string){
  const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Campus Reader//Reminders//CN','CALSCALE:GREGORIAN','METHOD:PUBLISH'];
  for(const reminder of reminders){
    lines.push('BEGIN:VEVENT',`UID:${reminder.id}@campus-reader`,`DTSTAMP:${stamp(now)}`,`DTSTART:${stamp(reminder.dueAt)}`,`DTEND:${stamp(new Date(Date.parse(reminder.dueAt)+60000).toISOString())}`,`SUMMARY:${escape(reminder.label+'：'+reminder.title)}`,`DESCRIPTION:${escape(reminder.schoolName+'；由本人确认的提醒时间，请核对公告原文。')}`);
    for(const days of reminder.days)lines.push('BEGIN:VALARM','ACTION:DISPLAY',`TRIGGER:-PT${days*24}H`,`DESCRIPTION:${escape(reminder.label)}`,'END:VALARM');
    lines.push('END:VEVENT');
  }
  return [...lines,'END:VCALENDAR'].map(foldCalendarLine).join('\r\n')+'\r\n';
}
