import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { createProxy, checkedLookup } from '../src/proxy.js';
import { loadConfig } from '../src/config.js';
import { clientIP, isPublicIP, parseAllowlist } from '../src/ip.js';

const servers = [];
async function serve(handler) {
  const server = http.createServer(handler);
  server.requestTimeout = 0;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  })));
});

async function proxy(env = {}) {
  return serve(createProxy(loadConfig({ ALLOW_PRIVATE_TARGETS: 'true', ...env })));
}
function pathFor(target) {
  return `/api/proxy?url=${encodeURIComponent(target)}`;
}
function open(base, path, { method = 'GET', headers, body, chunks } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + path, { method, headers, agent: false }, resolve);
    req.once('error', reject);
    if (chunks) {
      for (const chunk of chunks) req.write(chunk);
    }
    req.end(body);
  });
}
async function collect(response) {
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function call(base, target, options) {
  const response = await open(base, pathFor(target), options);
  return { status: response.statusCode, headers: response.headers, body: await collect(response) };
}

test('forwards method, encoded query, binary body and application headers', async () => {
  const body = Buffer.from([0, 255, 13, 10, 1, 128]);
  const upstream = await serve(async (req, res) => {
    const received = await collect(req);
    res.writeHead(201, { 'Content-Type': 'application/json', 'X-Upstream': 'yes' });
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: [...received] }));
  });
  const base = await proxy();
  const result = await call(base, `${upstream}/echo?a=1&b=x%2By&b=%26`, {
    method: 'POST', body,
    headers: {
      Authorization: 'Bearer upstream-secret', 'Content-Type': 'application/octet-stream',
      'Content-Length': body.length, Origin: 'https://client.example',
      Cookie: 'session=test', 'X-Custom': 'preserved',
      'X-Proxy-Token': 'do-not-forward', 'X-Forwarded-For': '1.2.3.4',
      'X-Vercel-Id': 'internal', Connection: 'x-hop', 'X-Hop': 'remove',
    },
  });
  assert.equal(result.status, 201);
  const echo = JSON.parse(result.body);
  assert.equal(echo.method, 'POST');
  assert.equal(echo.url, '/echo?a=1&b=x%2By&b=%26');
  assert.deepEqual(echo.body, [...body]);
  assert.equal(echo.headers.host, new URL(upstream).host);
  assert.equal(echo.headers.authorization, 'Bearer upstream-secret');
  assert.equal(echo.headers.origin, 'https://client.example');
  assert.equal(echo.headers.cookie, 'session=test');
  assert.equal(echo.headers['x-custom'], 'preserved');
  for (const key of ['x-hop', 'x-proxy-token', 'x-forwarded-for', 'x-vercel-id']) assert.equal(echo.headers[key], undefined);
  assert.equal(result.headers['access-control-allow-origin'], '*');
  assert.equal(result.headers['x-upstream'], 'yes');
});

test('forwards HTTP methods including HEAD, DELETE, PATCH and WebDAV', async () => {
  const upstream = await serve((req, res) => {
    res.setHeader('X-Method', req.method);
    res.setHeader('Content-Length', '4');
    res.end('data');
  });
  const base = await proxy();
  for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'PROPFIND', 'TRACE']) {
    const result = await call(base, upstream, { method });
    assert.equal(result.status, 200);
    assert.equal(result.headers['x-method'], method);
    assert.equal(result.body.toString(), method === 'HEAD' ? '' : 'data');
  }
});

test('forwards chunked GET request bodies', async () => {
  const upstream = await serve(async (req, res) => res.end(await collect(req)));
  const result = await call(await proxy(), upstream, {
    method: 'GET', headers: { 'Transfer-Encoding': 'chunked' }, chunks: ['first', 'second'],
  });
  assert.equal(result.body.toString(), 'firstsecond');
});

test('preflight reflects requested method and headers, bypasses token and target URL', async () => {
  const base = await proxy({ PROXY_TOKEN: 'secret' });
  const response = await open(base, '/api/proxy', {
    method: 'OPTIONS', headers: {
      Origin: 'https://any.example', 'Access-Control-Request-Method': 'PROPFIND',
      'Access-Control-Request-Headers': 'authorization, content-type, x-proxy-token',
    },
  });
  assert.equal(response.statusCode, 204);
  assert.equal(response.headers['access-control-allow-origin'], '*');
  assert.equal(response.headers['access-control-allow-methods'], 'PROPFIND');
  assert.equal(response.headers['access-control-allow-headers'], 'authorization, content-type, x-proxy-token');
  assert.equal(response.headers['access-control-allow-credentials'], undefined);
  assert.equal((await collect(response)).length, 0);
});

