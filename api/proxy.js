import { createProxy } from '../src/proxy.js';

// NODEJS_HELPERS=0 in vercel.json disables Vercel's eager body reader.
export default createProxy();
