# 图片链路的语域与判据：Pixiv 与 QQ 空间

本文界定两条图片投递链路的形式化描述：Pixiv 原图投递链路，与 QQ 空间说说配图链路。两条链路的功能边界、校验闸门、
失败判据与回归测试均在本文给出；两条链路的字节层校验共用同一实现。

## 目录

```text
0. 体例与术语
1. 共用校验面
2. Pixiv 投递链路
3. QQ 空间说说配图链路
4. 失败模式的统一判据
5. 未核验项与开放问题
```

**证据等级**：`【已核验】` 表示本轮读过源码或跑过命令并给出 `path:line`；`【据仓库记载】` 表示引自其它文档并给出处；
`【未核验】` 表示推断或未复现。

---

## 0. 体例与术语

### 0.1 术语表

表 1：核心术语（口径：本文全文使用下列固定术语，同一概念不换词）

| 术语 | 代码标识符 | 界定 |
| --- | --- | --- |
| 档位 | `tier` | 地址所指向的像素规模类别，取值为 `original` / `master` / `thumb` / `unknown` |
| 地址档位闸门 | `pixivImageTier` / `planPixivSend` | 由地址形状判定档位并分桶的校验 |
| 字节完整性闸门 | `verifyImageComplete` | 由尾标记与长度字段判定字节是否完整的校验 |
| 像素对账 | `pixivTierSizeVerdict` | 由元数据像素与实际像素比对判定档位是否被上游缩放的校验 |
| 零落盘 | `mode: 'base64'` | 配图字节不写入本地文件系统而直接以 data URI 投递的形态 |

### 0.2 测量批次标识

本文引用的实测数值来自 2026-09-20 至 2026-09-25 的若干测量批次。批次的日期用于标识口径；测量条件、方法与结果
分别在下文对应的表格中给出，不叙述测量过程。

### 0.3 行号引用的时效性

本文的 `path:line` 引用是写作时的仓库状态。重构会使行号平移，函数名与字段名是更稳定的锚点。

---

## 1. 共用校验面

### 1.1 两条链路的共同失效模式

两条链路的现象层失效形态一致：返回结果声明投递成功，而实际投递的字节是缩略档图像、下半幅为纯 `#808080` 的
截断渐进 JPEG，或未附任何图像。该失效模式的机制是：地址与字节两层校验缺失，使上游的降级结果被原样接受。

### 1.2 两道独立闸门

表 2：校验闸门分工（口径：实现位置为相对仓库根的 `path:line`）

| 闸门 | 判定对象 | 实现位置 |
| --- | --- | --- |
| 地址档位闸门 | 地址所指向的档位 | `qq-bridge/src/lib/pixiv.js` 的 `pixivImageTier` / `planPixivSend` |
| 字节完整性闸门 | 字节是否为完整图像 | `qq-bridge/src/safe-fetch.js` 的 `verifyImageComplete`（两条链路共用） |

闸门之外另有第三层校验：像素对账（`pixivTierSizeVerdict`）。该层的必要性在于第三方代理可以在使用原图地址的同时
返回被缩放的图像，此时地址档位判定成立而实际像素不符。

---

## 2. Pixiv 投递链路

本章界定 Pixiv 图像的来源解析、档位判定、候选分桶、像素对账与工具层流程。

### 2.1 现象与机制

#### 2.1.1 已报告的失效（测量批次 2026-09-20）

已报告的失效证据为投递到 QQ 后的附件名：

```text
3bbd4e1d0c3c1308c4d6fbf2ca3493bc_720.jpg
```

该附件名同时给出两项独立偏差。

表 3：失效现象的三项分解（口径：附件名为投递侧观测值；`lossless` 与 `contentKind` 为返回值观测值）

| 编号 | 现象 | 观测判据 |
| --- | --- | --- |
| (a) | 分辨率不是原图 | 文件名含 `_720`，即 720 档 |
| (b) | 下半幅约 60~70% 为纯 `#808080` | 截断的渐进 JPEG |
| (c) | 返回值声明无损 | 结果中带 `lossless: true` 与 `contentKind: 'pixiv-original'` |

关于 (a)：调用方未请求 720 档，代码中也不存在任何拼接 720 档地址的路径（`pixivMasterUrl` 只拼接
`_master1200.jpg`）。因此该地址只能来自上游返回的原图地址字段。

#### 2.1.2 机制

`qq-bridge/src/lib/pixiv.js:161-177` 记录了该失效的完整链路。

表 4：失效链路环节（口径：按数据流方向排列；证据位置见 `pixiv.js:161-177`）

| 步 | 环节 | 行为 |
| --- | --- | --- |
| ① | `normalizePixivIllustDetail` | 把镜像站 `urls.original` 原样收下 |
| ② | `pixivIllustOriginals` 的 ③④ 后备分支 | 由该地址推导其它页，并把它作为原图地址回报 |
| ③ | `pixivImageSources` | 把该地址排在候选第一位，于是 `size=original` 请求首选 720 档地址 |
| ④ | 全链路 | 不存在对地址是否为原图档的校验 |
| ⑤ | 字节侧 | 唯一检查为 `looksLikeImageBuffer`，只校验开头 3 个字节 |

#### 2.1.3 现行实现与判据

现行实现由三道校验串联：地址档位闸门（§2.3）拦截缩略档与非目标档；像素对账（§2.5）拦截地址档位成立而实际像素
被缩放的情形；字节完整性闸门（§2.6）拦截尾标记缺失或长度不符的字节。任一道校验不通过时，调用方切换到下一个候选
或如实报错，不投递半幅图像。

### 2.2 数据来源与优先级

三种来源按同一顺序尝试，并在结果中如实回报本次的数据来源（`source` / `sourcesTried`，`pixiv.js:103-113`）。

