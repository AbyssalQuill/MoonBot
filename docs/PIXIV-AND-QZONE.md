# 图片深潜：Pixiv 与 QQ 空间

本文只讲两条图片链路：**发 pixiv 图**与**QQ 空间说说配图**。两条路都有一个共同的敌人——"**看起来成功了，其实发出去的是缩略图 / 半幅灰 / 一张都没配上**"。

因此两条路都装了**两道独立闸门**：

| 闸门 | 管什么 | 实现 |
| --- | --- | --- |
| **地址档位闸门** | "你给我的这个地址到底是哪一档图" | `qq-bridge/src/lib/pixiv.js` 的 `pixivImageTier` / `planPixivSend` |
| **字节完整性闸门** | "这份字节到底是不是一张完整的图" | `qq-bridge/src/safe-fetch.js` 的 `verifyImageComplete`（**两条路共用同一道**） |

闸门之外还有第三层——**像素对账**（`pixivTierSizeVerdict`）：光看地址不够，因为第三方代理完全可能**拿着原图地址却给你一张缩过的图**。

行号引用写作时的仓库状态，重构后会平移。

---

# A. Pixiv

## A.1 现场：一次真实的翻车

主人报的问题，证据是发到 QQ 的那个附件名：

```
3bbd4e1d0c3c1308c4d6fbf2ca3493bc_720.jpg
```

两个独立的毛病叠在一起：

- **(a) 分辨率不是原图** —— `_720` 是 720 档。用户没要过 720 档，代码里也没有任何一处会**拼**出 720 档地址（`pixivMasterUrl` 只会拼 `_master1200.jpg`）⇒ 这个地址只能来自**上游给的原图地址**
- **(b) 下半幅 60~70% 是纯 `#808080`** —— 截断的渐进 JPEG

更糟的是：**结果里还写着 `lossless: true` / `contentKind: 'pixiv-original'`**（谎报无损）。

根因（`qq-bridge/src/lib/pixiv.js:161-177` 的完整记录）：

1. `normalizePixivIllustDetail` 把镜像站 `urls.original` **原样收下**
2. `pixivIllustOriginals` 的 ③④ 兜底会拿这条地址去推别的页，并把它当"原图地址"回报
3. `pixivImageSources` 直接把它排在**候选第一位** —— 于是 `size=original` 请求会**首选**一个 720 档地址发出去
4. **全链路没有任何一处校验"你给我的这个地址到底是不是原图档"**
5. 字节侧唯一的体检是 `looksLikeImageBuffer` —— **只认开头 3 个字节**

---

## A.2 数据来源：官方优先，镜像站兜底

三种来源，按同一套顺序试，并**如实报出这次是谁供的数据**（结果里的 `source` / `sourcesTried`，`pixiv.js:103-113`）：

| 顺序 | 来源 | 特点 | 何时可用 |
| --- | --- | --- | --- |
| ① | `app-api.pixiv.net`（Bearer token，见 `lib/pixiv-auth.js`） | 形状最规整，能拿 `meta_pages` 逐页原图直链（不用猜扩展名） | 有登录态时；**没登录态直接跳过**（实测匿名必 400，白等一次超时） |
| ② | `www.pixiv.net/ajax` | 匿名就能用（实测四类接口全 200） | 没配登录态时的主力 |
| ③ | 第三方镜像站（`pixivBase()`） | **最慢**：同一张图 2.7~5.7 秒，出现过 25 秒超时 | 只能垫底 |

三个曾经写错、后来被实测更正的事实（`pixiv.js:89-101`）：

1. **官网并不需要登录**：`ajax/illust/<id>`、`ajax/illust/<id>/pages`、`ajax/search/artworks/<kw>`、`ajax/user/<uid>/profile/all` 在线上 VPS 实测**全 200**，不需要 cookie 也不需要 Referer（UA 用 `Mozilla/5.0` 就行）
2. **真需要 Referer 的是图床** `i.pximg.net`：不带 `referer: https://www.pixiv.net/` 一律 **403 nginx**，带上就 200
3. **镜像站是第三方、随时可能换域名/挂掉** —— 所以地址可配：`config.json` 的 `pixiv.base` > 环境变量 `QQBRIDGE_PIXIV_BASE` > 内置默认，且**每次现读**（改完配置不用重启 MCP 子进程，`pixiv.js:152-154`）

**纪律**：`cookie` 与 `Bearer` **只发给 pixiv 自己的域名**，镜像站永远看不到任何凭证（`pixivRequestHeaders`，`pixiv.js:1071`）。

### 逐页原图直链怎么来（`pixivIllustOriginals`，`pixiv.js:1333`）

| 顺序 | 做法 | source 标记 |
| --- | --- | --- |
| ① | 详情本身已经带 `meta_pages`（app-api 那条路）→ **直接复用，不再多发一次请求** | `app-api:meta_pages` |
| ② | `app-api /v1/illust/detail` 的 `meta_pages[].image_urls.original` | `app-api:meta_pages` |
| ③ | 官网 `ajax/illust/{id}/pages` 的 `body[].urls.original` | `pixiv:pages` |
| ④ | 镜像站 `detail.php`（它拿自己登录态换来的同一份 ajax 响应） | `mirror` |
| ⑤ | 老兜底：由 p0 原图直链推同作品其它页（`deriveOriginalPageUrls`，把 `_p0` 换成 `_pN`） | `derived` |

