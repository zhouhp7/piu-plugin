import {load} from 'cheerio';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import {normalizeGameIdSelector} from './parser.js';
import {GRADE_CODES,PLATE_CODES,loadBadgeAssets} from './assets.js';
import {PiuError} from './errors.js';
import {formatShanghaiTime} from './time-format.js';
import {UI_COLORS as C,panel,text} from './ui.js';

const clean=value=>String(value??'').replace(/\s+/g,' ').trim();
const changed=message=>new PiuError('PAGE_CHANGED',message);
const integer=value=>/^\d[\d,]*$/.test(clean(value))?Number(clean(value).replaceAll(',','')):null;

/** Preserve the official counts and denominators; rows are never summed. */
export function parsePlayData(html) {
  const $=load(html),profile=$('.subProfile_wrap').first();
  if($('form#login_fs,input[name="mb_password"]').length&&!profile.length)throw new PiuError('AUTH_REQUIRED','登录已失效，请私聊发送 #piu 登录。');
  if(!profile.length||!$('.play_data_wrap').length)throw changed('未识别到 Play Data 页面，请检查登录状态或更新页面解析器。');
  const playerName=normalizeGameIdSelector(profile.find('.name_w .t2,.profile_name .t2').first().text());
  const playCount=integer($('.playData_tw .total .t2').first().text());
  if(!playerName||!Number.isSafeInteger(playCount))throw changed('Play Data 的档案或游玩次数不完整。');
  const sections={grades:[],plates:[]};
  $('.play_data_wrap .plate_w').each((_,element)=>{
    const root=$(element),kind=root.hasClass('grade')?'grades':'plates';
    root.find('.list > li .list_in').each((_,entry)=>{
      const row=$(entry),src=row.find('.img img').first().attr('src')??'';
      const folder=kind==='grades'?'grade':'plate';
      const match=new RegExp(`/${folder}/${kind==='plates'?'(?:s_)?':''}([^/.?#]+)\\.(?:png|webp)(?:[?#]|$)`,'i').exec(src);
      const code=match?.[1].toUpperCase().replace(/_(?:P|PLUS)$/,'+');
      const values=/^(\d[\d,]*)\s*\/\s*(\d[\d,]*)$/.exec(clean(row.find('.t_num').first().text()));
      const count=values?integer(values[1]):null,total=values?integer(values[2]):null;
      const allowed=kind==='grades'?GRADE_CODES:PLATE_CODES;
      if(!allowed.includes(code)||!Number.isSafeInteger(count)||!Number.isSafeInteger(total)||count>total||
          sections[kind].some(item=>item.code===code))throw changed('Play Data 的 Grade / Plate 统计不完整，已停止生成。');
      sections[kind].push({code,count,total});
    });
  });
  if(sections.grades.length!==16||sections.plates.length!==8)throw changed('未完整读取 Play Data 的 16 种 Grade 和 8 种 Plate。');
  const totals=new Set([...sections.grades,...sections.plates].map(item=>item.total));
  if(totals.size!==1)throw changed('Play Data 的统计范围不一致，已停止生成。');
  const select=$('.playData_tw select').first();
  const selected=select.find('option[selected]').first().length?select.find('option[selected]').first():select.find('option').first();
  return {kind:'data',playerName,playCount,playCountNote:clean($('.playData_tw .total .tt').first().text()),
    filterLabel:clean(selected.text())||'All',filterValue:selected.attr('value')??'',totalCharts:[...totals][0],
    ...sections,pumbility:null,ranking:null,updatedAt:new Date().toISOString(),source:'piugame.com/my_page/play_data.php'};
}