test('passes raw gzip bytes, repeated Set-Cookie and error statuses; overrides CORS and cache headers', async () => {
  const compressed = gzipSync(Buffer.from('original bytes'));
  const upstream = await serve((_req, res) => {
    res.writeHead(429, {
      'Content-Encoding': 'gzip', 'Content-Length': compressed.length,
      'Set-Cookie': ['a=1; Path=/', 'b=2; Path=/'], 'Retry-After': '60',
      'Access-Control-Allow-Origin': 'https://blocked.example', 'Access-Control-Allow-Credentials': 'true',
      'Cache-Control': 'public, max-age=86400', Connection: 'x-hop', 'X-Hop': 'remove',
    });
    res.end(compressed);
  });
  const result = await call(await proxy(), upstream);
  assert.equal(result.status, 429);
  assert.deepEqual(result.body, compressed);
  assert.equal(result.headers['content-encoding'], 'gzip');
  assert.equal(Number(result.headers['content-length']), compressed.length);
  assert.deepEqual(result.headers['set-cookie'], ['a=1; Path=/', 'b=2; Path=/']);
  assert.equal(result.headers['retry-after'], '60');
  assert.equal(result.headers['access-control-allow-origin'], '*');
  assert.equal(result.headers['access-control-allow-credentials'], undefined);
  assert.equal(result.headers['x-hop'], undefined);
  assert.equal(result.headers['cache-control'], 'no-store, no-transform');
});

test('does not follow upstream redirects', async () => {
  let hits = 0;
  const upstream = await serve((_req, res) => {
    hits++;
    res.writeHead(307, { Location: 'http://127.0.0.1/private' });
    res.end('redirect body');
  });
  const result = await call(await proxy(), upstream);
  assert.equal(result.status, 307);
  assert.equal(result.headers.location, 'http://127.0.0.1/private');
  assert.equal(result.body.toString(), 'redirect body');
  assert.equal(hits, 1);
});

test('delivers an SSE chunk before upstream finishes, without inserting bytes', { timeout: 5000 }, async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const upstream = await serve(async (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: first\n\n');
    await gate;
    res.end('data: last\n\n');
  });
  const response = await open(await proxy(), pathFor(upstream));
  const iterator = response[Symbol.asyncIterator]();
  try {
    const first = await iterator.next();
    assert.equal(first.value.toString(), 'data: first\n\n');
    release();
    let remaining = '';
    for await (const chunk of iterator) remaining += chunk;
    assert.equal(remaining, 'data: last\n\n');
  } finally { release(); }
});

test('client disconnect cancels the upstream response', { timeout: 5000 }, async () => {
  let closed;
  const wasClosed = new Promise((resolve) => { closed = resolve; });
  const upstream = await serve((_req, res) => {
    res.once('close', closed);
    res.write('first');
  });
  const response = await open(await proxy(), pathFor(upstream));
  await once(response, 'data');
  response.destroy();
  await wasClosed;
});

test('uploads chunks to upstream before the client finishes sending', { timeout: 5000 }, async () => {
  let receivedFirst;
  const firstChunk = new Promise((resolve) => { receivedFirst = resolve; });
  const upstream = await serve((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; receivedFirst(); });
    req.on('end', () => res.end(body));
  });
  const base = await proxy();
  const request = http.request(base + pathFor(upstream), { method: 'POST', agent: false });
  const responsePromise = once(request, 'response');
  request.write('first');
  await firstChunk;
  request.end('last');
  const [response] = await responsePromise;
  assert.equal((await collect(response)).toString(), 'firstlast');
});

test('default configuration allows an idle wait longer than the agent keep-alive timeout', { timeout: 10000 }, async () => {
  const upstream = await serve((_req, res) => {
    const timer = setTimeout(() => res.end('delayed'), 5200);
    res.once('close', () => clearTimeout(timer));
  });
  const result = await call(await proxy(), upstream);
  assert.equal(result.status, 200);
  assert.equal(result.body.toString(), 'delayed');
});