每一步失败都记进 `tried[]`，最终拼成 `note` 回报给模型 —— 失败原因要看得见。

---

## A.3 第一道闸门：地址档位

### 档位识别（`pixivImageTier`，`pixiv.js:207`）

先**把镜像站代理地址还原成它包着的 i.pximg 地址**（`pixivImageInnerUrl`，`pixiv.js:187`：从 `/api/image.php?url=...` 里取出 `url` 参数）—— 档位要看**里层**那个地址才准。

pixiv 的档位命名是**确定性**的：

| 形状 | 档位 |
| --- | --- |
| `/img-original/img/<日期>/<id>_pN.<ext>`，文件名上没有任何档位后缀 | **`original`** |
| `_pN_master1200.jpg` | `master`（1200 档） |
| `_pN_720.jpg` / `_pN_1080.jpg`（按边长命名的显式降级档） | `master` |
| `/img-master/` 路径 | `master` |
| `_pN_square1200.jpg` / `_pN_custom1200.jpg` | **`thumb`** |
| `/c/<W>x<H>` 边长前缀且 **W ≤ 600**（`c/250x250`、`c/360x360`、`c/540x540`） | **`thumb`** |
| 认不出（第三方 CDN / 新形状） | `unknown` —— 不拦，但下游**不许据此谎称无损** |

三个正则（`pixiv.js:180-184`）：

```js
const PIXIV_THUMB_SIDE_RE     = /\/c\/(\d{3,4})x(\d{3,4})/;
const PIXIV_RENDITION_NAME_RE = /_p\d+_(?:master1200|square1200|custom1200|\d{3,4})\./i;
const PIXIV_ORIGINAL_NAME_RE  = /\/\d+_p\d+\.(?:jpe?g|png|webp|gif)$/i;
```

### 候选分桶（`planPixivSend`，`pixiv.js:232`）

规矩很硬：

| 候选档位 | `size=original` 时 | `size=master` 时 |
| --- | --- | --- |
| `thumb` | **`skipped`：任何情况下都不发** | **`skipped`** —— 发了就是用户看到的那张 250×250 |
| `master` | **`fallback`：只有真原图档的候选全部失败才允许走到它**，而且必须**显式打日志 + 在结果里如实说明** | `primary`（用户明确要的就是它） |
| `original` | `primary` | `primary` |
| `unknown` | `primary`（不按档位拦，靠 §A.4 的像素对账把关） | `primary` |

桶归属由本函数**重算**，先把上游带的 `fallback` / `fallbackReason` 标记清掉 —— 免得出现"`primary` 里却挂着 `fallback: true`"这种自相矛盾（`pixiv.js:242-244`）。

### 候选从哪来、按什么顺序（`pixivImageSources`，`pixiv.js:1486`）

| 顺序 | 候选 | 说明 |
| --- | --- | --- |
| ① | `i.pximg.net` **直联**（带 `referer`） | 实测 60~400ms，**字节与源文件逐字节一致** |
| ② | 镜像站同名图代理（`pixivProxyUrl`） | 同字节，但慢（2.7~5.7s，偶发超时） |
| ③ | 老候选：从缩略图推日期路径（`pixivImageCandidates`） | 搜索路径一直在用，保持行为不变 |

`size=original` 时，非原图档的候选会被标成 `fallback: true` 并附上原因（`pixiv.js:1497-1504`）。`unknown` **不标** —— 不按档位拦，但要靠像素对账。

> ⚠️ `pixivImageCandidates` / `pixivImageSources` 里的 `size ?? 'master'` 只是**给老调用方的兼容默认**。工具层永远显式传 `size` —— 别把这两个默认值当成"产品行为"（`pixiv.js:20-25`）。

### 工具层的默认值

`qq_send_pixiv` 的 `sizeEff`（`mcp-napcat-safe.js:3280`）：

```js
const sizeEff = String(size ?? 'original').toLowerCase() === 'master' ? 'master' : 'original';
```

**三条路都默认 `original`**（2026-09-20 主人定调"发图默认原图，不要缩略图"）。以前只有"给了 `illustId`/`authorId`"才默认原图，只给 `query` 时回落 `master` —— 已改掉。显式传 `size` 时永远以调用方为准。

---

## A.4 第三层：像素对账（`pixivTierSizeVerdict`，`pixiv.js:269`）

**光校验"地址像不像原图"不够。** 镜像站（第三方代理）完全可能**拿着原图地址却给你一张缩过的图**（它的缓存 `<md5>_720.jpg` 就是这种产物）—— 地址看着是原图、字节却是 720 档。这次的线上现场正是这样。

所以再拿"作品的原图像素"（pixiv 详情里的 `width`/`height`，**就是原图的尺寸**）跟**实际拿到的像素**对一遍：