export const DATA_IMAGE_WIDTH=1800;
export async function renderPlayData(profile) {
  if(!profile||!Array.isArray(profile.grades)||!Array.isArray(profile.plates)||
    !Number.isSafeInteger(profile.playCount)||profile.playCount<0||!Number.isSafeInteger(profile.totalCharts)||profile.totalCharts<0)throw new TypeError('Invalid Play Data');
  for(const item of [...profile.grades,...profile.plates])if(!Number.isSafeInteger(item.count)||!Number.isSafeInteger(item.total)||item.count<0||item.count>item.total)throw new TypeError('Invalid Play Data count');
  const margin=64,gap=18,cellWidth=(DATA_IMAGE_WIDTH-margin*2-gap*3)/4,cellHeight=128;
  const gradeTop=480,gradeRows=Math.ceil(profile.grades.length/4);
  const plateTitle=gradeTop+gradeRows*(cellHeight+gap)+46,plateTop=plateTitle+42;
  const footerTop=plateTop+Math.ceil(profile.plates.length/4)*(cellHeight+gap)+24;
  const canvas=createCanvas(DATA_IMAGE_WIDTH,footerTop+112),ctx=canvas.getContext('2d');
  ctx.fillStyle=C.background;ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle=C.cyan;ctx.fillRect(margin,0,440,6);
  text(ctx,'PIU  /  PLAY DATA',margin,80,1300,56,C.cyan,900);
  text(ctx,profile.playerName,margin,171,profile.ranking?1180:1600,80,C.text,900);
  if(profile.ranking)text(ctx,`WORLD #${profile.ranking}`,DATA_IMAGE_WIDTH-margin,165,430,48,C.purple,700,'right');
  const stats=[['PLAY COUNT',profile.playCount.toLocaleString('en-US')],
    ['统计谱面',profile.totalCharts.toLocaleString('en-US')],['TOTAL PUMBILITY',profile.pumbility==null?'—':profile.pumbility.toLocaleString('en-US',{maximumFractionDigits:3})]];
  const statWidth=(DATA_IMAGE_WIDTH-margin*2-gap*2)/3;
  stats.forEach(([label,value],index)=>{
    const x=margin+index*(statWidth+gap);panel(ctx,x,224,statWidth,154);
    text(ctx,label,x+24,261,statWidth-48,22,C.muted,700);
    text(ctx,value,x+22,344,statWidth-44,76,index===2?C.purple:C.cyan,900);
  });
  const badges=await loadBadgeAssets(),decoded=new Map();
  for(const kind of ['grades','plates'])for(const item of profile[kind]) {
    const bytes=badges[kind].get(item.code);
    if(bytes)decoded.set(`${kind}:${item.code}`,await loadImage(bytes));
  }
  text(ctx,`GRADE  ·  ${profile.filterLabel}`,margin,438,1500,34,C.text,700);
  text(ctx,`PLATE  ·  ${profile.filterLabel}`,margin,plateTitle,1500,34,C.text,700);
  for(const [kind,top] of [['grades',gradeTop],['plates',plateTop]])profile[kind].forEach((item,index)=>{
    const x=margin+(index%4)*(cellWidth+gap),y=top+Math.floor(index/4)*(cellHeight+gap);
    panel(ctx,x,y,cellWidth,cellHeight);
    const image=decoded.get(`${kind}:${item.code}`),boxWidth=120,boxHeight=64;
    if(image){const scale=Math.min(boxWidth/image.width,boxHeight/image.height);
      ctx.drawImage(image,x+20+(boxWidth-image.width*scale)/2,y+10+(boxHeight-image.height*scale)/2,image.width*scale,image.height*scale);
    }else text(ctx,item.code,x+24,y+57,boxWidth,42,C.text,700);
    const percent=item.total?item.count/item.total*100:0;
    text(ctx,`${percent.toFixed(2)}%`,x+cellWidth-22,y+51,cellWidth-166,29,C.cyan,700,'right');
    text(ctx,`${item.count.toLocaleString('en-US')} / ${item.total.toLocaleString('en-US')}`,x+24,y+98,cellWidth-48,28,C.text,700);
    ctx.fillStyle='#2b3c53';ctx.fillRect(x+24,y+112,cellWidth-48,4);
    ctx.fillStyle=kind==='grades'?C.cyan:C.purple;ctx.fillRect(x+24,y+112,(cellWidth-48)*percent/100,4);
  });
  text(ctx,/Freeplay/i.test(profile.playCountNote??'')?'Play Count 不包含 Freeplay；各项数量按官网原值显示。':profile.playCountNote||'各项数量按官网原值显示。',margin,footerTop+22,1672,21,C.muted);
  text(ctx,'SOURCE  /  piugame.com/my_page/play_data.php',margin,footerTop+58,1672,19,C.muted);
  text(ctx,`UPDATE TIME  /  ${formatShanghaiTime(profile.updatedAt)}`,margin,footerTop+88,1672,19,C.muted);
  return canvas.encode('png');
}
