import { netlifyTransport } from './netlify';
import type { Transport } from './transport';
export const isNetlify = import.meta.env.VITE_BACKEND === 'netlify';
const cloud = isNetlify ? null : await import('./cloudbase');
export const siteTransport: Transport = isNetlify ? netlifyTransport : cloud!.cloudTransport;
export const setupIssues = isNetlify ? [] : cloud!.setupIssues;
export const regionNeedsVerification = !isNetlify && cloud!.regionNeedsVerification;
