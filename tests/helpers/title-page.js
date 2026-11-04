// Thresholds and markup transcribed from the official Phoenix 2 Title page.
const single = [5000,6000,7000,8000,9000,10000,11000,12000,13000,14000,
  15000,15250,15500,15750,16000,16250,16500,16750,17000,17250,
  17500,17700,17900,18100,18300,18500,18600,18700,18800,18900,19000];
const double = [5000,6000,7000,8000,9000,10000,11000,12000,13000,14000,
  15000,15300,15600,15900,16200,16500,16800,17100,17400,17700,
  18000,18200,18400,18600,18800,19000,19100,19200,19300,19400,19500];
const format = value => value.toLocaleString('en-US',{maximumFractionDigits:2});
export function titlePage(name='ALPHA#1001',scores={single:14730,double:17640}) {
  const rows = [['single',single],['double',double]].flatMap(([mode,thresholds])=>thresholds.map((threshold,index)=>{
    const tier=['INTERMEDIATE','ADVANCED','EXPERT'][Math.floor(index/10)];
    const title=index===30?`${mode.toUpperCase()} MASTER`:`[${mode==='single'?'S':'D'}] ${tier} LV.${index%10+1}`;
    const owned=scores[mode]>=threshold;
    return `<li class="${owned?'have':'not'}" data-name="${title}"><div class="txt_w"><p class="t1"><i class="txt">${title}</i></p></div>
      <div class="txt_w2"><p class="t3"><i class="txt">${mode==='single'?'Single':'Double'} Pumbility of ${threshold} +</i></p>
      ${owned?'':`<p class="t3 require-count"><i class="txt">[ ${format(scores[mode])} / ${format(threshold)} ]</i></p>`}</div></li>`;
  })).join('');
  return `<div class="subProfile_wrap"><div class="name_w"><p class="t2">${name}</p></div></div>
    <div class="data_title_wrap"><ul class="data_titleList2">${rows}</ul></div>`;
}
