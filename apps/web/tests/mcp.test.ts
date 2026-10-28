import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {mount,flushPromises} from '@vue/test-utils';
import {createPinia} from 'pinia';
import type {McpConnections,McpConsent} from '@campus/contracts';
import type {Transport} from '../src/lib/transport';
import McpConnectionsPanel from '../src/components/McpConnectionsPanel.vue';
import McpAuthorizationPanel from '../src/components/McpAuthorizationPanel.vue';
import App from '../src/App.vue';
const workspaceId='a'.repeat(32),scopes=['announcements:read','bookmarks:read','bookmarks:write','reminders:read','reminders:write','offline_access'] as const;
function fixture(){
 const connection={id:'b'.repeat(32),name:'Synthetic desktop',kind:'manual' as const,clientOrigin:null,scopes:['announcements:read' as const],createdAt:'2026-10-28T00:00:00Z',expiresAt:'2027-01-26T00:00:00Z',lastUsedAt:null};
 const state:McpConnections={url:'https://campus.example/mcp',workspaceId,connections:[]};
 const consent:McpConsent={ticket:'synthetic-ticket',workspaceId,clientName:'Synthetic AI',clientOrigin:'https://client.example',redirectOrigin:'http://localhost:7000',scopes:[...scopes],expiresAt:'2026-10-28T00:10:00Z'};
 const transport={anonymous:{state:vi.fn(async()=>({id:workspaceId}))},mcp:{list:vi.fn(async()=>structuredClone(state)),create:vi.fn(async()=>{state.connections=[connection];return{connection,token:'synthetic-ui-credential'};}),revoke:vi.fn(async()=>{state.connections=[];}),consent:vi.fn(async()=>consent),decide:vi.fn(async()=>({redirect:'https://client.example/callback'}))},restore:vi.fn(async()=>null),call:vi.fn(),onSessionChange:()=>()=>{}} as unknown as Transport;
 return{transport};
}
beforeEach(()=>{history.replaceState(null,'','/');localStorage.clear();sessionStorage.clear();});
afterEach(()=>vi.unstubAllGlobals());
it('connection UI creates with read-only defaults, masks the one-time credential, explicitly copies and revokes it',async()=>{
 const {transport}=fixture(),writeText=vi.fn(async()=>{});vi.stubGlobal('navigator',{clipboard:{writeText}});
 const wrapper=mount(McpConnectionsPanel,{props:{transport}});await flushPromises();
 expect(wrapper.findAll('input[type=checkbox]').filter(row=>(row.element as HTMLInputElement).checked)).toHaveLength(3);
 await wrapper.get('#mcp-connection-name').setValue('Synthetic desktop');await wrapper.get('form').trigger('submit');await flushPromises();
 expect(transport.mcp!.create).toHaveBeenCalledWith({name:'Synthetic desktop',scopes:['announcements:read','bookmarks:read','reminders:read']});
 expect(wrapper.get('#mcp-new-token').attributes('type')).toBe('password');expect(writeText).not.toHaveBeenCalled();
 await wrapper.get('[aria-label="显示连接密钥"]').trigger('click');expect(wrapper.get('#mcp-new-token').attributes('type')).toBe('text');
 await wrapper.findAll('button').find(row=>row.text()==='复制密钥')!.trigger('click');await flushPromises();expect(writeText).toHaveBeenCalledWith('synthetic-ui-credential');
 expect(JSON.stringify({...localStorage,...sessionStorage})).not.toContain('synthetic-ui-credential');
 await wrapper.get('[aria-label="撤销连接 Synthetic desktop"]').trigger('click');await flushPromises();expect(transport.mcp!.revoke).toHaveBeenCalledWith('b'.repeat(32));expect(wrapper.find('#mcp-new-token').exists()).toBe(false);wrapper.unmount();
});
it('duplicate submissions stay pending once and a credential arriving after unmount is discarded',async()=>{
 const {transport}=fixture();let finish!:(value:any)=>void;vi.mocked(transport.mcp!.create).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const wrapper=mount(McpConnectionsPanel,{props:{transport}});await flushPromises();await wrapper.get('#mcp-connection-name').setValue('Pending');await wrapper.get('form').trigger('submit');await wrapper.get('form').trigger('submit');expect(transport.mcp!.create).toHaveBeenCalledTimes(1);wrapper.unmount();finish({token:'late-synthetic-secret'});await flushPromises();expect(transport.mcp!.list).toHaveBeenCalledTimes(1);
});
it('OAuth confirms the anonymous workspace before consent, leaves write permissions unchecked, and submits once',async()=>{
 const {transport}=fixture(),assign=vi.fn();vi.stubGlobal('location',{assign});
 const wrapper=mount(McpAuthorizationPanel,{props:{transport,ticket:'synthetic-ticket'}});await flushPromises();
 expect(transport.anonymous!.state).toHaveBeenCalledTimes(1);expect(transport.mcp!.decide).not.toHaveBeenCalled();expect(transport.restore).not.toHaveBeenCalled();expect(wrapper.text()).toContain(workspaceId);expect(wrapper.text()).toContain('http://localhost:7000');
 const inputs=wrapper.findAll('input[type=checkbox]');expect(inputs.filter(row=>(row.element as HTMLInputElement).checked)).toHaveLength(4);
 await inputs[2]!.setValue(true);await wrapper.get('.submit').trigger('click');await flushPromises();expect(transport.mcp!.decide).toHaveBeenCalledWith({ticket:'synthetic-ticket',approved:true,scopes:['announcements:read','bookmarks:read','reminders:read','offline_access','bookmarks:write']});expect(assign).toHaveBeenCalledWith('https://client.example/callback');wrapper.unmount();
});
it('OAuth can be denied or exited without granting any access',async()=>{
 const {transport}=fixture(),assign=vi.fn();vi.stubGlobal('location',{assign});
 const wrapper=mount(McpAuthorizationPanel,{props:{transport,ticket:'synthetic-ticket'}});await flushPromises();await wrapper.findAll('button').find(row=>row.text()==='返回匿名工作区')!.trigger('click');expect(wrapper.emitted('back')).toHaveLength(1);expect(transport.mcp!.decide).not.toHaveBeenCalled();
 await wrapper.get('.mcp-deny').trigger('click');await flushPromises();expect(transport.mcp!.decide).toHaveBeenCalledWith(expect.objectContaining({approved:false}));wrapper.unmount();
});
it('the app displays MCP consent without AI login and immediately removes its ticket from the URL',async()=>{
 const {transport}=fixture();history.replaceState(null,'','/?mcp_authorize=synthetic-ticket&keep=yes');
 const wrapper=mount(App,{props:{transport,configurationIssues:[]},global:{plugins:[createPinia()],stubs:{McpAuthorizationPanel:{props:['ticket'],template:'<section class="synthetic-consent">{{ticket}}</section>'}}}});await flushPromises();expect(wrapper.get('.synthetic-consent').text()).toBe('synthetic-ticket');expect(location.search).toBe('?keep=yes');expect(wrapper.find('#password').exists()).toBe(false);wrapper.unmount();
});