表 5：元数据来源与顺序（口径：可用性结论来自线上 VPS 实测；耗时区间为同一图像的多次测量值）

| 顺序 | 来源 | 特性 | 可用条件 |
| --- | --- | --- | --- |
| ① | `app-api.pixiv.net`（Bearer token，见 `lib/pixiv-auth.js`） | 形状最规整，可取 `meta_pages` 逐页原图直链，无需推断扩展名 | 有登录态时；无登录态时跳过（实测匿名请求必返 400，等待至超时） |
| ② | `www.pixiv.net/ajax` | 匿名可用（实测四类接口全部返回 200） | 未配置登录态时的主要来源 |
| ③ | 第三方镜像站（`pixivBase()`） | 延迟最高：同一图像 2.7~5.7 s，出现过 25 s 超时 | 仅作后备来源 |

表 6：经实测更正的三项结论（口径：结论位置 `pixiv.js:89-101`；测量环境为线上 VPS）

| 结论 | 内容 |
| --- | --- |
| 官网接口不需要登录 | `ajax/illust/<id>`、`ajax/illust/<id>/pages`、`ajax/search/artworks/<kw>`、`ajax/user/<uid>/profile/all` 实测全部返回 200，不需要 cookie 与 Referer；UA 使用 `Mozilla/5.0` 即可 |
| 图床需要 Referer | `i.pximg.net` 不带 `referer: https://www.pixiv.net/` 一律返回 403 nginx，带上返回 200 |
| 镜像站为第三方且可失效 | 域名与可用性不保证，因此地址可配：`config.json` 的 `pixiv.base` > 环境变量 `QQBRIDGE_PIXIV_BASE` > 内置默认值，且每次现读（改配置不需要重启 MCP 子进程，`pixiv.js:152-154`） |

凭证约束：`cookie` 与 `Bearer` 只发送给 pixiv 自有域名，镜像站不接收任何凭证（`pixivRequestHeaders`，`pixiv.js:1071`）。

#### 2.2.1 逐页原图直链的解析顺序

`pixivIllustOriginals`（`pixiv.js:1333`）按下表顺序解析逐页原图直链。

表 7：原图直链的解析顺序（口径：`source` 列为结果中回报的来源标记）

| 顺序 | 解析方法 | `source` 标记 |
| --- | --- | --- |
| ① | 详情已带 `meta_pages`（app-api 路径），直接复用，不额外请求 | `app-api:meta_pages` |
| ② | `app-api /v1/illust/detail` 的 `meta_pages[].image_urls.original` | `app-api:meta_pages` |
| ③ | 官网 `ajax/illust/{id}/pages` 的 `body[].urls.original` | `pixiv:pages` |
| ④ | 镜像站 `detail.php`（其自身登录态所换取的同一份 ajax 响应） | `mirror` |
| ⑤ | 后备推导：由 p0 原图直链推导同作品其它页（`deriveOriginalPageUrls`，把 `_p0` 替换为 `_pN`） | `derived` |

每一步的失败都记入 `tried[]`，最终拼成 `note` 回报给模型，使失败原因在返回值中可见。

### 2.3 第一道闸门：地址档位

#### 2.3.1 档位识别

档位判定前先把镜像站代理地址还原为内层 `i.pximg` 地址（`pixivImageInnerUrl`，`pixiv.js:187`：从
`/api/image.php?url=...` 取出 `url` 参数），因为档位取决于内层地址。

`pixivImageTier`（`pixiv.js:207`）按下表判定档位。

表 8：档位判定规则（口径：pixiv 侧档位命名是确定性的；`W`、`H` 为边长像素数）

| 地址形状 | 判定档位 |
| --- | --- |
| `/img-original/img/<日期>/<id>_pN.<ext>`，文件名无档位后缀 | `original` |
| `_pN_master1200.jpg` | `master`（1200 档） |
| `_pN_720.jpg` / `_pN_1080.jpg`（按边长命名的显式降级档） | `master` |
| `/img-master/` 路径 | `master` |
| `_pN_square1200.jpg` / `_pN_custom1200.jpg` | `thumb` |
| `/c/<W>x<H>` 边长前缀且 `W ≤ 600`（`c/250x250`、`c/360x360`、`c/540x540`） | `thumb` |
| 无法识别（第三方 CDN / 新形状） | `unknown`：不拦截，但下游不得据此声明无损 |

判定使用的三个正则（`pixiv.js:180-184`）：

```js
const PIXIV_THUMB_SIDE_RE     = /\/c\/(\d{3,4})x(\d{3,4})/;
const PIXIV_RENDITION_NAME_RE = /_p\d+_(?:master1200|square1200|custom1200|\d{3,4})\./i;
const PIXIV_ORIGINAL_NAME_RE  = /\/\d+_p\d+\.(?:jpe?g|png|webp|gif)$/i;
```

#### 2.3.2 候选分桶

`planPixivSend`（`pixiv.js:232`）按档位与目标档位把候选分入 `primary` / `fallback` / `skipped` 三桶。

表 9：候选分桶规则（口径：桶名为 `planPixivSend` 返回结构中的字段名）

| 候选档位 | `size=original` 时 | `size=master` 时 |
| --- | --- | --- |
| `thumb` | `skipped`：任何情况下都不投递 | `skipped`：投递结果即 250×250 缩略图 |
| `master` | `fallback`：仅当真原图档候选全部失败才允许进入，且必须显式打日志并在结果中如实说明 | `primary`（调用方明确请求该档） |
| `original` | `primary` | `primary` |
| `unknown` | `primary`（不按档位拦截，由 §2.5 的像素对账把关） | `primary` |

