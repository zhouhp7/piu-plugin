# PIU Best50 / Yunzai 插件

读取 PIU Phoenix 2 官网成绩，生成 Best50、最近游玩、Play Data 统计和关注列表比较图。支持每个用户绑定多个 PIU 账号并合并档案，自动缓存曲绘，每天保存全球前 1000 名排行榜。

## 安装

需要 **Node.js 22.13+**。在 Yunzai 根目录执行：

```sh
git clone https://github.com/zhouhp7/piu-plugin.git plugins/piu-plugin
cd plugins/piu-plugin
npm ci
npm run browser:install
npm run setup
```

编辑生成的 `.env`，然后重启 Yunzai。使用二维码登录时，将 `PIU_PUBLIC_URL` 改为手机可访问的 HTTPS 地址；[反向代理示例](deploy/nginx.conf)默认转发到 `127.0.0.1:3210`。个人账号和排行榜采集均可导入 Cookie，无需公开登录页面或配置反向代理。Linux 还需安装浏览器系统依赖和中文字体。

## 命令

私聊机器人发送 `#piu login` 扫码登录，或发送 `#piu login sid=会话值` 直接绑定。`login` 的别名为“登录、登陆、绑定”；`logout` 的别名为“解绑、退出”。

| 命令 | 用途 |
| --- | --- |
| `#piu help` | 查看全部命令和别名的帮助图片 |
| `#piu login` | 私聊领取二维码，扫码添加 PIU 账号 |
| `#piu login sid=你的会话值` | 私聊导入自己设备上的官网登录会话 |
| `#piu login help` | 查看 Cookie 获取与导入方法 |
| `#piu list` | 私聊合并列出自己绑定的全部账号与档案 |
| `#piu b50` | 生成首个有效账号的首个档案的 Best50 |
| `#piu b50 ZANTING#9403` | 生成指定档案的 Best50，含 Single / Double 等级进度 |
| `#piu recent` | 显示首个有效账号的首个档案最近游玩的最多 50 条记录 |
| `#piu recent ZANTING#9403` | 显示指定档案的最近游玩 |
| `#piu data` | 显示首个有效账号的首个档案的 Play Data 统计图 |
| `#piu data ZANTING#9403` | 显示指定档案的游玩次数、Grade 和 Plate 统计 |
| `#piu follow SHAWN#1477 YINYBEST#3231 CHIPHANT#5633` | 批量添加关注；群内修改本群共享列表 |
| `#piu unfollow SHAWN#1477 YINYBEST#3231` | 批量取消关注；群内所有成员都可修改 |
| `#piu rank` | 比较本周一与上周一 01:00（GMT+8）的关注列表成绩 |
| `#piu rank 20261103 20261003` | 比较指定两天的快照，前者为当前、后者为基准 |
| `#piu logout` | 删除自己全部个人账号绑定和成绩图片缓存 |
| `#piu ranklogin sid=你的会话值` | 主人私聊导入 Cookie，授权每日排行榜采集，无需反向代理 |
| `#piu ranklogin help` | 主人私聊查看排行榜 Cookie 获取与导入方法 |
| `#piu ranklogin` | 主人私聊使用原扫码方式授权每日排行榜采集 |

指定档案须使用完整的 **名称#四位标签**。B50、recent 和 data 自动找到档案所属的本人绑定账号。名称含空格时，批量关注可写成 `#piu follow "NAME WITH SPACE#1234"`。`follow` / `unfollow` 不带参数时查看当前聊天的关注列表；新增关注需存在于最新保存的前 1000 名中，改名后需重新关注。

群内 `follow`、`unfollow` 和 `rank` 使用**本群共享的关注列表**，所有群成员均可添加、取消和查看，不同群互相独立。私聊继续使用个人列表，原有的个人关注仍可在私聊查看。

二维码是插件提供的登录入口，非官网原生扫码授权。服务器加密保存会话，不保存账号密码，请勿转发二维码。

## 在自己设备登录并导入 Cookie