| 判据 | 规则 |
| --- | --- |
| 只对 `page === 0` 比 | 详情里的宽高就是第 0 页的；其它页拿不到权威尺寸，**不瞎比** |
| 拿不到像素 | 放行（只靠档位/尾标记判） |
| `tier === 'original'` | 实际长边 **<** 期望长边 → **判不符**："要的是原图（W×H），拿到的却是 w×h —— 被上游缩过的档" |
| `tier === 'master'` | 期望 = `min(1200, max(ow, oh))`；实际长边 **<** `floor(期望 × 0.95)` → 判不符（容 5%：pixiv 按长边缩到 ≤1200，四舍五入会有 1~2 px 误差） |
| `tier === 'thumb'` / `unknown` | 只返回带外信息，不拦 |

**纯函数，离线可测** —— 自测见 `qq-bridge/tools/test-pixiv-tier-truncation.mjs`。

---

## A.5 第二道闸门：字节完整性（`verifyImageComplete`）

**两条链路共用同一道**（Pixiv 与 QQ 空间配图）。

### 为什么要它（`safe-fetch.js:250-272` 的现场记录）

排查过的三种可能，逐条证伪/证实：

| 假设 | 结论 |
| --- | --- |
| 我们的传输层"静默收半截" | **不是**。本地实测（node v24.13.0）：服务端声明 `Content-Length=1000` 只发 400 字节后 destroy socket，以及 chunked 发 400 字节后 destroy —— **两种形状都触发 `res.on('error') → "aborted"`**，走到 reject。上限也不会产生半截图（`settled=true; res.destroy(); reject(...)` 是**拒绝**，不是"截一半留下"） |
| **"没有校验就收下"** | **是。** `res.on('end')` 把收到的 chunk 直接 concat 就 resolve，而唯一的体检 `looksLikeImageBuffer` **只认开头 3 个字节**。于是只要**上游自己给的字节就是残的**（第三方代理把"没拉完就被掐断的原图"缓存下来、再带正确的 `Content-Length` 完整吐给我们 —— 这正是镜像站常见形态，也是我们唯一会拿到 720 档 + 半幅灰的来源），就会**原样写盘、原样发给 NapCat** |
| `content-length` 头 | 改动前**一次都没被读过**（全文件 grep 无命中）；JPEG 的 EOI（`FFD9`）也从没检查过 |

### 判据（`safe-fetch.js:286`）

| 格式 | 尾标记判据 |
| --- | --- |
| JPEG | 末 64 字节里必须有 **`FFD9`**（EOI） |
| PNG | 末 16 字节里必须有 **IEND 块完整尾部** `00 00 00 00 49 45 4E 44 AE 42 60 82`（长度 0 + 类型 + 固定 CRC） |
| GIF | 末 8 字节里必须有 **`0x3B`** |
| WebP | RIFF 头的长度字段（`readUInt32LE(4) + 8`）必须 **≤** 实际字节数。**只在"声明的比实际的还多"时才算截断** —— 声明得更少 = 尾部有额外填充，图本身是完整的，**别误杀** |

长度比对：**有 `content-length` 且响应没被编码压缩时**（`content-encoding` 为空或 `identity`），实际字节数必须与之相等。有压缩时长度对不上属正常，跳过比对。

不通过 → **抛「图片字节不完整」** → 调用方**换下一个候选**或如实报错，**绝不发半截图**。

### 下载侧的字节上限

```
MAX_IMAGE_FETCH_BYTES = 15 * 1024 * 1024     // safe-fetch.js:348
```

定标依据（不是估计，`safe-fetch.js:330-347`）：

- 改之前全桥有**三个互不相干的上限**：本函数默认 4MB、`qq_image_search`/`qq_send_image` 8MB、`qq_send_pixiv` 8MB —— 同一张图走不同入口结论不同，也没有任何一处说明依据是什么。现在统一成**一个常量**
- 真正卡人的是 **DSH 附件层**：线上装的 DSH 0.1.2-rc.1 里 `dsh-attachment-local/lib/index.js:637` 写着 `const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024`，同包 `README.zh.md` 第 41 行也写明 `maxImageBytes` 默认 20 MiB；`/root/.dsh/profiles/web/` 下没有覆盖这个值
- 所以 **15MB < DSH 的 20MB**，下载侧放宽不会把 DSH 撑爆；原来的 4MB/8MB 纯粹是自设的更紧上限，会在图还没到投递闸门之前就把它丢掉
- ⚠️ 本常量只管"把图下载下来"；**投递前还有一道独立的卡口** `lib/image-compress.js` 的 `IMAGE_HARD_MAX_BYTES`。两者是两道卡口（都放宽到 15MB 才叫端到端 15MB），但都不允许超过 DSH 的 20MB

`safeFetchBuffer` **默认不带任何请求头**（老调用行为一字不变）。`extraHeaders` 存在的唯一理由就是上面那条：`i.pximg.net` 带 `referer: https://www.pixiv.net/` 是 200、不带是 403 —— 补上它，`qq_send_pixiv` 才能**直联 pximg 拿逐字节一致的原图**。`host` 头由本函数自己按 URL 设置，调用方传进来的会被丢掉（防止把 host 改成别的域名）。