桶归属由本函数重算，先清除上游携带的 `fallback` / `fallbackReason` 标记，避免出现 `primary` 桶内携带
`fallback: true` 的自相矛盾状态（`pixiv.js:242-244`）。

#### 2.3.3 候选来源与顺序

`pixivImageSources`（`pixiv.js:1486`）按下表顺序生成候选。

表 10：候选来源与顺序（口径：延迟与字节一致性为实测值）

| 顺序 | 候选 | 说明 |
| --- | --- | --- |
| ① | `i.pximg.net` 直联（带 `referer`） | 实测 60~400 ms，字节与源文件逐字节一致 |
| ② | 镜像站同名图代理（`pixivProxyUrl`） | 字节一致，延迟高（2.7~5.7 s，偶发超时） |
| ③ | 既有候选：由缩略图推导日期路径（`pixivImageCandidates`） | 搜索路径持续使用，行为保持不变 |

`size=original` 时，非原图档候选被标记 `fallback: true` 并附原因（`pixiv.js:1497-1504`）；`unknown` 档不标记，
不按档位拦截，由像素对账把关。

`pixivImageCandidates` / `pixivImageSources` 中的 `size ?? 'master'` 是面向既有调用方的兼容默认值。工具层始终
显式传 `size`，该默认值不构成产品行为（`pixiv.js:20-25`）。

#### 2.3.4 工具层默认档位

`qq_send_pixiv` 的有效档位 `sizeEff`（`mcp-napcat-safe.js:3443`）：

```js
const sizeEff = String(size ?? 'original').toLowerCase() === 'master' ? 'master' : 'original';
```

三条入口（作品号、画师、关键词）的默认档位均为 `original`，定标批次 2026-09-20。此前仅当参数含 `illustId` 或
`authorId` 时默认 `original`，仅传 `query` 时回落 `master`；该行为已移除。显式传 `size` 时以调用方取值为准。

### 2.4 像素对账（第三层校验）

仅校验地址形状不足以判定图像质量：第三方代理可以在使用原图地址的同时返回被缩放的图像，其缓存文件名形如
`<md5>_720.jpg`，此时地址判定为原图档而字节为 720 档。§2.1.1 的失效即属该形态。

对账方法：以作品元数据中的原图像素（pixiv 详情里的 `width` / `height`）为期望值，与实际取得的像素比对。
`pixivTierSizeVerdict`（`pixiv.js:269`）的判据如下。

表 11：像素对账判据（口径：长边指 `max(width, height)`；`ow`、`oh` 为元数据宽高）

| 判据 | 规则 |
| --- | --- |
| 仅对 `page === 0` 比对 | 详情中的宽高只属于第 0 页；其它页无权威尺寸，不比对 |
| 取不到像素 | 放行，仅按档位与尾标记判定 |
| `tier === 'original'` | 实际长边小于期望长边即判不符，报告“期望 W×H，取得 w×h，被上游缩放” |
| `tier === 'master'` | 期望值为 `min(1200, max(ow, oh))`；实际长边小于 `floor(期望 × 0.95)` 即判不符（容差 5%：pixiv 按长边缩到不超过 1200，四舍五入产生 1~2 px 误差） |
| `tier === 'thumb'` / `unknown` | 只返回带外信息，不拦截 |

该函数为纯函数，可离线测试，自测脚本为 `qq-bridge/tools/test-pixiv-tier-truncation.mjs`。

### 2.5 第二道闸门：字节完整性

`verifyImageComplete` 为两条链路共用的字节层校验（Pixiv 投递与 QQ 空间配图）。

#### 2.5.1 必要性

`safe-fetch.js:250-272` 记录了三种候选假设的逐条证实与证伪。

表 12：截断来源的假设检验（口径：本机 Node v24.13.0；传输层实验用服务端声明 `Content-Length=1000` 后发 400 字节并销毁套接字）

| 假设 | 结论 |
| --- | --- |
| 传输层静默截断 | 不成立：上述两种形状（定长与 chunked）均触发 `res.on('error')` 的 `"aborted"` 并走到 reject；上限超限路径为 `settled=true; res.destroy(); reject(...)`，即拒绝而非截断 |
| 缺少字节校验即接受 | 成立：`res.on('end')` 把收到的 chunk 直接 concat 后 resolve，唯一检查 `looksLikeImageBuffer` 只校验开头 3 个字节。上游若返回残字节（第三方代理缓存未拉完即被中断的原图，再带正确的 `Content-Length` 完整吐出，为镜像站的常见形态），则该字节会被原样写盘并原样发给 NapCat |
| `content-length` 头被使用 | 改动前未读取（全文件检索无命中）；JPEG 的 EOI（`FFD9`）此前亦未检查 |

#### 2.5.2 判据

表 13：尾标记判据（口径：`path:line` 为 `safe-fetch.js:286` 起的判定实现）

| 格式 | 尾标记判据 |
| --- | --- |
| JPEG | 末 64 字节内必须含 `FFD9`（EOI） |
| PNG | 末 16 字节内必须含 IEND 块完整尾部 `00 00 00 00 49 45 4E 44 AE 42 60 82`（长度 0 + 类型 + 固定 CRC） |
| GIF | 末 8 字节内必须含 `0x3B` |
| WebP | RIFF 头的长度字段（`readUInt32LE(4) + 8`）必须不大于实际字节数；仅当声明值大于实际值才判截断，声明值小于实际值表示尾部有额外填充，图像本身完整，不得判为截断 |

长度比对规则：存在 `content-length` 且响应未被编码压缩（`content-encoding` 为空或 `identity`）时，实际字节数必须与
其相等；有压缩时长度不一致属正常，跳过比对。

