import crypto from 'node:crypto';
import { getRawConfig, saveConfig } from './src/config.js';

/**
 * 锅巴插件配置支持入口
 * 遵循 Guoba-Plugin 规范：返回 pluginInfo 和 configInfo
 */
export function supportGuoba() {
  return {
    pluginInfo: {
      name: 'piu-plugin',
      title: 'PIU-Plugin (Best50)',
      author: '@piu',
      authorLink: 'https://github.com',
      link: 'https://github.com',
      isV3: true,
      isV2: false,
      description: 'PIU Pumbility Best50 战绩图生成与每日全球排行榜抓取追踪插件',
      icon: 'mdi:gamepad-variant',
      iconColor: '#00c0ef',
      showInMenu: 'auto',
    },
    configInfo: {
      schemas: [
        // ==================== 服务与网络设置 ====================
        {
          component: 'SOFT_GROUP_BEGIN',
          label: '服务与网络设置',
        },
        {
          field: 'publicUrl',
          label: '公开访问地址 (Public URL)',
          bottomHelpMessage: '扫码登录时供外部访问的基准 URL。线上生产环境必须为 HTTPS（如 https://piu.example.com）；本地测试可用 http://localhost:3210',
          component: 'Input',
          required: true,
          componentProps: {
            placeholder: 'http://localhost:3210',
          },
        },
        {
          field: 'host',
          label: '服务监听 IP',
          bottomHelpMessage: '本地服务绑定的 IP 地址，一般填 127.0.0.1 或 0.0.0.0',
          component: 'Input',
          required: true,
          componentProps: {
            placeholder: '127.0.0.1',
          },
        },
        {
          field: 'port',
          label: '服务监听端口',
          bottomHelpMessage: '本地 HTTP 服务端口号（范围 1 - 65535）',
          component: 'InputNumber',
          required: true,
          componentProps: {
            min: 1,
            max: 65535,
            placeholder: '3210',
          },
        },
        {
          field: 'proxy',
          label: '代理服务器地址 (Proxy)',
          bottomHelpMessage: '访问 PIU 韩国官网的 HTTP/SOCKS 代理地址（例如 http://127.0.0.1:7890），国内直连受阻或经常超时时配置',
          component: 'Input',
          componentProps: {
            placeholder: '留空表示直连不走代理',
          },
        },

        // ==================== 安全与凭据设置 ====================
        {
          component: 'SOFT_GROUP_BEGIN',
          label: '安全与登录配置',
        },
        {
          field: 'sessionKey',
          label: '会话加密密钥 (Session Key)',
          helpMessage: '必须为 64 位十六进制字符。用于 AES 加密落盘存储的 PIU 会话和登录凭据',
          bottomHelpMessage: '首次配置可在下方点击生成，或在插件目录执行 npm run setup 自动生成',
          component: 'InputPassword',
          componentProps: {
            placeholder: '64 位十六进制密钥（如 a1b2c3...）',
          },
        },
        {
          field: 'loginSeconds',
          label: '扫码登录超时秒数',
          bottomHelpMessage: '扫码登录流程的最大等待有效秒数（范围 60 - 600 秒，默认 300）',
          component: 'InputNumber',
          required: true,
          componentProps: {
            min: 60,
            max: 600,
            placeholder: '300',
          },
        },
        {
          field: 'maxLogins',
          label: '最大并发登录流程数',
          bottomHelpMessage: '允许同时开启的扫码登录任务数上限（范围 1 - 10，默认 3）',
          component: 'InputNumber',
          required: true,
          componentProps: {
            min: 1,
            max: 10,
            placeholder: '3',
          },
        },
        {
          field: 'maxFetches',
          label: '最大并发抓取任务数',
          bottomHelpMessage: '允许同时向官网抓取个人数据的最大并发数（范围 1 - 8，默认 2）',
          component: 'InputNumber',
          required: true,
          componentProps: {
            min: 1,
            max: 8,
            placeholder: '2',
          },
        },
        {
          field: 'cacheSeconds',
          label: '个人战绩缓存时间（秒）',
          bottomHelpMessage: '缓存玩家查询个人战绩的秒数（范围 0 - 3600 秒，默认 120 秒）',
          component: 'InputNumber',
          required: true,
          componentProps: {
            min: 0,
            max: 3600,
            placeholder: '120',
          },
        },
        {
          field: 'sessionDays',
          label: '会话有效期（天）',
          bottomHelpMessage: '已登录凭证在本地的最长保留天数（范围 1 - 90 天，默认 14 天）',
          component: 'InputNumber',
          required: true,
          componentProps: {
            min: 1,
            max: 90,
            placeholder: '14',
          },
        },

        // ==================== 排行榜采集设置 ====================
        {
          component: 'SOFT_GROUP_BEGIN',
          label: '全球排行榜采集设置',
        },
        {
          field: 'rankEnabled',
          label: '启用排行榜采集守护',
          bottomHelpMessage: '每日 GMT+8 01:00 自动抓取并保存全球前 1000 名完整快照',
          component: 'Switch',
        },
        {
          field: 'rankKeepAliveMinutes',
          label: '排行榜会话保活间隔（分钟）',
          bottomHelpMessage: '保活间隔（0 - 1440 分钟，填 0 关闭自动保活，默认 20 分钟）',
          component: 'InputNumber',
          required: true,
          componentProps: {
            min: 0,
            max: 1440,
            placeholder: '20',
          },
        },
        {
          field: 'captureRetries',
          label: '抓取失败重试次数',
          bottomHelpMessage: '抓取失败后的自动重试次数（0 - 5 次，默认 2 次）',
          component: 'InputNumber',
          required: true,
          componentProps: {
            min: 0,
            max: 5,
            placeholder: '2',
          },
        },
        {
          field: 'jacketPrefetchPages',
          label: '首次曲绘预存页数',
          bottomHelpMessage: '首次授权排行榜采集时预存的曲绘页数（0 - 20，填 0 关闭，默认 3）',
          component: 'InputNumber',
          required: true,
          componentProps: {
            min: 0,
            max: 20,
            placeholder: '3',
          },
        },
        {
          field: 'jacketPrefetchImages',
          label: '曲绘预存图片上限',
          bottomHelpMessage: '预存曲绘图片数量上限（1 - 500，默认 120 张）',
          component: 'InputNumber',
          required: true,
          componentProps: {
            min: 1,
            max: 500,
            placeholder: '120',
          },
        },

        // ==================== 浏览器与环境设置 ====================
        {
          component: 'SOFT_GROUP_BEGIN',
          label: '浏览器与环境设置',
        },
        {
          field: 'browserPath',
          label: '自定义浏览器可执行路径',
          bottomHelpMessage: '已安装 Playwright Chromium 时请留空；也可填写本机 Chrome 路径（例如 C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe）',
          component: 'Input',
          componentProps: {
            placeholder: '留空默认使用 Playwright 内置 Chromium',
          },
        },
        {
          field: 'browserChannel',
          label: '浏览器通道 (Channel)',
          bottomHelpMessage: '可选填 chrome、msedge 等，留空默认',
          component: 'Input',
          componentProps: {
            placeholder: '留空默认',
          },
        },
        {
          field: 'dataDir',
          label: '数据存储目录',
          bottomHelpMessage: '相对于插件根目录的数据目录路径（默认 data）',
          component: 'Input',
          componentProps: {
            placeholder: 'data',
          },
        },
      ],

      // 获取配置供前端表单展示
      getConfigData() {
        return getRawConfig();
      },

      // 前端保存时写入配置
      setConfigData(data, { Result }) {
        try {
          // 校验 key（如果提供了非空值，必须是 64 位十六进制）
          if (data.sessionKey && !/^[a-f0-9]{64}$/i.test(String(data.sessionKey).trim())) {
            return Result.error('会话密钥 (sessionKey) 必须为 64 位十六进制字符！');
          }
          if (data.publicUrl) {
            const url = new URL(data.publicUrl);
            const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
            if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local))) {
              return Result.error('公开访问地址必须是 HTTPS 源地址（本地测试可用 http://localhost:3210）！');
            }
          }
          saveConfig(data);
          return Result.ok({}, '配置已保存成功~');
        } catch (err) {
          return Result.error('配置保存失败：' + (err.message || String(err)));
        }
      },

      // 扩展动作（可在后台一键调用）
      actions: {
        generateKey(args, { Result }) {
          const key = crypto.randomBytes(32).toString('hex');
          return Result.ok({ key }, '随机 64 位密钥生成成功！');
        },
      },
    },
  };
}
