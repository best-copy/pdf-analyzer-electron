// 🖼 libs/img-enhance.js 단위 검사 (smoke) — 업스케일 배율·흑백 판정·이진화·윤곽 → PDF/SVG
//   윤곽은 실제 imagetracer(src/libs/imagetracer.js)로 따서 확인한다(앱과 같은 파일).
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const IE = require(path.join(ROOT, 'src', 'libs', 'img-enhance.js'));
const IT = require(path.join(ROOT, 'src', 'libs', 'imagetracer.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✔ ' + m); } else { fail++; console.log('  ✘ ' + m); } };

// ① 배율
{
  let p = IE.upscalePlan(640, 480, { mode: 'dpi', printWmm: 54.19, targetDpi: 300 });
  ok(p.run === 1, '이미 300dpi면 키우지 않음 ' + JSON.stringify(p));
  p = IE.upscalePlan(500, 400, { mode: 'dpi', printWmm: 100, targetDpi: 300 });
  ok(p.run === 3 && p.outW === 1181 && p.outH === 945, '100mm에 500px → AI 3배 후 1181px로 맞춤 ' + JSON.stringify(p));
  p = IE.upscalePlan(200, 100, { mode: 'dpi', printWmm: 100 });
  ok(p.run === 4 && p.outW === 800 && p.need > 5, '6배가 필요해도 4배까지 ' + JSON.stringify(p));
  p = IE.upscalePlan(300, 300, { mode: 2 });
  ok(p.run === 2 && p.outW === 600, '2배 고정');
  p = IE.upscalePlan(10000, 6000, { mode: 4 });
  ok(p.capped && Math.max(p.outW, p.outH) <= 16000 && p.outW * p.outH <= 120e6 + 1e5, '너무 크면 상한까지만 ' + JSON.stringify(p));
}

// ② 흑백 판정·이진화
{
  const n = 1000, g = new Uint8ClampedArray(n * 4), c = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) { const v = i % 256; g.set([v, v + 2 > 255 ? 255 : v + 2, v, 255], i * 4); c.set([v, 255 - v, 40, 255], i * 4); }
  ok(IE.isNeutralRgba(g) && !IE.isNeutralRgba(c), '무채색/컬러 판정');
  const b = new Uint8ClampedArray(400 * 4);
  for (let i = 0; i < 400; i++) { const v = i < 200 ? 30 + (i % 20) : 200 + (i % 30); b.set([v, v, v, 255], i * 4); }
  const r = IE.binarizeRgba(b);
  let blk = 0; for (let i = 0; i < 400; i++) if (r.data[i * 4] === 0) blk++;
  ok(r.thr >= 49 && r.thr < 200 && blk === 200, `오츠 문턱값 ${r.thr} → 검정 ${blk}/200`);
}

// ③ 윤곽 → PDF·SVG (합성 로고: 흰 바탕 + 빨간 사각형 + 검은 고리(구멍) + 회색 점)
function makeLogo() {
  const w = 120, h = 80, d = new Uint8ClampedArray(w * h * 4).fill(255);
  const put = (x, y, r, g, b) => { const i = (y * w + x) * 4; d[i] = r; d[i + 1] = g; d[i + 2] = b; };
  for (let y = 10; y < 40; y++) for (let x = 10; x < 50; x++) put(x, y, 220, 20, 30);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const r = Math.hypot(x - 85, y - 40); if (r >= 12 && r < 25) put(x, y, 0, 0, 0); }
  for (let y = 55; y < 72; y++) for (let x = 15; x < 35; x++) put(x, y, 128, 130, 127);
  return { width: w, height: h, data: d };
}
{
  const img = makeLogo();
  const td = IT.imagedataToTracedata(img, { numberofcolors: 4, colorsampling: 0, pathomit: 4, ltres: 1, qtres: 1 });
  const st = IE.traceStats(td, {});
  ok(st.colors >= 3, '색 층 ' + st.colors + ' · 모양 ' + st.shapes);
  const L = IE.traceShapes(td, {});
  ok(L[0].info.white, '넓은 색(흰 바탕)부터 그린다');
  const blackL = L.find(x => x.info.neutral && x.info.gray < 30);
  ok(blackL && blackL.shapes.some(s => s.length >= 2), '검은 고리 = 바깥 + 구멍 두 경로');
  const grayL = L.find(x => x.info.neutral && x.info.gray > 100 && x.info.gray < 160);
  ok(!!grayL, '거의 회색(128,130,127) → 회색으로');
  const ops = IE.tracePdfOps(td, { pageW: 120, pageH: 80 });
  ok(/^q\n/.test(ops) && /\nQ$/.test(ops) && /B\*/.test(ops), 'PDF 내용: q … B*(짝홀 칠하기 + 틈 메우기) … Q');
  ok(/ rg /.test(ops) && /\b0 g\b/.test(ops), '빨강은 rg, 검정은 0 g(먹)');
  const grayRg = ops.split('\n').filter(l => / rg /.test(l)).filter(l => { const [r, g, b] = l.split(' ').map(Number); return Math.max(r, g, b) - Math.min(r, g, b) < 0.05; });
  ok(grayRg.length === 0, '무채색을 rg로 쓴 줄 없음');
  // 빨간 사각형 좌표: 화소 10~50 × 10~40 → 쪽(1px = 1pt, 위아래 뒤집힘) x 10~50, y 40~70
  const redIdx = L.findIndex(x => !x.info.neutral);
  const red = L[redIdx];
  const xs = [], ys = [];
  red.shapes[0][0].segs.forEach(g => { xs.push(g[g.length - 2]); ys.push(g[g.length - 1]); });
  ok(Math.min(...xs) === 10 && Math.max(...xs) === 50 && Math.min(...ys) === 10 && Math.max(...ys) === 40, '빨간 사각형 윤곽 = 화소 경계 그대로');
  const opsNoSeam = IE.tracePdfOps(td, { pageW: 120, pageH: 80, seam: 0 });
  ok(!/B\*/.test(opsNoSeam) && /f\*/.test(opsNoSeam), '틈 메우기 끄면 f*만');
  const opsDrop = IE.tracePdfOps(td, { pageW: 120, pageH: 80, dropWhite: true });
  ok(!/\b1 g\b/.test(opsDrop) && opsDrop.length < ops.length, '흰색 비우기 → 흰 층을 그리지 않음');
  const svg = IE.traceSvg(td, { wMm: 50, hMm: 33.333 });
  ok(/width="50mm"/.test(svg) && /viewBox="0 0 120 80"/.test(svg) && (svg.match(/<path /g) || []).length === L.length && /fill-rule="evenodd"/.test(svg), 'SVG: mm 크기·화소 viewBox·층마다 path 하나');
}

