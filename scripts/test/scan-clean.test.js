// 🧹 scan-clean.js — 판정·굽기 단위 검사 (노드 단독, smoke에 포함)
//   실행: node scripts/test/scan-clean.test.js
// 합성 회색 그림(150dpi)으로: 검은 띠·그늘 점 줄은 지우고 가장자리 가까이 글자 줄은 남기는지, 모서리 옅은 점 무늬,
// 기울기 부호(내용 시계방향 = +), 빈 쪽, 구역마다 다른 기울기 경고. 굽기: 쪽 방향 0·90·180·270의 좌표 바꾸기와 내용 스트림 모양.
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const PDFLib = require(path.join(ROOT, 'src/libs/pdf-lib.min.js'));
const SC = require(path.join(ROOT, 'src/libs/scan-clean.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✘ ' + m); } };
const DPI = 150, MM = DPI / 25.4, W = Math.round(210 * MM), H = Math.round(297 * MM);
function page() { return new Uint8Array(W * H).fill(255); }
function rect(g, x, y, w, h, v) { for (let yy = Math.max(0, Math.round(y)); yy < Math.min(H, Math.round(y + h)); yy++) for (let xx = Math.max(0, Math.round(x)); xx < Math.min(W, Math.round(x + w)); xx++) g[yy * W + xx] = v; }
// 글줄(기울기 deg, 시계방향 +) — 굵기 3px 막대가 띄엄띄엄
function lines(g, deg, x0, x1, y0, y1, step) {
  const t = Math.tan(deg * Math.PI / 180), cx = W / 2;
  for (let y = Math.round(y0); y < y1; y += step) for (let x = Math.round(x0); x < x1; x++) { if (((x / 9) | 0) % 3 === 2) continue; const yy = Math.round(y + (x - cx) * t), xi = Math.round(x); for (let k = 0; k < 3; k++) { const p = (yy + k) * W + xi; if (yy + k >= 0 && yy + k < H) g[p] = 30; } }
}
function speck(g, x0, y0, x1, y1, v) { for (let y = Math.round(y0); y < y1; y += 2) for (let x = Math.round(x0) + (y % 4 ? 1 : 0); x < x1; x += 2) g[y * W + Math.round(x)] = v; }

