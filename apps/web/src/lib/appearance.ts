import {onUnmounted,ref} from 'vue';
type Theme='light'|'dark';
const preferenceKey='campus-reader:theme';
/** Only a public visual preference is stored. Account data and credentials never enter it. */
export function useAppearance(){
  const media=typeof matchMedia==='function'?matchMedia('(prefers-color-scheme: dark)'):null;
  let chosen:Theme|null=null;
  try{const value=localStorage.getItem(preferenceKey);if(value==='light'||value==='dark')chosen=value;}catch{}
  const theme=ref<Theme>(chosen||(media?.matches?'dark':'light'));
  function apply(){document.documentElement.dataset.theme=theme.value;document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme.value==='dark'?'#08140f':'#f4f1e8');}
  function follow(){if(!chosen){theme.value=media?.matches?'dark':'light';apply();}}
  function toggle(){theme.value=theme.value==='light'?'dark':'light';chosen=theme.value;try{localStorage.setItem(preferenceKey,theme.value);}catch{}apply();}
  apply();media?.addEventListener('change',follow);
  onUnmounted(()=>media?.removeEventListener('change',follow));
  return {theme,toggle};
}
