// 체크섬(adler32)이 틀리거나 빠진 Flate 스트림 — 흑백 변환이 그 쪽을 컬러로 남기지 않는가 (앱 파일 그대로)
//   실행: node scripts/test/inflate-tolerant.test.js   (npm run smoke가 함께 돌린다)
// 회귀(실파일 2개): pako.inflate가 이런 스트림에서 예외 없이 undefined를 줘, 워커 'stream-grayify'가
//   TypeError로 죽고 그 쪽 전체가 원래 색으로 저장됐다 — 화면(Acrobat·pdf-lib)은 멀쩡해 눈치채기 어렵다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const pako = require(path.join(ROOT, 'src/libs/pako.min.js'));

let pass = 0, fail = 0;
const ck = (name, ok, info) => { if (ok) { pass++; console.log('  ✔ ' + name); } else { fail++; console.log('  ✘ ' + name, info !== undefined ? JSON.stringify(info) : ''); } };
const B = s => Uint8Array.from(Buffer.from(s, 'latin1'));
const S = u8 => Buffer.from(u8).toString('latin1');

// 워커 — worker-gray.js 그대로, postMessage를 가로챈다
const posted = [];
const wself = { postMessage: (m) => posted.push(m) };
const wctx = vm.createContext({ importScripts() {}, self: wself, console, pako, TextDecoder, TextEncoder });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/worker-gray.js'), 'utf8'), wctx, { filename: 'worker-gray.js' });
// 메인 — app-process.js의 inflateLenient 그대로
const ap = fs.readFileSync(path.join(ROOT, 'src/app-process.js'), 'utf8');
const a = ap.indexOf('    function inflateLenient(');
const mctx = vm.createContext({ pako, console });
vm.runInContext(ap.slice(a, ap.indexOf('\n    }', a) + 6) + '\nthis.inflateLenient = inflateLenient;', mctx, { filename: 'app-process.js(inflateLenient)' });

const content = 'q 1 0 0 rg 10 10 100 100 re f 0 0 1 RG 5 w 0 0 m 50 50 l S Q\n'.repeat(40);
const good = pako.deflate(B(content));
const badSum = good.slice(); badSum[badSum.length - 1] ^= 0xff;          // 체크섬 1바이트 틀림
const noSum = good.slice(0, good.length - 4);                            // 체크섬 없음

ck('전제: pako.inflate는 체크섬이 틀리면 결과를 주지 않음(예외 또는 undefined — 실파일은 undefined였다)', (() => { try { return pako.inflate(badSum) === undefined; } catch (e) { return true; } })());
for (const [name, data] of [['체크섬 틀림', badSum], ['체크섬 없음', noSum]]) {
  const w = wctx.inflateRawTolerant(data);
  ck(`워커 inflateRawTolerant — ${name} → 원문 그대로`, !!w && S(w) === content, w && w.length);
  const wl = wctx.inflateLenientW(data, null);
  ck(`워커 inflateLenientW — ${name} → 원문 그대로`, !!wl && S(wl) === content);
  const ml = mctx.inflateLenient(data, null);
  ck(`앱 inflateLenient — ${name} → 원문 그대로`, !!ml && S(ml.subarray(0, content.length)) === content);
}
ck('zlib 머리가 아니면 raw로 억지로 풀지 않음', wctx.inflateRawTolerant(B('not zlib at all')) === null);

// 워커 메시지 처리 전체 — 체크섬 틀린 콘텐츠 스트림도 회색 연산자로 바뀌어 돌아와야 한다
(async () => {
  const run = async (bytes) => {
    posted.length = 0;
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    await wself.onmessage({ data: { id: 1, type: 'stream-grayify', payload: { bytes: buf, wasCompressed: true, csGrayMap: {}, dotGain: 0 } } });
    return posted[0];
  };
  const r = await run(badSum);
  const out = r && r.result ? S(pako.inflate(new Uint8Array(r.result.bytes, 0, r.result.length))) : '';
  ck('stream-grayify: 체크섬 틀린 스트림도 변환됨(오류 아님)', !!(r && r.result), r && r.error);
  ck('stream-grayify: 결과에 rg·RG가 남지 않고 g·G로', !!out && !/\b(rg|RG)\b/.test(out) && /\bg\b/.test(out) && /\bG\b/.test(out), out.slice(0, 80));
  const empty = await run(pako.deflate(new Uint8Array(0)));
  ck('stream-grayify: 빈 스트림은 정상(오류 아님)', !!(empty && empty.result), empty && empty.error);
  const junk = await run(B('\x78\x9c garbage garbage'));
  ck('stream-grayify: 정말 깨진 스트림은 inflate_fail로 알림(원본 유지 경로)', !!(junk && junk.error === 'inflate_fail'), junk);

  console.log(`\n  ${pass} 통과 · ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})();