// ③-b 색 줄이기: 경계가 번진(안티앨리어스) 로고 — 자동 색 수 = 실제 색 수, 경계 회색이 다른 색(파랑)으로 가지 않는다
{
  const w = 160, h = 100, d = new Uint8ClampedArray(w * h * 4);
  const cols = { W: [255, 255, 255], K: [0, 0, 0], R: [216, 30, 44], B: [30, 91, 216] };
  const at = (x, y) => {   // 그 점의 색
    if (Math.hypot(x - 115, y - 50) >= 18 && Math.hypot(x - 115, y - 50) < 30) return 'K';
    if (x >= 10 && x < 60 && y >= 10 && y < 45) return 'R';
    if (y >= 60 && y < 95 && x >= 10 && x < 10 + (y - 60) * 1.6) return 'B';
    return 'W';
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {   // 4×4 표본으로 번진 경계
    const acc = [0, 0, 0];
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) { const c = cols[at(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)]; acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; }
    d.set([acc[0] / 16, acc[1] / 16, acc[2] / 16, 255], (y * w + x) * 4);
  }
  const q = IE.quantizeRgba(d, w, h, 0);
  ok(q.k === 4, '자동 색 수 = 4 (흰·검·빨·파) ' + JSON.stringify(q.pal));
  const isBlue = j => q.data[j + 2] > 150 && q.data[j] < 100;
  let strayBlue = 0, ringNotDark = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const j = (y * w + x) * 4;
    if (isBlue(j) && !(y >= 58 && x < 70)) strayBlue++;
    const r = Math.hypot(x + 0.5 - 115, y + 0.5 - 50);
    if (r > 20 && r < 28 && q.data[j] > 60) ringNotDark++;
  }
  ok(strayBlue === 0, '검정·흰 경계의 회색이 파랑으로 가지 않음 (엉뚱한 파랑 ' + strayBlue + '화소)');
  ok(ringNotDark === 0, '고리 안쪽은 검정 그대로 (빨강과 합쳐지지 않음)');
  const q2 = IE.quantizeRgba(d, w, h, 3);
  ok(q2.k === 3, '색 수를 3으로 정하면 3색');
  const td = IT.imagedataToTracedata({ width: w, height: h, data: q.data }, { pal: q.pal, numberofcolors: q.pal.length, colorquantcycles: 1, pathomit: 4 });
  ok(IE.traceStats(td, {}).colors === 4, '그 색 그대로 윤곽 4층');
}

// ④ 2색(흑백) 모드: 이진화 + 회색 팔레트
{
  const img = makeLogo();
  const bin = IE.binarizeRgba(img.data);
  const td = IT.imagedataToTracedata({ width: img.width, height: img.height, data: bin.data }, { numberofcolors: 2, colorsampling: 0, colorquantcycles: 1, pathomit: 4 });
  const st = IE.traceStats(td, {});
  ok(st.gray && st.colors === 2, '흑백 2색 → 먹(회색)만 2층 ' + JSON.stringify(st));
}

console.log(`\nimg-enhance: 통과 ${pass} · 실패 ${fail}`);
if (fail) process.exit(1);