校验不通过时抛出“图片字节不完整”，调用方切换到下一个候选或如实报错，不投递截断图像。

#### 2.5.3 下载侧字节上限

```text
MAX_IMAGE_FETCH_BYTES = 15 * 1024 * 1024     // safe-fetch.js:348
```

定标依据（`safe-fetch.js:330-347`）如下。

表 14：字节上限的定标条件、方法与结果（口径：常量单位为字节；DSH 侧结论引自所装包源码）

| 项 | 内容 |
| --- | --- |
| 定标前状态 | 全桥存在三个互不相关的上限：本函数默认 4 MB、`qq_image_search` / `qq_send_image` 8 MB、`qq_send_pixiv` 8 MB；同一图像经不同入口得到不同结论，且无依据说明 |
| 约束来源 | DSH 附件层：线上 DSH 0.1.2-rc.1 的 `dsh-attachment-local/lib/index.js:637` 定义 `const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024`，同包 `README.zh.md` 第 41 行写明 `maxImageBytes` 默认 20 MiB；`/root/.dsh/profiles/web/` 未覆盖该值 |
| 结果 | 15 MB < DSH 的 20 MB，下载侧放宽不会超过 DSH 上限；原先的 4 MB / 8 MB 为自设的更紧上限，会在图像到达投递闸门之前将其丢弃 |
| 适用范围 | 本常量只约束下载。投递前另有独立卡口 `lib/image-compress.js` 的 `IMAGE_HARD_MAX_BYTES`；两者均需放宽到 15 MB 才构成端到端 15 MB，且均不得超过 DSH 的 20 MB |

`safeFetchBuffer` 默认不携带任何请求头（既有调用行为不变）。`extraHeaders` 的存在理由为上表所述的图床要求：
`i.pximg.net` 带 `referer: https://www.pixiv.net/` 返回 200，不带返回 403；补齐该头是 `qq_send_pixiv` 能够直联
pximg 取得逐字节一致原图的必要条件。`host` 头由本函数按 URL 自行设置，调用方传入的 `host` 会被丢弃，以避免把
`host` 改写为其它域名。

### 2.6 工具层流程

`qq_send_pixiv`（`mcp-napcat-safe.js:3443` 起）。

#### 2.6.1 入口

表 15：入口与参数对照（口径：三条入口的默认档位均为 `original`）

| 入口 | 参数 | 行为 |
| --- | --- | --- |
| 作品号 | `illustId`（作品号或 `pixiv.net/artworks/<数字>` 链接） | 直接取该作品；其它搜索与筛选参数全部忽略 |
| 画师 | `authorId` | 画师号、`pixiv.net/users/<数字>` 链接或画师名称。名称走 `resolvePixivAuthor`（官方用户搜索）；存在歧义时返回候选列表交由调用方选择，不做自动定号（误发作者账号的代价高于不投递） |
| 关键词 | `query` | 走 `pixivSearch`（本地筛选加自动翻页） |

画师名称路径的实测约束（`pixiv.js:1520-1532`）：web 搜索引擎路径不可靠。线上 VPS 上 bing 候选恒为 0，
duckduckgo 间歇返回 202；常见名称（如“七菜”）会返回 3 个同名账号而目标账号不在前列。因此实现只产出候选，
不做自动定号。

#### 2.6.2 逐候选试的顺序与闸门

`mcp-napcat-safe.js:3354-3460`：

```text
sources = pixivImageSources(work, { page, size: sizeEff, originals })
plan    = planPixivSend(sources, { size: sizeEff })

1. 对 plan.skipped 中的缩略档逐个打日志（记录被跳过的档）
2. tryList(plan.primary)   —— 逐个候选：
     safeFetchBuffer 下载  →  sniffImageInfo 取实际像素
     →  pixivTierSizeVerdict 对账（不符 → 弃用 + 打日志 + continue）
     →  成功则记下 gotFrom / gotVia / gotTier / gotPixels
3. 若 primary 全部失败且存在 fallback：
     向 stderr 打一行："原图档 N 个候选全部失败 → 显式降级到 X 档；失败原因：…"
     tryList(plan.fallback, isFallback=true)  → 成功则置 tierFallback = {…}
4. 全部失败 → 如实报错，列出试过的地址与失败原因
     若失败原因为“超过大小限制”，提示改用 size=master
     并注明“另有 N 个缩略档候选按规则未试：投递结果将是缩略图”
```

随后计算 `sha256`、按魔数确定扩展名、写入 `napcat.tmpDir`（服务器上指向容器挂载目录）或
`<root>/state/image-tmp`，再 POST `/api/social/send-message`。

#### 2.6.3 返回字段

表 16：返回值字段语义（口径：字段名与结果结构一致）

| 字段 | 含义 |
| --- | --- |
| `lossless` | 仅当“请求档位为原图”“实际投递为原图档”“未发生降级”三项同时成立时取 `true` |
| `tierServed` | 实际投递的档位（`original` / `master` / `thumb` / `unknown`），由地址档位与实际像素双重判定 |
| `tierFallback` | 非 null 表示发生降级，含 `to` / `reason` / `originalTried` / `failures` |
| `pixels` | 实际取得的像素（`WxH`） |
| `bytes` / `sha256` / `format` | 本次实际投递的字节属性 |
| `fetchedFrom` | 实际命中的 URL |
| `fetchedVia` | 字节来源：`pximg-direct` / `mirror-proxy` |
| `pixivSource` | 元数据来源：`app-api:meta_pages` / `pixiv:pages` / `mirror` / `derived` |
| `source` | 入口：`illustId` / `authorId` / `search` |
| `pick` | 画师路径的说明文本（“按名称「X」检索到画师 N，名下共 M 件公开作品，按投稿时间新→旧取第 K 件”） |

