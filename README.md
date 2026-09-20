# CardVideo

上传一张照片和一段视频，得到一个分享链接。对方打开链接、用手机摄像头对准**打印出来的照片**，
照片上就会升起一块 3D 悬浮屏播放那段视频。

基于 [MindAR](https://github.com/hiukim/mind-ar-js)（图像追踪）+ [Three.js](https://threejs.org/)（渲染），
无前端构建步骤，可部署到 Vercel。完整设计决策与实测数据见 [`DESIGN.md`](./DESIGN.md)。

---

## 快速开始（本地，零云凭证）

```bash
npm install          # postinstall 会自动同步 public/vendor
npm start            # http://localhost:3000
```

不配置任何环境变量时：媒体存 `./data/media`，卡片元数据存 `./data/cards.json`。
整条链路（预检 → 编译 → 上传 → 分享 → AR 观看 → 删除）都能在本机跑通。

### 用手机测试（必须 HTTPS）

```bash
npm run dev:https    # 监听 0.0.0.0，自签证书，启动后打印手机可访问的地址
```

摄像头是**受安全上下文限制的 API**：局域网 http 下 `navigator.mediaDevices` 直接不存在，
AR 页面根本起不来。localhost 是唯一豁免的源——而手机恰恰不是 localhost。所以手机测试绕不开 HTTPS。

启动后会打印**该用哪个地址**。这一步值得留意，因为本机可能有多个网卡，而默认路由未必走物理网卡
（本机开发时就遇到过默认路由指向代理的虚拟网卡，那个地址手机永远连不通）：

```
  ┌─ 手机测试地址（手机需连同一 Wi-Fi）
  │  https://192.168.0.2:3000/debug.html
  └─ 先用这个地址打开 /debug.html，全绿了再去 /selfcheck

  本机其它地址（多半连不通，仅供排查）:
    172.21.32.1      vEthernet (Default Switch)    ✗ Hyper-V / Docker NAT
    192.168.254.1    VMware Network Adapter VMnet1 ✗ VMware host-only or NAT
    198.18.0.1       Meta                          ✗ proxy/VPN TUN adapter
```

**证书是自签的，手机第一次打开会警告"不安全"，需要手动信任一次：**

| 浏览器 | 操作 |
|---|---|
| Android Chrome | 点「高级」→「继续前往」 |
| iOS Safari | 点「显示详细信息」→「访问此网站」 |
| iOS（Safari 还需额外一步） | 设置 → 通用 → 关于本机 → 证书信任设置 → 打开该证书 |

证书由 `scripts/dev-cert.mjs` 用 `scripts/lib/x509.mjs` **在进程内签发**（Node 的 X.509 只能验证
不能签发，本机又没有 openssl，所以自己编码 DER）。证书覆盖本机所有物理网卡地址以及
`<ip>.nip.io` 别名，因此换网段后一般不需要重新信任。

> 不想装证书也可以用隧道：`npx localtunnel --port 3000` 或
> `cloudflared tunnel --url http://localhost:3000`，它们自带受信任的 HTTPS。代价是媒体会
> 经过第三方服务器。

### 生成测试素材

```bash
npm run fixtures
```

会在 `data/fixtures/` 生成一张高纹理测试照片（手写 PNG 编码，无需图像库）和一段带帧计数器的
H.264 MP4（需要 ffmpeg）。**照片可以直接打印出来做真机测试。**

---

## 页面

| 路径 | 作用 |
|---|---|
| `/` | 介绍页 |
| `/create` | 创建卡片：选照片 + 视频 → 预检 → 编译 → 上传 → 拿到分享链接 |
| `/selfcheck` | 本地自检：**在同一页面内**编译并直接进 AR，不上传任何文件 |
| `/c/{id}` | 分享落地页：显示照片、打印引导、「开始体验」按钮 |
| `/ar?card={id}` | AR 观看页（真实卡片） |
| `/debug.html` | 运行时诊断：验证 import map、特征提取器、编译 Worker 是否正常 |
| `/codec-test.html` | 解码能力诊断：用浏览器自录音频验证音频解码，排除设备/浏览器问题 |

**第一次部署后请先打开 `/debug.html`。** 它会在浏览器里跑通 6 项检查，包括"编译 Worker 能否
产出可被追踪器解析的 .mind"。这是无构建前端最容易静默失败的地方。

---

## 上传流程为什么是这样

Vercel 的函数**请求体上限 4.5MB**，视频永远无法经过 API。所以：

```
POST /api/upload-ticket   → 服务端生成 cardId 和每个对象的预签名上传地址
浏览器 ──PUT──────────────→ 对象存储（R2 / 本地 /api/local-upload）
POST /api/cards           → 只写元数据（几百字节）
```

`.mind` 追踪文件在**浏览器里编译**，不在服务端。原因：mind-ar 的编译器依赖
`@tensorflow/tfjs`，未压缩约 200MB，而 Vercel 函数包上限 250MB（见 `DESIGN.md` §3.2）。
放到浏览器还有个额外好处——创建者可以立刻自检。

---

## 部署到 Vercel

后端留在 Vercel，**媒体和卡片元数据都放同一个国内对象存储**（一套凭证、一个免费额度）。

### 为什么不是 Cloudflare R2

R2 的流量免费，是所有选项里带宽成本最低的——**但它要外币卡**，在国内这是硬门槛。

### 为什么选腾讯云 COS

- 支持支付宝/微信付款
- 新用户 **50GB 标准存储 + 10GB/月外网下行流量，免费 6 个月**
- S3 兼容，所以代码是**厂商无关**的：COS、七牛 Kodo、阿里云 OSS、R2 都是改配置不改代码

### 为什么元数据也存对象存储，不另建数据库

一张卡片就是 id、标题、三个对象键、时长、时间戳、owner token，**几百字节**。为此再注册一个
数据库、再管一套凭证和 SDK 不划算，而且每个像样的托管数据库都会带来"外币卡要求"或"又一个
会耗尽的免费额度"。

**访问模式也让对象存储是合适选择而非妥协**：卡片写入一次、永不修改，所以没有读-改-写竞争，
id 在写入前就已生成所以没有冲突需要仲裁。数据库能提供的（事务、索引、查询）在这里都不需要——
只需要按 key 取一条不可变记录。

**唯一放弃的能力**是"列出所有卡片"（需要额外的索引对象）。应用里没有任何地方需要列出卡片，
所以我没有实现它，而不是做个假的。

### 步骤

**1. 建对象存储（七牛 Kodo / 腾讯云 COS）**

- 控制台创建存储桶（七牛华北-河北 = `cn-north-1`），访问控制选**公开**
- **配置跨域规则** —— 不配的话上传会以「网络错误」失败：
  - 来源：`*`（测试期）或你的实际域名
  - 方法：`GET, HEAD, PUT, POST`（**不需要** `OPTIONS`）
  - Headers：`*`，或**每行一个**写 `Content-Type` / `Content-Length` / `Authorization`
  - 缓存时间 3600 —— **改完可能不是立即生效**，边缘会继续返回旧的失败结果约 20 秒
- 拿密钥（七牛：个人中心 → 密钥管理，**取同一行里的两个不同值**）

**2. 建 Turso 数据库**

```bash
turso db show <数据库名> --url        # → TURSO_DATABASE_URL
turso db tokens create <数据库名>     # → TURSO_AUTH_TOKEN
```

**3. 配置 Vercel 环境变量**

```
S3_ENDPOINT=https://s3.cn-north-1.qiniucs.com     # 注意：不含空间名
S3_REGION=cn-north-1
S3_BUCKET=cardvideo-media
S3_ACCESS_KEY_ID=<AccessKey>
S3_SECRET_ACCESS_KEY=<SecretKey>                  # 与上面取自同一行
S3_PROVIDER=qiniu
TURSO_DATABASE_URL=libsql://...
TURSO_AUTH_TOKEN=...
```

**必填项要么全填、要么全不填**——只填一部分会启动失败并明确报错，因为半配置的存储比不配置更危险。

**4. 部署**

连接 Git 仓库，或在本地 `vercel`。

### 部署前先本地验证

Vercel 上有几处行为与本地**不同**，这个命令在本地就把它们验掉，不必等部署后才发现：

```bash
npm run check:deploy
```

| 检查 | 为什么重要 |
|---|---|
| `check:entrypoints` | 入口文件是否存在、**`api/` 处理器是否被 `vercel.json` 重写挂上**、两种 URL 形态是否都能打到 API |
| `check:production` | 以 `VERCEL=1` 导入应用：验证 default export、静态资源、**`/media/` 未被挂载**、应用不自行监听端口 |
| `check:storage` | 凭证格式、**密钥查重**、**CORS 预检逐头验证**、预签名上传、读取、删除 |
| `check:turso` | 连接、建表、字段映射、类型、删除 |

部署之后还要问一次**线上**——本地检查再全也发现不了下面这个故障：

```bash
npm run check:live        # 默认 https://card.javierchen.cn，也可 npm run check:live -- <url>
```

它验证函数**真的在被调用**，而不只是构建成功。

### ⚠️ 入口文件：根目录 `server.js` 不够，必须放在 `api/`

**这里踩过一次真实的坑，症状完全没有报错。** 按官方文档在根目录放了 `server.js` 转出应用，部署"成功"、页面全部正常，但**整个 API 从未被调用**：

| 线上实际返回 | 应该是 |
|---|---|
| `GET /api/health` → `200 text/html`（首页文档） | `200 application/json` |
| `GET /任意不存在的路径` → `200 text/html`（首页） | `404 JSON` |
| `POST /api/*` → `405` 空 body | `400 JSON` |

整站被当成**纯静态包**发布了，`public/` 里的文件在 CDN 上直接发，`/api/*` 找不到文件就回落首页，POST 打静态文件被 Vercel 拒为 405。**构建日志里一个字都没有。**

而根目录 `server.js` 是官方文档写的位置，`check:entrypoints` 当时也全绿——它验证了文件存在且导出正确，但**没有任何本地检查能发现"这个文件没被打包进去"**。

所以函数入口放在 **`api/`** —— Vercel 唯一无需推断框架、一定当作 serverless function 的目录：

```
api/index.js          ← default export 一个 (req, res) handler，转发给 Express app
vercel.json           ← rewrites: /api/:path* -> /api
```

`api/index.js` 会**归一化路径**，因为重写过来时 `/api` 前缀是保留还是被剥掉没有明确文档。两种形态都必须能命中，`check:entrypoints` 对两种都做了断言。

> 这也解释了你最初看到的那条报错：`The pattern "server/index.js" defined in functions doesn't match any Serverless Functions inside the api directory` —— Vercel 的 `functions` 只认 `api/` 目录。当时我删掉了 `functions` 块，但**没有把文件放进 `api/`**，等于只解决了一半。

### ⚠️ 本机代理会让线上看起来是坏的

```bash
npm run check:live
```

在这台机器上，Clash 之类的代理开着 fake-IP 模式时，会把 `card.javierchen.cn` 解析到 `198.18.0.0/15` 保留网段（实测 `198.18.0.225`），于是**所有请求由代理回答而不是 Vercel**。

这正是本次排查的起点：浏览器里 `POST /api/upload-ticket` 显示 `405`、远程地址 `127.0.0.1:7897`——那个 405 是**本地代理**回的。同一个域名，走 Node 直连拿到的才是真实结果：

```
A 记录（DoH 查询）: 64.29.17.1 / 216.198.79.65     ← 真实 Vercel IP
NS:                ns1.vercel-dns.com
```

`check:live` 用 Node 的 `fetch`（走 OpenSSL，不受系统代理和 Windows Schannel 影响）。**看到 405 或证书错误时，先确认是不是代理在中间。**

### ⚠️ Vercel 上与本地不同的两点

**① `express.static()` 会被忽略。** 官方文档明确说明：静态资源必须放在 `public/**` 由 CDN 直接服务，`express.static()` 不生效（[Express on Vercel](https://vercel.com/docs/frameworks/backend/express)）。

所以 `server/index.js` 里那套基于 `setHeaders` 的缓存策略**在生产上不起作用**，同样的策略以 `headers` 规则写在 `vercel.json` 里。**两处必须保持一致**，否则本地正常的缓存行为上线后会变——而缓存行为错了，表现是"改了代码但浏览器跑旧的"。

**② 入口文件见上一节。** 结论是：不要依赖根目录的零配置探测，把 handler 放进 `api/` 并用 `rewrites` 显式挂上。

### 流量成本提醒

**每次观看都完整下载一遍视频**，所以带宽是主要成本，而不是存储：

| | 直连公网 | 绑定 CDN 域名后 |
|---|---|---|
| 下行流量 | ≈ ¥0.5/GB | ≈ ¥0.15/GB（回源） |

一个 25MB 视频被看 1000 次就是 25GB。**上线前建议绑定域名**，它同时解决另一个问题：未绑域名时读取走预签名 URL，**有效期只有 1 小时**，观看者停在同一页面超过一小时可能播放失败。绑定后填进 `S3_PUBLIC_BASE_URL`，代码不用改。

### 本地开发

不配置任何变量时，媒体走 `./data/media`、元数据走 `./data/media/cards/<id>/meta.json`。
**注意本地跑的是和线上完全相同的元数据代码路径**（同一个 `cardStore` 实现），只是底层存储不同——
这样"只在生产运行的那条路径"不会成为从未被测试过的路径。

---

## 验证

```bash
npm run check          # 三套检查全跑
```

脚本会**自动探测服务器地址**（先试 `https://localhost:3000`，再试 `http://localhost:3000`），
因为手机测试跑的是 HTTPS 自签证书模式，而写死 http 会让整套检查在健康服务器上报"全部不可达"。
也可以显式指定：`npm run check:server -- https://192.168.0.2:3000`。

| 命令 | 检查内容 |
|---|---|
| `npm run check:three` | mind-ar 1.2.5 从 three 导入的每个符号是否仍然存在（three r165 删掉了 `sRGBEncoding`，mind-ar 会因此**整页白屏**） |
| `npm run check:frontend` | 每个前端模块能否被真实 ESM 解析器解析、**递归遍历每个页面的模块图**、每个资源的 MIME 是否正确 |
| `npm run check:server` | 端到端 API：上传凭证、直传、建卡、读取、Range 请求、删除鉴权、路径穿越、跨卡片 key 攻击 |
| `npm run check:storage` | **对象存储真实连通**：凭证格式、密钥是否填重、CORS 预检、预签名上传、公开读取、删除 |
| `npm run check:turso` | **数据库真实连通**：连接、建表、建卡/读卡/字段比对/删除 |
| `npm run check:live` | **线上真的在跑函数**（而不只是静态文件）：`/api/health` 必须是 JSON、必须报告 `storage=s3` 与 `cards=turso`、其余 API 路径必须可达 |

`check:live` 是唯一一个**必须部署之后才能跑**的检查，也是唯一能发现"构建成功但函数没接上"的检查——本地代码在那种情况下是完全正确的。详见[入口文件](#️-入口文件根目录-serverjs-不够必须放在-api)。

`storage` 与 `turso` 两项需要 `.env`，并会真的读写云端资源（用完即删）；`check:live` 不需要凭证。

### 对象存储的坑（都已在检查脚本里固化）

国内对象存储的**每一个**失败都会在浏览器里表现成同一句话——「**网络错误**」——但原因完全不同，而且服务端日志看起来是正常的：

| 真实现象 | 真实原因 | 检查脚本如何识别 |
|---|---|---|
| 浏览器报网络错误，Node 里同样的请求成功 | **CORS 预检被拒** | 模拟 `OPTIONS`，逐项验证 origin / 方法 / **每一个请求头** |
| 校验和错误 `SignatureDoesNotMatch` | **两个密钥填成了同一个值**（AccessKey 与 SecretKey 都是 40 字符、都以 S 开头，极易复制错） | 比对哈希指纹，第 0 秒就停止 |
| 请求 404 / 域名不存在 | **endpoint 里多了空间名**（控制台显示的是拼好后的完整地址） | 检查 endpoint 是否已包含 bucket |
| 缺一个头就整个预检失败 | 允许的 Headers **每行一个**，逗号分隔会被当成一个头部名 | 逐个头单独发预检，点名是哪一个被拒 |

**并且注意「缓存时间」**：桶的 CORS 规则带缓存 TTL，改了规则后**边缘可能仍在返回旧的失败结果**。实测配好之后预检仍失败，等约 20 秒才生效——不要以为是自己没配对。

`check:frontend` 需要 `--experimental-vm-modules`；缺少该标志时它会**硬失败并提示**，
而不是降级成一个永远报 PASS 的假检查。

### 这套检查为什么这么"多疑"

开发过程中，这些检查**自己**出过至少五次错，每次都是"报绿但没查"：

| 检查的缺陷 | 后果 |
|---|---|
| 相对导入用了错误的解析基准 | 漏掉了 vendored 文件里指向不存在路径的导入 |
| 只认引号字符串、不认模板字面量 | `import(\`...?v=${...}\`)` 让整棵子树逃过检查 |
| 缺实验性标志时静默降级 | 永远 PASS |
| 用正则扫 export 列表 | 误报 4 个"缺失"符号 |
| 断言了错误的不变式 | 放过了破坏样本索引的实现 |

所以现在每个新增的检查都要求**独立的外部判定**（真实的 ESM 解析器、Node 模块链接器、
ffmpeg 解码、HTTP 响应），而不只是我自己写的结构性断言。

---

## 已知限制

- **照片必须打印。** 对着另一块屏幕拍会因反光、摩尔纹和视角畸变而失败。这是这类技术的
  物理限制，产品文案里必须说清楚。
- **不做转码。** 只接受 H.264/MP4。iPhone 默认的 HEVC 会在安卓 Chrome 上黑屏，所以上传时
  直接拒绝并提示重新导出。
- **某些浏览器解不了 MP4 里的 AAC 音频。** 实测**手机版 Edge**（Android）会以
  `DEMUXER_ERROR_DETECTED_AAC` 拒绝**任何**含 AAC 轨的 MP4——包括纯音频、无视频轨的文件——
  而**同一台设备上的 Chrome 全部正常**。最麻烦的是它**自称支持**：`canPlayType` 返回
  `probably`、`MediaSource.isTypeSupported` 返回 `yes`，所以**无法在上传时预检，只能靠实际播放发现**。
  AR 页检测到这种错误时会明确提示"请改用 Chrome 或 Safari"。可以对照 `/codec-test.html`：
  如果那里"播放浏览器自己录制的音频"通过，但 AR 没声音，就是这个问题。
  → 若将来要覆盖更多浏览器，方向是**上传时额外转一份非 AAC 音轨**并在播放失败时自动降级，
  而不是修改原文件（文件本身完全合规）。
- **素图会被拒。** 纯色、大面积渐变、强烈虚化的照片无法生成追踪特征。注意"有纹理"不等于
  "能追踪"：规整重复的图案（格子布、规则砖墙）会被 mind-ar 的自相似抑制全部丢弃，实测特征点为 0。
- **丢弃的上传会留下孤儿对象。** 用户拿到上传凭证后放弃，`data/media/cards/<id>/` 下的文件
  不会被清理（元数据从未写入）。成本很低（照片 + `.mind` 通常 < 2MB），但若有人拿到凭证后
  上传一个大视频再放弃，就会留下一个无人引用的文件。后续可加定期清扫。
- **无视频转码、无多视频、无通用卡片模式。** 均为 `DESIGN.md` 中明确排除的范围。
- **位置参数写死**（`public/js/ar/video-screen.js` 的 `POSE`）。真机看到实际画面后按需微调。

### 排查视频问题

怀疑是文件的问题时，先看事实而不是猜：

```bash
node scripts/inspect-video.mjs "你的视频.mp4"        # 编码、采样率、box 结构、是否 faststart
node scripts/dump-mp4-boxes.mjs "你的视频.mp4"       # 完整 box 树（含嵌套）
node scripts/fix-video.mjs "你的视频.mp4"            # 只重编码音频、视频原样复制
```

`server/lib/stripAudio.js` 与 `scripts/test-track-split.mjs` 是一个**未接入主流程**的实验：
按 box 层面的手术拆分音视频轨。保留它是因为里面的注释记录了一个代价很高的坑——`stco` 是
**绝对文件偏移**，删轨让 `moov` 变小之后必须同步平移，否则整个样本索引失效，而文件从外部看
完全正常（box 结构正确、`mdat` 字节一致、体积还小了一点）。

---

## 项目结构

```
api/
  index.js              Vercel 真正调用的函数入口；归一化路径后转发给 Express app

server.js               根目录零配置入口；与 api/index.js 导出同一个 app 实例

server/
  index.js              Express 应用；同时导出 app 供 Vercel 包装
  lib/config.js         决策常量（阈值、验收标准）与 id/错误工具
  lib/storage.js        存储适配器：disk（开发）/ 通用 S3（COS、七牛、OSS、R2）
  lib/cardStore.js      元数据：Turso / data/cards.json（本地兜底）
  lib/mp4.js            手写 MP4 box 解析：改尺寸、时长、编解码器
  routes/api.js         上传凭证、建卡、读取、删除（含鉴权与 key 归属校验）
  routes/media.js       Range 请求支持 + 本地直传端点

public/
  js/ar/precheck.js         素图拦截，用 mind-ar 原版特征提取器
  js/ar/mind-compile.js     编译 Worker 的主线程客户端
  js/ar/mind-compile.worker.js  浏览器端 .mind 编译（module worker）
  js/ar/ar-viewer.js        相机、追踪、播放状态机
  js/ar/video-screen.js     悬浮屏几何、材质与升起动画
  js/ar/mp4-meta.js         浏览器端 MP4 编解码器检测

scripts/
  sync-vendor.mjs       复制并打补丁三个依赖产物，生成 import map
  check-three-compat.mjs  依赖符号兼容性检查
  check-frontend.mjs      前端模块图静态验证
  check-entrypoints.mjs   入口契约：api/ 处理器 + rewrites + 两种 URL 形态
  check-live.mjs          线上冒烟：函数是否真的在被调用
  smoke-test.mjs          端到端 API 测试
  gen-fixtures.mjs        生成测试照片与视频
```

---

## 缓存策略（改代码看不到效果时先看这里）

这个项目**没有构建步骤**，浏览器缓存的就不再是"产物"而是"源码本身"，所以缓存策略是正确性的一部分：

| 内容 | 策略 | 理由 |
|---|---|---|
| HTML | `no-cache` + ETag | 页面里装着 import map，是模块图的版本锚点 |
| `/js`、`/css` | `no-cache` + ETag | 会随开发变动；复验返回 304，几乎零成本 |
| `/vendor` | `max-age=300` | 是 MB 级三方产物，值得缓存；但 `sync-vendor` 会改写其中两个文件，所以不能长缓存 |
| `/media/*` | `max-age=31536000, immutable` | 对象键按卡片划分，v1 中卡片内容不可变 |

条件请求的 304 由 `server/index.js` **显式实现**，没有依赖 Express。实测在这个配置下 Express
的静态中间件会对带 `If-None-Match` 的请求回 200 并重发整个正文（加不加 `compression` 都一样，
HEAD 也一样）——那样 `no-cache` 就等于没有节省。

**如果改完代码浏览器还是跑旧行为**，先排除缓存：打开 `/debug.html`，它会显示服务端实际返回的
资源哈希，与你预期的对比即可。诊断页本身的动态导入带防缓存参数，所以它不会被这个问题误导。

---

## 环境约束（本机踩坑记录）

- npm 默认缓存目录在工作区外会造成 `EPERM`；`.npmrc` 已把缓存指到 `./.npm-cache`。
- 本机沙箱**禁止 npm lifecycle script**，所以 `sharp`、`canvas` 这类需要 postinstall 下载
  原生二进制的包装不上。这也是 `gen-fixtures.mjs` 手写 PNG 编码器、以及服务端编译路径
  需要 `canvas` 桩模块的原因。
- `ffmpeg` 可以执行，但需要放宽沙箱权限；缺失时 `npm run fixtures` 会跳过视频生成而不是失败。
