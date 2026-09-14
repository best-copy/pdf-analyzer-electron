// 사진 띠 이음매 보정 — 단위 검증 (앱이 싣는 src/seam-repair.js를 그대로 읽는다: 복사본 드리프트 방지)
//   실행: node scripts/test/seam-repair.test.js   (npm run smoke가 함께 돌린다)
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'seam-repair.js'), 'utf8');
const { seamTrackImageRects, seamLines, seamRepairPixels, seamRepairCanvas } = new Function(
  src + '\nreturn { seamTrackImageRects, seamLines, seamRepairPixels, seamRepairCanvas };')();

let pass = 0, fail = 0;
const ck = (name, ok, info) => { if (ok) { pass++; console.log('  ✔ ' + name); } else { fail++; console.log('  ✘ ' + name, info !== undefined ? JSON.stringify(info) : ''); } };

console.log('\n[0] 그림 자리 기록 — seamTrackImageRects');
{
  function FakeCtx() { this.calls = 0; this.m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; }
  FakeCtx.prototype.drawImage = function () { this.calls++; };
  FakeCtx.prototype.getTransform = function () { return this.m; };
  const r4 = q => [q.x0, q.y0, q.x1, q.y1].map(v => Math.round(v * 10) / 10);

  const ctx = new FakeCtx(), img = { width: 7, height: 9 };
  const t = seamTrackImageRects(ctx);
  // pdf.js 3.x 방식: setTransform(±1,0,0,±1,x,y) 뒤 9인자 drawImage
  ctx.m = { a: 1, b: 0, c: 0, d: -1, e: 100, f: 500 }; ctx.drawImage(img, 0, 0, 10, 10, 0, 0, 50, 40);
  ctx.m = { a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 };   ctx.drawImage(img, 5, 6, 30, 40);        // 5인자
  ctx.m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };     ctx.drawImage(img, 1, 2);                // 3인자 → 그림 크기
  ctx.m = { a: 0, b: 1, c: -1, d: 0, e: 200, f: 0 };  ctx.drawImage(img, 0, 0, 10, 20);        // 90° 돌림
  ctx.m = { a: 1, b: 0.5, c: 0, d: 1, e: 0, f: 0 };   ctx.drawImage(img, 0, 0, 10, 10);        // 기울어짐 → 기록 안 함
  ck('9인자·y 뒤집힘 → (100,460)-(150,500)', t.rects[0] && r4(t.rects[0]).join() === '100,460,150,500', t.rects[0]);
  ck('5인자 → (15,26)-(45,66)', t.rects[1] && r4(t.rects[1]).join() === '15,26,45,66', t.rects[1]);
  ck('3인자는 그림 크기로 → (1,2)-(8,11)', t.rects[2] && r4(t.rects[2]).join() === '1,2,8,11', t.rects[2]);
  ck('90° 돌린 그림 → (180,0)-(200,10)', t.rects[3] && r4(t.rects[3]).join() === '180,0,200,10', t.rects[3]);
  ck('기울어진 그림은 기록 안 함', t.rects.length === 4, t.rects.length);
  ck('원래 drawImage는 매번 불린다', ctx.calls === 5, ctx.calls);
  t.stop();
  ck('끝나면 프로토타입의 drawImage로 돌아간다', !Object.prototype.hasOwnProperty.call(ctx, 'drawImage') && ctx.drawImage === FakeCtx.prototype.drawImage);

  // 같은 캔버스에 렌더가 겹칠 때(크게 보기에서 쪽을 빨리 넘김)
  const c2 = new FakeCtx(), A = seamTrackImageRects(c2), B = seamTrackImageRects(c2);
  c2.drawImage(img, 0, 0, 10, 10);
  ck('겹친 두 기록이 둘 다 받는다', A.rects.length === 1 && B.rects.length === 1, [A.rects.length, B.rects.length]);
  A.stop(); c2.drawImage(img, 0, 0, 10, 10);
  ck('먼저 끝난 쪽은 더 안 받고, 남은 쪽은 계속 받는다', A.rects.length === 1 && B.rects.length === 2, [A.rects.length, B.rects.length]);
  ck('남은 기록이 있는 동안은 가로채기 유지', Object.prototype.hasOwnProperty.call(c2, 'drawImage'));
  B.stop(); c2.drawImage(img, 0, 0, 10, 10);
  ck('마지막이 끝나면 원래대로·더 쌓이지 않음', !Object.prototype.hasOwnProperty.call(c2, 'drawImage') && B.rects.length === 2);
  // 캔버스 자체에 drawImage가 붙어 있던 경우(own)는 그것으로 되돌린다
  const c3 = new FakeCtx(), mine = function () {}; c3.drawImage = mine;
  const t3 = seamTrackImageRects(c3); t3.stop();
  ck('자기 속성이던 drawImage는 그대로 복원', c3.drawImage === mine);
}

// W×H 회색(128) 판에 원하는 행/열을 흰색(250)으로 — 비친 틈 흉내
function plate(W, H, v = 128) { const px = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < px.length; i += 4) { px[i] = px[i + 1] = px[i + 2] = v; px[i + 3] = 255; } return px; }
const setPx = (px, W, x, y, v) => { const o = (y * W + x) * 4; px[o] = px[o + 1] = px[o + 2] = v; };
const getPx = (px, W, x, y) => px[(y * W + x) * 4];