---

## A.6 工具层的完整流程（`qq_send_pixiv`，`mcp-napcat-safe.js:3245` 起）

### 三条入口

| 入口 | 参数 | 行为 |
| --- | --- | --- |
| 作品号 | `illustId`（作品号或 `pixiv.net/artworks/<数字>` 链接） | 直接取该作品；其它搜索/筛选参数全部忽略 |
| 画师 | `authorId` | 画师号 / `pixiv.net/users/<数字>` 链接 / **画师名字**。名字走 `resolvePixivAuthor`（官方用户搜索）；**歧义时返回候选列表让人挑，绝不瞎猜一个发出去**（发错人比不发更糟） |
| 关键词 | `query` | 走 `pixivSearch`（本地筛选 + 自动翻页） |

画师名字这条路的历史坑（`pixiv.js:1520-1532`）：web 搜索引擎那条路实测不可靠 —— 那台 VPS 上 bing 候选恒 0、duckduckgo 时好时坏 202，且"七菜"这种常见名会捞出 3 个同名号而真号不在前列。所以**只做候选，不做自动定号**。

### 逐候选试的顺序与闸门（`mcp-napcat-safe.js:3395-3460`）

```
sources = pixivImageSources(work, { page, size: sizeEff, originals })
plan    = planPixivSend(sources, { size: sizeEff })

1. 把 plan.skipped 里的缩略档逐个打日志（"跳过一个不该发的档"）
2. tryList(plan.primary)   —— 逐个候选：
     safeFetchBuffer 下载  →  sniffImageInfo 拿实际像素
     →  pixivTierSizeVerdict 对账（不符 → 弃用 + 打日志 + continue）
     →  成功就记下 gotFrom / gotVia / gotTier / gotPixels
3. 若 primary 全失败且有 fallback：
     打一行 stderr："原图档 N 个候选全部失败 → 显式降级到 X 档；失败原因：…"
     tryList(plan.fallback, isFallback=true)  → 成功则 tierFallback = {…}
4. 都失败 → 如实报错，列出试过的地址与失败原因
     若失败原因是"超过大小限制"，提示改用 size=master
     并注明"另有 N 个缩略档候选按规矩没试：发了就是缩略图"
```

随后：算 `sha256`、按魔数定扩展名、写进 `napcat.tmpDir`（服务器上它指向容器挂载目录）或 `<root>/state/image-tmp`，再 POST `/api/social/send-message`。

### 返回字段：说真话的那几个

| 字段 | 含义 |
| --- | --- |
| `lossless` | **只有在"要的就是原图"且"真正发出去的是原图档"且"没发生降级"时才敢说 `true`** |
| `tierServed` | **真正发出去的是哪一档**（`original` / `master` / `thumb` / `unknown`）—— 地址档位 + 实际像素**双重判定**过 |
| `tierFallback` | 非 null = 发生了降级，含 `to` / `reason` / `originalTried` / `failures` |
| `pixels` | 实际拿到的像素（`WxH`） |
| `bytes` / `sha256` / `format` | **就是这次真发的那些字节** |
| `fetchedFrom` | 实际命中的 URL |
| `fetchedVia` | 字节是谁给的：`pximg-direct` / `mirror-proxy` |
| `pixivSource` | 元数据是谁给的：`app-api:meta_pages` / `pixiv:pages` / `mirror` / `derived` |
| `source` | 走了哪条入口：`illustId` / `authorId` / `search` |
| `pick` | 画师那条路的人话说明（"按名字「X」搜到画师 N，名下共 M 件公开作品，按投稿时间新→旧取第 K 件"） |

`lossless` 的旧写法是 `lossless: sizeEff === 'original'` —— 于是**降级发了 720/1200 档、甚至缩略图，结果里照样写 `lossless: true`**。现在只有在三个条件都成立时才敢说真话（`mcp-napcat-safe.js:3502-3506`）。

---

## A.7 Pixiv 的其他硬规矩

### R-18 的**不对称**策略

| 工具 | 策略 |
| --- | --- |
| `qq_pixiv_search` | 默认 `r18=exclude`，只有显式传 `only` / `include` 才放行 |
| `qq_send_pixiv` | **永远排除 R-18/R-18G**（刻意不给 `r18` 参数 —— 不适合的内容**无法**被发进 QQ） |
| 空间配图 | 同一规矩（说说公开可见） |

发图那条路的闸门写在 `mcp-napcat-safe.js:3338-3347`：xRestrict 缺失/非 0 都当 R-18；命中就返回错误并列出标签。

> 顺带一个实测更正：本镜像站默认搜索里 `xRestrict` **恒为 0**（「初音ミク」「エロ」「R-18」「巨乳」「オリジナル」各 60 条全是 0）—— 它只搜全年龄库。所以 `r18='only'` 实测恒为空。过滤逻辑仍保留（`xRestrict !== 0` + R-18/R-18G 标签兜底），因为上游随时可能变，且标签兜底确实能挡住"关键词本身就是 R-18 标签"的作品（`pixiv.js:55-60`）。

