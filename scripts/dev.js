import http from 'node:http';
import proxy from '../api/proxy.js';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/api/proxy') return proxy(req, res);
  res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ error: 'not_found', message: 'Use /api/proxy?url=<encoded target URL>' }));
});
server.requestTimeout = 0; // The proxy enforces its own total deadline.
server.listen(port, host, () => console.log(`CORS_Proxy listening at http://${host}:${port}/api/proxy`));
