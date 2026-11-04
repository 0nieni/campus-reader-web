import {getDatabase} from '@netlify/database';
import {getContext} from '@netlify/functions';
import type {SqlPool} from '../../apps/cloud/src/postgres-storage';
import {postgresRepository} from '../../apps/cloud/src/postgres-repository';
import {readLexmountPage} from '../../apps/cloud/src/lexmount-pages';
import {schoolDirectory} from '../../apps/cloud/src/school-directory';
import {websiteSources} from '../../apps/cloud/src/website-sources';
import {publicSources} from '../../apps/cloud/src/public-sources';
import {sourceDirectoryAudit,auditHttp,sourceAuditKey} from '../../apps/cloud/src/source-directory-audit';

// No configuration value is bundled. The temporary Functions-only key is
// provisioned for the authorized run and removed after it; the endpoint expires.
export default auditHttp({
 key:sourceAuditKey,
 production:()=>getContext().deploy.context==='production',
 async run(target){
  const pool=getDatabase().pool as unknown as SqlPool,repo=postgresRepository(pool);
  const directory=schoolDirectory(pool,repo,readLexmountPage,Date.now,{trackActivity:false});
  const websites=websiteSources(pool,repo,readLexmountPage);
  const sources=publicSources(pool,repo,websites,directory.sources);
  return sourceDirectoryAudit(pool,id=>id==='school_bjtu'?directory.refresh('bjtu'):sources.maintenanceRefreshSource(id))(target);
 }
});
