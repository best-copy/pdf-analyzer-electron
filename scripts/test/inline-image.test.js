// 흑백변환 워커 — 인라인 이미지(BI … ID … EI) 경계·변환 단위 검증 (앱 워커 파일을 그대로 올려 쓴다: 복사본 드리프트 방지)
//   실행: node scripts/test/inline-image.test.js   (npm run smoke가 함께 돌린다)
// 회귀: CR 줄바꿈 PDF에서 'BI'가 'I'로 깨져 Acrobat "이 페이지에 오류", 인라인 RGB 그림이 흑백으로 안 바뀜.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const ctx = vm.createContext({ importScripts() {}, self: {}, console, pako: require(path.join(ROOT, 'src/libs/pako.min.js')) });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/worker-gray.js'), 'utf8'), ctx, { filename: 'worker-gray.js' });
const { scanInlineImage, findInlineBI, preprocessInlineImages, grayifyStream, buildDotGainLUT } = ctx;

let pass = 0, fail = 0;
const ck = (name, ok, info) => { if (ok) { pass++; console.log('  ✔ ' + name); } else { fail++; console.log('  ✘ ' + name, info !== undefined ? JSON.stringify(info) : ''); } };
const B = str => Uint8Array.from(Buffer.from(str, 'latin1'));
const S = u8 => Buffer.from(u8).toString('latin1');
const count = (t, tok) => (t.match(new RegExp('(^|[\\s])' + tok + '(?=[\\s])', 'g')) || []).length;
const codes = s => [...s].map(c => c.charCodeAt(0));
// 2×1 RGB 픽셀 (빨강, 흰색) — 회색 76, 255
const RGB2 = '\xff\x00\x00\xff\xff\xff';
const stream = (nl, sep) => `q${nl}1 0 0 rg${nl}1.5 0 0 4 10 20 cm${nl}BI${nl}/W 2${sep}/H 1${sep}/CS /RGB${sep}/BPC 8${nl}ID ${RGB2}${nl}EI${nl}Q${nl}0 0 1 RG${nl}`;
const grayOf = out => { const m = out.match(/BI\n([\s\S]*?)\nID\n([\s\S]*?)\nEI/); return m && { dict: m[1], px: codes(m[2]) }; };

console.log('\n[1] 경계 찾기 — 구분자가 무엇이든');
for (const [name, nl, sep] of [['LF', '\n', '\n'], ['CR (문제 파일)', '\r', '\r'], ['CRLF', '\r\n', '\r\n'], ['한 줄(스페이스)', ' ', ' ']]) {
  const raw = B(stream(nl, sep));
  const bi = findInlineBI(raw, 0);
  const img = bi >= 0 ? scanInlineImage(raw, bi) : null;
  ck(`${name}: BI를 찾고 데이터 6바이트·EI 뒤까지`, img && img.ok && img.exact && img.w === 2 && img.h === 1 && img.isRGB && img.dataEnd - img.dataStart === 6 && S(raw.slice(img.end - 2, img.end)) === 'EI', img);
}
{
  ck('앞이 공백이 아닌 "xBI /"는 BI가 아님', findInlineBI(B('BT (xBI /W) Tj ET\n'), 0) < 0);
  ck('BI 뒤에 사전 키(/)가 없으면 BI가 아님', findInlineBI(B('q BI Q\n'), 0) < 0);
  const tricky = 'BI\n/W 4\n/H 1\n/CS /G\n/BPC 8\nID \nEI\nEI\nQ\n';   // 데이터 4바이트 = "\nEI\n"
  const t = B(tricky), im = scanInlineImage(t, 0);
  ck('데이터 안의 "\\nEI\\n"에 속지 않음(길이로 자름)', im.ok && im.dataEnd - im.dataStart === 4 && im.end === tricky.lastIndexOf('EI') + 2, im);
  const crlfId = B('BI\r\n/W 2\r\n/H 1\r\n/CS /G\r\n/BPC 8\r\nID\r\n\x10\x30\r\nEI\r\n');
  const ic = scanInlineImage(crlfId, 0);
  ck('ID 뒤 CRLF(마지막 바이트가 공백 아님) — 데이터가 \\n 다음부터, 애매하지 않음', ic.ok && S(crlfId.slice(ic.dataStart, ic.dataEnd)) === '\x10\x30' && !ic.ambiguous, ic);
  const amb = B('BI\r\n/W 2\r\n/H 1\r\n/CS /G\r\n/BPC 8\r\nID\r\n\x10\x00\r\nEI\r\n');   // 마지막 바이트 0x00(검정)
  const ia = scanInlineImage(amb, 0);
  ck('ID 뒤 CRLF + 마지막 바이트 0x00 — 두 해석이 모두 성립 → ambiguous', ia.ok && ia.ambiguous === true, ia);
  const hex = B('BI /W 2 /H 1 /CS /RGB /BPC 8 /F /AHx ID ff0000ffffff> EI Q\n');
  const ih = scanInlineImage(hex, 0);
  ck('압축(필터) 그림은 공백+EI로 경계', ih.ok && ih.hasFilter && !ih.exact && S(hex.slice(ih.dataStart, ih.dataEnd)) === 'ff0000ffffff>', ih);
  const e1 = scanInlineImage(B('BI /W 2 EI ID x EI\n'), 0);
  ck('ID보다 EI가 먼저면 실패 + 그 EI 뒤부터 다시 찾게', !e1.ok && e1.next === 'BI /W 2 EI'.length, e1);
  ck('끝까지 ID가 없으면 실패 + 스트림 끝까지 건너뛰게', (r => !r.ok && r.next === 9)(scanInlineImage(B('BI /W 2 x'), 0)));
  const mask = B('BI /IM true /W 10 /H 2 ID \xff\x80\xff\x80 EI\n');   // 10비트 → 행당 2바이트
  const imk = scanInlineImage(mask, 0);
  ck('ImageMask 1비트 행 패딩(10×2 → 4바이트)', imk.ok && imk.imageMask && imk.exact && imk.dataEnd - imk.dataStart === 4, imk);
}

