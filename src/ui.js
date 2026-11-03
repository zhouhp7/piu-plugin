export const UI_FONT = 'Arial, "Noto Sans CJK SC", "Noto Sans", "Microsoft YaHei", "PingFang SC", sans-serif';
export const UI_COLORS = Object.freeze({background:'#0c1323',panel:'#18263b',border:'#34475e',
  text:'#f3f7ff',muted:'#a7b7cc',cyan:'#60f0ed',purple:'#b39aff'});

export function panel(ctx,x,y,width,height,fill = UI_COLORS.panel,radius = 16) {
  ctx.beginPath();ctx.roundRect(x,y,width,height,radius);
  ctx.fillStyle=fill;ctx.fill();ctx.strokeStyle=UI_COLORS.border;ctx.lineWidth=1;ctx.stroke();
}

export function text(ctx,value,x,y,width,size = 24,color = UI_COLORS.text,weight = 400,align = 'left') {
  ctx.save();ctx.textAlign=align;ctx.textBaseline='alphabetic';
  ctx.font=`${weight} ${size}px ${UI_FONT}`;
  while(ctx.measureText(String(value)).width>width&&size>14)ctx.font=`${weight} ${--size}px ${UI_FONT}`;
  ctx.fillStyle=color;ctx.fillText(String(value),x,y,width);ctx.restore();
}

export function wrapLines(ctx,value,width,size = 22,weight = 400) {
  ctx.save();ctx.font=`${weight} ${size}px ${UI_FONT}`;
  const lines=[];
  for(const paragraph of String(value).split('\n')) {
    let line='';
    const tokens=paragraph.match(/[A-Za-z0-9_#@.+:/-]+|\s+|[^\s]/gu)??[];
    for(const token of tokens) {
      const parts=ctx.measureText(token).width>width?[...token]:[token];
      for(const part of parts){
        if(line&&ctx.measureText(line+part).width>width){lines.push(line.trimEnd());line='';}
        line+=line?part:part.trimStart();
      }
    }
    lines.push(line);
  }
  ctx.restore();return lines;
}
