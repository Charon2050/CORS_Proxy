import { domainToASCII } from 'node:url';
import { parseAllowlist } from './ip.js';

function integer(env, name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const text = env[name]?.trim();
  if (!text) return fallback;
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function boolean(env, name, fallback) {
  const value = env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value !== 'true' && value !== 'false') throw new Error(`${name} must be true or false`);
  return value === 'true';
}

function targetHosts(value = '') {
  return value.split(',').map((host) => host.trim().toLowerCase()).filter(Boolean).map((host) => {
    const wildcard = host.startsWith('*.');
    const name = domainToASCII(wildcard ? host.slice(2) : host).replace(/\.$/, '');
    if (!name || !/^[a-z0-9.-]+$/.test(name) || name.split('.').some((label) =>
      !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) {
      throw new Error('ALLOWED_TARGET_HOSTS must contain hostnames, without schemes, paths or ports');
    }
    return wildcard ? `*.${name}` : name;
  });
}

export function loadConfig(env = process.env) {
  return {
    allowedIPs: parseAllowlist(env.ALLOWED_CLIENT_IPS),
    token: env.PROXY_TOKEN ?? '',
    allowedHosts: targetHosts(env.ALLOWED_TARGET_HOSTS),
    allowPrivateTargets: boolean(env, 'ALLOW_PRIVATE_TARGETS', false),
    onVercel: env.VERCEL === '1',
    requestTimeoutMs: integer(env, 'REQUEST_TIMEOUT_MS', 290000, 1, 2147483647),
    connectTimeoutMs: integer(env, 'CONNECT_TIMEOUT_MS', 10000, 1, 2147483647),
    idleTimeoutMs: integer(env, 'UPSTREAM_IDLE_TIMEOUT_MS', 0, 0, 2147483647),
    maxRequestBytes: integer(env, 'MAX_REQUEST_BODY_BYTES', 4500000),
    corsMaxAge: integer(env, 'CORS_MAX_AGE_SECONDS', 86400),
  };
}
