import test from 'node:test';
import assert from 'node:assert/strict';
import {loadImage} from '@napi-rs/canvas';
import {parseTitleProgress,normalizeTitleProgress} from '../src/title-progress.js';
import {normalizeProfile} from '../src/model.js';
import {renderBest50,renderRecent,IMAGE_HEIGHT,RECENT_IMAGE_HEIGHT} from '../src/render.js';
import {titlePage} from './helpers/title-page.js';

test('Single and Double use live mode-specific thresholds and progress within their current level',()=>{
  const data=parseTitleProgress(titlePage());
  assert.equal(data.playerName,'ALPHA#1001');
  assert.equal(data.single.title,'INTERMEDIATE Lv.10');
  assert.equal(data.single.score,14730);assert.equal(data.single.minimum,14000);
  assert.equal(data.single.nextTitle,'ADVANCED Lv.1');assert.equal(data.single.percent,73);
  assert.equal(data.double.title,'ADVANCED Lv.9');
  assert.equal(data.double.minimum,17400);assert.equal(data.double.nextThreshold,17700);
  assert.equal(data.double.percent,80);
});

test('zero, promotion boundaries, the first title, Expert and MASTER are represented honestly',()=>{
  const zero=parseTitleProgress(titlePage('ZERO#1001',{single:0,double:5000}));
  assert.equal(zero.single.title,'BEGINNER');assert.equal(zero.single.percent,0);
  assert.equal(zero.single.score,0);assert.equal(zero.single.nextThreshold,5000);
  assert.equal(zero.double.title,'INTERMEDIATE Lv.1');assert.equal(zero.double.percent,0);
  const promoted=parseTitleProgress(titlePage('A#1001',{single:17500,double:18000}));
  assert.equal(promoted.single.title,'EXPERT Lv.1');assert.equal(promoted.single.percent,0);
  assert.equal(promoted.double.title,'EXPERT Lv.1');assert.equal(promoted.double.percent,0);
  const master=parseTitleProgress(titlePage('MAX#1001',{single:22000,double:23000}));
  for(const mode of ['single','double']) {
    assert.equal(master[mode].title,'MASTER');assert.equal(master[mode].percent,100);
    assert.equal(master[mode].score,null,'the page hides the exact score for fully unlocked titles');
    assert.equal(master[mode].nextThreshold,null);
  }
  assert.equal(master.single.minimum,19000);assert.equal(master.double.minimum,19500);
});

test('thresholds come from the live page and unrelated legacy and equipped titles do not change the result',()=>{
  // Change just one threshold without disturbing its strict ascending order.
  const changed=titlePage().replace('Single Pumbility of 15000 +','Single Pumbility of 15100 +').replace('[ 14,730 / 15,000 ]','[ 14,730 / 15,100 ]');
  assert.ok(Math.abs(parseTitleProgress(changed).single.percent-730/1100*100)<1e-9);
  const unrelated='<li data-name="[LEGACY] INTERMEDIATE LV.10"><i>unknown score</i></li>';
  assert.equal(parseTitleProgress(titlePage().replace('</ul>',unrelated+'</ul>')).single.percent,73);
});

test('expired login, incomplete tables, duplicate rows and inconsistent or malformed counters fail closed',()=>{
  assert.throws(()=>parseTitleProgress('<form id="login_fs"><input name="mb_password"></form>'),{code:'AUTH_REQUIRED'});
  assert.throws(()=>parseTitleProgress('<h1>maintenance</h1>'),{code:'PAGE_CHANGED'});
  for(const html of [titlePage().replace('data-name="SINGLE MASTER"','data-name="missing"'),
    titlePage().replace('data-name="[S] EXPERT LV.10"','data-name="[S] EXPERT LV.9"'),
    titlePage().replace('[ 14,730 / 15,000 ]','[ 14,731 / 15,000 ]'),
    titlePage().replace('[ 14,730 / 15,000 ]','[ 14,730 / 99,000 ]'),
    titlePage().replace('Single Pumbility of 15000 +','Single Pumbility of unknown +')]) {
    assert.throws(()=>parseTitleProgress(html),{code:'PAGE_CHANGED'});
  }
});

test('scaled B50 JPEG renders both progress bars while recent excludes their extra height',async()=>{
  const titleProgress=parseTitleProgress(titlePage());
  const profile={playerName:'ALPHA#1001',titleProgress,records:[]};
  assert.equal(normalizeProfile(profile).titleProgress.single.percent,73);
  assert.equal(normalizeTitleProgress({single:{...titleProgress.single,score:Infinity}}).single,null);
  const b50=await renderBest50(profile),recent=await renderRecent(profile);
  assert.equal(b50.readUInt16BE(0),0xffd8);assert.equal(recent.readUInt16BE(0),0xffd8);
  const b50Image=await loadImage(b50),recentImage=await loadImage(recent);
  assert.equal(b50Image.height,IMAGE_HEIGHT);
  assert.equal(recentImage.height,RECENT_IMAGE_HEIGHT);
  assert.equal(b50Image.height,2308);assert.equal(recentImage.height,2193);
});
