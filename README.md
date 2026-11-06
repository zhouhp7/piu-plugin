# PIU Best50 / Yunzai 插件

读取 PIU Phoenix 2 官网成绩，生成 Best50、最近游玩、Play Data 和关注榜比较图。支持多账号绑定、本地档案缓存及每日全球前 1000 名快照。

## 安装

需要 **Node.js 22.13+**，在 Yunzai 根目录执行：

```sh
git clone https://github.com/zhouhp7/piu-plugin.git plugins/piu-plugin
cd plugins/piu-plugin
npm ci
npm run browser:install
npm run setup
```

编辑生成的 `.env` 后重启 Yunzai。二维码登录需将 `PIU_PUBLIC_URL` 配为手机可访问的 HTTPS 地址；[反向代理示例](deploy/nginx.conf)转发至 `127.0.0.1:3210`。Cookie 登录无需公开页面或反向代理。Linux 还需浏览器系统依赖和中文字体。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `#piu help` | 查看全部命令和别名 |
| `#piu login [sid=会话值]` | 私聊添加账号；不带参数扫码；别名：登录、登陆、绑定 |
| `#piu list [序号]` | 私聊查看档案，带序号设为默认；也可用 `#piu default 序号` |
| `#piu refresh` | 私聊从官网刷新个人档案缓存 |
| `#piu b50 [档案]` | Best50 与 Single / Double 等级进度 |
| `#piu recent [档案]` | 最近最多 50 次游玩，保留重复记录 |
| `#piu data [档案]` | Play Data 游玩次数、Grade 和 Plate 统计 |
| `#piu logout` | 删除本人全部账号绑定、默认设置及成绩图片缓存；别名：解绑、退出 |
| `#piu follow 名称#标签 ...` / `#piu unfollow 名称#标签 ...` | 批量关注或取消；不带参数查看列表 |
| `#piu rank [日期1 日期2]` | 比较关注榜；日期格式 YYYYMMDD，前者为当前、后者为基准 |

重复登录可添加不同账号，同一账号更新会话，`list` 合并显示全部档案。`b50`、`recent`、`data` 支持**列表序号、唯一名称、唯一 `#四位标签` 或完整 `名称#四位标签`**；有重名时使用序号或完整标识，不填则使用默认档案。默认设置重启后保留。

名称仅限 **1–12 位英文字母或数字**，无空格或符号；参数大小写不敏感，统一显示大写。列表仅读本地缓存，缺少统计显示 `—`；用 `refresh` 更新档案信息和统计，不触发排行榜采集。

关注须用完整名称和四位标签，符合规则即可添加，无需绑定账号、已有快照、进入前 1000 名或访问官网；改名后需重新关注。群内 `follow`、`unfollow`、`rank` 使用本群共享列表，所有成员可修改，不同群独立；私聊使用个人列表。

## 在自己设备登录并导入 Cookie

1. 在自己的浏览器登录 [PIU 官网](https://www.piugame.com)，打开 [Pumbility 页面](https://www.piugame.com/my_page/pumbility.php)。
2. 在开发者工具 **Application → Cookies → https://www.piugame.com** 找到 `sid`，复制 Value。
3. 私聊机器人发送 `#piu login sid=复制的值`，再用 `#piu list` 查看档案。

也支持完整 Cookie 请求头值、PIU Cookie JSON 或 Playwright `storageState` JSON；只导入 PIU Cookie，无需密码或 AM.PASS Cookie。`#piu login help` 查看方法。Cookie 是登录凭证，只发给可信机器人，勿发群聊；泄露后需在官网退出或撤销会话。二维码是插件登录入口，请勿转发。会话加密保存，不保存密码。

**排行榜授权独立于个人登录。** 主人私聊 `#piu ranklogin sid=会话值` 导入，或不带参数扫码；`#piu ranklogin help` 查看方法。验证完整前 1000 名后保存专用会话和当日快照，失败保留原数据。普通 `login` 不授权采集，`logout` 不删除排行榜会话；失效后由主人重新登录。

## 图片与排行榜

- 图片宽高缩小至原布局的 **2/3**，输出 **JPG**；曲绘自动本地缓存。三类成绩图均显示当前称号、最近游玩时间和街机厅，官网 GMT+9 时间转为 GMT+8。
- B50 使用官网 Pumbility；recent 显示原始分数并保留 STAGE BREAK。Single / Double 等级用红 / 绿大字显示。B50 从 [Title 页面](https://piugame.com/my_page/title.php)读取双模式分数和当前等级进度：INTERMEDIATE、ADVANCED、EXPERT 各 Lv.1–10，之后为 MASTER；低于 INTERMEDIATE Lv.1 时显示 BEGINNER。
- 授权后每天 **GMT+8 01:00** 保存全球前 1000 名至 SQLite，采集或保存失败后，当天每隔 **30 分钟** 补采，成功后停止当天补采；跨天不再补抓前一天。服务重启后会立即尝试补采当天已错过的时段。默认每 20 分钟保活。`rank` 默认比较本周一与上周一快照，须两日均已采集，历史缺失无法补造。图中显示实际采集时间，名次进退用 ↑ / ↓；未进入某次快照的档案，该次成绩和排名不可用。“关注内名次”仅在上榜关注者之间计算，B50 世界排名取自最近保存榜单。

## 配置与本地运行

完整配置见 [`.env.example`](.env.example)。`PIU_DATA_DIR` 默认 `data/`，`PIU_BROWSER_PATH` 可指定 Chrome，`PIU_RANK_ENABLED` 控制每日采集；`setup` 自动生成会话密钥 `PIU_SESSION_KEY`。

```sh
node bin/piu.js login-local local
node bin/piu.js fetch local best50.jpg 'ZANTING#9403'
node bin/piu.js recent local recent.jpg 'ZANTING#9403'
node bin/piu.js data local play-data.jpg 'ZANTING#9403'
node bin/piu.js rank-login-local
node bin/piu.js rank-daemon
npm test
```

更新时保留 `.env` 和 `data/`；备份会话须同时保留原密钥，发布源码时排除运行数据。

代码采用 MIT 许可，官网图片归各自权利人所有，详见 [第三方声明](THIRD_PARTY_NOTICES.md)。