`lossless` 的旧实现为 `lossless: sizeEff === 'original'`，因此在降级投递 720 / 1200 档乃至缩略图时结果仍为
`lossless: true`。现行实现要求三项条件同时成立（`mcp-napcat-safe.js:3461-3506`）。

### 2.7 其它不变量

#### 2.7.1 R-18 的不对称策略

表 17：R-18 处理策略（口径：策略按工具分别定义，不对称是刻意设计）

| 工具 | 策略 |
| --- | --- |
| `qq_pixiv_search` | 默认 `r18=exclude`，仅显式传 `only` / `include` 时放行 |
| `qq_send_pixiv` | 始终排除 R-18 / R-18G：不提供 `r18` 参数，使不适合内容无法被投递进 QQ |
| 空间配图 | 同一规则（说说的可见性为公开） |

投递路径的闸门实现于 `mcp-napcat-safe.js:3297-3347`：`xRestrict` 缺失或非 0 即判为 R-18，命中时返回错误并列出标签。

实测更正：本镜像站默认搜索结果的 `xRestrict` 恒为 0（关键词“初音ミク”“エロ”“R-18”“巨乳”“オリジナル”各
60 条全部为 0），即该站点只检索全年龄库，因此 `r18='only'` 实测恒为空。过滤逻辑仍然保留
（`xRestrict !== 0` 加 R-18 / R-18G 标签后备），因为上游可能变更，且标签后备能够拦截“关键词本身即 R-18 标签”
的作品（`pixiv.js:55-60`）。

#### 2.7.2 本地筛选

镜像站只接受 `keyword` 与 `page` 两个参数。逐个试过的参数 `mode=safe/all/r18`、`s_mode=s_tag/s_tag_full/s_tc`、
`order=date_d/popular_d`、`p`、`bl`、`type=illust/manga` 全部被忽略（同一关键词的 `total` 恒定、首条 id 恒定）；
只有 `page` 改变结果集（`pixiv.js:36-37`）。

因此筛选实现于已抓取的数据之上（`normalizePixivFilters` 加 `filterPixivItems`），`scanPages` 自动翻页用于补偿
单页 60 条的限制。

表 18：筛选与翻页参数（口径：值域与默认值取自实现；实测结论来自第 1 页 60 条样本）

| 参数 | 行为 |
| --- | --- |
| 单页条数 | 60 条；走 app-api 时为 30 条（`pixiv.js:332-333`） |
| `scanPages` | 默认 3，上限 10。硬要求：不传任何新参数时，结果必须与改动前逐字段一致；实现方式是“调用方是否使用新参数”作为开关（未给任何筛选参数时只抓 1 页、不排序、只过滤 R-18） |
| `sort` | 只支持投稿时间：`date_desc`（默认）/ `date_asc` / `random`。传 `popular` / `hot` / `rank` 时回落 `date_desc` 并在 `warnings` 中写明原因 |
| 不能按人气排序的原因 | 逐条核对第 1 页 60 条 item 的全部键：`aiType / alt / bookmarkData / createDate / description / height / id / illustType / isBookmarkable / isMasked / isOriginal / isUnlisted / is_howto / pageCount / profileImageUrl / restrict / sl / tags / title / titleCaptionTranslation / updateDate / url / userId / userName / visibilityScope / width / xRestrict`。其中 `bookmarkData` 表示当前登录用户是否收藏（未登录恒为 `null`），`isBookmarkable` 只表示是否可收藏；把整个返回体按字符串统计：`bookmarkCount` 命中 0 次、`like` 命中 0 次、`view` 命中 0 次 |
| `excludeAi` | 不能写作 `aiType !== 0`。实测：关键词“AIイラスト”的 60 条全部 `aiType=2`；“手描き”的 60 条全部 `aiType=1`；“アナログ”为 `1=57 / 2=3`。因此 `aiType=2` 表示 AI 生成，`aiType=1` 表示非 AI（0 未出现在实测样本中，按“未标注”处理）。写作 `!=0` 会把整页作品全部过滤 |
| `illustType` | 三种取值：0=插画、1=漫画、2=动图（ugoira）。`illust='illust'` 与 `'manga'` 只接受 0 / 1；2 不属于任何一类，被两条筛选中任意一条排除 |
| 翻页边界 | 相邻页 id 不重叠（`p1∩p2 = p1∩p3 = p2∩p3 = 0`），每页 60 条，`lastPage` 恒为 10。`page` 超出 `lastPage`（试过 `page=11`）仍返回 60 条，属异常后备行为，不可采信；自动翻页因此一律限制在 `lastPage` 之内 |

#### 2.7.3 按作品号取图的实现约束

`mcp-napcat-safe.js:3247-3291` 记录：旧实现构造 `thumbUrl` 为空的对象后继续执行，而候选由缩略图推导日期路径，
因此候选数为 0，该路径从未成功。现行实现先按作品号取得详情与原图直链。

同类纯函数约束：`pixivMasterUrl` 一律拼接 `.jpg`。实测 png 原图作品的 `..._p0_master1200.png` 返回 404，
`.jpg` 返回 200（740 KB）（`pixiv.js:1315-1321`）。

#### 2.7.4 画师的其它作品

`pixivUserWorkIds`（`pixiv.js:1410`）的顺序为：app-api `/v1/user/illusts`（Bearer，每页 30 件，按 `next_url`
向后翻页，上限 10 页）、官网 `profile/all`（一次返回全部）、镜像站 `native.php`（代拉同一 `profile/all`）。

表 19：画师作品枚举约束（口径：判定依据取自实现与实测）

