import {createCanvas} from '@napi-rs/canvas';
import {UI_COLORS as C,panel,text,wrapLines} from './ui.js';
import {encodeOutput,scaledDimension} from './image-output.js';

export const HELP_GROUPS = Object.freeze([
  {title:'账号与成绩',items:[
    {command:'#piu login [Cookie 内容]',description:'私聊扫码或导入 sid=会话值 添加账号；同一账号会更新会话，help 查看获取方法。',aliases:'登录 / 登陆 / 绑定'},
    {command:'#piu list [序号]',description:'私聊读取本地档案缓存，标注默认档案；带序号可设为默认。',aliases:'账号 / 游戏ID / ids'},
    {command:'#piu default 序号',description:'按 list 序号设置默认档案，重启后仍保留。'},
    {command:'#piu refresh',description:'私聊从官网刷新个人档案缓存，不触发排行榜采集。'},
    {command:'#piu b50 [档案]',description:'生成 Best50，含 Single / Double 等级进度；省略时使用默认档案。',aliases:'best50'},
    {command:'#piu recent [档案]',description:'最近最多 50 次游玩，保留重复，显示游戏分数和时间。'},
    {command:'#piu data [档案]',description:'Play Data：游玩次数、Grade 和 Plate 达成统计。'},
    {command:'#piu logout',description:'删除本人全部 PIU 账号绑定和成绩图片缓存。',aliases:'解绑 / 退出'},
  ]},
  {title:'关注与排行榜',items:[
    {command:'#piu follow 名称#标签 ...',description:'批量添加关注，无需已上榜或绑定账号；群内共享，所有成员都可修改，私聊使用个人列表。'},
    {command:'#piu unfollow 名称#标签 ...',description:'批量取消关注。follow / unfollow 不带参数时查看关注列表。'},
    {command:'#piu rank',description:'比较本周一 01:00 与上周一 01:00（GMT+8）的快照。'},
    {command:'#piu rank 日期1 日期2',description:'日期为 YYYYMMDD；前者为当前、后者为基准。'},
    {command:'#piu ranklogin [Cookie 内容]',description:'仅机器人主人私聊：导入 Cookie 授权每日采集，无需反向代理；help 查看方法，不带参数仍扫码。'},
  ]},
]);
export const HELP_NOTES = Object.freeze([
  '#piu help / #piu 帮助：查看本帮助图片。[] 表示可选参数，输入命令时去掉方括号。',
  'b50 / recent / data 不指定档案时使用默认档案；可用 list 序号、唯一名称、唯一 #四位标签或完整 名称#四位标签 指定本人档案。重复名称或标签须改用序号或完整标识。',
  '查询示例：#piu b50 5；#piu recent ZANTING；#piu data #9403；#piu b50 ZANTING#9403。#piu default 5 与 #piu list 5 均可设置默认档案。',
  'list 仅读取本地档案缓存；需要更新官网档案信息时，私聊 #piu refresh。follow / unfollow 仍须使用完整的 名称#四位标签。',
  '批量关注示例：#piu follow SHAWN#1477 YINYBEST#3231 CHIPHANT#5633。',
  '符合规则的完整档案标识均可关注；添加时仅读写本地列表，无需账号、排行榜快照或连接官网。排行榜成绩和名次仅来自已采集的前 1000 名，未上榜时该次数据不可用。',
  '所有档案名称仅限 1–12 位英文字母或数字，不含空格或符号；参数大小写不敏感，统一显示大写。',
  '日期示例：#piu rank 20261103 20261102。缺失的历史快照不能比较，也不会补造。',
  '机器人在线且排行榜专用会话有效时，每天 GMT+8 01:00 保存全球前 1000 名；按配置保活，失效后由主人重新登录。普通个人登录不会授权全局排行榜采集。',
  'login、list、default、refresh 仅限私聊；ranklogin 还要求主人权限。二维码是插件登录入口，非官网原生扫码授权；使用账号密码登录，会话加密保存，不保存密码，二维码请勿转发。',
  'Cookie 登录：#piu login sid=你的会话值，或粘贴完整 Cookie 请求头值 / PIU Cookie JSON。仅限私聊，验证后加密保存；只发送给可信机器人。',
  '排行榜 Cookie 授权示例：#piu ranklogin sid=你的会话值。验证完整前 1000 名后保存专用会话，不会修改个人绑定。',
  '群内 follow / unfollow / rank 使用本群共享列表；不同群互相独立，私聊保留个人列表。',
]);

const HELP_LAYOUT_WIDTH=1200;
export const HELP_IMAGE_WIDTH=scaledDimension(HELP_LAYOUT_WIDTH);
let pending;
/** Available before login/configuration. The guide contains no account data. */
export function renderHelp() {
  if(!pending)pending=drawHelp().catch(error=>{pending=undefined;throw error;});
  return pending;
}
async function drawHelp() {
  const width=HELP_LAYOUT_WIDTH,margin=48,inner=width-margin*2;
  const measuring=createCanvas(1,1).getContext('2d');
  const groups=HELP_GROUPS.map(group=>({...group,items:group.items.map(item=>({...item,
    lines:wrapLines(measuring,item.description,inner-48,23),
    height:66+wrapLines(measuring,item.description,inner-48,23).length*30+(item.aliases?26:0)}))}));
  const notes=HELP_NOTES.map(value=>wrapLines(measuring,value,inner-48,22));
  const groupHeight=groups.reduce((sum,group)=>sum+62+group.items.reduce((n,item)=>n+item.height+10,0)+20,0);
  const noteHeight=64+notes.reduce((sum,lines)=>sum+lines.length*31+14,0);
  const canvas=createCanvas(width,180+groupHeight+noteHeight+54),ctx=canvas.getContext('2d');
  ctx.fillStyle=C.background;ctx.fillRect(0,0,width,canvas.height);
  ctx.fillStyle=C.cyan;ctx.fillRect(margin,0,360,6);
  text(ctx,'PIU 命令帮助',margin,86,inner,48,C.cyan,900);
  text(ctx,'BEST50  /  RECENT  /  PLAY DATA  /  RANKING',margin,130,inner,22,C.muted,700);
  let y=174;
  for(const group of groups){
    text(ctx,group.title,margin,y+38,inner,32,C.text,700);y+=62;
    for(const item of group.items){
      panel(ctx,margin,y,inner,item.height);
      text(ctx,item.command,margin+24,y+39,inner-48,28,C.cyan,700);
      item.lines.forEach((line,index)=>text(ctx,line,margin+24,y+77+index*30,inner-48,23,C.text));
      if(item.aliases)text(ctx,`别名：${item.aliases}`,margin+24,y+item.height-14,inner-48,19,C.muted);
      y+=item.height+10;
    }
    y+=20;
  }
  text(ctx,'使用说明',margin,y+38,inner,30,C.text,700);y+=66;
  for(const lines of notes){
    for(const line of lines){text(ctx,line,margin+12,y+24,inner-24,22,C.muted);y+=31;}
    y+=14;
  }
  return encodeOutput(canvas);
}