### 本地筛选全在这边做

镜像站**只认 `keyword` 和 `page`**。逐个试过 `mode=safe/all/r18`、`s_mode=s_tag/s_tag_full/s_tc`、`order=date_d/popular_d`、`p`、`bl`、`type=illust/manga` —— **全部被忽略**（同一关键词 `total` 恒定、首条 id 恒定）；只有 `page` 让结果换了一批（`pixiv.js:36-37`）。

所以筛选只能在已抓回来的数据上做（`normalizePixivFilters` + `filterPixivItems`），`scanPages` 自动翻页就是为了补上"一页只有 60 条"的问题。

| 参数 | 行为 |
| --- | --- |
| 一页 60 条（走 app-api 是 30 条） | `pixiv.js:332-333` |
| `scanPages` | 默认 **3**、上限 **10**。**硬要求：不传任何新参数时结果必须与改动前逐字段一致** —— 做法是"调用方有没有用新参数"当开关（一个筛选参数都没给 → 只抓 1 页、不排序、只过滤 R-18） |
| `sort` | **只支持投稿时间**：`date_desc`（默认）/ `date_asc` / `random`。传 `popular` / `hot` / `rank` 会**回落 `date_desc`** 并在 `warnings` 写明原因 |
| 为什么不能按人气排 | 逐条核对了第 1 页 60 条 item 的**全部键**：`aiType / alt / bookmarkData / createDate / description / height / id / illustType / isBookmarkable / isMasked / isOriginal / isUnlisted / is_howto / pageCount / profileImageUrl / restrict / sl / tags / title / titleCaptionTranslation / updateDate / url / userId / userName / visibilityScope / width / xRestrict`。其中 `bookmarkData` 是"**当前登录用户**有没有收藏"（未登录恒为 `null`），`isBookmarkable` 只是"能不能收藏"；把整个返回体当字符串数过：`bookmarkCount` = 0 次、`like` = 0 次、`view` = 0 次 |
| `excludeAi` | ⚠️ **不能写成 `aiType !== 0`**。实测：关键词「AIイラスト」→ 60/60 条 `aiType=2`；「手描き」→ 60/60 条 `aiType=1`；「アナログ」→ 1=57 / 2=3。⇒ **`aiType=2` = AI 生成，`aiType=1` = 非 AI**（0 在实测样本里没出现过，按"未标注"处理）。按 `!=0` 写会把整页作品全过滤光 |
| `illustType` | **三种值**：0=插画、1=漫画、**2=动图（ugoira）**。`illust='illust'` / `'manga'` 只认 0/1；2 不属于任何一类，被这两条筛选中任意一条排除 |
| 翻页边界 | 相邻页 id 不重叠（`p1∩p2 = p1∩p3 = p2∩p3 = 0`），每页 60 条，`lastPage` 恒为 10。**`page` 超出 `lastPage`（试过 `page=11`）仍然返回 60 条**，明显是兜底/循环 —— **不可采信**，所以自动翻页一律卡在 `lastPage` 内 |

### 按作品号取图的一个历史 bug

`mcp-napcat-safe.js:3288-3291` 记着：旧写法在这里造了个 `thumbUrl` 为空的对象就往下走，而候选是**从缩略图推日期路径**的 —— 于是 **0 个候选**，这条路**从来没通过**。现在先按号把详情和原图直链问出来。

同类的一个纯函数坑：`pixivMasterUrl` **一律拼 `.jpg`** —— 实测 png 原图的作品 `..._p0_master1200.png` 是 **404**，`.jpg` 才是 200/740KB（`pixiv.js:1315-1321`）。

### 画师的其它作品

`pixivUserWorkIds`（`pixiv.js:1410`）的顺序：app-api `/v1/user/illusts`（Bearer，每页 30 件、跟 `next_url` 往后翻，上限 10 页）→ 官网 `profile/all`（一次给全）→ 镜像站 `native.php` 代拉同一个 `profile/all`。

- **pixiv 作品号全局递增**，所以"按号倒序 = 按投稿时间新→旧"（这里没有 `createDate` 可用，只能这么排）
- ⚠️ **app-api 若返回 0 件不当作结论**，继续往下试：app-api 那个 `type=illust` 可能不含某些投稿类型，而 `profile/all` 是"这个人一共投了什么"的权威答案，兜底一遍成本很低

---

# B. QQ 空间说说配图

## B.1 先说清"发说说"的真实链路

因为**配图怎么给完全由它决定**。下面每条都是读代码 / 读**装好的包**得到的（`lib/qzone-image.js:3-17`）：

