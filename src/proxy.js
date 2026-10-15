import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Transform } from 'node:stream';
import { loadConfig } from './config.js';
import { clientIP, ipType, isPublicIP } from './ip.js';

const TOKEN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
const INFRA_HEADERS = new Set(['host', 'forwarded', 'x-real-ip', 'x-proxy-token', 'expect']);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', '*');
  res.setHeader('Cache-Control', 'no-store, no-transform');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
}

function error(res, status, code, message) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    // Never append JSON (or a heartbeat) to an upstream byte stream.
    res.destroy();
    return;
  }
  for (const name of res.getHeaderNames()) res.removeHeader(name);
  cors(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: code, message }));
}

function filteredHeaders(rawHeaders, request = false) {
  const blocked = new Set(HOP_HEADERS);
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() === 'connection') {
      for (const token of rawHeaders[i + 1].split(',')) blocked.add(token.trim().toLowerCase());
    }
  }
  const headers = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i].toLowerCase();
    if (blocked.has(name)) continue;
    if (request && (INFRA_HEADERS.has(name) || name.startsWith('x-forwarded-') ||
        name.startsWith('x-vercel-'))) continue;
    if (!request && name.startsWith('access-control-')) continue;
    headers.push([name, rawHeaders[i + 1]]);
  }
  return headers;
}

function validToken(actual, expected) {
  if (typeof actual !== 'string') return false;
  const digest = (value) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(actual), digest(expected));
}