1. 在自己的浏览器登录 [PIU 官网](https://www.piugame.com)，打开个人 [Pumbility 页面](https://www.piugame.com/my_page/pumbility.php)。
2. 在开发者工具 **Application → Cookies → https://www.piugame.com** 中找到 `sid`，复制它的 Value。
3. 私聊机器人发送 `#piu login sid=复制的值`。成功后用 `#piu list` 查看档案。

不同账号会追加绑定，同一账号会更新会话；失败时保留原绑定。也支持完整 Cookie 请求头值或 PIU Cookie JSON 文本，只导入 PIU 官网 Cookie，无需密码或 AM.PASS Cookie。

Cookie 是登录凭证，只发给可信机器人，勿发到群聊。会话加密保存；`#piu logout` 删除本人全部个人账号绑定。若凭证泄露，还需在官网退出或撤销会话。普通 `login` 不会授权排行榜采集。

### 同一用户绑定多个账号

重复使用 `#piu login` 扫码，或 `#piu login sid=另一账号的会话值`，即可添加不同的 PIU 账号。`#piu list` 按绑定顺序合并显示所有档案，并标注账号序号；旧版单账号会话自动兼容，无需重新绑定。重新登录同一账号会更新会话，档案改名时也会按官网档案 ID 识别。

`#piu b50 名称#标签`、`#piu recent 名称#标签`、`#piu data 名称#标签` 自动使用对应账号。不指定档案时，使用首个有效账号的首个档案。单个账号失效不会影响其他账号，列表会标出需要重新登录的账号。`#piu logout` 删除本人全部账号绑定和成绩图片缓存。

### 主人用 Cookie 授权排行榜采集

在自己设备登录官网后，**机器人主人私聊**发送 `#piu ranklogin sid=复制的值`。同样支持完整 Cookie 请求头值、Cookie JSON 数组和 Playwright `storageState` JSON。只导入 PIU 官网 Cookie；无需提供账号密码或 AM.PASS Cookie，也无需反向代理。

插件会实际读取并校验完整前 1000 名，成功后加密保存排行榜专用会话及当日手动快照，继续使用现有的每日采集和保活配置。验证失败时保留原排行榜会话和快照；不修改个人账号绑定。`#piu logout` 只删除个人会话；排行榜会话失效后，由主人再次私聊导入新 Cookie。

`#piu ranklogin help` 查看获取方法。不带参数的 `#piu ranklogin` 保留原扫码方式。

## 成绩与排行榜

生成图片统一按原布局的宽、高各缩小至 **2/3**，以 **JPG** 格式输出，减少文件大小。

- B50 使用官网 Pumbility 分数；recent 显示游戏原始分数、Grade、Plate、等级及 GMT+8 游玩时间，保留重复游玩与 STAGE BREAK。
- B50 读取同一档案的 [Title 页面](https://piugame.com/my_page/title.php)，分别显示 Single、Double 的当前分数、INTERMEDIATE / ADVANCED / EXPERT（各 Lv.1–10）或 MASTER，以及到下一小等级的进度。门槛取自当前官网，百分比为 `(当前分数 − 本级门槛) / (下级门槛 − 本级门槛)`。未达 INTERMEDIATE Lv.1 时显示 BEGINNER；MASTER 显示 100%，官网不提供精确分数时显示 `≥ MASTER 门槛`。
- 卡片使用大曲绘和官网原版图标；顶栏信息使用大字，更新时间统一为 GMT+8。Single 等级圈为红色，Double 为绿色。曲绘跨用户缓存，缺少时自动下载保存。
- 主人完成 `#piu ranklogin` 后，机器人在线且会话有效时，每天 **GMT+8 01:00** 保存完整前 1000 名至 SQLite；默认每 20 分钟保活，失效后需重新登录。普通个人登录不授权全局采集。
- 比较需要两个日期都已有快照；过去未采集的数据无法补造。晚启动补采会标记实际时间。B50 全球排名来自最近保存的榜单；比较图另显示“关注内名次”。

## 配置与本地运行

完整配置见 [`.env.example`](.env.example)。常用项：

| 配置 | 作用 |
| --- | --- |
| `PIU_PUBLIC_URL` | 手机可访问的 HTTPS 地址，本机测试默认 `http://localhost:3210` |
| `PIU_SESSION_KEY` | `setup` 自动生成的会话加密密钥 |
| `PIU_DATA_DIR` | 持久化目录，默认 `data/` |
| `PIU_BROWSER_PATH` | 可选：已安装的 Chrome 路径 |
| `PIU_RANK_ENABLED` | 是否启用每日排行榜采集，默认 `true` |

```sh
node bin/piu.js login-local local
node bin/piu.js fetch local best50.jpg 'ZANTING#9403'
node bin/piu.js recent local recent.jpg 'ZANTING#9403'
node bin/piu.js data local play-data.jpg 'ZANTING#9403'
node bin/piu.js rank-login-local
node bin/piu.js rank-daemon
npm test
```

更新时保留 `.env` 和 `data/`；备份会话时同时保留原密钥。源码发布时排除这些运行数据。

代码采用 MIT 许可，官网图片归各自权利人所有，详见 [第三方声明](THIRD_PARTY_NOTICES.md)。