| 步 | 谁 | 做什么 |
| --- | --- | --- |
| ① | 桥 | `mcp-napcat-safe.js` 的 `qq_send_qzone` → OneBot `POST <httpUrl>/send_qzone_msg` |
| ② | NapCat（本机装的是 9.9.26-44498，包体 `resources/app/napcat/napcat.mjs`） | `SendQzoneMsg._handle` 逐个处理 **`e.images`**：先 `Ti(this.core.NapCatTempPath, a)`（图片解析器：**case 1 本地路径 / case 2 http(s) 下载 / case 3 `base64://` 解码**）归一成一个真正的文件路径；**URL 与 base64 这两种"非本地"来源，NapCat 自己在 `finally` 里删掉** |
| ③ | NapCat | 把该文件字节转 base64 → `uploadImageToQzone` → `POST up.qzone.qq.com/cgi-bin/upload/cgi_upload_image` 拿 **richval** |
| ④ | NapCat | `publishQzoneMsg(content, richvals, ugc_right, target_uins)` 把 richval 用 `\t` 拼起来 → `POST emotion_cgi_publish_v6` |

**从这条链路推出两条结论**：

- **(a) 图片可以按 URL / base64 直传，桥这边一个字节都不用落盘** ⇒ 策略选"**能零落盘就零落盘**"
- **(b) 旧代码给的是 `file`，而 NapCat 只读 `images`** —— 那个参数**一直被静默忽略**（配了图也发不出来、**还不报错**）。已修（`mcp-napcat-safe.js:2700-2703`）

### 顺手修掉的第二个 bug：`tid` 恒为 null

`onebot()` 返回的就是 OneBot 响应里的 `data`，`tid` 在 **`data.tid`**；旧写法只读 `data.data.tid`（多套了一层）→ **发说说成功后 `tid` 恒为 null**。现在两种形态都兼容（`mcp-napcat-safe.js:2705-2707`）：

```js
const out = { ok: true, tid: data?.tid ?? data?.data?.tid ?? null, content: text };
```

---

## B.2 取图：四级优先级 + 逐张体检

入口 `collectQzoneImages`（`lib/qzone-image.js:170`）。**入参优先级：`file` > `imageUrl` > `pixivIllustId`/`pixivQuery` > `imageQuery`**（第一条非空者生效）。

**这个函数不抛错**：拿不到图就返回空 `items` + `notes`，让调用方发**纯文字说说**。这是主人要的边界 —— **配图失败别把发帖搞挂**。

| 来源 | 做什么 | 体检 |
| --- | --- | --- |
| ① `file`（本地路径） | `fs.readFileSync` 读字节 | **必须自己过 `verifyQzoneImage`** —— 这条路**没经过** `safeFetchBuffer` |
| ② `imageUrl`（直链） | `safeFetchBuffer` | 已经在 `safeFetchBuffer` 内部跑过 `verifyImageComplete`；这里再显式对一次 |
| ③ pixiv（`pixivIllustId` 优先，其次 `pixivQuery`） | `pixivIllustOriginals` → `pixivImageSources` → `planPixivSend` | 与 §A 完全同一套闸门 + 像素对账 |
| ④ `imageQuery`（联网搜图） | `searchImages`（`lib/image-search.js`） | `verifyImageComplete` |

**pixiv 那条路额外做的事**：先按 `work.adult` 过滤，R-18 的作品**不配进公开说说**，并在 `notes` 里说明。理由与 `qq_send_pixiv` 同一规矩 —— 说说是公开可见的。

---

## B.3 零落盘优先的字节形态（`prepareQzoneImageArg`，`lib/qzone-image.js:106`）

```
bytes ≤ DEFAULT_BASE64_MAX_BYTES（10MB，napcat-file.js:27）
  → arg = napcatImageFileArg(`base64://${buf.toString('base64')}`, cfg)
  → mode = 'base64'，path = ''，cleanup = null        ← 一个字节都没写盘

bytes > 10MB
  → 写进 napcat.tmpDir（服务器上它指向容器挂载目录）
  → arg = napcatImageFileArg(file, cfg)（auto 模式映射成容器内路径）
  → mode = 'file'，调用方必须在 finally 里 await cleanup()
```

**为什么必须走 `napcatImageFileArg` 这个 helper**（`lib/qzone-image.js:20-24`）：

`napcatImageFileArg` 对已经是 `base64://` / `file://` / `http(s)://` 的输入**原样返回**（`lib/napcat-file.js:63`）—— 于是"最终交给 NapCat 的形态"**仍然只由那一个 helper 决定**。

**一次干跑实测**（stub OneBot，脚本 `_qzone_dryrun.mjs`）：11MB 的本地图在 `auto` 模式下，helper 只会原样返回**宿主路径**（超过 base64 上限 → 返回 `mapped || p`），容器里的 NapCat **读不到** —— 这正是 docx 那次「识别URL失败」的同一形状。所以现在大图会**先复制进 `napcat.tmpDir`（容器挂载目录）再由 helper 映射成容器路径**，发完即删。

`napcatImageFileArg` 的三种模式（`lib/napcat-file.js:9-21`）：

| 模式 | 行为 |
| --- | --- |
| `path` | 原样传路径（本机裸机部署的既有行为，**默认值**，保持不动） |
| `base64` | 读字节转 `base64://…`（跨容器/跨机都能发，代价是体积 +33%） |
| `auto` | 先看 `napcat.dockerPathMap` 能否把宿主路径映射成**容器内路径**（映射不上再退 base64；都不可行才原样传路径） |

服务器上必须这样配：

