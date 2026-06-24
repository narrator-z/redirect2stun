# redirect2stun

通过 Cloudflare Worker + STUN 打洞，让内网服务同时支持 IPv6 直连和 IPv4 访问的 307 重定向方案，配合 Lucky 反向代理统一暴露服务。

## 适用场景

- 你有**公网 IPv6**，但运营商封锁了 80/443 端口
- 你有**两个域名**（一个作为统一的访问入口，另一个作为回源目标）
- 使用 **Cloudflare** 做 DNS 和 Worker
- 内网设备没有公网 IPv4，需要通过 STUN 打洞暴露服务

## 整体架构

```
用户访问 https://入口域名/服务路径
       │
       ▼
Cloudflare DNS ──→ Worker (307 重定向)
       │
       ├─ IPv4 用户 ──→ 从 KV 读取 STUN 打洞端口
       │                 307 → 回源域名:打洞端口/路径
       │
       └─ IPv6 用户 ──→ 使用预设 IPv6 端口
                       307 → 回源域名:IPv6端口/路径
       │
       ▼
   回源域名:端口
       │
       ▼
┌─────────────────────────────────┐
│        Lucky 反向代理           │
│  (https://lucky666.cn)          │
│  负责 TLS 卸载 + 路由分发       │
├─────────────────────────────────┤
│  ├─ 服务 A → 127.0.0.1:端口A   │
│  ├─ 服务 B → 127.0.0.1:端口B   │
│  └─ 服务 C → 127.0.0.1:端口C   │
└─────────────────────────────────┘
```

### 各组件职责

| 组件 | 职责 |
|------|------|
| **Cloudflare Worker** | 根据客户端 IP 类型选择端口，307 重定向到回源地址 |
| **Lucky** | STUN 打洞 + 反向代理（TLS 终止、路径分发、Webhook 推送端口） |
| **Cloudflare Tunnel**（补充） | 用于 redirect2stun 无法正常工作的应用（见下文） |

## 流量路径

- **IPv4 用户**：Worker 读取 KV → 307 跳转到 `回源域名:打洞端口` → Lucky 反向代理分流到内网服务
- **IPv6 用户**：Worker 使用预设端口 → 307 跳转到 `回源域名:预设端口` → Lucky 反向代理分流到内网服务
- **子域名保留**：访问 `子.入口域名/路径` → 跳转到 `子.回源域名:端口/路径`

## 前置准备

| 资源 | 用途 |
|------|------|
| 两个域名 | 入口域名（用户访问）、回源域名（指向你的服务器），DNS 托管于 Cloudflare |
| Cloudflare 账号 | 创建 Worker、KV 命名空间，可选 Cloudflare Tunnel |
| 内网设备 | 安装 Lucky，配置反向代理、STUN 打洞和 Webhook |
| 公网 IPv6 | 内网设备需有公网 IPv6 地址 |

## 部署步骤

### 1. Cloudflare 端

#### 1.1 创建 Worker

方式一：**直接粘贴代码**
- 进入 Cloudflare Dashboard → **Workers & Pages** → 创建 Worker
- 将本仓库 [`worker.js`](worker.js) 的代码全部复制粘贴到编辑器，保存并部署

方式二：**连接 GitHub 自动同步（推荐）**
- 进入 Cloudflare Dashboard → **Workers & Pages** → 创建 Worker → 选择 **Git 集成**
- 授权 Cloudflare 访问你的 GitHub 账号
- 选择本仓库 `narrator-z/redirect2stun`，分支 `main`
- 配置如下：

  | 配置项 | 值 |
  |--------|-----|
  | Build command | 留空 |
  | Deploy command | `npx wrangler deploy` |

> 💡 本项目是纯 JavaScript Worker，**无需构建步骤**，Build command 留空即可。Deploy command 使用 `npx wrangler deploy`，借助 `wrangler.toml`（已提交至仓库，仅含占位值）完成部署。之后每次 `git push`，Cloudflare 会自动部署更新。

#### 1.2 创建 KV 命名空间

- Workers & Pages → **KV** → 创建命名空间
- 在该 KV 中手动添加一条键值对，键名固定为 `GLOBAL_V4_PORT`，值随意填写（后续会被 Lucky 的 Webhook 自动更新）

#### 1.3 配置环境变量与 KV 绑定

Worker → **Settings** → **Variables**，添加以下内容：

**环境变量（Plain text）：**

| 变量名 | 说明 |
|--------|------|
| `MAIN_DOMAIN_A` | 你的入口域名 |
| `MAIN_DOMAIN_B` | 你的回源域名 |
| `DEFAULT_V6_PORT` | IPv6 用户使用的端口（即 Lucky 监听端口） |
| `AUTH_SECRET` | 自定义密钥，用于 Webhook 鉴权 |

