// 1성분(DeviceGray) JPEG 인코더 단위 검증 — 앱 파일(src/libs/gray-jpeg.js)을 그대로 쓰고,
// 벤더링된 jpeg-js 디코더로 되읽어 크기·성분 수·화질·마커 구조를 확인한다.
//   실행: node scripts/test/gray-jpeg.test.js   (npm run smoke가 함께 돌린다)
// 회귀: DHT 길이 필드 1바이트 오류(jpeg-js는 받지만 Chromium은 거부), 지그재그 순서 오류(화질 붕괴)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const { encodeGrayJpeg } = require(path.join(ROOT, 'src/libs/gray-jpeg.js'));
const dctx = vm.createContext({ self: {}, console, Uint8Array, Int32Array, Uint16Array, Int16Array, Float32Array, Uint8ClampedArray, Int8Array, Float64Array, ArrayBuffer, Math, Error, Array, Object, Number, String, Buffer });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/libs/jpeg-decoder.js'), 'utf8'), dctx, { filename: 'jpeg-decoder.js' });
const JpegImage = dctx.self.JpegImage;

let pass = 0, fail = 0;
const ck = (name, ok, info) => { if (ok) { pass++; console.log('  ✔ ' + name); } else { fail++; console.log('  ✘ ' + name, info !== undefined ? JSON.stringify(info) : ''); } };

// 마커를 차례로 걸어 각 세그먼트 길이가 파일 구조와 맞는지(길이 필드 오류 검출)
function walkMarkers(j) {
  const seen = []; let i = 2;
  if (j[0] !== 0xFF || j[1] !== 0xD8) return null;
  while (i + 4 <= j.length) {
    if (j[i] !== 0xFF) return null;
    const m = j[i + 1], L = (j[i + 2] << 8) | j[i + 3];
    seen.push({ m, L, at: i });
    if (m === 0xC4) {                                   // DHT 내부 표 합계와 길이 필드가 일치해야 한다
      let p = i + 4, end = i + 2 + L;
      while (p < end) { let n = 0; for (let k = 1; k <= 16; k++) n += j[p + k]; p += 17 + n; }
      if (p !== end) return { bad: 'DHT', p, end };
    }
    if (m === 0xDA) { seen.eoi = j[j.length - 2] === 0xFF && j[j.length - 1] === 0xD9; return seen; }
    i += 2 + L;
  }
  return null;
}
function decode(j) {
  JpegImage.resetMaxMemoryUsage(512 * 1024 * 1024);
  const im = new JpegImage(); im.opts = { tolerantDecoding: false, maxResolutionInMP: 100, maxMemoryUsageInMB: 512 };
  im.parse(j);
  return { w: im.width, h: im.height, comps: im.components.length, data: im.getData(im.width, im.height) };
}
const psnr = (a, b) => { let se = 0; for (let i = 0; i < a.length; i++) { const e = a[i] - b[i]; se += e * e; } return se ? 10 * Math.log10(65025 / (se / a.length)) : 99; };

let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
const make = (w, h, f) => { const g = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = Math.max(0, Math.min(255, Math.round(f(x, y)))); return g; };
const cases = [
  ['사진형(부드러운 계조+잡음)', 640, 480, (x, y) => 128 + 90 * Math.sin(x / 37) * Math.cos(y / 23) + 12 * (rnd() - 0.5), 36],
  ['가장자리 채움(13×7)', 13, 7, (x, y) => x * 19 + y * 5, 38],
  ['1×1', 1, 1, () => 77, 40],
  ['전부 흰색', 64, 64, () => 255, 50],
  ['전부 검정', 64, 64, () => 0, 50],
  ['고대비 체커(최악의 AC)', 256, 256, (x, y) => ((x >> 1) + (y >> 1)) % 2 ? 255 : 0, 14],
  ['무작위 잡음(긴 허프만 코드)', 200, 150, () => rnd() * 255, 10],
];
for (const [name, w, h, f, minPsnr] of cases) {
  const g = make(w, h, f);
  let j, dec, mk;
  try { j = encodeGrayJpeg(g, w, h, 82); mk = walkMarkers(j); dec = decode(j); }
  catch (e) { ck(name + ' — 인코드/디코드', false, String(e)); continue; }
  ck(`${name} — 마커 구조·DHT 길이·EOI`, Array.isArray(mk) && mk.eoi, mk);
  ck(`${name} — 크기 ${w}×${h}·1성분`, dec.w === w && dec.h === h && dec.comps === 1, { w: dec.w, h: dec.h, c: dec.comps });
  const p = psnr(g, dec.data);
  ck(`${name} — 화질 PSNR ${p.toFixed(1)}dB ≥ ${minPsnr}`, p >= minPsnr);
}
// 품질 스케일: 높을수록 크고 화질이 좋아야 한다
{
  const g = make(320, 240, (x, y) => 128 + 100 * Math.sin((x + y) / 9) + 20 * (rnd() - 0.5));
  const lo = encodeGrayJpeg(g, 320, 240, 30), mid = encodeGrayJpeg(g, 320, 240, 82), hi = encodeGrayJpeg(g, 320, 240, 100);
  const pl = psnr(g, decode(lo).data), pm = psnr(g, decode(mid).data), ph = psnr(g, decode(hi).data);
  ck(`품질 30<82<100 — 크기 ${lo.length}<${mid.length}<${hi.length}, PSNR ${pl.toFixed(1)}<${pm.toFixed(1)}<${ph.toFixed(1)}`,
     lo.length < mid.length && mid.length < hi.length && pl < pm && pm < ph);
}
// 잘못된 입력은 조용히 깨진 JPEG를 만들지 말고 던져야 한다(워커가 Flate로 폴백)
{
  let threw = false; try { encodeGrayJpeg(new Uint8Array(10), 4, 4, 82); } catch (e) { threw = true; }
  ck('픽셀 부족 입력은 오류', threw);
  threw = false; try { encodeGrayJpeg(new Uint8Array(0), 0, 0, 82); } catch (e) { threw = true; }
  ck('0×0 입력은 오류', threw);
}
// 워커가 실제로 이 인코더를 싣는지
{
  const wsrc = fs.readFileSync(path.join(ROOT, 'src/worker-gray.js'), 'utf8');
  ck('worker-gray.js가 gray-jpeg.js를 불러 jpeg2gray에서 사용', /importScripts\('\.\/libs\/gray-jpeg\.js'\)/.test(wsrc) && /encodeGrayJpeg\(gray, iw, ih, 82\)/.test(wsrc));
}

console.log(`\n  ${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