| 项 | 内容 |
| --- | --- |
| 排序依据 | pixiv 作品号全局递增，因此按作品号倒序等价于按投稿时间新→旧；此处无 `createDate` 可用 |
| app-api 返回 0 件 | 不作为结论，继续尝试后续来源：app-api 的 `type=illust` 可能不含某些投稿类型，而 `profile/all` 是该账号投稿总量的权威答案，后备尝试成本低 |

---

## 3. QQ 空间说说配图链路

本章界定 QQ 空间说说的发帖链路、配图来源优先级、字节形态选择、体检闸门与临时文件清扫。

### 3.1 发帖链路的实测结构

配图形态由 NapCat 侧的接收契约决定。下表各条为读代码与所装包得到的结论（`lib/qzone-image.js:3-17`）。

表 20：发帖链路各步（口径：NapCat 版本为本机所装 9.9.26-44498，包体 `resources/app/napcat/napcat.mjs`）

| 步 | 主体 | 行为 |
| --- | --- | --- |
| ① | 桥 | `mcp-napcat-safe.js` 的 `qq_send_qzone` 调用 OneBot `POST <httpUrl>/send_qzone_msg` |
| ② | NapCat | `SendQzoneMsg._handle` 逐个处理 `e.images`：先经 `Ti(this.core.NapCatTempPath, a)`（图片解析器：case 1 本地路径 / case 2 http(s) 下载 / case 3 `base64://` 解码）归一为文件路径；URL 与 base64 两种非本地来源由 NapCat 自身在 `finally` 中删除 |
| ③ | NapCat | 把该文件字节转为 base64，经 `uploadImageToQzone` 调用 `POST up.qzone.qq.com/cgi-bin/upload/cgi_upload_image` 取得 richval |
| ④ | NapCat | `publishQzoneMsg(content, richvals, ugc_right, target_uins)` 用 `\t` 拼接 richval，调用 `POST emotion_cgi_publish_v6` |

由上表可得两项结论。

表 21：链路的两项推论（口径：结论 (b) 的修复位置为 `mcp-napcat-safe.js:2659-2703`）

| 编号 | 结论 |
| --- | --- |
| (a) | 图像可按 URL 或 base64 直传，桥侧无需落盘，因此策略取“可零落盘时零落盘” |
| (b) | 旧实现传 `file`，而 NapCat 只读 `images`，该参数被静默忽略：配置了配图也不会发出，且不报错。已修复 |

#### 3.1.1 说说标识的读取

`onebot()` 返回 OneBot 响应中的 `data`，`tid` 位于 `data.tid`；旧实现只读 `data.data.tid`（多一层），
导致发帖成功后 `tid` 恒为 null。现行实现兼容两种形态（`mcp-napcat-safe.js:2664-2707`）：

```js
const out = { ok: true, tid: data?.tid ?? data?.data?.tid ?? null, content: text };
```

### 3.2 配图来源与优先级

入口为 `collectQzoneImages`（`lib/qzone-image.js:170`）。入参优先级为 `file` > `imageUrl` >
`pixivIllustId` / `pixivQuery` > `imageQuery`，第一条非空者生效。

该函数不抛错：取不到配图时返回空 `items` 与 `notes`，由调用方发纯文字说说。该边界为设计约定：配图失败不阻断发帖。

表 22：配图来源与体检路径（口径：`verifyQzoneImage` 与 `verifyImageComplete` 为 §1.2、§3.4 所述实现）

| 来源 | 取字节方式 | 体检 |
| --- | --- | --- |
| ① `file`（本地路径） | `fs.readFileSync` | 必须自行通过 `verifyQzoneImage`：该路径不经过 `safeFetchBuffer` |
| ② `imageUrl`（直链） | `safeFetchBuffer` | `safeFetchBuffer` 内部已执行 `verifyImageComplete`，此处再显式比对一次 |
| ③ pixiv（`pixivIllustId` 优先，其次 `pixivQuery`） | `pixivIllustOriginals` → `pixivImageSources` → `planPixivSend` | 与第 2 章完全相同的闸门与像素对账 |
| ④ `imageQuery`（联网搜图） | `searchImages`（`lib/image-search.js`） | `verifyImageComplete` |

pixiv 路径的附加规则：先按 `work.adult` 过滤，R-18 作品不配入公开说说，并在 `notes` 中说明。理由与
`qq_send_pixiv` 一致：说说的可见性为公开。

### 3.3 零落盘优先的字节形态

`prepareQzoneImageArg`（`lib/qzone-image.js:106`）按字节数选择形态：

```text
bytes ≤ DEFAULT_BASE64_MAX_BYTES（10MB，napcat-file.js:27）
  → arg = napcatImageFileArg(`base64://${buf.toString('base64')}`, cfg)
  → mode = 'base64'，path = ''，cleanup = null        即零落盘

bytes > 10MB
  → 写入 napcat.tmpDir（服务器上指向容器挂载目录）
  → arg = napcatImageFileArg(file, cfg)（auto 模式映射为容器内路径）
  → mode = 'file'，调用方必须在 finally 中 await cleanup()
```

必须经 `napcatImageFileArg` 这一 helper 的原因（`lib/qzone-image.js:20-24`）：该 helper 对已是
`base64://` / `file://` / `http(s)://` 的输入原样返回（`lib/napcat-file.js:63`），因此最终交给 NapCat 的形态
只由该 helper 决定。

空跑实测（OneBot stub，脚本 `_qzone_dryrun.mjs`）：11 MB 的本地图像在 `auto` 模式下，helper 只原样返回宿主路径
（超过 base64 上限时返回 `mapped || p`），容器内的 NapCat 读不到该路径，与 docx 路径的“识别URL失败”同形。
现行实现因此先把大图像复制进 `napcat.tmpDir`（容器挂载目录），再由 helper 映射为容器路径，发送完成后删除。