**KV 命名空间绑定：**

- **Variable name**：`STUN_HTTPS`
- **KV namespace**：选择你刚创建的命名空间

#### 1.4 域名路由

- Worker → **Triggers** → **Custom Domains** → 添加你的入口域名和回源域名
- 或者在 DNS 面板为两个域名分别添加 CNAME 记录指向 Worker

#### 1.5 DNS 建议

| DNS 记录 | 说明 |
|----------|------|
| 回源域名 → AAAA 记录指向你的公网 IPv6 | 作为回源地址 |
| 入口域名 → Worker 地址 | 触发 Worker 逻辑 |

回源域名建议关闭 Cloudflare 代理（灰度云朵），避免 CDN 干扰直连。

### 2. 内网端（Lucky）

Lucky（管理面板 `https://lucky666.cn`）承担三项功能：反向代理、STUN 打洞、Webhook 推送。

#### 2.1 配置反向代理

在 Lucky 中设置多个反向代理规则，将统一端口上的不同路径分发到各个内网服务。例如：

| 路径/子域名 | 目标地址 |
|------------|----------|
| `/app1` | `127.0.0.1:8080` |
| `/app2` | `127.0.0.1:3000` |

Lucky 负责 TLS 终止，因此最终用户通过 `https://` 访问，你的内网服务可以只监听 HTTP。

#### 2.2 开启 STUN 打洞

在 Lucky 中启用 STUN 功能，它会自动从你的路由器/防火墙获取一个公网 IPv4 端口映射，将外部端口映射到 Lucky 监听的本地端口。

#### 2.3 配置 Webhook

打洞成功后，Lucky 通过 Webhook 将端口通知 Worker，Worker 再将其存入 KV。

| 配置项 | 值 |
|--------|-----|
| 请求地址 | `https://你的Worker域名/update-port` |
| 请求方法 | `POST` |
| Content-Type | `application/json` |
| 请求体 | `{"port": "打洞获取的端口", "secret": "你设置的AUTH_SECRET"}` |
| 触发时机 | STUN 打洞成功或端口变化时 |

## 完整工作流程

```
① Lucky 启动，配置反向代理规则
② Lucky 开启 STUN 打洞，获取公网 IPv4:端口
③ Lucky 发送 POST 到 Worker (/update-port)
④ Worker 校验 secret，将端口写入 KV (GLOBAL_V4_PORT)
⑤ 用户访问 https://入口域名/服务路径
⑥ Cloudflare DNS → Worker
⑦ Worker 判断客户端 IP 类型:
   ├─ IPv4 → 从 KV 取 STUN 打洞端口
   └─ IPv6 → 使用 DEFAULT_V6_PORT
⑧ Worker 307 重定向到 https://回源域名:端口/服务路径
⑨ 请求到达 Lucky → 根据路径分发到对应内网服务
```

## 补充方案：Cloudflare Tunnel

307 重定向 + STUN 打洞方案对大多数 HTTP 应用友好，但以下情况可能无法正常工作：

- 应用使用 **WebSocket**（部分实现不支持跳转）
- 应用内部有**硬编码的重定向逻辑**（会覆盖 307）
- 应用校验 **Host 头**与预期不符
- 某些 **SSE (Server-Sent Events)** 应用
- 非 HTTP 协议（如 SSH、RDP）

对于这些应用，建议以 **Cloudflare Tunnel** 作为补充：

### 部署 Cloudflare Tunnel

1. Cloudflare Dashboard → **Zero Trust** → **Networks** → **Tunnels** → 创建 Tunnel
2. 在内网设备安装 `cloudflared` 并运行
3. 在 Tunnel 中配置 Public Hostname，将路径指向对应的内网服务
4. 使用入口域名的不同子域名（如 `tunnel.入口域名`）或不同路径来访问

### 路由策略建议

| 访问方式 | 适用应用 | 说明 |
|----------|---------|------|
| redirect2stun（307 + STUN） | 普通 HTTP/HTTPS Web 应用 | 延迟低，直连 |
| Cloudflare Tunnel | WebSocket、SSH、RDP、硬编码应用 | 兼容性好，经 CF 中转 |

两者可以共存，你可以根据每个应用的特点选择合适的暴露方式。

## 安全说明

- `worker.js` 中所有敏感信息（域名、端口、密钥）均通过 Cloudflare 环境变量注入，GitHub 仓库不包含任何真实数据
- 本地 `wrangler.toml` 已通过 `.gitignore` 排除，不会上传
- 所有配置在 Cloudflare Dashboard Variables 页面完成

## 参考

- [Cloudflare Workers 文档](https://developers.cloudflare.com/workers/)
- [Cloudflare Tunnel 文档](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
- [Lucky 项目](https://lucky666.cn)
