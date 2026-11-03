import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {fetchOfficialJacket} from '../src/client.js';

const source = 'https://www.piugame.com/data/song_img2/example.png';
function pageFor(fetcher) {
  return {evaluate: (fn, source) => vm.runInNewContext(`(${fn.toString()})(source)`,
    {source, fetch:fetcher, location:{origin:'https://www.piugame.com'}, URL, AbortSignal,
      btoa:value=>Buffer.from(value,'binary').toString('base64')})};
}
test('jackets use verified browser fetch with same-origin credentials and no redirects', async () => {
  const bytes = Uint8Array.from([137,80,78,71,13,10,26,10]);
  const page=pageFor(async (url,options)=>{
    assert.equal(url,source);
    assert.equal(options.redirect,'error');
    assert.equal(options.credentials,'same-origin');
    return new Response(bytes,{headers:{'content-type':'image/png'}});
  });
  assert.deepEqual(await fetchOfficialJacket(page,source),Buffer.from(bytes));
});
test('jackets reject foreign origins and credential-bearing URLs without accessing browser', async () => {
  const page={evaluate(){throw new Error('must not run');}};
  assert.equal(await fetchOfficialJacket(page,'https://evil.test/a.png'),null);
  assert.equal(await fetchOfficialJacket(page,'https://u:p@www.piugame.com/a.png'),null);
});
test('jackets reject non-image responses and oversized streamed bodies', async () => {
  const html=pageFor(async ()=>new Response('<html>login</html>',{headers:{'content-type':'text/html'}}));
  assert.equal(await fetchOfficialJacket(html,source),null);
  let cancelled=false;
  const large=pageFor(async ()=>new Response(new ReadableStream({
    pull(controller){controller.enqueue(new Uint8Array(2000001));},
    cancel(){cancelled=true;}
  }),{headers:{'content-type':'image/png'}}));
  assert.equal(await fetchOfficialJacket(large,source),null);
  assert.equal(cancelled,true);
});