console.log('\n[2] 바이트 단계 — RGB/CMYK 인라인 그림을 회색으로');
for (const [name, nl] of [['LF', '\n'], ['CR (문제 파일)', '\r'], ['CRLF', '\r\n']]) {
  const out = S(preprocessInlineImages(B(stream(nl, nl)), 0));
  const g = grayOf(out);
  ck(`${name}: /CS /G로 바뀌고 픽셀이 회색 [76,255]`, g && /\/CS \/G/.test(g.dict) && !/RGB/.test(g.dict) && g.px.join() === '76,255', g);
  ck(`${name}: BI·EI 짝 유지, 앞뒤 명령 그대로`, count(out, 'BI') === 1 && count(out, 'EI') === 1 && out.includes('1 0 0 rg') && out.includes('0 0 1 RG'));
}
{
  const cmyk = S(preprocessInlineImages(B('BI\r/W 1\r/H 1\r/CS /CMYK\r/BPC 8\rID \x00\x00\x00\xff\rEI\rBI\r/W 1\r/H 1\r/CS /DeviceCMYK\r/BPC 8\rID \x00\x00\x00\x00\rEI\r'), 0));
  const px = [...cmyk.matchAll(/\nID\n([\s\S])\nEI/g)].map(m => m[1].charCodeAt(0));
  ck('CMYK: K100 → 0(검정), 전부 0 → 255(흰색)', px.join() === '0,255', px);
  const dg = S(preprocessInlineImages(B('BI\n/W 1\n/H 1\n/CS /RGB\n/BPC 8\nID \x80\x80\x80\nEI\n'), 20));
  const lut = buildDotGainLUT(20);
  ck('Dot Gain LUT 적용(128 → LUT[128])', grayOf(dg).px[0] === lut[128] && lut[128] !== 128, [grayOf(dg).px[0], lut[128]]);
  // 한 스트림에 그림 셋 + 사이사이 가짜 BI — 변환 안 되는 부분은 바이트가 정확히 그대로
  const src = 'q\rBI\rQ\r' + 'BI\r/W 2\r/H 1\r/CS /RGB\r/BPC 8\rID ' + RGB2 + '\rEI\r' + '(fake BI /x) Tj\r'
            + 'BI /W 2 /H 1 /CS /RGB /BPC 8 /F /AHx ID ff0000ffffff> EI\r' + 'BI\r/W 1\r/H 1\r/CS /RGB\r/BPC 8\rID \x00\xff\x00\rEI\rQ\r';
  const out = S(preprocessInlineImages(B(src), 0));
  ck('그림 3개 중 비압축 2개만 변환, BI·EI 각 3개', count(out, 'EI') === 3 && (out.match(/\/CS \/G/g) || []).length === 2 && out.includes('/F /AHx ID ff0000ffffff> EI'), out.replace(/[^\x20-\x7e\r\n]/g, '.'));
  ck('변환하지 않은 부분(가짜 BI·글자·압축 그림)은 원본 바이트 그대로', out.startsWith('q\rBI\rQ\r') && out.includes('\nEI\r(fake BI /x) Tj\rBI /W 2 /H 1 /CS /RGB /BPC 8 /F /AHx ID ff0000ffffff> EI\r'));
  ck('초록(0,255,0) → 150', (m => m && m[1].charCodeAt(0) === 150)(out.match(/\/W 1\r\/H 1\r\/CS \/G\r\/BPC 8\nID\n([\s\S])\nEI/)));
  const dec = 'BI /W 2 /H 1 /CS /RGB /BPC 8 /D [1 0 1 0 1 0] ID ' + RGB2 + ' EI\n';
  ck('Decode 배열이 있으면 변환하지 않음(원본 그대로)', S(preprocessInlineImages(B(dec), 0)) === dec);
  const amb = 'BI\r\n/W 2\r\n/H 1\r\n/CS /RGB\r\n/BPC 8\r\nID\r\n\x10\x20\x30\x40\x50\x00\r\nEI\r\n';
  ck('경계가 애매한(CRLF+0x00) 그림은 변환하지 않고 원본 그대로', S(preprocessInlineImages(B(amb), 0)) === amb);
  const short = 'BI\n/W 4\n/H 1\n/CS /RGB\n/BPC 8\nID ' + RGB2 + '\nEI\n';   // 선언 12바이트인데 실제 6바이트
  ck('크기 값과 실제 데이터 길이가 다르면 변환하지 않음(원본 그대로)', S(preprocessInlineImages(B(short), 0)) === short);
  const none = B('q 1 0 0 rg 0 0 10 10 re f Q\n');
  ck('인라인 그림이 없으면 원래 배열 그대로', preprocessInlineImages(none, 0) === none);
}