test('total timeout returns 504 before headers and aborts upstream', { timeout: 5000 }, async () => {
  let closed;
  const wasClosed = new Promise((resolve) => { closed = resolve; });
  const upstream = await serve((_req, res) => res.once('close', closed));
  const result = await call(await proxy({ REQUEST_TIMEOUT_MS: '100' }), upstream);
  assert.equal(result.status, 504);
  assert.equal(JSON.parse(result.body).error, 'request_timeout');
  assert.equal(result.headers['access-control-allow-origin'], '*');
  await wasClosed;
});

test('idle timeout and failed connections return CORS-enabled errors', async () => {
  const upstream = await serve(() => {});
  const result = await call(await proxy({ UPSTREAM_IDLE_TIMEOUT_MS: '80' }), upstream);
  assert.equal(result.status, 504);
  assert.equal(JSON.parse(result.body).error, 'upstream_timeout');
  const closed = http.createServer();
  closed.listen(0, '127.0.0.1');
  await once(closed, 'listening');
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  const failure = await call(await proxy(), `http://127.0.0.1:${port}`);
  assert.equal(failure.status, 502);
  assert.equal(failure.headers['access-control-allow-origin'], '*');
});

test('timeout after headers terminates the stream without appending an error', { timeout: 5000 }, async () => {
  const upstream = await serve((_req, res) => res.write('original'));
  const response = await open(await proxy({ REQUEST_TIMEOUT_MS: '150' }), pathFor(upstream));
  let body = '';
  await assert.rejects(async () => {
    for await (const chunk of response) body += chunk;
  });
  assert.equal(body, 'original');
});

test('enforces token authentication without consuming upstream Authorization', async () => {
  const upstream = await serve((req, res) => res.end(req.headers.authorization));
  const base = await proxy({ PROXY_TOKEN: 'proxy-secret' });
  for (const token of ['', 'wrong', 'proxy-secret, proxy-secret']) {
    const result = await call(base, upstream, { headers: { 'X-Proxy-Token': token } });
    assert.equal(result.status, 401);
    assert.equal(result.headers['access-control-allow-origin'], '*');
  }
  const result = await call(base, upstream, { headers: { 'X-Proxy-Token': 'proxy-secret', Authorization: 'Bearer key' } });
  assert.equal(result.body.toString(), 'Bearer key');
});

test('IP allowlist applies to preflight and ignores spoofed forwarding headers locally', async () => {
  const base = await proxy({ ALLOWED_CLIENT_IPS: '203.0.113.0/24' });
  const response = await open(base, '/api/proxy', { method: 'OPTIONS', headers: { 'X-Forwarded-For': '203.0.113.1', 'X-Vercel-Forwarded-For': '203.0.113.1' } });
  assert.equal(response.statusCode, 403);
  await collect(response);
  const allowed = await open(await proxy({ ALLOWED_CLIENT_IPS: '127.0.0.0/8' }), '/api/proxy', { method: 'OPTIONS' });
  assert.equal(allowed.statusCode, 204);
  await collect(allowed);
});

test('on Vercel trusts the ingress IP, fails closed for missing or ambiguous headers', async () => {
  const base = await proxy({ VERCEL: '1', ALLOWED_CLIENT_IPS: '2001:db8::/32,203.0.113.0/24' });
  for (const [value, status] of [['2001:db8::123', 204], ['203.0.113.8', 204], ['', 403], ['203.0.113.8, 1.2.3.4', 403], ['1.2.3.4', 403]]) {
    const response = await open(base, '/api/proxy', { method: 'OPTIONS', headers: { 'X-Vercel-Forwarded-For': value } });
    assert.equal(response.statusCode, status);
    await collect(response);
  }
  assert.equal(clientIP({ socket: {}, headers: { 'x-forwarded-for': '203.0.113.8' } }, true), '203.0.113.8');
});

test('rejects invalid URLs and ambiguous/unencoded target query parameters', async () => {
  const base = await proxy();
  const paths = ['/api/proxy', '/api/proxy?url=', '/api/proxy?url=http://example.com&other=x', '/api/proxy?url=http://example.com&url=http://other.com'];
  for (const value of ['ftp://example.com', 'http://user:password@example.com', 'http://example.com/#fragment', 'http://', 'not a URL', 'http://example.com/\r\n']) paths.push(pathFor(value));
  for (const path of paths) {
    const response = await open(base, path);
    assert.equal(response.statusCode, 400, path);
    assert.equal(response.headers['access-control-allow-origin'], '*');
    const body = (await collect(response)).toString();
    assert.ok(!body.includes('password'));
  }
});