```json
"napcat": {
  "imageFileMode": "auto",
  "tmpDir": "/root/napcat/config/moonbot-tmp",
  "dockerPathMap": [{ "host": "/root/napcat/config", "container": "/app/napcat/config" }]
}
```

不配对时 NapCat 报 `文件处理失败: 识别URL失败, uri= /root/...`，表现是**表情包一张都发不出去**。本机裸机部署时同机能读，所以本地一直正常、一到服务器全灭。

---

## B.4 体检闸门（`verifyQzoneImage`，`lib/qzone-image.js:84`）

```js
const complete = verifyImageComplete(buf, info.contentLength ?? null, info.contentEncoding ?? null);
const ext = sniffQzoneImageExt(buf);
const meta = sniffImageInfo(buf) || {};
if (!complete.ok) return { ...base, ok: false, reason: complete.reason || '图片字节不完整' };
if (!ext)          return { ...base, ok: false, reason: '认不出图片格式（魔数不是 PNG/JPEG/GIF/WebP）' };
```

**纯函数，离线可测。**

`sniffQzoneImageExt`（`lib/qzone-image.js:70`）用魔数认格式（与 `safe-fetch.js` 的 `looksLikeImageBuffer` 同一套判定）：

| 魔数 | 扩展名 |
| --- | --- |
| `89 50 4E 47` | `png` |
| `FF D8 FF` | `jpg` |
| `GIF87a` / `GIF89a` | `gif` |
| `RIFF`…`WEBP`（偏移 8） | `webp` |

**宽高拿不到不拦**（有的格式/裁剪形状嗅探不出来），只作附带的像素对账信息。

**体检不过 → 发纯文字说说**，`notes` 里如实写原因。既不报错，也不 attach 半幅灰的截断图。

回归测试：`qq-bridge/tests/qzone-image.test.js`。

---

## B.5 临时文件清扫（`sweepQzoneImageTmp`，`lib/qzone-image.js:142`）

只有超过 10MB 的图才会落盘，而且**成败都立刻删**（`try/finally` 保证异常路径也删）。

残留兜底是**启动时扫一次**：删掉**我们自己命名的**、超过 3 小时（`QZONE_IMAGE_TMP_MAX_AGE_MS`）的配图临时文件。

| 设计点 | 做法 | 为什么 |
| --- | --- | --- |
| 文件名形状 | `qzone-<毫秒>-<6位随机>.<ext>`，正则 `^qzone-\d{10,}-[0-9a-z]{4,}\.(?:jpe?g\|png\|gif\|webp)$` **必须从头匹配** | |
| **为什么不按目录清空** | 临时目录可能就是 `napcat.tmpDir` —— 那是与**表情包 / 文档共用的容器挂载目录**（`lib/napcat-file.js:16-21` 的部署配置就是这么写的）。**清空目录等于把别人的东西删了** | |
| 同类做法参照 | `core/sticker.js:439`、`core/docx.js:76` | 都是"启动时扫一次旧文件" |
| 清理失败 | 忽略（不影响发帖） | |

---

## B.6 工具入口与参数（`qq_send_qzone`，`mcp-napcat-safe.js:2661`）

```
content      说说正文
file         本地图片/gif 绝对路径
imageUrl     直链（如 qq_image_search 的结果）
imageQuery   关键词 —— 桥联网搜图取最佳命中
pixivIllustId / pixivQuery   pixiv 取图（original 质量）
pixivSize    original（默认）/ master（超 15MB 时用）
imageIndex   第几条（默认 0）
imageCount   配几张：默认 1，上限 3（QZONE_IMAGE_MAX）
```

参数优先级（工具描述里明写）：**`file` > `imageUrl` > `pixivIllustId`/`pixivQuery` > `imageQuery`**。

配图相关的返回字段（`mcp-napcat-safe.js:2708-2716`）：

| 字段 | 含义 |
| --- | --- |
| `images[].from` | 来源（`file` / `url` / `search` / `pixiv:<id>`） |
| `images[].handedToNapCatAs` | 最终交给 NapCat 的形态：`base64` 还是 `file` |
| `images[].fetchedVia` | `pximg-direct` / `mirror-proxy` / `local` |
| `images[].pixels` / `tier` / `tierFallback` | 像素对账结果与降级说明 |
| `imageNotes` | 取图过程中的说明（如"pixiv 作品 X 是 R-18，不配进公开说说"） |
| `imageFailures` | 请求了配图但一张都没配上时，列出试过的地址与失败原因 |

**`prepared` 的 `cleanup` 一定在 `finally` 里逐个 await**（`mcp-napcat-safe.js:2718-2721`）：无配图时 `prepared` 为空；有临时文件（>10MB 才会出现）**必须成败都删**。

---

## B.7 空间互动的其他坑