export function checkedLookup(allowPrivateTargets, resolver = lookup) {
  return (hostname, options, callback) => {
    resolver(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      if (!addresses?.length || (!allowPrivateTargets && addresses.some(({ address }) => !isPublicIP(address)))) {
        const blocked = new Error('Target address is not allowed');
        blocked.code = 'TARGET_BLOCKED';
        return callback(blocked);
      }
      // Return the checked addresses directly to the socket: no second DNS lookup.
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

function targetURL(req, config) {
  const query = new URL(req.url, 'http://proxy.invalid').searchParams;
  if (query.getAll('url').length !== 1 || [...query.keys()].some((key) => key !== 'url')) {
    throw new Error('Provide exactly one url parameter; URL-encode the entire target URL');
  }
  const value = query.get('url');
  if (!value || /[\u0000-\u0020\u007f]/.test(value) || !/^https?:\/\//i.test(value)) {
    throw new Error('url must be an absolute HTTP or HTTPS URL');
  }
  const target = new URL(value);
  if (target.username || target.password || target.hash) {
    throw new Error('URL credentials and fragments are not supported');
  }
  const hostname = target.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (config.allowedHosts.length && !config.allowedHosts.some((allowed) =>
    allowed.startsWith('*.') ? hostname.endsWith(allowed.slice(1)) : hostname === allowed)) {
    const err = new Error('Target hostname is not allowed');
    err.code = 'TARGET_BLOCKED';
    throw err;
  }
  if (isIP(hostname) && !config.allowPrivateTargets && !isPublicIP(hostname)) {
    const err = new Error('Target address is not allowed');
    err.code = 'TARGET_BLOCKED';
    throw err;
  }
  return target;
}

function preflight(req, res, config) {
  const method = req.headers['access-control-request-method'];
  const headers = req.headers['access-control-request-headers'];
  if ((method !== undefined && (typeof method !== 'string' || !TOKEN.test(method))) ||
      (headers !== undefined && (typeof headers !== 'string' ||
        !headers.split(',').every((header) => TOKEN.test(header.trim()))))) {
    return error(res, 400, 'invalid_preflight', 'Invalid preflight method or headers');
  }
  res.setHeader('Access-Control-Allow-Methods', method || 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
  if (headers) res.setHeader('Access-Control-Allow-Headers', headers);
  res.setHeader('Access-Control-Max-Age', String(config.corsMaxAge));
  res.setHeader('Vary', 'Access-Control-Request-Method, Access-Control-Request-Headers');
  res.statusCode = 204;
  res.end();
}

export function createProxy(config = loadConfig()) {
  const dnsLookup = checkedLookup(config.allowPrivateTargets);
  return async function proxy(req, res) {
    cors(res);
    if (config.allowedIPs) {
      const address = clientIP(req, config.onVercel);
      if (!isIP(address) || !config.allowedIPs.check(address, ipType(address))) {
        return error(res, 403, 'client_ip_denied', 'Client IP is not allowed');
      }
    }
    // Browsers do not include the actual proxy token in preflight requests.
    if (req.method === 'OPTIONS') return preflight(req, res, config);
    if (config.token && !validToken(req.headers['x-proxy-token'], config.token)) {
      return error(res, 401, 'proxy_token_required', 'A valid X-Proxy-Token is required');
    }
    if (!TOKEN.test(req.method) || req.method === 'CONNECT' || req.headers.upgrade) {
      return error(res, 400, 'unsupported_protocol', 'Only ordinary HTTP requests are supported');
    }
    let target;
    try {
      target = targetURL(req, config);
    } catch (err) {
      return error(res, err.code === 'TARGET_BLOCKED' ? 403 : 400,
        err.code === 'TARGET_BLOCKED' ? 'target_denied' : 'invalid_url',
        err.code === 'ERR_INVALID_URL' ? 'Invalid target URL' : err.message);
    }
    const contentLength = req.headers['content-length'];
    if (config.maxRequestBytes && contentLength && Number(contentLength) > config.maxRequestBytes) {
      return error(res, 413, 'request_too_large', 'Request body exceeds MAX_REQUEST_BODY_BYTES');
    }

    // Keep Vercel's invocation alive until the downstream response finishes or disconnects.
    await new Promise((resolve) => {
      let upstream;
      let response;
      let connectTimer;
      let finished = false;
      let failed = false;
      let received = 0;
      const limiter = new Transform({
        transform(chunk, encoding, callback) {
          received += chunk.length;
          if (config.maxRequestBytes && received > config.maxRequestBytes) {
            const err = new Error('Request body too large');
            err.code = 'BODY_TOO_LARGE';
            callback(err);
          } else callback(null, chunk);
        },
      });
      const totalTimer = setTimeout(() => fail(504, 'request_timeout', 'Proxy request deadline exceeded'), config.requestTimeoutMs);

      function stopUpstream() {
        clearTimeout(totalTimer);
        clearTimeout(connectTimer);
        req.unpipe(limiter);
        limiter.destroy();
        upstream?.destroy();
        response?.destroy();
      }

      function finish() {
        if (finished) return;
        finished = true;
        stopUpstream();
        req.off('aborted', abort);
        req.off('error', abort);
        req.signal?.removeEventListener('abort', abort);
        res.off('finish', finish);
        res.off('close', finish);
        res.off('error', finish);
        if (!req.destroyed && !req.readableEnded) req.resume();
        resolve();
      }

      function abort() {
        res.destroy();
        finish();
      }

      function fail(status, code, message) {
        if (failed || finished) return;
        failed = true;
        stopUpstream();
        error(res, status, code, message);
      }

      req.once('aborted', abort);
      req.once('error', abort);
      req.signal?.addEventListener('abort', abort, { once: true });
      res.once('finish', finish);
      res.once('close', finish);
      res.once('error', finish);
      limiter.once('error', () => fail(413, 'request_too_large', 'Request body exceeds MAX_REQUEST_BODY_BYTES'));
      if (req.aborted || req.signal?.aborted || res.destroyed) return abort();

      try {
        const transport = target.protocol === 'https:' ? https : http;
        // Raw header arrays retain duplicate fields; Host must name the target.
        const headers = filteredHeaders(req.rawHeaders, true).flat();
        headers.push('host', target.host);
        // GET/HEAD/DELETE do not default to chunked framing in node:http.
        // Recreate transport framing when the incoming message carries a stream.
        if (req.headers['transfer-encoding'] && !contentLength) {
          headers.push('transfer-encoding', 'chunked');
        }
        upstream = transport.request(target, {
          method: req.method,
          headers,
          lookup: dnsLookup,
        });
        connectTimer = setTimeout(() => fail(504, 'connect_timeout', 'Upstream connection deadline exceeded'), config.connectTimeoutMs);
        upstream.once('socket', (socket) => {
          if (!socket.connecting) clearTimeout(connectTimer);
          else socket.once(target.protocol === 'https:' ? 'secureConnect' : 'connect', () => clearTimeout(connectTimer));
        });
        upstream.setTimeout(config.idleTimeoutMs, () => fail(504, 'upstream_timeout', 'Upstream connection was idle for too long'));
        upstream.once('error', (err) => {
          if (err.code === 'TARGET_BLOCKED') fail(403, 'target_denied', 'Target address is not allowed');
          else fail(502, 'upstream_error', 'Unable to complete the upstream request');
        });
        upstream.once('upgrade', (_response, socket) => {
          socket.destroy();
          fail(502, 'unsupported_protocol', 'Upstream protocol upgrades are not supported');
        });
        upstream.once('response', (incoming) => {
          response = incoming;
          if (finished || failed) return incoming.destroy();
          incoming.once('error', () => fail(502, 'upstream_error', 'Upstream response was interrupted'));
          const headers = new Map();
          for (const [name, value] of filteredHeaders(incoming.rawHeaders)) {
            const values = headers.get(name) || [];
            values.push(value);
            headers.set(name, values);
          }
          for (const [name, values] of headers) res.setHeader(name, values.length === 1 ? values[0] : values);
          cors(res);
          res.statusCode = incoming.statusCode;
          res.statusMessage = incoming.statusMessage;
          // Flush immediately; pipe preserves backpressure and never decompresses data.
          res.flushHeaders();
          incoming.pipe(res);
        });
        req.pipe(limiter).pipe(upstream);
      } catch {
        fail(502, 'upstream_error', 'Unable to create the upstream request');
      }
    });
  };
}