test('denies private literal targets and DNS targets by default', async () => {
  const base = await proxy({ ALLOW_PRIVATE_TARGETS: 'false' });
  for (const target of ['http://127.0.0.1', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://2130706433', 'http://169.254.169.254', 'http://localhost']) {
    const result = await call(base, target);
    assert.equal(result.status, 403, target);
  }
});

test('target host rules match exact domains or subdomains, never suffix lookalikes', async () => {
  const base = await proxy({ ALLOWED_TARGET_HOSTS: 'api.example.com,*.example.org' });
  for (const target of ['http://example.org', 'http://example.org.evil.test', 'http://evilapi.example.com', 'http://api.example.com.evil.test']) {
    const result = await call(base, target);
    assert.equal(result.status, 403, target);
  }
  const upstream = await serve((_req, res) => res.end('allowed'));
  const result = await call(await proxy({ ALLOWED_TARGET_HOSTS: '127.0.0.1' }), upstream);
  assert.equal(result.body.toString(), 'allowed');
});

test('enforces size limits for Content-Length and chunked bodies', async () => {
  const upstream = await serve(async (req, res) => {
    try { res.end(await collect(req)); } catch { /* Proxy cancels oversized uploads. */ }
  });
  const base = await proxy({ MAX_REQUEST_BODY_BYTES: '8' });
  const fixed = await call(base, upstream, { method: 'POST', headers: { 'Content-Length': '9' }, body: '123456789' });
  assert.equal(fixed.status, 413);
  const chunked = await call(base, upstream, { method: 'POST', chunks: ['12345', '67890'] });
  assert.equal(chunked.status, 413);
  const valid = await call(base, upstream, { method: 'POST', body: '12345678' });
  assert.equal(valid.body.toString(), '12345678');
});

test('IP classification blocks reserved ranges, IPv6 local and mapped private addresses', () => {
  for (const address of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '192.168.0.1', '198.18.0.1', '224.1.1.1', '::', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:a00:1', '2002:7f00:1::', '2001:db8::1', '3fff::1']) assert.equal(isPublicIP(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPublicIP(address), true, address);
  const list = parseAllowlist('192.0.2.0/24,2001:db8::/32');
  assert.ok(list.check('::ffff:192.0.2.1', 'ipv6'));
  assert.ok(list.check('2001:db8::1', 'ipv6'));
});

test('DNS check uses the exact checked records and rejects mixed public/private answers', async () => {
  const records = [{ address: '8.8.8.8', family: 4 }];
  let calls = 0;
  const resolver = (_hostname, options, done) => { calls++; assert.equal(options.all, true); done(null, records); };
  const resolve = (fn, options) => new Promise((accept, reject) => fn('example.com', options, (err, addresses) => err ? reject(err) : accept(addresses)));
  assert.strictEqual(await resolve(checkedLookup(false, resolver), { all: true }), records);
  assert.equal(calls, 1);
  records.push({ address: '10.0.0.1', family: 4 });
  await assert.rejects(resolve(checkedLookup(false, resolver), { all: true }), { code: 'TARGET_BLOCKED' });
  assert.strictEqual(await resolve(checkedLookup(true, resolver), { all: true }), records);
});

test('invalid environment settings fail closed', () => {
  for (const env of [
    { ALLOWED_CLIENT_IPS: 'not-an-ip' }, { ALLOWED_CLIENT_IPS: '10.0.0.0/33' },
    { ALLOWED_CLIENT_IPS: '::1/129' }, { ALLOW_PRIVATE_TARGETS: 'yes' },
    { REQUEST_TIMEOUT_MS: '0' }, { REQUEST_TIMEOUT_MS: 'NaN' },
    { REQUEST_TIMEOUT_MS: '2147483648' }, { MAX_REQUEST_BODY_BYTES: '-1' },
    { ALLOWED_TARGET_HOSTS: 'https://example.com' }, { ALLOWED_TARGET_HOSTS: '*' },
  ]) assert.throws(() => loadConfig(env));
});
