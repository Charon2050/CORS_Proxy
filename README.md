# CORS_Proxy

部署到 Vercel 的通用 HTTP/HTTPS 代理，使用 Node.js 24 原生模块，无第三方运行时依赖。

```text
POST https://cors-proxy.example.com/api/proxy?url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1%2Fresponses
```

支持 GET、POST、PUT、PATCH、DELETE、HEAD、WebDAV 等 HTTP 方法，OPTIONS 由代理直接返回预检响应。支持 SSE、二进制和普通响应流；不解析 JSON，不自动解压，不自动重试，不跟随目标重定向。响应体逐块传输，遵循下游背压；客户端断开时取消上游请求。

## 部署到 Vercel

1. 将本项目推送到 GitHub、GitLab 或 Bitbucket，随后在 Vercel 选择 **Add New → Project** 导入。
2. Framework Preset 选择 **Other**，Root Directory 为项目根目录。无需设置 Build Command 或 Output Directory。Node.js Version 使用 **24.x**。
3. 在 **Settings → Functions** 确认启用 **Fluid Compute**。项目的 `vercel.json` 已为 `api/proxy.js` 设置 `maxDuration: 300`。
4. 在 **Environment Variables** 中按需设置下方变量。所有访问控制默认关闭，部署前可配置 `ALLOWED_CLIENT_IPS` 或 `PROXY_TOKEN`。变量修改后重新部署。
5. 部署后，在 **Settings → Domains** 添加所绑定的域名，按 Vercel 界面提示设置 DNS。
6. 如需任意浏览器访问，确保该部署的 **Deployment Protection** 不要求 Vercel 登录；平台拦截发生在应用之前，应用无法为这类响应补 CORS 头。访问控制可由本项目的 IP 白名单和密钥承担。

项目通过 `vercel.json` 的 `build.env.NODEJS_HELPERS=0` 禁用 Vercel 原生 Node.js helpers，避免其提前读取请求体；这与 Next.js 的 `api.bodyParser` 配置不同。不要在平台环境变量中将 `NODEJS_HELPERS` 覆盖为其他值。项目同时设置 `supportsCancellation: true`，让 Vercel 在客户端断开时取消调用。应用无需持久磁盘、数据库或构建产物。

### 等待时间和平台限制

默认允许整个请求持续 **290 秒**，包含上传请求、等待上游响应和传送完整响应流；Vercel 函数上限设置为 **300 秒**，预留 10 秒用于返回错误和清理资源。默认建连超时 10 秒；连接建立后没有独立的空闲超时，始终受总时长约束。

按 Vercel 当前文档，在开启 Fluid Compute 时：

| 套餐 | 函数时长上限 | 本项目如何配置 |
| --- | --- | --- |
| Hobby | 300 秒 | 默认配置即可 |
| Pro / Enterprise | 常规上限 800 秒 | 将 `vercel.json` 的 `maxDuration` 改为 `800`，并设置 `REQUEST_TIMEOUT_MS=790000` |
| Pro / Enterprise 的扩展时长 Beta | 满足平台条件时 1800 秒 | 将 `maxDuration` 改为 `1800`，并设置 `REQUEST_TIMEOUT_MS=1790000`；以账号支持情况为准 |

**仅修改环境变量不会提高 Vercel 的函数上限。** `maxDuration` 不能通过本项目的环境变量动态改变，修改配置后需要重新部署。Node.js 24 属于扩展时长支持的运行时；Secure Compute / Static IPs 等配置可能限制 Beta 使用。

Vercel 对请求体存在约 **4.5 MB** 的平台限制；设置更大的 `MAX_REQUEST_BODY_BYTES` 无法绕过它。响应使用流式路径，但仍受平台的响应、网络和执行时长限制，不保证无限文件大小。应用不提供 WebSocket、HTTP CONNECT 隧道、协议升级或无限期连接。

上游在较长时间内没有输出时，中间网络或 HTTP/1.1 客户端也可能主动关闭空闲连接。代理不会向任意响应体插入心跳或 SSE 消息，以免破坏原始内容。需要心跳时，应由上游生成。

## 调用方式

始终对**整个目标 URL**使用 `encodeURIComponent` 或等价方法，尤其是目标本身包含 `&`、`+`、`#` 或已编码字符时。代理只接受一个 `url` 参数；其他外层参数会返回 400，避免将未编码的目标查询条件静默丢失。目标 URL 必须为绝对 HTTP/HTTPS 地址，不能含用户名、密码或片段。

