import {onUnmounted,watch,type Ref} from 'vue';
import loginStyle from '../template-login.css?inline';
import portalStyle from '../template-portal.css?inline';
/** Original template sheets remain unchanged. Only the current page's sheet is active. */
export function usePageTemplate(isPortal:Ref<boolean>){
 const element=document.createElement('style');element.dataset.campusTemplate='true';document.head.append(element);
 delete document.documentElement.dataset.theme;
 const stop=watch(isPortal,portal=>{element.textContent=portal?portalStyle:loginStyle;document.documentElement.dataset.pageTemplate=portal?'portal':'login';document.querySelector('meta[name="theme-color"]')?.setAttribute('content','#f8f7fb');},{immediate:true,flush:'sync'});
 onUnmounted(()=>{stop();element.remove();delete document.documentElement.dataset.pageTemplate;});
}
