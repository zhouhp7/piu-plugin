import test from 'node:test';
import assert from 'node:assert/strict';
import {PiuError} from '../src/errors.js';
import {normalizeProfileInput,resolveProfileSelector} from '../src/profile-selector.js';

const rows = [
  {playerName:'ALPHA#1001',accountId:'account-a',profileId:'profile-a',index:99},
  {gameId:'BETA',tag:'#2002',accountId:'account-b',profileId:'profile-b',index:1},
  {playerName:'GAMER3#3003',accountId:'account-b',profileId:'profile-c',index:2},
];
const expectCode = code => error => {
  assert.ok(error instanceof PiuError);
  assert.equal(error.code,code);
  assert.match(error.message,/#piu list/);
  return true;
};

test('normalization accepts optional empty input, normalizes whitespace and NFC and bounds its result',()=>{
  assert.equal(normalizeProfileInput(undefined),'');
  assert.equal(normalizeProfileInput(' \t\r\n '),'');
  assert.equal(normalizeProfileInput('  NAME\tWITH\nSPACE   # 3003  '),'NAME WITH SPACE # 3003');
  assert.equal(normalizeProfileInput(' Cafe\u0301 '),'Café');
  assert.equal(normalizeProfileInput('a'.repeat(160)).length,160);
  for(const value of [null,0,1,true,[],{},'a'.repeat(161),'A\0B','A\u007fB']) {
    assert.throws(()=>normalizeProfileInput(value),expectCode('GAME_ID_FORMAT'));
  }
});

test('ordinals select by actual array order rather than profile metadata and preserve row identity',()=>{
  for(const [index,row] of rows.entries()) assert.strictEqual(resolveProfileSelector(rows,String(index+1)),row);
  assert.strictEqual(resolveProfileSelector([...rows].reverse(),'1'),rows[2]);
  assert.throws(()=>resolveProfileSelector(rows,'4'),expectCode('GAME_ID_NOT_FOUND'));
  assert.throws(()=>resolveProfileSelector(rows,'999999999999999999999999999999999'),expectCode('GAME_ID_NOT_FOUND'));
  for(const value of ['0','00','01','+1','-1','1.0','1.5','.5']) {
    assert.throws(()=>resolveProfileSelector(rows,value),expectCode('GAME_ID_FORMAT'));
  }
});

test('full IDs canonicalize case and reject duplicate canonical identities even on an exact spelling',()=>{
  const lower={playerName:'Alice#1234',accountId:'one'},upper={playerName:'ALICE#1234',accountId:'two'};
  for(const value of ['Alice # 1234','ALICE#1234','aLiCe#1234']) {
    assert.throws(()=>resolveProfileSelector([lower,upper],value),expectCode('GAME_ID_AMBIGUOUS'));
  }
  assert.strictEqual(resolveProfileSelector([lower],'alice#1234'),lower);
  assert.throws(()=>resolveProfileSelector([lower,{...lower,accountId:'three'}],'Alice#1234'),expectCode('GAME_ID_AMBIGUOUS'));
});

test('pure names match the entire normalized name and reject all case-insensitive duplicates',()=>{
  assert.strictEqual(resolveProfileSelector(rows,'beta'),rows[1]);
  assert.strictEqual(resolveProfileSelector(rows,' gamer3 '),rows[2]);
  assert.throws(()=>resolveProfileSelector(rows,'NAME'),expectCode('GAME_ID_NOT_FOUND'));
  const duplicates=[{playerName:'Alice#1001'},{playerName:'ALICE#2002'}];
  for(const value of ['Alice','ALICE','alice']) {
    assert.throws(()=>resolveProfileSelector(duplicates,value),expectCode('GAME_ID_AMBIGUOUS'));
  }
  for(const value of ['NAME WITH SPACE','Cafe\u0301','名字','ALPHA_BETA','ALPHA-BETA','A'.repeat(13),'NAME WITH SPACE#1234','A'.repeat(13)+'#1234']) {
    assert.throws(()=>resolveProfileSelector(rows,value),expectCode('GAME_ID_FORMAT'));
  }
  const limit={playerName:'A1B2C3D4E5F6#0101'};
  assert.strictEqual(resolveProfileSelector([limit],'a1b2c3d4e5f6'),limit);
});

test('tag-only selection requires uniqueness across accounts',()=>{
  assert.strictEqual(resolveProfileSelector(rows,'#2002'),rows[1]);
  assert.strictEqual(resolveProfileSelector(rows,' # 3003 '),rows[2]);
  const repeated=[...rows,{playerName:'OTHER#2002',accountId:'account-c'}];
  assert.throws(()=>resolveProfileSelector(repeated,'#2002'),expectCode('GAME_ID_AMBIGUOUS'));
  assert.throws(()=>resolveProfileSelector(rows,'#9999'),expectCode('GAME_ID_NOT_FOUND'));
});

test('numeric names use ordinals unless supplied with a full ID',()=>{
  const numeric={playerName:'2#4444'},first={playerName:'FIRST#1111'};
  assert.strictEqual(resolveProfileSelector([numeric,first],'2'),first);
  assert.strictEqual(resolveProfileSelector([numeric,first],'2#4444'),numeric);
  assert.strictEqual(resolveProfileSelector([{playerName:'0#0000'}],'0#0000').playerName,'0#0000');
  const alphanumeric={playerName:'1E0#0101'};
  assert.strictEqual(resolveProfileSelector([alphanumeric],'1e0'),alphanumeric);
});

test('blank, malformed and unknown selections fail with static guidance and never echo input',()=>{
  for(const value of [undefined,'',' \t ','#123','#12345','NAME#123','NAME#12345','NAME##1234']) {
    assert.throws(()=>resolveProfileSelector(rows,value),expectCode('GAME_ID_FORMAT'));
  }
  for(const value of ['UNKNOWN','UNKNOWN#1234']) {
    assert.throws(()=>resolveProfileSelector(rows,value),error=>{
      expectCode('GAME_ID_NOT_FOUND')(error);
      assert.match(error.message,/#piu refresh/);
      assert.ok(!error.message.includes(value));
      return true;
    });
  }
  assert.throws(()=>resolveProfileSelector(rows,'sid=secret-never-echo'),error=>{
    expectCode('GAME_ID_FORMAT')(error);assert.ok(!error.message.includes('secret-never-echo'));return true;
  });
  assert.throws(()=>resolveProfileSelector([], '1'),expectCode('GAME_ID_NOT_FOUND'));
  assert.throws(()=>resolveProfileSelector([{playerName:'broken'}], 'broken'),expectCode('GAME_ID_NOT_FOUND'));
  const original=structuredClone(rows);
  assert.strictEqual(resolveProfileSelector(rows,'BETA#2002'),rows[1]);
  assert.deepEqual(rows,original);
});