try {
  // ① 아래 검은 띠 + 왼쪽 그늘 점 줄 + 오른쪽 위 모서리 점 무늬 + 1.2° 기울기
  {
    const g = page();
    lines(g, 1.2, 30 * MM, 180 * MM, 40 * MM, 250 * MM, 5 * MM);
    rect(g, 0, H - 7 * MM, W, 5 * MM, 10);                       // 아래 검은 띠
    speck(g, 2 * MM, 20 * MM, 5 * MM, 270 * MM, 200);              // 왼쪽 그늘 점 줄(옅은 회색)
    for (let k = 0; k < 20 * MM; k++) speck(g, W - 2 * MM - k, 2 * MM + k, W - 2 * MM, 2 * MM + k + 1, 215);   // 오른쪽 위 삼각 무늬
    rect(g, 0, 0, W, 2 * MM, 255); rect(g, 0, H - 2 * MM, W, 2 * MM, 255); rect(g, 0, 0, 2 * MM, H, 255); rect(g, W - 2 * MM, 0, 2 * MM, H, 255);
    const r = SC.scanAnalyze(g, W, H, { dpi: DPI });
    ok(r.edges.bottom >= 7 && r.edges.bottom <= 12, '아래 검은 띠 지움 ' + JSON.stringify(r.edges));
    ok(r.edges.left >= 5 && r.edges.left <= 12, '왼쪽 그늘 점 줄 지움 ' + r.edges.left);
    ok(r.spots.length > 0 && r.spots.every(s => s.x > 150 && s.y < 40), '오른쪽 위 모서리 점 무늬만 ' + r.spots.length + '칸');
    ok(Math.abs(r.angle - 1.2) <= 0.1 && Math.abs(r.deskew - 1.2) <= 0.1, '기울기 +1.2°(내용 시계방향 = +) ' + r.angle);
    ok(!r.blank && !r.review.length, '빈 쪽 아님·확인 필요 없음 ' + r.review.join(','));
  }
  // ② 가장자리 가까이 진짜 글자 줄(진한 획이 띄엄띄엄) — 지우면 안 된다
  {
    const g = page();
    lines(g, 0, 30 * MM, 180 * MM, 40 * MM, 250 * MM, 5 * MM);
    for (let k = 0; k < 10; k++) rect(g, 30 * MM + k * 15 * MM, 7 * MM, 5 * MM, 3 * MM, 0);   // 맨 위 숫자 줄
    const r = SC.scanAnalyze(g, W, H, { dpi: DPI });
    ok(r.edges.top === 0, '맨 위 글자 줄은 지우지 않음 ' + JSON.stringify(r.edges));
    ok(r.deskew === 0, '수평 쪽은 돌리지 않음 ' + r.angle);
  }
  // ③ 빈 쪽 — 기울기 재지 않음
  {
    const g = page();
    rect(g, 0, H - 7 * MM, W, 5 * MM, 10);
    const r = SC.scanAnalyze(g, W, H, { dpi: DPI });
    ok(r.blank && r.deskew === 0 && r.edges.bottom > 0, '빈 쪽: 띠는 지우고 기울기는 0');
  }
  // ④ 무늬 폭이 너무 넓으면(글자일 수 있음) 건드리지 않고 '확인 필요'
  {
    const g = page();
    lines(g, 0, 40 * MM, 180 * MM, 40 * MM, 250 * MM, 5 * MM);
    speck(g, 2 * MM, 20 * MM, 16 * MM, 270 * MM, 200);   // 14mm 폭 점 무늬
    const r = SC.scanAnalyze(g, W, H, { dpi: DPI });
    ok(r.edges.left === 0 && r.review.some(s => /왼쪽 무늬 폭 큼/.test(s)), '넓은 무늬는 그대로 + 확인 필요 ' + r.review.join(','));
  }
  // ⑤ 구역마다 기울기가 다르면(오려 붙인 원고) 확인 필요
  {
    const g = page();
    lines(g, 0, 20 * MM, 100 * MM, 30 * MM, 140 * MM, 5 * MM);
    lines(g, 2.0, 110 * MM, 190 * MM, 30 * MM, 140 * MM, 5 * MM);
    lines(g, 0, 20 * MM, 100 * MM, 160 * MM, 270 * MM, 5 * MM);
    lines(g, 2.0, 110 * MM, 190 * MM, 160 * MM, 270 * MM, 5 * MM);
    const r = SC.scanAnalyze(g, W, H, { dpi: DPI });
    ok(r.review.some(s => /부분마다 기울기 다름/.test(s)), '구역마다 다른 기울기 → 확인 필요 ' + r.review.join(',') + ' / ' + r.angle);
  }
  // ⑥ 화면 좌표 → PDF 좌표(쪽 상자 0 0 595 842, 화면 왼쪽 위 (0,0)·오른쪽 아래)
  {
    const box = { x0: 0, y0: 0, x1: 595, y1: 842 };
    const eq = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
    ok(eq(SC.scanDispToUser(box, 0, 0, 0), [0, 842]) && eq(SC.scanDispToUser(box, 0, 595, 842), [595, 0]), '방향 0');
    // 90: 화면은 842×595 — 왼쪽 위 = 사용자 (0,0), 오른쪽 아래 = (595,842)
    ok(eq(SC.scanDispToUser(box, 90, 0, 0), [0, 0]) && eq(SC.scanDispToUser(box, 90, 842, 595), [595, 842]), '방향 90');
    ok(eq(SC.scanDispToUser(box, 180, 0, 0), [595, 0]) && eq(SC.scanDispToUser(box, 180, 595, 842), [0, 842]), '방향 180');
    ok(eq(SC.scanDispToUser(box, 270, 0, 0), [595, 842]) && eq(SC.scanDispToUser(box, 270, 842, 595), [0, 0]), '방향 270');
  }
  // ⑦ 굽기 — 내용 앞뒤에 감싸기·흰 사각형(회색 1 g)·회전 cm
  (async () => {
    const d = await PDFLib.PDFDocument.create();
    const pg = d.addPage([595, 842]); pg.drawRectangle({ x: 10, y: 10, width: 50, height: 50 });
    const st = SC.scanBakePage(PDFLib, d, 0, { edges: { top: 0, bottom: 8, left: 5, right: 0 }, spots: [{ x: 180, y: 5, w: 10, h: 10 }], deskew: 1.5 });
    const arr = d.context.lookup(pg.node.get(PDFLib.PDFName.of('Contents'))).asArray();
    const dec = r => new TextDecoder().decode(PDFLib.decodePDFRawStream(d.context.lookup(r)).decode());
    const pre = dec(arr[0]), post = dec(arr[arr.length - 1]);
    ok(st.rects === 3 && st.angle === 1.5, '굽기: 사각형 3개(아래 띠·왼쪽·점 무늬) · 회전 1.5°');
    ok(/^q\n[-0-9. ]+ cm\nq\n$/.test(pre) && /^Q\n1 g\n([-0-9. ]+ re\n){3}f\nQ\n$/.test(post), '내용 = q 회전 q [원래] Q 흰색 사각형 Q ' + JSON.stringify([pre, post]));
    const m = pre.match(/([-0-9.]+) ([-0-9.]+) ([-0-9.]+) ([-0-9.]+) [-0-9.]+ [-0-9.]+ cm/);
    ok(m && +m[2] > 0 && Math.abs(Math.atan2(+m[2], +m[1]) * 180 / Math.PI - 1.5) < 0.01, '회전 = PDF 좌표 반시계 +1.5° (바로잡기)');
    const none = SC.scanBakePage(PDFLib, d, 0, { edges: { top: 0, bottom: 0, left: 0, right: 0 }, spots: [], deskew: 0 });
    ok(none.rects === 0 && none.angle === 0, '고칠 것이 없으면 아무것도 넣지 않는다');
    // ⑧ 떼어 내기 — 저장했다 다시 읽어도(작업 파일) 감싸기 조각만 떼면 원래 내용 그대로
    {
      const d2 = await PDFLib.PDFDocument.create();
      const p2 = d2.addPage([595, 842]); p2.drawRectangle({ x: 100, y: 100, width: 80, height: 40 });
      const origContents = String(p2.node.get(PDFLib.PDFName.of('Contents')));
      SC.scanBakePage(PDFLib, d2, 0, { edges: { top: 0, bottom: 7, left: 4, right: 0 }, spots: [{ x: 1, y: 1, w: 5, h: 5 }], deskew: -0.85 });
      const d3 = await PDFLib.PDFDocument.load(await d2.save());
      const okUn = SC.scanUnbakePage(PDFLib, d3, 0);
      const after = String(d3.getPage(0).node.get(PDFLib.PDFName.of('Contents')));
      ok(okUn && after === origContents, '떼어 내기 → 원래 내용 참조 그대로 ' + JSON.stringify([origContents, after]));
      ok(!SC.scanUnbakePage(PDFLib, d3, 0), '굽지 않은 쪽은 떼어 낼 것이 없다(false)');
    }
    // ⑨ 직접 지운 곳(manual) — 다른 정리가 없어도 흰 사각형으로 들어가고, 떼어 내기도 그대로
    {
      const d4 = await PDFLib.PDFDocument.create();
      const p4 = d4.addPage([595, 842]); p4.drawRectangle({ x: 100, y: 100, width: 80, height: 40 });
      const orig = String(p4.node.get(PDFLib.PDFName.of('Contents')));
      const st = SC.scanBakePage(PDFLib, d4, 0, { edges: { top: 0, bottom: 0, left: 0, right: 0 }, spots: [], deskew: 0, manual: [{ x: 10, y: 20, w: 30, h: 5 }] });
      const arr = d4.context.lookup(p4.node.get(PDFLib.PDFName.of('Contents'))).asArray();
      const post = new TextDecoder().decode(PDFLib.decodePDFRawStream(d4.context.lookup(arr[arr.length - 1])).decode());
      const m = post.match(/([-0-9.]+) ([-0-9.]+) ([-0-9.]+) ([-0-9.]+) re/);
      const MMp = 72 / 25.4;
      ok(st.rects === 1 && m && Math.abs(+m[1] - 10 * MMp) < 0.01 && Math.abs(+m[2] - (842 - 25 * MMp)) < 0.01 && Math.abs(+m[3] - 30 * MMp) < 0.01,
        '직접 지운 곳: 화면 mm(왼쪽 위 원점) → PDF 사각형 ' + post.trim().replace(/\n/g, ' | '));
      ok(SC.scanUnbakePage(PDFLib, d4, 0) && String(p4.node.get(PDFLib.PDFName.of('Contents'))) === orig, '직접 지운 곳도 떼어 내기 가능');
    }
    // ⑩ 펜 획 — 흰 둥근 선(굵기 mm → pt, 점 mm → PDF 좌표), 한 번 찍기도 점으로, 떼어 내기 가능
    {
      const d5 = await PDFLib.PDFDocument.create();
      const p5 = d5.addPage([595, 842]); p5.drawRectangle({ x: 100, y: 100, width: 80, height: 40 });
      const orig = String(p5.node.get(PDFLib.PDFName.of('Contents')));
      const MMp = 72 / 25.4;
      const st = SC.scanBakePage(PDFLib, d5, 0, { edges: { top: 0, bottom: 5, left: 0, right: 0 }, spots: [], deskew: 0.8,
        manual: [{ t: 'p', w: 3, pts: [[10, 20], [40, 25], [60, 20]] }, { t: 'p', w: 2, pts: [[100, 100]] }, { x: 5, y: 5, w: 3, h: 3 }] });
      const arr = d5.context.lookup(p5.node.get(PDFLib.PDFName.of('Contents'))).asArray();
      const post = new TextDecoder().decode(PDFLib.decodePDFRawStream(d5.context.lookup(arr[arr.length - 1])).decode());
      const w1 = post.match(/([-0-9.]+) w\n([-0-9.]+) ([-0-9.]+) m\n/);
      ok(st.strokes === 2 && st.rects === 2 && /1 G\n1 J\n1 j\n/.test(post), '펜 획 2개 + 사각형 2개(띠·직접) ' + JSON.stringify(st));
      ok(w1 && Math.abs(+w1[1] - 3 * MMp) < 0.01 && Math.abs(+w1[2] - 10 * MMp) < 0.01 && Math.abs(+w1[3] - (842 - 20 * MMp)) < 0.01, '펜 굵기·시작점 좌표 ' + (w1 && w1[0]));
      ok(/([-0-9.]+) ([-0-9.]+) m\n\1 \2 l\nS\n/.test(post), '한 번 찍은 점 = 같은 자리로 선(둥근 점)');
      ok(SC.scanUnbakePage(PDFLib, d5, 0) && String(p5.node.get(PDFLib.PDFName.of('Contents'))) === orig, '펜 획이 있어도 떼어 내기 가능');
    }
    // ⑪ 내용 상자·가운데로 거리 — 왼쪽으로 쏠린 글(15~125mm, 50~200mm) → 오른쪽 +35mm·아래 +23.5mm
    {
      const g = page();
      lines(g, 0, 15 * MM, 125 * MM, 50 * MM, 200 * MM, 5 * MM);
      const r = SC.scanAnalyze(g, W, H, { dpi: DPI });
      ok(r.content && Math.abs(r.content.x - 15) <= 1.5 && Math.abs(r.content.x + r.content.w - 125) <= 1.5, '내용 상자 가로 ' + JSON.stringify(r.content));
      ok(r.center && Math.abs(r.center.dx - 35) <= 1.5 && Math.abs(r.center.dy - (148.5 - 125)) <= 3, '가운데로 거리 ' + JSON.stringify(r.center));
      const rb = SC.scanAnalyze(page(), W, H, { dpi: DPI });
      ok(rb.content === null && rb.center === null, '빈 쪽은 내용 상자 없음');
      // 굽기: 이동 → 회전 앞에 '1 0 0 1 tx ty cm' (화면 오른쪽 +10mm = PDF x +, 아래 +10mm = PDF y −), 떼어 내기 가능
      const d6 = await PDFLib.PDFDocument.create();
      const p6 = d6.addPage([595, 842]); p6.drawRectangle({ x: 100, y: 100, width: 80, height: 40 });
      const orig = String(p6.node.get(PDFLib.PDFName.of('Contents')));
      const st = SC.scanBakePage(PDFLib, d6, 0, { edges: { top: 0, bottom: 0, left: 0, right: 0 }, spots: [], deskew: 1, shift: { x: 10, y: 10 } });
      const arr = d6.context.lookup(p6.node.get(PDFLib.PDFName.of('Contents'))).asArray();
      const pre = new TextDecoder().decode(PDFLib.decodePDFRawStream(d6.context.lookup(arr[0])).decode());
      const m = pre.match(/^q\n1 0 0 1 ([-0-9.]+) ([-0-9.]+) cm\n[-0-9. ]+ cm\nq\n$/);
      const MMp = 72 / 25.4;
      ok(st.shift === 1 && m && Math.abs(+m[1] - 10 * MMp) < 0.01 && Math.abs(+m[2] + 10 * MMp) < 0.01, '이동 cm(회전보다 먼저 씀) ' + JSON.stringify(pre));
      ok(SC.scanUnbakePage(PDFLib, d6, 0) && String(p6.node.get(PDFLib.PDFName.of('Contents'))) === orig, '이동이 있어도 떼어 내기 가능');
      // 쪽 방향 270에서도 화면 기준 이동 — 화면 오른쪽 = PDF y 감소(270: dx → -y 방향)
      const d7 = await PDFLib.PDFDocument.create();
      const p7 = d7.addPage([842, 595]); p7.setRotation(PDFLib.degrees(270)); p7.drawRectangle({ x: 1, y: 1, width: 2, height: 2 });
      SC.scanBakePage(PDFLib, d7, 0, { edges: { top: 0, bottom: 0, left: 0, right: 0 }, spots: [], deskew: 0, shift: { x: 10, y: 0 } });
      const a7 = d7.context.lookup(p7.node.get(PDFLib.PDFName.of('Contents'))).asArray();
      const pre7 = new TextDecoder().decode(PDFLib.decodePDFRawStream(d7.context.lookup(a7[0])).decode());
      const box = { x0: 0, y0: 0, x1: 842, y1: 595 }, e0 = SC.scanDispToUser(box, 270, 0, 0), e1 = SC.scanDispToUser(box, 270, 10 * MMp, 0);
      const m7 = pre7.match(/1 0 0 1 ([-0-9.]+) ([-0-9.]+) cm/);
      ok(m7 && Math.abs(+m7[1] - (e1[0] - e0[0])) < 0.01 && Math.abs(+m7[2] - (e1[1] - e0[1])) < 0.01, '쪽 방향 270 이동 = 화면 기준 ' + (m7 && m7[0]));
    }
    console.log(`scan-clean.test: 통과 ${pass} · 실패 ${fail}`);
    process.exit(fail ? 1 : 0);
  })().catch(e => { console.log('  ✘ 예외 ' + e.stack); process.exit(1); });
} catch (e) { console.log('  ✘ 예외 ' + (e && e.stack || e)); process.exit(1); }