### 浏览器 fetch：POST 和流式读取

```javascript
const target = 'https://openrouter.ai/api/v1/responses';
const response = await fetch(
  `https://cors-proxy.example.com/api/proxy?url=${encodeURIComponent(target)}`,
  {
    method: 'POST',
    credentials: 'omit',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer YOUR_OPENROUTER_API_KEY',
      // 仅当服务端配置了 PROXY_TOKEN 时需要：
      // 'X-Proxy-Token': 'YOUR_PROXY_TOKEN',
    },
    body: JSON.stringify({
      model: 'openai/gpt-4.1-mini',
      input: '你好',
      stream: true,
    }),
    // signal: abortController.signal, // 可用于取消请求
  },
);

if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
const reader = response.body.getReader();
const decoder = new TextDecoder();
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  console.log(decoder.decode(value, { stream: true }));
}
const tail = decoder.decode();
if (tail) console.log(tail);
```

流的网络分块不等于 SSE 事件或 JSON 对象边界；业务代码仍需按上游协议拼接和解析。

### GET：保留目标查询参数

```javascript
const target = 'https://example.com/search?q=a+b&page=2';
const response = await fetch(
  `https://cors-proxy.example.com/api/proxy?url=${encodeURIComponent(target)}`,
);
```

### curl：检查预检

```bash
curl -i -X OPTIONS 'https://cors-proxy.example.com/api/proxy' \
  -H 'Origin: https://example.com' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type,x-proxy-token'
```

允许的客户端应得到 204、`Access-Control-Allow-Origin: *`、所请求的方法和请求头。预检不需要代理密钥，也不连接目标；IP 白名单仍然生效。若使用 curl 测试响应流，添加 `-N` 禁止客户端输出缓冲。Windows PowerShell 中请使用 `curl.exe`，并将上面的命令合为一行。

## 环境变量

参见 [.env.example](.env.example)。本地复制为 `.env.local`；Vercel 中通过项目设置添加，不提交密钥文件。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ALLOWED_CLIENT_IPS` | 空 | 逗号分隔的 IPv4 / IPv6 / CIDR；空表示不限制客户端 |
| `PROXY_TOKEN` | 空 | 非空时，实际请求必须携带对应的 `X-Proxy-Token`；不会转发给目标 |
| `ALLOWED_TARGET_HOSTS` | 空 | 精确域名或 `*.example.com`，逗号分隔；通配符仅匹配子域，不包含根域；不写协议、端口或路径。支持 IPv4 字面量规则 |
| `ALLOW_PRIVATE_TARGETS` | `false` | 是否允许内网、回环、链路本地等非公网目标；本地模拟上游时可设 `true` |
| `REQUEST_TIMEOUT_MS` | `290000` | 整个请求的时长上限，必须大于 0，并小于 Vercel `maxDuration × 1000` |
| `CONNECT_TIMEOUT_MS` | `10000` | DNS、TCP 和 TLS 建连时长上限，必须大于 0 |
| `UPSTREAM_IDLE_TIMEOUT_MS` | `0` | 上游连接空闲超时；0 禁用独立空闲超时 |
| `MAX_REQUEST_BODY_BYTES` | `4500000` | 应用请求体上限，同时检查 Content-Length 和实际字节数；0 禁用应用层限制 |
| `CORS_MAX_AGE_SECONDS` | `86400` | 预检缓存秒数，浏览器可能自行设定更低上限 |
| `NODEJS_HELPERS` | `0`（已在构建配置设置） | 保持为 0，禁用 Vercel helpers 的请求体预读取 |
| `HOST` | `127.0.0.1` | 仅本地服务器监听地址 |
| `PORT` | `3000` | 仅本地服务器端口 |

示例：

```dotenv
ALLOWED_CLIENT_IPS=203.0.113.10,198.51.100.0/24,2001:db8::/32
ALLOWED_TARGET_HOSTS=openrouter.ai,api.openai.com
PROXY_TOKEN=replace-with-a-long-random-secret
```

示例 IP 为文档专用地址，需要替换为实际客户端的**公网出口 IP**。白名单和密钥同时设置时，两者必须同时满足。格式错误的变量会使初始化失败，避免配置无效时意外开放访问。

### IP 来源与目标检查

在 Vercel（平台自动设置 `VERCEL=1`）中，读取平台提供的 `x-vercel-forwarded-for`，缺失时读取 `x-forwarded-for`。只接受单个合法 IP，不接受逗号分隔的代理链；缺失或非法时，启用白名单的请求会被拒绝。Vercel 前面再增加 CDN / 代理可能改变平台看到的客户端 IP，请按实际入口拓扑配置。

