export const mcpScopes=['announcements:read','bookmarks:read','bookmarks:write','reminders:read','reminders:write','offline_access'] as const;
export type McpScope=typeof mcpScopes[number];
export interface McpConnection {id:string;name:string;kind:'oauth'|'manual';clientOrigin:string|null;scopes:McpScope[];createdAt:string;expiresAt:string;lastUsedAt:string|null}
export interface McpConnections {url:string;workspaceId:string;connections:McpConnection[]}
export interface McpConsent {ticket:string;clientName:string;clientOrigin:string;redirectOrigin:string;workspaceId:string;scopes:McpScope[];expiresAt:string}
export interface McpTransport {
 list():Promise<McpConnections>;
 create(input:{name:string;scopes:McpScope[]}):Promise<{connection:McpConnection;token:string}>;
 revoke(id:string):Promise<void>;
 consent(ticket:string):Promise<McpConsent>;
 decide(input:{ticket:string;approved:boolean;scopes:McpScope[]}):Promise<{redirect:string}>;
}
