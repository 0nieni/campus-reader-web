import type {AuthSession} from './index';
export interface AnonymousState {id:string;identity:AuthSession;transferExpiresAt:string|null}
export interface AnonymousTransfer {code:string;expiresAt:string}
export interface AnonymousImport {schoolId:string|null;bookmarks:number;tags:number;sources:number;reminders:number;skipped:number;emailReverificationRequired:true;pushReauthorizationRequired:true}
export interface AnonymousTransport {
 state():Promise<AnonymousState>;
 createTransfer():Promise<AnonymousTransfer>;
 cancelTransfer():Promise<void>;
 importTransfer(code:string):Promise<AnonymousImport>;
}
