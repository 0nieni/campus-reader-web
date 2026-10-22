// Retired QStash callbacks never instantiate SQL or send either channel.
export default async()=>new Response(null,{status:410,headers:{'cache-control':'no-store'}});