console.log('\n[3] 전체 흑백 치환 — 글자 하나도 버리지 않는다 (Acrobat 오류 회귀)');
for (const [name, nl] of [['LF', '\n'], ['CR (문제 파일)', '\r'], ['CRLF', '\r\n']]) {
  const out = S(grayifyStream(preprocessInlineImages(B(stream(nl, nl)), 0), {}, 0));
  ck(`${name}: BI 1개·EI 1개 (BI가 I로 깨지지 않음)`, count(out, 'BI') === 1 && count(out, 'EI') === 1, out.replace(/[^\x20-\x7e\n\r]/g, '.'));
  ck(`${name}: 색 연산자는 회색으로(빨강 0.2990 g · 파랑 0.1140 G)`, !/\brg\b/.test(out) && !/\bRG\b/.test(out) && /0\.2990 g/.test(out) && /0\.1140 G/.test(out));
}
{
  const out = S(grayifyStream(B(stream('\r', '\r')), {}, 0));
  ck('문자열 단계 단독(CR)도 BI를 보존', count(out, 'BI') === 1 && count(out, 'EI') === 1 && !/(^|\s)I\r\/W/.test(out));
  const g = S(grayifyStream(preprocessInlineImages(B('BI\r/W 8\r/H 1\r/CS /G\r/BPC 8\rID 0 0 1 rg\rEI\r'), 0), {}, 0));
  ck('그림 데이터 속 "0 0 1 rg" 바이트는 치환되지 않음', g.includes('ID 0 0 1 rg\rEI'), g);
  const fake = S(grayifyStream(B('q\rBI\rQ\r1 0 0 rg\r'), {}, 0));
  ck('가짜 BI는 글자 그대로 유지', fake.startsWith('q\rBI\rQ\r') && fake.includes('0.2990 g'), fake);
}

console.log('\n[4] 조작된 스트림 — 후보가 많아도 선형 시간');
{
  const evil = B('q\n' + 'BI /a '.repeat(40000) + '1 0 0 rg\n');   // ID·EI 없는 BI 4만 개, 약 240KB
  let t = Date.now(); const a = preprocessInlineImages(evil, 0); const tA = Date.now() - t;
  t = Date.now(); const b = S(grayifyStream(evil, {}, 0)); const tB = Date.now() - t;
  ck(`ID 없는 BI 4만 개: 바이트 단계 ${tA}ms · 문자열 단계 ${tB}ms (각 1초 미만)`, tA < 1000 && tB < 1000);
  ck('그 스트림도 바이트를 잃지 않음', a === evil && b.endsWith('0.2990 g\n') && (b.match(/BI \/a /g) || []).length === 40000);
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
