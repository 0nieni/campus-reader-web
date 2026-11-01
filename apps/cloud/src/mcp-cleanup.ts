import type {SqlPool} from './postgres-storage';
import {mcpIso} from './mcp-security';
/** Small bounded batches in the existing daily task. Consumed refresh proofs
 * remain until expiry so reuse continues to revoke their authorization family. */
export async function cleanupMcp(pool:SqlPool,now=Date.now()){
 for(const [table,key]of [['campus_mcp_receipts','grant_id,request_id'],['campus_mcp_codes','code_hash'],['campus_mcp_tokens','token_hash'],['campus_mcp_pending','ticket_hash']] as const)await pool.query(`DELETE FROM ${table} WHERE (${key}) IN (SELECT ${key} FROM ${table} WHERE expires_at<$1 ORDER BY expires_at LIMIT 1000)`,[mcpIso(now)]);
 await pool.query(`DELETE FROM campus_mcp_grants g WHERE g.id IN (SELECT id FROM campus_mcp_grants WHERE expires_at<$1 ORDER BY expires_at LIMIT 500) AND NOT EXISTS(SELECT 1 FROM campus_mcp_tokens t WHERE t.grant_id=g.id) AND NOT EXISTS(SELECT 1 FROM campus_mcp_codes c WHERE c.grant_id=g.id) AND NOT EXISTS(SELECT 1 FROM campus_mcp_receipts r WHERE r.grant_id=g.id)`,[mcpIso(now)]);
 await pool.query(`DELETE FROM campus_mcp_clients c WHERE c.id IN (SELECT id FROM campus_mcp_clients WHERE expires_at<$1 ORDER BY expires_at LIMIT 500) AND NOT EXISTS(SELECT 1 FROM campus_mcp_grants g WHERE g.client_id=c.id) AND NOT EXISTS(SELECT 1 FROM campus_mcp_pending p WHERE p.client_id=c.id)`,[mcpIso(now)]);
 await pool.query('DELETE FROM campus_mcp_limits WHERE (bucket,subject) IN (SELECT bucket,subject FROM campus_mcp_limits WHERE expires_at<$1 ORDER BY expires_at LIMIT 1000)',[mcpIso(now)]);
}
