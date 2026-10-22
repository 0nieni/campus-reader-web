'use strict';
// FC Node.js 20+ event function, handler reminder-tick.handler. No SDK or data access.
const {createHash,createHmac,randomUUID}=require('node:crypto');
const target='https://campus-reader-ninie6159.netlify.app/.netlify/functions/reminder-tick';
exports.handler=async()=>{
 const secret=process.env.REMINDER_TRIGGER_SECRET;
 if(process.env.REMINDER_TICK_URL!==target||!secret||secret.length<32||secret.length>256)throw Error('Reminder trigger is not configured');
 const timestamp=String(Date.now()),requestId=randomUUID().replaceAll('-',''),body='{}';
 const canonical=['POST',new URL(target).pathname,timestamp,requestId,createHash('sha256').update(body).digest('hex')].join('\n');
 const signature=createHmac('sha256',secret).update(canonical).digest('hex');
 const response=await fetch(target,{method:'POST',redirect:'error',signal:AbortSignal.timeout(25000),headers:{'content-type':'application/json','x-reminder-time':timestamp,'x-reminder-request':requestId,'x-reminder-signature':signature},body});
 console.info(JSON.stringify({event:'reminder-tick',status:response.status,requestId}));
 if(response.status!==204)throw Error('Reminder tick was not accepted');
 return{accepted:true};
};
