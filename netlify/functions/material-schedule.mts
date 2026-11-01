import {dispatchMaterials} from '../../apps/cloud/src/material-dispatch';
export const config={schedule:'45 18 * * *'}; // Daily 02:45 Beijing, production only.
export default async()=>{
 const secret=Netlify.env.get('MATERIALS_JOB_SECRET');
 if(!secret||secret.length<32){console.info(JSON.stringify({event:'material-collection',state:'unconfigured'}));return new Response(null,{status:204});}
 await dispatchMaterials(Netlify.env.get('URL'),secret);
 return new Response(null,{status:204});
};