`napcatImageFileArg` 的三种模式（`lib/napcat-file.js:9-21`）：

表 23：文件参数形态（口径：`auto` 为跨容器部署的推荐取值）

| 模式 | 行为 |
| --- | --- |
| `path` | 原样传路径（本机裸机部署的既有行为，默认值，保持不变） |
| `base64` | 读字节转 `base64://…`（跨容器与跨机可用，代价是体积增加 33%） |
| `auto` | 先按 `napcat.dockerPathMap` 把宿主路径映射为容器内路径；映射失败退 base64；两者均不可行时原样传路径 |

服务器配置：

```json
"napcat": {
  "imageFileMode": "auto",
  "tmpDir": "/root/napcat/config/moonbot-tmp",
  "dockerPathMap": [{ "host": "/root/napcat/config", "container": "/app/napcat/config" }]
}
```

配置缺失时 NapCat 报 `文件处理失败: 识别URL失败, uri= /root/...`，表现为表情包全部无法投递。本机裸机部署时同机
可读该路径，因此本地正常而服务器侧全部失败。

### 3.4 体检闸门

`verifyQzoneImage`（`lib/qzone-image.js:84`）为纯函数，可离线测试：

```js
const complete = verifyImageComplete(buf, info.contentLength ?? null, info.contentEncoding ?? null);
const ext = sniffQzoneImageExt(buf);
const meta = sniffImageInfo(buf) || {};
if (!complete.ok) return { ...base, ok: false, reason: complete.reason || '图片字节不完整' };
if (!ext)          return { ...base, ok: false, reason: '认不出图片格式（魔数不是 PNG/JPEG/GIF/WebP）' };
```

`sniffQzoneImageExt`（`lib/qzone-image.js:70`）按魔数判定格式，与 `safe-fetch.js` 的 `looksLikeImageBuffer`
使用同一套判定：

表 24：魔数与扩展名（口径：偏移量以文件头为原点）

| 魔数 | 扩展名 |
| --- | --- |
| `89 50 4E 47` | `png` |
| `FF D8 FF` | `jpg` |
| `GIF87a` / `GIF89a` | `gif` |
| `RIFF`…`WEBP`（偏移 8） | `webp` |

宽高取不到时不拦截（部分格式与裁剪形状无法嗅探），只作为附带的像素对账信息。

体检不通过时发纯文字说说，并在 `notes` 中写明原因：既不报错，也不附截断图像。

回归测试：`qq-bridge/tests/qzone-image.test.js`。

### 3.5 临时文件清扫

只有超过 10 MB 的配图才会落盘，且成败均立即删除（`try/finally` 保证异常路径同样删除）。残留清理在启动时执行
一次：删除由本实现命名、且超过 3 小时（`QZONE_IMAGE_TMP_MAX_AGE_MS`）的配图临时文件。

表 25：清扫实现与理由（口径：`sweepQzoneImageTmp`，`lib/qzone-image.js:142`）

| 设计点 | 做法 | 理由 |
| --- | --- | --- |
| 文件名形状 | `qzone-<毫秒>-<6位随机>.<ext>`；正则 `^qzone-\d{10,}-[0-9a-z]{4,}\.(?:jpe?g\|png\|gif\|webp)$` 必须从头匹配 | 只删除本实现生成的文件 |
| 不按目录清空的原因 | 临时目录可能就是 `napcat.tmpDir`，即与表情包、文档共用的容器挂载目录（`lib/napcat-file.js:16-21` 的部署配置如此） | 清空目录会删除其它子系统的文件 |
| 同类做法参照 | `core/sticker.js:439`、`core/docx.js:76` | 均为启动时扫描一次旧文件 |
| 清理失败 | 忽略，不影响发帖 | 清扫是附带路径，不构成发帖前置条件 |

### 3.6 工具入口与参数

`qq_send_qzone`（`mcp-napcat-safe.js:2701`）：

```text
content      说说正文
file         本地图片/gif 绝对路径
imageUrl     直链（如 qq_image_search 的结果）
imageQuery   关键词：桥联网搜图取最佳命中
pixivIllustId / pixivQuery   pixiv 取图（original 质量）
pixivSize    original（默认）/ master（超 15MB 时用）
imageIndex   第几条（默认 0）
imageCount   配几张：默认 1，上限 3（QZONE_IMAGE_MAX）
```

参数优先级为 `file` > `imageUrl` > `pixivIllustId` / `pixivQuery` > `imageQuery`。

表 26：配图相关返回字段（口径：`mcp-napcat-safe.js:2667-2716`）

| 字段 | 含义 |
| --- | --- |
| `images[].from` | 来源（`file` / `url` / `search` / `pixiv:<id>`） |
| `images[].handedToNapCatAs` | 最终交给 NapCat 的形态：`base64` 或 `file` |
| `images[].fetchedVia` | `pximg-direct` / `mirror-proxy` / `local` |
| `images[].pixels` / `tier` / `tierFallback` | 像素对账结果与降级说明 |
| `imageNotes` | 取图过程的说明（如“pixiv 作品 X 是 R-18，不配进公开说说”） |
| `imageFailures` | 请求配图但未配上任何图像时，列出试过的地址与失败原因 |

`prepared` 的 `cleanup` 必须在 `finally` 中逐个 await（`mcp-napcat-safe.js:2677-2721`）：无配图时 `prepared`
为空；存在临时文件（仅大于 10 MB 时出现）时，成败均须删除。

### 3.7 空间互动接口

表 27：空间互动工具与其接口约束（口径：行号取自 `mcp-napcat-safe.js`）

