import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {pushSupport,enablePush} from '../src/lib/browser-push';
import type {Transport} from '../src/lib/transport';
const originalUA=Object.getOwnPropertyDescriptor(navigator,'userAgent'),originalPlatform=Object.getOwnPropertyDescriptor(navigator,'platform'),originalWorker=Object.getOwnPropertyDescriptor(navigator,'serviceWorker');
const property=(name:string,value:unknown)=>Object.defineProperty(navigator,name,{configurable:true,value});
beforeEach(()=>{
 vi.stubGlobal('isSecureContext',true);vi.stubGlobal('PushManager',{});vi.stubGlobal('Notification',{requestPermission:vi.fn(async()=>'granted')});vi.stubGlobal('matchMedia',vi.fn(()=>({matches:false})));
 property('serviceWorker',{});property('platform','Win32');property('userAgent','Mozilla Windows Chrome');
});
afterEach(()=>{
 vi.unstubAllGlobals();for(const [name,value] of [['userAgent',originalUA],['platform',originalPlatform],['serviceWorker',originalWorker]] as const){if(value)Object.defineProperty(navigator,name,value);else delete(navigator as any)[name];}
});
it('accepts feature-capable Windows and Android and explains Apple home-screen setup',()=>{
 expect(pushSupport()).toBe('');property('userAgent','Mozilla Android Chrome');expect(pushSupport()).toBe('');
 property('userAgent','Mozilla iPhone Safari');expect(pushSupport()).toContain('添加到主屏幕');vi.stubGlobal('matchMedia',()=>({matches:true}));expect(pushSupport()).toBe('');
 vi.stubGlobal('isSecureContext',false);expect(pushSupport()).toContain('HTTPS');
});
it('asks permission only on the explicit call and unregisters an unbound subscription on API failure',async()=>{
 const unsubscribe=vi.fn(async()=>true),subscribe=vi.fn(async()=>({endpoint:'https://fcm.googleapis.com/fake',toJSON:()=>({keys:{auth:'fake',p256dh:'fake'}}),unsubscribe}));
 const worker={pushManager:{getSubscription:async()=>null,subscribe}},register=vi.fn(async()=>worker);property('serviceWorker',{register,ready:Promise.resolve(worker)});
 const call=vi.fn(async()=>{throw Error('synthetic API failure');});expect(Notification.requestPermission).not.toHaveBeenCalled();
 await expect(enablePush({call} as unknown as Transport,'AAAA')).rejects.toThrow('synthetic API failure');expect(Notification.requestPermission).toHaveBeenCalledTimes(1);expect(subscribe).toHaveBeenCalledTimes(1);expect(unsubscribe).toHaveBeenCalledTimes(1);
});
