import {panel,text,UI_COLORS as C} from './ui.js';
import {normalizeProfileMeta} from './profile-meta.js';
import {formatShanghaiTime} from './time-format.js';

/** All values are already present in the selected official page's header. */
export function drawProfileMeta(ctx,profile,{x,y,width,height=104}) {
  const meta=normalizeProfileMeta(profile);
  panel(ctx,x,y,width,height);
  const gap=24,padding=24,inner=width-padding*2-gap*2;
  const widths=[inner*0.28,inner*0.35,inner*0.37];
  const values=[['CURRENT TITLE',meta.equippedTitle??'—'],
    ['LAST PLAYED',formatShanghaiTime(meta.lastAccessAt)],['ARCADE',meta.lastArcade??'—']];
  let left=x+padding;
  const large=width>2200;
  for(let index=0;index<values.length;index++) {
    const [label,value]=values[index];
    text(ctx,label,left,y+29,widths[index],large?21:18,C.muted,700);
    text(ctx,value,left,y+77,widths[index],large?32:25,index===0?C.cyan:C.text,700);
    left+=widths[index]+gap;
  }
}
