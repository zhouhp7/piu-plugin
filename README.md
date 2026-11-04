# PIU Best50 / Yunzai 插件

读取 PIU Phoenix 2 官网成绩，生成 Best50、最近游玩、Play Data 统计和关注列表比较图。支持同一账号的多个 GAME ID，自动缓存曲绘，每天保存全球前 1000 名排行榜。

## 安装

需要 **Node.js 22.13+**。在 Yunzai 根目录执行：

```sh
git clone https://github.com/zhouhp7/piu-plugin.git plugins/piu-plugin
cd plugins/piu-plugin
npm ci
npm run browser:install
npm run setup
```

编辑生成的 `.env`，然后重启 Yunzai。使用二维码登录时，将 `PIU_PUBLIC_URL` 改为手机可访问的 HTTPS 地址；[反向代理示例](deploy/nginx.conf)默认转发到 `127.0.0.1:3210`。使用 Cookie 导入绑定个人账号时，无需公开登录页面或配置反向代理。Linux 还需安装浏览器系统依赖和中文字体。

## 命令

先私聊机器人发送 `#piu 登录`，或使用下方 Cookie 导入方式完成绑定。

| 命令 | 用途 |
| --- | --- |
| `#piu help` | 查看全部命令和别名的帮助图片 |
| `#piu 登录` | 私聊领取登录二维码 |
| `#piu cookie` | 私聊查看 Cookie 获取与导入方法 |
| `#piu cookie sid=你的会话值` | 使用自己设备上的官网登录会话绑定个人账号 |
| `#piu list` | 私聊列出自己账号的全部档案 |
| `#piu b50` | 生成首个档案的 Best50 |
| `#piu b50 ZANTING#9403` | 生成指定档案的 Best50 |
| `#piu recent` | 显示首个档案最近游玩的最多 50 条记录 |
| `#piu recent ZANTING#9403` | 显示指定档案的最近游玩 |
| `#piu data` | 显示首个档案的 Play Data 统计图 |
| `#piu data ZANTING#9403` | 显示指定档案的游玩次数、Grade 和 Plate 统计 |
| `#piu follow SHAWN#1477 YINYBEST#3231 CHIPHANT#5633` | 批量添加关注 |
| `#piu unfollow SHAWN#1477 YINYBEST#3231` | 批量取消关注 |
| `#piu rank` | 比较本周一与上周一 01:00（GMT+8）的关注列表成绩 |
| `#piu rank 20261103 20261003` | 比较指定两天的快照，前者为当前、后者为基准 |
| `#piu 解绑` | 删除自己的登录会话和成绩图片缓存 |
| `#piu ranklogin` | 机器人主人私聊授权每日排行榜采集 |

指定档案须使用完整的 **名称#四位标签**。B50、recent 和 data 仅查询本人绑定账号的档案。名称含空格时，批量关注可写成 `#piu follow "NAME WITH SPACE#1234"`。`follow` / `unfollow` 不带参数时查看自己的关注列表；新增关注需存在于最新保存的前 1000 名中，改名后需重新关注。

二维码是插件提供的登录入口，非官网原生扫码授权。服务器加密保存会话，不保存账号密码，请勿转发二维码。

## 在自己设备登录并导入 Cookie

1. 在自己的电脑浏览器登录 [PIU 官网](https://www.piugame.com)，打开个人 [Pumbility 页面](https://www.piugame.com/my_page/pumbility.php)，确认能看到自己的档案。
2. 打开开发者工具（F12），在 **Application → Cookies → https://www.piugame.com** 中找到 `sid` 并复制它的 Value。也可以在 **Network** 中刷新，选择 `pumbility.php` 请求，查看 **Request Headers → Cookie**。
3. **私聊**可信机器人发送 `#piu cookie sid=复制的值`。若验证失败，重新登录后复制该请求完整的 Cookie 值，发送 `#piu cookie 名称1=值1; 名称2=值2`。可保留开头的 `Cookie:`。
4. 机器人实际访问官网个人页面，验证成功后加密保存会话并清除旧成绩缓存。失败时保留原绑定。之后发送 `#piu list` 或 `#piu b50` 即可。

`sid` 的依据是现有 [PumpItUpScoreTracker 客户端](https://github.com/DrMurloc/PumpItUpScoreTracker/blob/main/ScoreTracker/ScoreTracker.OfficialMirror/Infrastructure/Apis/PiuGameApi.cs)仅设置 `sid` Cookie，以及 [phoenix-parser 的 Phoenix 2 同步功能](https://github.com/AlanCooper509/phoenix-parser/blob/master/react/src/Phx2/SyncForm.jsx)只提取该字段。目前未使用真实已登录账号逐项删减 Cookie 实测，最终以机器人访问个人页面的验证结果为准。

也支持在 `#piu cookie` 后直接粘贴 Cookie JSON 数组或 Playwright `storageState` JSON 文本。只保留 `piugame.com` / `www.piugame.com` 的 Cookie，不导入其他域的 Cookie 或 localStorage。无需提供账号密码、AM.PASS Cookie 或完整 cURL 请求；当前命令接收文本，不接收文件附件。

Cookie 相当于登录凭证，请勿发到群聊；聊天平台及机器人宿主可能留存消息，插件回复不会引用或回显 Cookie。仅导入自己账号的会话。解绑使用 `#piu 解绑`；若已泄露，还需在官网退出或撤销会话。此方式只绑定个人账号，排行榜专用授权仍使用主人私聊 `#piu ranklogin`。

## 成绩与排行榜

- B50 使用官网 Pumbility 分数；recent 显示游戏原始分数、Grade、Plate、等级及 GMT+8 游玩时间，保留重复游玩与 STAGE BREAK。
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
node bin/piu.js fetch local best50.png 'ZANTING#9403'
node bin/piu.js recent local recent.png 'ZANTING#9403'
node bin/piu.js data local play-data.png 'ZANTING#9403'
node bin/piu.js rank-login-local
node bin/piu.js rank-daemon
npm test
```

更新时保留 `.env` 和 `data/`；备份会话时同时保留原密钥。源码发布时排除这些运行数据。

代码采用 MIT 许可，官网图片归各自权利人所有，详见 [第三方声明](THIRD_PARTY_NOTICES.md)。