console.log('\n[1] 경계 찾기 — seamLines');
{
  const W = 200, H = 200;
  const L1 = seamLines([{ x0: 20, x1: 180, y0: 20, y1: 100 }, { x0: 20, x1: 180, y0: 100, y1: 180 }], W, H);
  ck('맞닿은 가로 띠 → 가로 이음매 1개', L1.length === 1 && L1[0].dir === 'h', L1);
  ck('정수 경계면 경계 양쪽 두 행(99~100)을 후보로', L1[0] && L1[0].a === 99 && L1[0].b === 100, L1[0]);
  ck('구간은 겹치는 열(20~179)', L1[0] && L1[0].from === 20 && L1[0].to === 179, L1[0]);
  const L2 = seamLines([{ x0: 20, x1: 180, y0: 20, y1: 100.4 }, { x0: 20, x1: 180, y0: 100.4, y1: 180 }], W, H);
  ck('소수 경계(100.4) → 그 행 하나(100)', L2.length === 1 && L2[0].a === 100 && L2[0].b === 100, L2);
  ck('5px 떨어진 두 그림 → 이음매 없음', seamLines([{ x0: 20, x1: 180, y0: 20, y1: 100 }, { x0: 20, x1: 180, y0: 105, y1: 180 }], W, H).length === 0);
  ck('좌우 끝이 다른 두 그림 → 건드리지 않음', seamLines([{ x0: 20, x1: 180, y0: 20, y1: 100 }, { x0: 60, x1: 140, y0: 100, y1: 180 }], W, H).length === 0);
  const L3 = seamLines([{ x0: 20, x1: 90, y0: 30, y1: 170 }, { x0: 90, x1: 180, y0: 30, y1: 170 }], W, H);
  ck('맞닿은 세로 띠 → 세로 이음매', L3.length === 1 && L3[0].dir === 'v' && L3[0].from === 30 && L3[0].to === 169, L3);
  ck('겹치는 길이 8px 미만 → 무시', seamLines([{ x0: 20, x1: 25, y0: 20, y1: 100 }, { x0: 20, x1: 25, y0: 100, y1: 180 }], W, H).length === 0);
  ck('전면 합성 사각형과는 이음매 없음', seamLines([{ x0: 0, x1: 200, y0: 0, y1: 200 }, { x0: 20, x1: 180, y0: 20, y1: 100 }], W, H).length === 0);
}

console.log('\n[2] 메우기 — seamRepairPixels');
{
  const W = 40, H = 20;
  const px = plate(W, H);
  for (let x = 5; x < 35; x++) setPx(px, W, x, 10, 250);
  setPx(px, W, 20, 9, 30);
  const n = seamRepairPixels(px, W, H, [{ dir: 'h', a: 10, b: 10, from: 5, to: 34 }]);
  ck('흰 틈 30픽셀을 고침', n === 30, n);
  ck('틈이 위·아래 이웃 평균이 됨', getPx(px, W, 7, 10) === 128 && getPx(px, W, 20, 10) === 79, [getPx(px, W, 7, 10), getPx(px, W, 20, 10)]);
  ck('구간 밖은 그대로', getPx(px, W, 2, 10) === 128 && getPx(px, W, 37, 10) === 128);
  const q = plate(W, H);
  ck('이웃과 같은 밝기 → 0개', seamRepairPixels(q, W, H, [{ dir: 'h', a: 10, b: 10, from: 0, to: 39 }]) === 0);
  const k = plate(W, H); for (let x = 0; x < W; x++) setPx(k, W, x, 10, 20);
  ck('어두운 괘선은 건드리지 않음', seamRepairPixels(k, W, H, [{ dir: 'h', a: 10, b: 10, from: 0, to: 39 }]) === 0 && getPx(k, W, 5, 10) === 20);
  const t = plate(W, H); for (let x = 0; x < W; x++) { setPx(t, W, x, 9, 240); setPx(t, W, x, 10, 240); }
  const n2 = seamRepairPixels(t, W, H, [{ dir: 'h', a: 9, b: 10, from: 0, to: 39 }]);
  ck('두 행 틈 → 둘 다 메움', n2 === 80 && getPx(t, W, 3, 9) === 128 && getPx(t, W, 3, 10) === 128, [n2, getPx(t, W, 3, 9)]);
  const v = plate(W, H); for (let y = 2; y < 18; y++) setPx(v, W, 15, y, 250);
  ck('세로 틈 16픽셀을 고침', seamRepairPixels(v, W, H, [{ dir: 'v', a: 15, b: 15, from: 2, to: 17 }]) === 16 && getPx(v, W, 15, 5) === 128);
}

console.log('\n[3] 캔버스 띠 단위 보정 — seamRepairCanvas (둘레만 읽는가)');
{
  const W = 60, H = 30, px = plate(W, H);
  for (let x = 10; x < 50; x++) setPx(px, W, x, 12, 250);
  const reads = [];
  const ctx = {
    getImageData(x, y, w, h) { reads.push([x, y, w, h]); const d = new Uint8ClampedArray(w * h * 4);
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) for (let c = 0; c < 4; c++) d[(yy * w + xx) * 4 + c] = px[((y + yy) * W + x + xx) * 4 + c];
      return { data: d, width: w, height: h }; },
    putImageData(id, x, y) { for (let yy = 0; yy < id.height; yy++) for (let xx = 0; xx < id.width; xx++) for (let c = 0; c < 4; c++) px[((y + yy) * W + x + xx) * 4 + c] = id.data[(yy * id.width + xx) * 4 + c]; },
  };
  const n = seamRepairCanvas(ctx, [{ dir: 'h', a: 12, b: 12, from: 10, to: 49 }]);
  ck('틈 40픽셀을 고침', n === 40, n);
  ck('읽은 범위는 줄 둘레(40×3)뿐', reads.length === 1 && reads[0][2] === 40 && reads[0][3] === 3, reads);
  ck('캔버스에 반영됨', getPx(px, W, 20, 12) === 128);
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