本地使用 TCP 连接的 `remoteAddress`，忽略用户传入的转发 IP 头。不要在非 Vercel 公网部署中手动设置 `VERCEL=1`；此项目没有为其他入口提供可信代理配置。

默认拒绝非公网目标 IP，也会检查域名解析结果，并将**同一组已检查的地址**交给连接过程，避免检查后再次解析造成 DNS 重绑定。混合公网和私网的 DNS 结果整体拒绝。启用目标域名白名单后仍然执行 IP 检查，除非显式打开 `ALLOW_PRIVATE_TARGETS`。代理不会跟随重定向。

## “原样转发”的边界

- 保留 HTTP 方法、目标路径和查询参数、请求体字节、`Authorization` 等应用请求头，以及上游最终状态码、响应体字节和普通响应头。gzip / br 等压缩内容不会在代理中解压。
- 应用逐块读取和转发请求体，但 Vercel 入口可能在调用函数之前先接收整个上传；不能据此保证客户端到 Vercel 的上传是实时流式的。
- `Host` 改为目标主机；连接级头（包括 `Connection` 指定的头）、`Expect`、代理认证头、`X-Proxy-Token` 和 Vercel / 转发 IP 元数据不发送给目标。HTTP 分块边界、头名称大小写、协议版本及连接级信息不保证一致；不转发 trailers 和中间 1xx 响应。
- 上游的 `Access-Control-*` 头被代理替换。所有应用生成的响应均包含 `Access-Control-Allow-Origin: *`，并通过 `Access-Control-Expose-Headers: *` 暴露浏览器允许读取的响应头。浏览器仍禁止读取 `Set-Cookie` 等受限头。
- 统一设置 `Cache-Control: no-store, no-transform`、`CDN-Cache-Control: no-store`、`Vercel-CDN-Cache-Control: no-store` 和 `X-Accel-Buffering: no`，防止代理 URL 缓存带凭据的 API 数据，并减少中间层缓冲。
- `Access-Control-Allow-Origin: *` 与浏览器的 `credentials: 'include'` 不兼容，所以不设置 `Access-Control-Allow-Credentials`。使用显式 `Authorization` 请求头和 `credentials: 'omit'`。服务端客户端直接发送的 Cookie 仍会转发；代理不负责改写 Cookie 的域和路径。
- 上游 3xx 和 `Location` 原样返回。浏览器或 HTTP 客户端可能随后直接访问目标地址，因此后续请求未必经过代理；这不是代理端自动跟随重定向。
- 在响应头发出之前，网络错误返回 502，超时返回 504；在流已经开始之后，只能中断连接，不追加 JSON 或伪造成功结尾。部分数据已到达客户端时，客户端需按上游协议判断是否完整。
- Vercel 在应用执行前产生的 413、超时、鉴权或路由错误不受本项目控制，可能没有 CORS 头。

## 本地运行与验证

安装 Node.js 24，然后在 PowerShell 中执行：

```powershell
Copy-Item .env.example .env.local
npm.cmd run dev
```

macOS / Linux 可以使用 `cp .env.example .env.local` 和 `npm run dev`。项目没有第三方依赖，无需安装包即可运行。

服务默认地址：`http://127.0.0.1:3000/api/proxy`。

```powershell
npm.cmd test
```

测试使用真正的本地 HTTP 连接，覆盖逐块 SSE 转发、客户端取消、上传大小限制、超时、压缩字节、重复响应头、方法和查询参数、CORS、鉴权、IP 白名单与目标 DNS 检查。不需要上游 API 密钥或互联网连接。部署后仍需通过实际 Vercel 域名验证平台入口、客户端公网 IP 和长连接行为。

## 官方参考

- [Vercel Node.js runtime](https://vercel.com/docs/functions/runtimes/node-js)
- [禁用 Node.js helpers](https://vercel.com/docs/functions/runtimes/node-js/advanced-node-configuration)
- [请求取消支持](https://vercel.com/docs/functions/functions-api-reference#cancel-requests)
- [Vercel streaming functions](https://vercel.com/docs/functions/streaming-functions)
- [函数时长配置](https://vercel.com/docs/functions/configuring-functions/duration)
- [平台限制](https://vercel.com/docs/functions/limitations)
- [Vercel 请求头与客户端 IP](https://vercel.com/docs/headers/request-headers)
