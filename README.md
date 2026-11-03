# PIU Pumbility Best50 / Yunzai 插件

读取本人 PIU Phoenix 2 官网成绩，生成 Best50 图片；保存全球 Pumbility 前 1000 名的每日快照，并按个人关注列表生成比较图。支持一个官网账号绑定的多个 GAME ID。

## 环境与安装

使用 Node.js **22.13 或以上**。SQLite 使用 Node 自带的 `node:sqlite`，无需另装数据库服务器。

将本目录放到 Yunzai 的 `plugins/piu-best50-plugin/`，进入目录执行：

```sh
npm ci
npm run browser:install
npm run setup
```

`setup` 创建本地 `.env`，生成随机会话加密密钥；已有文件不会被覆盖。修改 `PIU_PUBLIC_URL` 为用户手机能够打开的 HTTPS 域名，通过反向代理转发到 `127.0.0.1:3210`，示例见 `deploy/nginx.conf`。本机测试可使用默认 `http://localhost:3210`；手机无法通过自己的 localhost 访问电脑。

重启 Yunzai 后加载插件。可用 `PIU_BROWSER_PATH` 指向已安装的 Chrome；留空则使用 Playwright Chromium。Linux 还需安装浏览器系统依赖和中文字体。

## 机器人命令

所有显式档案标识都使用 **名称#四位标签**，例如 `ZANTING#9403`。不接受纯名称、`#9403` 或 `uid2`。一个账号内的默认档案仍是官网列表中的首个档案。

| 命令 | 用途 |
| --- | --- |
| `#piu help` | 显示全部命令与用途；别名 `#piu 帮助`。 |
| 私聊 `#piu 登录` | 领取登录二维码，完成官网账号登录并绑定个人会话；别名 `登陆`、`绑定`、`login`。 |
| 私聊 `#piu list` | 列出本人账号的全部档案、完整标识、Pumbility 和成绩数量；别名 `账号`、`游戏ID`、`ids`。 |
| `#piu b50` | 生成本人首个档案的 Best50；别名 `best50`。 |
| `#piu b50 ZANTING#9403` | 为本人账号内指定档案生成 Best50。 |
| `#piu follow SHAWN#1477 YINYBEST#3231 CHIPHANT#5633` | 批量添加到自己的关注列表。 |
| `#piu unfollow SHAWN#1477 YINYBEST#3231` | 批量移出自己的关注列表。 |
| `#piu follow` / `#piu unfollow` | 不带参数时查看自己的关注列表。 |
| `#piu rank` | 比较本周一与上周一 GMT+8 01:00 对应快照，生成关注列表图片。 |
| `#piu rank 20261103 20261003` | 比较两个 `YYYYMMDD` 日期的快照，前者为当前、后者为基准。 |
| `#piu 解绑` | 删除本人登录会话和 B50 图片缓存；别名 `退出`、`logout`。 |
| 主人私聊 `#piu ranklogin` | 明确授权全局排行榜采集专用会话。 |

名称含空格时，批量关注命令可写成 `#piu follow "NAME WITH SPACE#1234" SHAWN#1477`。每个用户最多关注 100 个档案。新增关注需能在最新保存的全球前 1000 名中找到；已有关注者跌出榜单后仍保留关注，图中相应数据为空。不同机器人、适配器和发命令用户的绑定、关注列表分别保存。

二维码打开的是本插件提供的独立浏览器登录入口，**不是官网原生扫码授权**。用户在该窗口中输入官网账号密码，完成后点击“完成并绑定”。服务器不保存账号密码，会加密保存登录会话以读取成绩；二维码请勿转发。普通个人登录不会授权全局排行榜采集。

## 图片与曲绘

Best50 为 5 列 × 10 行，单卡片 600 × 150。标题右侧同一行显示完整玩家标识、总 Pumbility；全球前 1000 名玩家可显示最近排行榜快照中的全球排名。每首歌按官网顺序展示，分数右侧的原版 Grade、Plate 和等级圆圈固定靠右对齐。Single 使用红色圆圈，Double 使用绿色圆圈，圈内只显示等级数字。

12 种普通 Grade、对应失败变体及 8 种 Plate 原图保存在 `assets/`，来源、尺寸和 SHA-256 记录在 `assets/manifest.json`。不会根据游戏分数自行推算缺失的 Pumbility。