| 工具 | 坑 |
| --- | --- |
| `qq_qzone_like` | 走 **QZone 现役接口 `internal_dolike_app`**（`w.qzone.qq.com` 前缀，POST 表单，返回**纯 JSON 而不是 JSONP**）；老的 `emotion_cgi_do_like_v6` **已 HTTP 500**（`mcp-napcat-safe.js:2634-2635`） |
| `qq_qzone_comment` | `tid` 来自 `qq_qzone_view` 返回文本里的 `[tid=xxx]` |
| `qq_qzone_reply_comment` | 楼中楼回复需要 `commentId`，从 `qq_qzone_view` 的评论列表拿 |
| `qq_qzone_view` | 返回里**带评论（id + 作者 + 内容）**，就是为了让回复工具能直接拿 `commentId`；回复时的 @ 需要作者昵称 |

空间 cookie 走 `/api/qzone-cookie` 查配置状态。有总开关 `QZONE_TOOL_DISABLED`（未启用时这些工具返回统一说明）。

主动发说说（`postRandomQzone`，`core/qzone.js:8`）是一个独立的简单路径：从内置文案池里随机挑一条、`POST <napcatBase>/send_qzone_msg`，成功后往 `memory_entries` 写一条 `category='qzone_post'` —— **让 AI 知道自己发过这条说说**。

---

# C. 两条链路的共同教训

| 教训 | 具体表现 | 现在的防线 |
| --- | --- | --- |
| **"看起来成功"是最贵的失败** | 参数名错了（`file` vs `images`）静默忽略；档位错了照样写 `lossless: true`；`tid` 恒为 null | 参数名对着**装好的 NapCat 包**核；`lossless` 改成按**实际发出去的档位**判定；两种 `tid` 形态都兼容 |
| **只校验"开头几个字节"等于没校验** | `looksLikeImageBuffer` 只认前 3 个字节 → 上半张正常、下半幅灰的图会全链路通过 | `verifyImageComplete`：四种格式的尾标记 + `content-length` 比对 |
| **地址可信 ≠ 字节可信** | 第三方代理拿着原图地址给你一张 720 档 | `pixivTierSizeVerdict` 拿实际像素跟元数据对账 |
| **跨容器的路径不能直接传** | 宿主路径交给容器里的 NapCat → `识别URL失败`，一条都发不出去 | 统一走 `napcatImageFileArg`；`auto` 模式映射容器路径，映射不上退 base64 |
| **临时目录可能是共用的** | 无脑清空 `napcat.tmpDir` 会把表情包和文档一起删了 | 按**自己的文件名正则**过滤，且只在启动时扫一次 |
| **降级必须显式** | "谁先成功就发谁" → 用户要原图收到缩略图，还被告知无损 | `planPixivSend` 分桶；降级要**打日志 + 写进结果**（`tierFallback`） |

对应的回归测试：

| 测试 | 覆盖 |
| --- | --- |
| `qq-bridge/tests/pixiv-source-order.test.js` | 候选来源顺序 |
| `qq-bridge/tests/pixiv-auth.test.js` | 登录态与令牌 |
| `qq-bridge/tests/qzone-image.test.js` | 空间配图的体检、零落盘、清扫 |
| `qq-bridge/tools/test-pixiv-tier-truncation.mjs` | 档位识别与截断（纯函数自测） |
| `qq-bridge/tools/test-pixiv-byid.mjs`、`test-pixiv-cache.mjs`、`test-pixiv-filters.mjs` | 按号取图、缓存、本地筛选 |
| `qq-bridge/tools/e2e-pixiv-send.mjs` | 端到端发图 |
| `qq-bridge/tools/probe-jpeg-structure.mjs`、`probe-pixiv-native.mjs`、`probe-pixiv-params.mjs`、`dump-pixiv-shape.mjs` | 现场探针 |

---

# D. 未核实项

- **NapCat 内部行号**（`napcat.mjs` 的 80276~80283、9237、11560、11578、11585 等）来自 `lib/qzone-image.js` 顶部注释里记录的**读包结果**（本机 NapCat 9.9.26-44498）。我本轮**没有重新解包核对这些行号** —— NapCat 升级后它们会平移，函数名（`SendQzoneMsg._handle`、`uploadImageToQzone`、`publishQzoneMsg`）是更稳的锚点。
- `qq_send_pixiv` 里"写临时文件 → POST `/api/social/send-message`"之后的**投递侧**（`core/console-server.js:2112` 起的 `send-message` 端点、`core/qq-send.js` 的 `onebotSend`）我只核到端点与调用，**没有逐行读发送实现**。
- `lib/image-compress.js` 的 `IMAGE_HARD_MAX_BYTES` 已核对：`image-compress.js:47` 就是 `15 * 1024 * 1024`，与 `MAX_IMAGE_FETCH_BYTES` 同值，投递前的两道卡口确实都放宽到 15MB（`image-compress.js:250`、`295-296` 是判定处）。
- 干跑脚本 `_qzone_dryrun.mjs` 是 `lib/qzone-image.js:2693` 注释里提到的工作区临时脚本，**本仓库 `tools/` 下没有它**（我搜过 `qq-bridge/tools/`），所以那条实测结论是**转述代码注释**，我没有复现。
- 本文没有覆盖 `qq_send_image`（联网找图直发）的完整实现，只核到它复用了 `safeFetchBuffer` 的同一道闸门。