| 工具 | 约束 |
| --- | --- |
| `qq_qzone_like` | 走 QZone 现役接口 `internal_dolike_app`（`w.qzone.qq.com` 前缀，POST 表单，返回纯 JSON 而非 JSONP）；旧的 `emotion_cgi_do_like_v6` 已返回 HTTP 500（`mcp-napcat-safe.js:2661-2635`） |
| `qq_qzone_comment` | `tid` 取自 `qq_qzone_view` 返回文本中的 `[tid=xxx]` |
| `qq_qzone_reply_comment` | 楼中楼回复需要 `commentId`，从 `qq_qzone_view` 的评论列表取得 |
| `qq_qzone_view` | 返回值包含评论（id、作者、内容），使回复工具可直接取得 `commentId`；回复时的 `@` 需要作者昵称 |

空间 cookie 通过 `/api/qzone-cookie` 查询配置状态。总开关为 `QZONE_TOOL_DISABLED`，未启用时这些工具返回统一说明。

主动发说说（`postRandomQzone`，`core/qzone.js:8`）是独立路径：从内置文案池随机选取一条，调用
`POST <napcatBase>/send_qzone_msg`，成功后向 `memory_entries` 写入一条 `category='qzone_post'` 记录，使模型
知晓本次发帖。

---

## 4. 失败模式的统一判据

### 4.1 判据总表

表 28：失败模式、现象、现行防线（口径：防线为第 1 至第 3 章所述实现的归纳）

| 失败模式 | 现象 | 现行防线 |
| --- | --- | --- |
| 声明成功而实际未生效 | 参数名错误（`file` 对 `images`）被静默忽略；档位错误仍写 `lossless: true`；`tid` 恒为 null | 参数名对所装 NapCat 包核对；`lossless` 按实际投递档位判定；兼容两种 `tid` 形态 |
| 只校验开头字节等于未校验 | `looksLikeImageBuffer` 只识别前 3 个字节，上半幅正常、下半幅为灰的截断图像可全链路通过 | `verifyImageComplete`：四种格式的尾标记校验加 `content-length` 比对 |
| 地址可信不等价于字节可信 | 第三方代理使用原图地址返回 720 档图像 | `pixivTierSizeVerdict` 以实际像素对账元数据 |
| 跨容器路径不可直接传递 | 宿主路径交给容器内 NapCat 导致 `识别URL失败`，配图全部无法投递 | 统一经 `napcatImageFileArg`；`auto` 模式映射容器路径，映射失败退 base64 |
| 临时目录可能被共用 | 清空 `napcat.tmpDir` 会删除表情包与文档 | 按本实现的文件名正则过滤，且只在启动时扫描一次 |
| 降级必须显式 | 按成功顺序投递导致请求原图而收到缩略图且被声明无损 | `planPixivSend` 分桶；降级须打日志并写入结果（`tierFallback`） |

### 4.2 回归测试对照

表 29：回归测试覆盖范围（口径：路径为相对仓库根）

| 测试 | 覆盖 |
| --- | --- |
| `qq-bridge/tests/pixiv-source-order.test.js` | 候选来源顺序 |
| `qq-bridge/tests/pixiv-auth.test.js` | 登录态与令牌 |
| `qq-bridge/tests/qzone-image.test.js` | 空间配图的体检、零落盘、清扫 |
| `qq-bridge/tools/test-pixiv-tier-truncation.mjs` | 档位识别与截断（纯函数自测） |
| `qq-bridge/tools/test-pixiv-byid.mjs`、`test-pixiv-cache.mjs`、`test-pixiv-filters.mjs` | 按号取图、缓存、本地筛选 |
| `qq-bridge/tools/e2e-pixiv-send.mjs` | 端到端发图 |
| `qq-bridge/tools/probe-jpeg-structure.mjs`、`probe-pixiv-native.mjs`、`probe-pixiv-params.mjs`、`dump-pixiv-shape.mjs` | 在线环境结构探针 |

---

## 5. 未核验项与开放问题

表 30：未核验声明清单（口径：等级为本文的证据分级；`path:line` 为可回溯位置）

| 项 | 声明 | 等级 |
| --- | --- | --- |
| NapCat 内部行号 | `napcat.mjs` 的 80276~80283、9237、11560、11578、11585 等行号来自 `lib/qzone-image.js` 顶部注释记录的读包结果（本机 NapCat 9.9.26-44498）；本轮未重新解包核对，NapCat 升级后行号会平移。函数名（`SendQzoneMsg._handle`、`uploadImageToQzone`、`publishQzoneMsg`）是更稳定的锚点 | 【未核验】 |
| 投递侧实现 | `qq_send_pixiv` 的“写临时文件 → POST `/api/social/send-message`”之后的投递侧（`core/console-server.js:1973` 起的 `send-message` 端点、`core/qq-send.js` 的 `onebotSend`）只核到端点与调用，未逐行读发送实现 | 【未核验】 |
| 投递前卡口 | `lib/image-compress.js` 的 `IMAGE_HARD_MAX_BYTES` 已核对：`image-compress.js:47` 为 `15 * 1024 * 1024`，与 `MAX_IMAGE_FETCH_BYTES` 同值；判定处为 `image-compress.js:250`、`295-296` | 【已核验】 |
| 空跑脚本 | 空跑脚本 `_qzone_dryrun.mjs` 是 `lib/qzone-image.js:2693` 注释提到的临时脚本，本仓库 `qq-bridge/tools/` 下不存在（已检索），因此 §3.3 的空跑结论为转述代码注释，本轮未复现 | 【未核验】 |
| 覆盖范围 | 本文未覆盖 `qq_send_image`（联网找图直发）的完整实现，只核到它复用 `safeFetchBuffer` 的同一道闸门 | 【已核验】 |