曲绘以官网图片 URL 规范化后保存到 `data/jackets/`，保留原始文件，跨用户共享且不设置过期时间。生成 B50 时优先读取缓存，缺少的曲绘自动下载保存；损坏文件会重新下载。缓存只共享官方曲绘，不共享玩家头像、成绩和会话。首次授权排行榜采集时，默认从官方 [Over Ranking](https://www.piugame.com/leaderboard/over_ranking.php) 的前 3 页预存曲绘；也可运行 `rank-prefetch` 手动预存。

## 每日排行榜与历史比较

机器人持续运行、专用登录有效时，每天 **GMT+8 01:00** 读取 [Pumbility Ranking](https://www.piugame.com/leaderboard/pumbility_ranking.php)，只有完整的 1000 条记录通过校验后才写入 `data/rankings.sqlite`。插件加载时会启动采集定时器；若当日 01:00 已过且缺少定时快照，会进行一次补采，并记录实际采集时间。

默认比较的是当前日历周的周一和上周一。程序不会用当前榜单补造过去数据：若两个日期中任一快照缺失，会提示缺少日期及已有日期。手动采集、晚启动补采与准点采集分别标记，图片显示实际时间；同日没有定时/补采快照时，允许使用该日手动快照作为明确标记的回退。运行前未采集的历史日期无法恢复。

排行榜需要登录。主人首次执行 `#piu ranklogin` 授权，之后默认每 20 分钟保活；失效时需重新授权。机器人离线、网络失败或登录失效都可能造成缺失快照。个人 `解绑` 不会删除已授权的全局排行榜采集会话。

一次真实前 1000 名数据检查发现 **53 组重复四位标签，涉及 108 个档案**，因此数据库与命令均按完整名称和标签识别。官网没有提供公开稳定的玩家 ID，玩家改名后无法自动确认新旧名称是同一个人，需要重新关注新名称。当前页面也未提供国家字段，所以比较图的附加排名显示为“关注内名次”，不推断中国区排名。

## 命令行本地测试

先完成上面的依赖安装和 `.env` 初始化。以下命令在插件目录运行：

```sh
# 打开本机浏览器完成个人登录，按终端提示回车
node bin/piu.js login-local local
node bin/piu.js list local
node bin/piu.js fetch local best50.png 'ZANTING#9403'

# 不指定档案时使用首个档案
node bin/piu.js fetch local best50.png

# 专门授权排行榜采集，首次取得真实快照
node bin/piu.js rank-login-local
node bin/piu.js rank-capture
node bin/piu.js rank-dates
node bin/piu.js rank-audit
node bin/piu.js rank-prefetch

# 单独持续运行排行榜采集器，Ctrl+C 停止
node bin/piu.js rank-daemon

# CLI 的 owner 是关注列表所属者，不等同于 Yunzai 用户标识
node bin/piu.js rank-follow local SHAWN#1477 YINYBEST#3231 CHIPHANT#5633
node bin/piu.js rank-unfollow local SHAWN#1477
node bin/piu.js rank local 20261103 20261003 rank.png
node bin/piu.js rank-preview local 20261103 rank-current.png

# 离线解析或渲染；render 默认不读取远程曲绘
node bin/piu.js parse pumbility.html profile.json
node bin/piu.js render profile.json best50.png
npm test
```

`rank-preview` 展示某日真实数据，不计算相对不存在基准的变化。`node bin/piu.js rank local` 使用默认周一比较日期。`node bin/piu.js serve local` 可单独启动二维码登录入口，完成绑定后停止该进程再执行 `fetch`。

## 配置与数据

配置写入插件目录 `.env`，完整示例见 `.env.example`。

| 配置 | 默认值 / 作用 |
| --- | --- |
| `PIU_PUBLIC_URL` | `http://localhost:3210`；部署时改为公开 HTTPS 源地址。 |
| `PIU_HOST` / `PIU_PORT` | `127.0.0.1` / `3210`；登录入口监听地址。 |
| `PIU_SESSION_KEY` | `setup` 生成的 64 位十六进制密钥，用于加密会话。 |
| `PIU_DATA_DIR` | 插件目录内 `data`；可指定其他持久化目录。 |
| `PIU_BROWSER_PATH` | 可选 Chrome 可执行文件路径。 |
| `PIU_LOGIN_SECONDS` | `300`；登录入口有效期。 |
| `PIU_MAX_LOGINS` / `PIU_MAX_FETCHES` | `3` / `2`；同时登录和成绩读取上限。 |
| `PIU_CACHE_SECONDS` | `120`；个人 B50 图片内存缓存时间。 |
| `PIU_SESSION_DAYS` | `14`；个人保存会话的最长使用天数。 |
| `PIU_RANK_ENABLED` | `true`；是否启动每日采集和保活。 |
| `PIU_RANK_KEEPALIVE_MINUTES` | `20`；排行榜保活间隔，`0` 关闭保活。 |
| `PIU_RANK_CAPTURE_RETRIES` | `2`；采集失败后的额外重试次数。 |
| `PIU_JACKET_PREFETCH_PAGES` | `3`；首次授权时预存曲绘页数，`0` 关闭自动预存。 |
| `PIU_JACKET_PREFETCH_IMAGES` | `120`；每次预存最多处理的曲绘数。 |

持久化文件包括：`data/sessions/` 个人加密会话、`data/ranking-auth/` 专用采集加密会话、`data/rankings.sqlite` 榜单和关注列表、`data/jackets/` 共享原始曲绘。备份数据库和会话时同时保留原密钥；更换密钥后原会话无法解密，需要重新登录。部署更新时保留 `.env` 和整个数据目录，勿将其放入源码发布包。

代码许可为 MIT；官网 Grade、Plate 和曲绘归各自权利人所有，详情见 `THIRD_PARTY_NOTICES.md`。
