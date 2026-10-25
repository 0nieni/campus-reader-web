<script setup lang="ts">
defineProps<{name:string}>();
const paths:Record<string,string[]>={
 user:['M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8','M4 21v-2a8 8 0 0 1 16 0v2'],
 lock:['M4 12a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7','M8 10V7a4 4 0 1 1 8 0v3M12 14v3'],
 eye:['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z','M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6'],
 'eye-closed':['M3 9c4.5 8 13.5 8 18 0','m5 12-2 2m6 0-1 3m7-3 1 3m3-5 2 2'],
 doc:['M7 3h7l5 5v12a1 1 0 0 1-1 1H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z','M14 3v5h5M9 13h6M9 17h6'],
 book:['M4 5.5A2.5 2.5 0 0 1 6.5 3H20v17H6.5A2.5 2.5 0 0 0 4 22V5.5Z','M4 6v14M8 7h8M8 11h8'],
 cup:['M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4ZM7 6H4v2a5 5 0 0 0 4 5M17 6h3v2a5 5 0 0 1-4 5'],
 cal:['M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z','M7 3v4M17 3v4M3 10h18M8 14h2M14 14h2M8 17h2'],
 grid:['M3 4.5A1.5 1.5 0 0 1 4.5 3h4A1.5 1.5 0 0 1 10 4.5v4A1.5 1.5 0 0 1 8.5 10h-4A1.5 1.5 0 0 1 3 8.5v-4Z','M14 4.5A1.5 1.5 0 0 1 15.5 3h4A1.5 1.5 0 0 1 21 4.5v4a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 14 8.5v-4ZM3 15.5A1.5 1.5 0 0 1 4.5 14h4a1.5 1.5 0 0 1 1.5 1.5v4A1.5 1.5 0 0 1 8.5 21h-4A1.5 1.5 0 0 1 3 19.5v-4ZM14 15.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-4a1.5 1.5 0 0 1-1.5-1.5v-4Z'],
 bell:['M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4'],
 saved:['M6 4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21l-6-4-6 4V4.5Z'],
 search:['M10.8 3.6a7.2 7.2 0 1 0 0 14.4 7.2 7.2 0 0 0 0-14.4','m16 16 5 5'],
 collapse:['m14 18-6-6 6-6'],
 globe:['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18','M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18'],
 sparkle:['m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z'],
 logout:['M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4M13 8l5 4-5 4M18 12H8'],
};
</script>
<template><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><template v-if="name==='planet'"><circle cx="12" cy="12" r="8.7"/><ellipse cx="12" cy="12" rx="4" ry="8.7" transform="rotate(48 12 12)"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/></template><template v-else><path v-for="(path,index) in paths[name]||paths.doc" :key="index" :d="path"/></template></svg></template>
