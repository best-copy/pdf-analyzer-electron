// 🧹 스캔 정리 — 실제 앱 본체로 판정 → 쪽별 창 → 적용(쪽 편집본) → 되돌리기 → 내부 편집기 뒤 다시 입히기 → 작업 파일 왕복
//   실행: node scripts/test/scan-clean.e2e.js            (합성 스캔 원고)
//         set SCAN_PDF=D:\...\스캔.pdf & node scripts/test/scan-clean.e2e.js   (실파일 — 처음 6쪽만 판정 요약 출력)
// 창은 TEST_WINDOW=left(가장 왼쪽 모니터)·검사용 사용자 폴더. 사용자 파일은 읽기만 한다.
// 합성 원고(쪽마다 그림 1장, 150dpi 회색 JPEG): 내용 1.5° 시계방향 기울기 · 아래 검은 띠(5mm) · 왼쪽 그늘 점 줄 ·
//   오른쪽 위 모서리 옅은 점 무늬 · 맨 위 가까이 진짜 글자 줄(지우면 안 됨) · 빈 쪽 1장
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn, execSync, execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const electron = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = 9367;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✔ ' + m); } else { fail++; console.log('  ✘ ' + m); } };
const getJson = u => new Promise((res, rej) => http.get(u, r => { let s = ''; r.on('data', d => s += d); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } }); }).on('error', rej));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function connect() {
  for (let i = 0; i < 240; i++) {
    try {
      const t = (await getJson(`http://127.0.0.1:${PORT}/json`)).find(x => x.type === 'page' && /index\.html/.test(x.url));
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
        let id = 0; const wait = new Map();
        ws.onmessage = m => { const d = JSON.parse(m.data); if (wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
        return expr => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })); })
          .then(d => d.result && d.result.result ? d.result.result.value : { __err: JSON.stringify(d.result && d.result.exceptionDetails || d).slice(0, 600) });
      }
    } catch (e) {}
    await sleep(300);
  }
  throw new Error('CDP 연결 실패');
}
async function until(ev, expr, ms) { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(400); } return false; }

const REAL = process.env.SCAN_PDF && fs.existsSync(process.env.SCAN_PDF) ? process.env.SCAN_PDF : null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfedit-scan-'));
let child;
(async () => {
  try {
    // 합성 원고는 앱을 한 번 켜서 그 안의 캔버스·pdf-lib으로 만든다 → 파일로 저장 → 그 파일을 열고 다시 시작
    let pdfPath = REAL;
    child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, stdio: 'ignore', env: Object.assign({}, process.env, { TEST_WINDOW: 'left' }) });
    let ev = await connect();
    await sleep(2500);
    if (!pdfPath) {
      const p = await ev(`(async () => {
        const MM = 150 / 25.4, W = Math.round(210 * MM), H = Math.round(297 * MM);
        const mkPage = (blank) => {
          const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
          x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
          if (!blank) {
            // 내용(1.5° 시계방향): 세로 괘선·가로 글줄 막대·사진 상자
            x.save(); x.translate(W / 2, H / 2); x.rotate(1.5 * Math.PI / 180); x.translate(-W / 2, -H / 2);
            x.fillStyle = '#111';
            for (let col = 0; col < 8; col++) for (let k = 0; k < 40; k++) x.fillRect(Math.round(30 * MM + col * 20 * MM), Math.round(45 * MM + k * 5.5 * MM), Math.round(15 * MM), Math.round(1.6 * MM));
            for (let col = 0; col < 9; col++) x.fillRect(Math.round(27 * MM + col * 20 * MM), Math.round(40 * MM), 3, Math.round(225 * MM));
            x.fillStyle = '#555'; x.fillRect(Math.round(60 * MM), Math.round(150 * MM), Math.round(60 * MM), Math.round(40 * MM));
            x.restore();
            // 맨 위 가까이 진짜 글자 줄(기울지 않은 작은 숫자 줄) — 지우면 안 된다
            x.fillStyle = '#000'; for (let k = 0; k < 10; k++) x.fillRect(Math.round(30 * MM + k * 15 * MM), Math.round(8 * MM), Math.round(5 * MM), Math.round(3 * MM));
          }
          // 아래 검은 띠(가장자리 2mm 흰 테두리 안쪽 5mm)
          x.fillStyle = '#000'; x.fillRect(0, H - Math.round(7 * MM), W, Math.round(5 * MM));
          // 왼쪽 그늘 점 줄(2~5mm) — 옅은 점
          x.fillStyle = '#c8c8c8'; for (let y = 2 * MM; y < H - 8 * MM; y += 3) for (let xx = 2 * MM; xx < 5 * MM; xx += 3) if ((xx + y) % 2 < 1.5) x.fillRect(Math.round(xx), Math.round(y), 1, 1);
          // 오른쪽 위 모서리 옅은 점 무늬(삼각형)
          x.fillStyle = '#d0d0d0'; for (let y = 2 * MM; y < 22 * MM; y += 2) for (let xx = W - 2 * MM - (22 * MM - y); xx < W - 2 * MM; xx += 2) x.fillRect(Math.round(xx), Math.round(y), 1, 1);
          // 맨 바깥 2mm 흰 테두리
          x.fillStyle = '#fff'; const f = Math.round(2 * MM); x.fillRect(0, 0, W, f); x.fillRect(0, H - f, W, f); x.fillRect(0, 0, f, H); x.fillRect(W - f, 0, f, H);
          return c.toDataURL('image/jpeg', 0.92);
        };
        const d = await PDFLib.PDFDocument.create();
        for (const blank of [false, false, true]) {
          const jpg = await d.embedJpg(mkPage(blank));
          const pg = d.addPage([595.28, 841.89]); pg.drawImage(jpg, { x: 0, y: 0, width: 595.28, height: 841.89 });
        }
        return await window.electronAPI.writeTempFile(await d.save(), 'pdf');
      })()`);
      pdfPath = path.join(tmp, 'synthetic-scan.pdf');
      fs.copyFileSync(p, pdfPath);
      try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (e) {}
      await sleep(1500);
      child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`, pdfPath], { cwd: ROOT, stdio: 'ignore', env: Object.assign({}, process.env, { TEST_WINDOW: 'left' }) });
      ev = await connect();
    } else {
      try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (e) {}
      await sleep(1500);
      child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`, pdfPath], { cwd: ROOT, stdio: 'ignore', env: Object.assign({}, process.env, { TEST_WINDOW: 'left' }) });
      ev = await connect();
    }
    await ev(`window.__errs = []; { const oe = window.showError; window.showError = m => { window.__errs.push(String(m)); try { oe(m); } catch (e) {} }; } window.confirm = () => true; 1`);
    const opened = await until(ev, `!!(typeof originalPdfBytes !== 'undefined' && originalPdfBytes && globalPdfDoc && pageResults.filter(Boolean).length >= ${REAL ? 6 : 3})`, REAL ? 900000 : 120000);
    ok(opened, '원고 열림 ' + (REAL ? path.basename(REAL) : '(합성 3쪽)'));
    await sleep(1500);
    console.log('🧹 스캔 정리');
    const t0 = Date.now();
    await ev(`(async () => { window.__scanOpen = openScanCleanModal(); return 1; })()`);
    const shown = await until(ev, `!!document.querySelector('.sc-modal') && !document.querySelector('#scApply').textContent.includes('판정 중')`, REAL ? 1200000 : 120000);
    ok(shown, `판정 끝 · 창 표시 (${((Date.now() - t0) / 1000).toFixed(1)}초)`);
    const st = await ev(`(() => ({ sub: document.querySelector('#scSub').textContent, btn: document.querySelector('#scApply').textContent,
      rows: [...document.querySelectorAll('#scList .rbv-pghead')].map(h => h.textContent.replace(/\\s+/g, ' ').trim()),
      canvasW: document.querySelector('#scCanvas').width, errs: window.__errs.slice() }))()`);
    console.log('    ' + st.sub); st.rows.slice(0, 8).forEach(r => console.log('    · ' + r));
    if (!REAL) {
      ok(/3쪽 판정/.test(st.sub) && /정리할 쪽 3쪽/.test(st.sub) && /기울기 2[ )]/.test(st.sub), '합성 3쪽 판정 — 정리할 쪽 3쪽(빈 쪽도 띠·점 무늬) · 기울기 2쪽 ' + st.sub);
      ok(st.rows[0] && /띠/.test(st.rows[0]) && /점/.test(st.rows[0]) && /↺ 1\.[45]/.test(st.rows[0]), '1쪽: 띠·점 무늬·↺ 1.5° 안팎 ' + st.rows[0]);
      ok(st.rows[2] && /빈 쪽/.test(st.rows[2]) && !/↺|↻/.test(st.rows[2]), '빈 쪽은 기울기를 재지 않음 ' + st.rows[2]);
      ok(st.canvasW > 200 && !st.errs.length, '전·후 미리보기 그림 · 오류 없음');
    } else {
      ok(st.rows.length >= 6 && st.canvasW > 200 && !st.errs.length, '실파일 판정 목록 · 미리보기 · 오류 없음');
    }
    // ⚡ 빠른 판정(문서 여러 개 + 작업 스레드)이 예전 방식(문서 1개·화면 스레드)과 결과가 같은지 · 걸린 시간
    console.log('⚡ 판정 속도·결과 대조');
    const sp = await ev(`(async () => {
      const rows = pageResults.map((r, i) => ({ r, shown: i + 1 })).filter(x => x.r && !x.r.isBlank && x.r.originalIdx != null);
      const strip = m => JSON.stringify([...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => { const c = Object.assign({}, v); delete c.img; return [k, c]; }));
      const free = m => m.forEach(v => { if (v.img) URL.revokeObjectURL(v.img); });
      const first = scanAnalyzeRows.last;
      let t = performance.now(); const oldR = await scanAnalyzeRows(rows, null, null, { docs: 1, worker: false, cache: false }); const oldMs = performance.now() - t;
      t = performance.now(); const newR = await scanAnalyzeRows(rows, null, null, { cache: false }); const newMs = performance.now() - t; const info = scanAnalyzeRows.last;
      const same = strip(oldR) === strip(newR);
      let diff = null;
      if (!same) for (const [k, v] of oldR) { const a = Object.assign({}, v), b = Object.assign({}, newR.get(k)); delete a.img; delete b.img; if (JSON.stringify(a) !== JSON.stringify(b)) { diff = [k, a, b]; break; } }
      t = performance.now(); const cR = await scanAnalyzeRows(rows, null, null, {}); const cMs = performance.now() - t; const cInfo = scanAnalyzeRows.last;
      const sameC = strip(oldR) === strip(cR);
      free(oldR); free(newR); free(cR);
      return { n: rows.length, oldMs, newMs, docs: info.docs, worker: info.worker, same, diff, cMs, cached: cInfo.cached, sameC, first };
    })()`);
    console.log(`    ${sp.n}쪽 · 예전 방식 ${(sp.oldMs / 1000).toFixed(1)}초 → 새 방식 ${(sp.newMs / 1000).toFixed(1)}초 (문서 ${sp.docs}개·작업 스레드 ${sp.worker}) · 기억에서 ${(sp.cMs / 1000).toFixed(2)}초 · 창 처음 열 때 ${JSON.stringify(sp.first)}`);
    ok(sp.same, '새 방식 판정 결과 = 예전 방식(쪽마다 전부 같음) ' + (sp.diff ? JSON.stringify(sp.diff).slice(0, 400) : ''));
    ok((sp.n < 8 || sp.docs > 1) && sp.worker, `문서 ${sp.docs}개로 동시에 그리고 판정은 작업 스레드`);
    ok(sp.cached === sp.n && sp.sameC, `판정 기억: ${sp.cached}/${sp.n}쪽을 기억에서 · 결과 같음`);
    // ✏ 직접 지우기 — 오른쪽(정리 후) 그림 위를 끌어 고르면 원래 스캔 기준 mm로 저장, 왼쪽에서 고른 것과 같은 자리
    console.log('✏ 직접 지우기');
    const mn = await ev(`(async () => {
      const ov = document.querySelector('.merge-overlay'), T = ov.__scTest;
      await T.goRow(0);
      const g = T.geo(), k = g.W / g.wMm;   // mm → 캔버스 화소
      const L = T.dragToMm({ x: 70 * k, y: 160 * k }, { x: 110 * k, y: 180 * k }, 0);
      // 같은 자리를 오른쪽 그림 위에서(돌아간 그림 → 같은 원래 자리의 화면 좌표)
      const a = g.angle * Math.PI / 180, cx = g.W / 2, cy = g.H / 2;
      const fwd = (x, y) => { const qx = x - cx, qy = y - cy; return { x: qx * Math.cos(-a) - qy * Math.sin(-a) + cx + g.W + g.gap, y: qx * Math.sin(-a) + qy * Math.cos(-a) + cy }; };
      const mid = fwd(90 * k, 170 * k);
      const R = T.dragToMm({ x: mid.x - 20 * k, y: mid.y - 10 * k }, { x: mid.x + 20 * k, y: mid.y + 10 * k }, 1);
      T.addManual(L);
      // 오른쪽 클릭 우클릭 취소 흉내 대신: 하나 더 넣고 '하나 취소' 버튼
      T.addManual(R); document.querySelector('#scManUndo').click();
      const plan = T.planOfCur();
      const tag = document.querySelector('#scList .rbv-pghead.cur').textContent;
      // ✎ 펜: 단축키 ] 두 번 → 굵기 2단계 위, 오른쪽(돌아간 그림)에서 사진 상자 아래쪽을 가로로 긋기
      const kd = (code, key) => document.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true }));
      kd('KeyR', 'ㄱ'); const tR = T.tool(); kd('KeyP', 'ㅔ'); const tP = T.tool();
      for (let i = 0; i < 14; i++) kd('BracketLeft', '['); for (let i = 0; i < 6; i++) kd('BracketRight', ']');   // 4mm에서 시작   // 기억된 굵기가 상한 가까이면 ] 가 막히므로 먼저 가늘게
      const w0 = T.penMm();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ']', code: 'BracketRight', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ']', code: 'BracketRight', bubbles: true }));
      const w1 = T.penMm();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '[', code: 'BracketLeft', bubbles: true }));
      const w2 = T.penMm();
      const pts = []; for (let xm = 66; xm <= 114; xm += 2) pts.push(fwd(xm * k, 185 * k));
      const P = T.penToMm(pts, 1, w2);
      T.addManual(P);
      const plan2 = T.planOfCur();
      // 빨간 띠 폭: 아래 띠 안쪽 경계를 마우스로 끌어 12mm로 → 되돌리기 → 다시 12mm
      const cvEl = document.querySelector('#scCanvas');
      let bb = cvEl.getBoundingClientRect(), kk = bb.width / cvEl.width;
      const remeasure = () => { bb = cvEl.getBoundingClientRect(); kk = bb.width / cvEl.width; };
      const cl = (x, y) => ({ clientX: bb.left + x * kk, clientY: bb.top + y * kk });
      const dragEdge = (y0, y1) => {
        remeasure();
        cvEl.dispatchEvent(new MouseEvent('mousedown', Object.assign({ bubbles: true, button: 0, detail: 1 }, cl(g.W / 2, y0))));
        window.dispatchEvent(new MouseEvent('mousemove', Object.assign({ bubbles: true }, cl(g.W / 2, (y0 + y1) / 2))));
        window.dispatchEvent(new MouseEvent('mousemove', Object.assign({ bubbles: true }, cl(g.W / 2, y1))));
        window.dispatchEvent(new MouseEvent('mouseup', Object.assign({ bubbles: true }, cl(g.W / 2, y1))));
      };
      await T.goRow(0); await new Promise(r => setTimeout(r, 300));
      const auto0 = T.curEdges().bottom;
      const hitB = T.edgeHit({ x: g.W / 2, y: g.H - auto0 * k });
      dragEdge(g.H - auto0 * k, g.H - 12 * k);
      const after1 = T.curEdges().bottom, tag1 = document.querySelector('#scList .rbv-pghead.cur').textContent;
      document.querySelector('#scEdgeAuto').click();
      const reset = T.curEdges().bottom;
      dragEdge(g.H - reset * k, g.H - 12 * k);
      const edge = { auto0, hitB, after1, tag1, reset, final: T.curEdges().bottom, top: T.curEdges().top };
      // ⊕ 가운데로·화살표·이동 도구 — 2쪽에서(1쪽 검사 자리를 건드리지 않게)
      await T.goRow(1);
      const rc = document.querySelector('.merge-overlay');
      T.centerCur(); const cen = T.curShift();
      T.setShift(0, 0);
      kd('ArrowRight', 'ArrowRight'); kd('ArrowRight', 'ArrowRight');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', shiftKey: true, bubbles: true }));
      const arrow = T.curShift();
      T.setShift(0, 0); T.setTool('move');
      await new Promise(r => setTimeout(r, 300));
      const g2 = T.geo(), k2 = g2.W / g2.wMm; remeasure();
      const cl2 = (x, y) => ({ clientX: bb.left + x * kk, clientY: bb.top + y * kk });
      const sx0 = g2.W + g2.gap + g2.W / 2, sy0 = g2.H / 2;
      cvEl.dispatchEvent(new MouseEvent('mousedown', Object.assign({ bubbles: true, button: 0, detail: 1 }, cl2(sx0, sy0))));
      window.dispatchEvent(new MouseEvent('mousemove', Object.assign({ bubbles: true }, cl2(sx0 + 5 * k2, sy0))));
      window.dispatchEvent(new MouseEvent('mousemove', Object.assign({ bubbles: true }, cl2(sx0 + 10 * k2, sy0))));
      window.dispatchEvent(new MouseEvent('mouseup', Object.assign({ bubbles: true }, cl2(sx0 + 10 * k2, sy0))));
      const dragged = T.curShift();
      const tag2 = document.querySelector('#scList .rbv-pghead.cur').textContent;
      T.setTool('pen');
      await T.goRow(0);
      const ctr = { cen, arrow, dragged, tag2 };
      const sizeTxt = document.querySelector('#scPenSize').textContent;
      // 우클릭 맞히기: 획 위 = 맞음, 멀리 = 아님
      const hitOn = T.hitManual(P, 90, 185.3), hitOff = T.hitManual(P, 90, 195);
      return { L, R, angle: g.angle, manual: plan.manual, tag, undoOn: !document.querySelector('#scManUndo').disabled,
        edge, ctr, pen: { tR, tP, w0, w1, w2, P: { w: P.w, n: P.pts.length, first: P.pts[0], last: P.pts[P.pts.length - 1] }, n2: plan2.manual.length, sizeTxt, hitOn, hitOff, tool: T.tool() } };
    })()`);
    const near = (a, b, t) => a && b && Math.abs(a.x + a.w / 2 - (b.x + b.w / 2)) < t && Math.abs(a.y + a.h / 2 - (b.y + b.h / 2)) < t;
    ok(near(mn.L, { x: 70, y: 160, w: 40, h: 20 }, 0.3) && Math.abs(mn.L.w - 40) < 0.3, '왼쪽에서 끈 사각형 = 원래 스캔 mm ' + JSON.stringify(mn.L));
    ok(near(mn.R, mn.L, 0.5) && mn.R.w >= 39.5, `오른쪽(${mn.angle}° 돌아간 그림)에서 끈 같은 자리 → 같은 원래 자리(감싸는 사각형) ` + JSON.stringify(mn.R));
    ok(mn.ctr.cen && Math.abs(mn.ctr.arrow.x - 1) < 0.01 && Math.abs(mn.ctr.arrow.y - 5) < 0.01, '⊕ 가운데로 ' + JSON.stringify(mn.ctr.cen) + ' · 화살표 → → Shift+↓ = 1mm, 5mm ' + JSON.stringify(mn.ctr.arrow));
    ok(Math.abs(mn.ctr.dragged.x - 10) <= 0.8 && Math.abs(mn.ctr.dragged.y) <= 0.3 && /⇔ →(9|10)/.test(mn.ctr.tag2), '✥ 이동 도구로 오른쪽 그림을 10mm 끌기 → ' + JSON.stringify(mn.ctr.dragged) + ' · 목록 ' + mn.ctr.tag2.replace(/\s+/g, ' '));
    ok(mn.edge.hitB === 'bottom' && Math.abs(mn.edge.after1 - 12) <= 0.8 && /띠·직접/.test(mn.edge.tag1), `빨간 띠 경계를 끌어 아래 폭 ${mn.edge.auto0} → ${mn.edge.after1}mm · 목록 '띠·직접'`);
    ok(mn.edge.reset === mn.edge.auto0 && Math.abs(mn.edge.final - 12) <= 0.8 && mn.edge.top === 0, '↺ 띠 자동 → 판정값으로, 다시 끌어 12mm · 다른 쪽(위)은 그대로 ' + JSON.stringify(mn.edge));
    ok(mn.pen.tR === 'rect' && mn.pen.tP === 'pen', '단축키 R(한글 ㄱ) = 사각형 · P(한글 ㅔ) = 펜');
    ok(mn.pen.w1 > mn.pen.w0 && mn.pen.w2 < mn.pen.w1 && mn.pen.w2 > mn.pen.w0 && mn.pen.sizeTxt.includes(mn.pen.w2 + 'mm'), `펜 굵기 단축키 ] ] [ → ${mn.pen.w0} → ${mn.pen.w1} → ${mn.pen.w2}mm · 표시 ` + mn.pen.sizeTxt);
    ok(mn.pen.tool === 'pen' && mn.pen.n2 === 2 && Math.abs(mn.pen.P.first[0] - 66) < 0.3 && Math.abs(mn.pen.P.first[1] - 185) < 0.3 && Math.abs(mn.pen.P.last[0] - 114) < 0.3 && mn.pen.P.n >= 10,
      '오른쪽(돌아간 그림)에 그은 펜 획 → 원래 스캔 mm로 되돌림 ' + JSON.stringify(mn.pen.P));
    ok(mn.pen.hitOn && !mn.pen.hitOff, '우클릭 맞히기: 획 위만');
    ok(mn.manual && mn.manual.length === 1 && /직접 1/.test(mn.tag) && mn.undoOn, '계획에 직접 지운 곳 1개(하나 취소 반영) · 목록 표시 ' + mn.tag.replace(/\\s+/g, ' '));
    // 💾 중간 저장(Ctrl+S) — 고친 것을 쪽에 반영하고 작업 저장, 창은 그대로(합성만 · 저장 창은 가짜로)
    if (!REAL) {
      const ms = await ev(`(async () => {
        const T = document.querySelector('.merge-overlay').__scTest;
        await T.goRow(0);
        let calls = 0; const os = window.saveWorkFile; window.saveWorkFile = async () => { calls++; return true; };
        const ctrlS = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true }));
        const waitSaved = async n => { for (let i = 0; i < 300 && calls < n; i++) await new Promise(r => setTimeout(r, 100)); await new Promise(r => setTimeout(r, 200)); };
        ctrlS(); await waitSaved(1);
        const a = { calls, man: ((contentEdits.get(0) || {}).scan || {}).manual, info: document.querySelector('#scSaveInfo').textContent,
          open: !!document.querySelector('.sc-modal'), applyOn: !document.querySelector('#scApply').disabled, undo: document.querySelector('#scUndo').style.display !== 'none' };
        const rev1 = (contentEdits.get(0) || {}).rev;
        // 이어서 하나 더 지우고 다시 저장 → 반영 · 그 뒤 Ctrl+Z로 빼고 저장 → 다시 1개
        T.addManual({ x: 20, y: 20, w: 5, h: 5 });
        ctrlS(); await waitSaved(2);
        const man2 = ((contentEdits.get(0) || {}).scan || {}).manual;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true }));
        ctrlS(); await waitSaved(3);
        const man3 = ((contentEdits.get(0) || {}).scan || {}).manual, rev3 = (contentEdits.get(0) || {}).rev;
        // 바뀐 것 없이 저장 → 다시 굽지 않음
        ctrlS(); await waitSaved(4);
        const rev4 = (contentEdits.get(0) || {}).rev;
        window.saveWorkFile = os;
        return { a, n1: a.man && a.man.length, n2: man2 && man2.length, n3: man3 && man3.length, rev1, rev3, rev4, calls, errs: window.__errs.slice() };
      })()`);
      ok(ms.a.calls === 1 && ms.n1 >= 1 && ms.a.open && ms.a.applyOn && ms.a.undo && /저장함/.test(ms.a.info), '💾 Ctrl+S 중간 저장: 직접 지운 곳이 쪽에 반영 · 작업 저장 · 창 그대로(정리하기 버튼 살아 있음) · ' + ms.a.info);
      ok(ms.n2 === ms.n1 + 1 && ms.n3 === ms.n1 && ms.rev3 > ms.rev1, `저장 ${ms.n1}개 → 이어서 지우고 다시 저장 → ${ms.n2}개 · Ctrl+Z 뒤 저장 → ${ms.n3}개`);
      ok(ms.rev4 === ms.rev3 && ms.calls === 4 && !ms.errs.length, '바뀐 것 없이 저장하면 다시 굽지 않고 저장만');
    }
    // 적용 — 합성은 전부, 실파일은 처음 2쪽만(나머지 쪽 끄기)
    const ap = await ev(`(async () => {
      ${REAL ? `document.querySelector('#scAllOff').click(); for (const i of [0, 1]) document.querySelectorAll('#scList .rbv-pgchk')[i].click();` : ''}
      // 📐 기울기 보정을 켜 둔 채 적용 → 두 번 돌지 않게 '끄고 정리'를 묻는다
      ensureAdjustFields(editSettings).deskew.enabled = true;
      let asked = null; const oa = window.askChoice; window.askChoice = async (m) => { asked = m; return 'off'; };
      document.querySelector('#scApply').click();
      for (let i = 0; i < 600 && !document.querySelector('#scSub').textContent.includes('정리했습니다'); i++) await new Promise(r => setTimeout(r, 200));
      window.askChoice = oa;
      const recs = [...contentEdits.entries()].filter(([, v]) => v.scan).map(([k, v]) => ({ k, deskew: v.scan.deskew, bottom: v.scan.edges.bottom, spots: v.scan.spots.length, len: v.bytes.length }));
      return { sub: document.querySelector('#scSub').textContent, recs, undoShown: document.querySelector('#scUndo').style.display !== 'none', errs: window.__errs.slice(),
        asked: !!(asked && asked.includes('기울기 보정')), fastOrig: pageResults[0].scanThumbOrig || null, fastThumb: pageResults[0].thumbnail, fastW: pageResults[0].thumbW, dkOff: !editSettings.deskew.enabled && !document.getElementById('esDkEnabled').checked };
    })()`);
    if (!REAL) ok(ap.asked && ap.dkOff, '📐 기울기 보정이 켜져 있으면 묻고 → 끄고 정리 ' + JSON.stringify({ asked: ap.asked, off: ap.dkOff }));
    ok(ap.fastOrig && ap.fastThumb && ap.fastThumb !== ap.fastOrig && ap.fastW > 200, '⚡ 빠른 썸네일: 정리 창 미리보기에 정리를 입힌 그림으로 바뀜 · 정리 전 썸네일은 남겨 둠 (폭 ' + ap.fastW + ')');
    ok(ap.recs.length >= (REAL ? 1 : 2) && ap.undoShown && !ap.errs.length, `적용 → 쪽 편집본 ${ap.recs.length}쪽(scan 계획 포함) · 되돌리기 버튼 ` + JSON.stringify(ap.recs.slice(0, 3)));
    // 구운 쪽을 앱의 판정기로 다시 재면 띠·기울기가 거의 없어야 한다(합성)
    const re = await ev(`(async () => {
      const k = [...contentEdits.keys()].find(i => contentEdits.get(i).scan);
      const b = contentEdits.get(k).bytes;
      const pdf = await pdfjsLib.getDocument({ data: b.slice(0) }).promise; const page = await pdf.getPage(1);
      const vp = page.getViewport({ scale: 150 / 72 }); const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const x = c.getContext('2d', { willReadFrequently: true }); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: x, viewport: vp }).promise;
      const id = x.getImageData(0, 0, c.width, c.height).data, g = new Uint8Array(c.width * c.height);
      for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (id[j] * 77 + id[j + 1] * 150 + id[j + 2] * 29) >> 8;
      const r = scanAnalyze(g, c.width, c.height, { dpi: 150 });
      // 맨 위 진짜 글자 줄(8~11mm)이 살아 있는지 — 가운데 세로 띠에서 진한 점 수
      let dark = 0; const MM = 150 / 25.4; for (let y = Math.round(8.3 * MM); y < Math.round(10.7 * MM); y++) for (let xx = Math.round(30 * MM); xx < Math.round(170 * MM); xx++) if (g[y * c.width + xx] < 100) dark++;
      let pen = 0; for (let y = Math.round(184 * MM); y < Math.round(186 * MM); y++) for (let xx = Math.round(70 * MM); xx < Math.round(110 * MM); xx++) if (g[y * c.width + xx] < 200) pen++;
      let hole = 0; for (let y = Math.round(164 * MM); y < Math.round(176 * MM); y++) for (let xx = Math.round(74 * MM); xx < Math.round(106 * MM); xx++) if (g[y * c.width + xx] < 200) hole++;
      await pdf.destroy();
      return { k, angle: r.angle, bottom: r.edges.bottom, spots: r.spots.length, topRowDark: dark, hole, pen, eb: contentEdits.get(k).scan.edges.bottom, manual: (contentEdits.get(k).scan.manual || []).length };
    })()`);
    if (!REAL) {
      ok(Math.abs(re.angle) <= 0.15 && re.bottom === 0, `구운 쪽을 다시 재면 기울기 ${re.angle}° · 아래 띠 ${re.bottom}mm (없어짐)`);
      ok(re.topRowDark > 500, '가장자리 가까이의 진짜 글자 줄은 남아 있다 (진한 점 ' + re.topRowDark + ')');
      ok(Math.abs(re.eb - 12) <= 0.8, '고친 아래 띠 폭이 구운 쪽 계획에 (' + re.eb + 'mm)');
      ok(re.pen === 0, '펜으로 그은 줄(사진 상자 아래쪽)이 구운 쪽에서 흰색 (남은 진한 점 ' + re.pen + ')');
      ok(re.k === 0 && re.manual === 2 && re.hole === 0, '직접 지운 곳(사진 상자 가운데)이 구운 쪽에서 흰색 · 계획에 저장 ' + JSON.stringify({ k: re.k, manual: re.manual, hole: re.hole }));
    }
    if (!REAL) {
      const mv = await ev(`(async () => {
        const rec = contentEdits.get(1); if (!rec) return { none: true };
        const pdf = await pdfjsLib.getDocument({ data: rec.bytes.slice(0) }).promise; const page = await pdf.getPage(1);
        const vp = page.getViewport({ scale: 150 / 72 }); const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        const x = c.getContext('2d', { willReadFrequently: true }); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: x, viewport: vp }).promise;
        const d = x.getImageData(0, 0, c.width, c.height).data, MM = 150 / 25.4;
        let n = 0, t = 0; for (let y = Math.round(165 * MM); y < Math.round(175 * MM); y++) for (let q = Math.round(123 * MM); q < Math.round(128 * MM); q++) { t++; if (d[(y * c.width + q) * 4] < 128) n++; }
        await pdf.destroy();
        return { shift: rec.scan.shift, dark: n, tot: t };
      })()`);
      ok(mv.shift && Math.abs(mv.shift.x - 10) <= 0.8 && mv.dark > mv.tot * 0.8, '구운 2쪽: 사진 상자가 10mm 오른쪽으로(123~128mm가 사진) ' + JSON.stringify(mv));
    }
    // 실파일이면 구운 쪽을 PNG로 남겨 눈 확인
    const keep = await ev(`(async () => { const k = [...contentEdits.keys()].find(i => contentEdits.get(i).scan); return await window.electronAPI.writeTempFile(contentEdits.get(k).bytes, 'pdf'); })()`);
    const png = path.join(os.tmpdir(), 'scan-clean-baked.png');
    try { execFileSync('gswin64c', ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=pnggray', '-r150', '-dDownScaleFactor=4', '-o', png, keep]); console.log('    구운 쪽 그림 → ' + png); } catch (e) {}
    try { fs.unlinkSync(keep); } catch (e) {}
    // 되돌리기
    const ud0 = await ev(`pageResults[0].scanThumbOrig || ''`);
    const ud = await ev(`(async () => { document.querySelector('#scUndo').click(); for (let i = 0; i < 1200 && document.querySelector('#scUndo').style.display !== 'none'; i++) await new Promise(r => setTimeout(r, 100)); window.__udThumb = pageResults[0].thumbnail; return [...contentEdits.values()].filter(v => v.scan).length; })()`);
    const udThumb = await ev(`window.__udThumb`);
    ok(ud0 && udThumb === ud0, '↺ 되돌리기 → 남겨 둔 정리 전 썸네일로 바로(PDF에서 다시 그리지 않음)');
    ok(ud === 0, '↺ 되돌리기 → 스캔 정리 편집본 없음');
    // 다시 적용 → 내부 편집기 저장 흉내(원본 쪽을 편집 결과로) → 스캔 정리가 다시 입혀지는지
    const ed = await ev(`(async () => {
      document.querySelector('#scApply').click();
      for (let i = 0; i < 600 && !document.querySelector('#scSub').textContent.includes('정리했습니다'); i++) await new Promise(r => setTimeout(r, 200));
      const k = [...contentEdits.keys()].find(i => contentEdits.get(i).scan);
      const before = contentEdits.get(k);
      const d = await PDFLib.PDFDocument.create(); const [pg] = await d.copyPages(await getSourceDoc(), [k]); d.addPage(pg);
      const p = await window.electronAPI.writeTempFile(await d.save(), 'pdf');
      await applyEditorResult({ edits: { [k]: { bytesPath: p, model: [{ t: 'dummy' }] } } });
      const after = contentEdits.get(k);
      const a1 = { scan: !!after.scan, prev: !!after.scanPrev, model: (after.model || []).length, rev: after.rev > before.rev };
      await applyEditorResult({ removed: [k] });
      const r2 = contentEdits.get(k);
      return { k, a1, removedKeepsScan: !!(r2 && r2.scan), errs: window.__errs.slice() };
    })()`);
    ok(ed.a1.scan && ed.a1.prev && ed.a1.model === 1 && ed.a1.rev, '내부 편집기 저장 뒤에도 스캔 정리가 다시 입혀짐(편집 내용 유지) ' + JSON.stringify(ed.a1));
    ok(ed.removedKeepsScan && !ed.errs.length, '편집을 다 지워도 스캔 정리는 남는다');
    // 작업 파일 왕복 — scan 계획이 남고, 다시 연 뒤 또 적용해도 두 번 돌지 않는다
    if (!REAL) {
      // 내부 편집 표시(빨간 사각형)를 넣어 둔다 — 다시 연 뒤 또 정리해도 이 편집이 남아야 한다
      const mk = await ev(`(async () => {
        const k = [...contentEdits.keys()].find(i => contentEdits.get(i).scan);
        const d = await PDFLib.PDFDocument.create(); const [pg] = await d.copyPages(await getSourceDoc(), [k]); d.addPage(pg);
        d.getPage(0).drawRectangle({ x: 250, y: 400, width: 60, height: 60, color: PDFLib.rgb(1, 0, 0) });
        const p = await window.electronAPI.writeTempFile(await d.save(), 'pdf');
        await applyEditorResult({ edits: { [k]: { bytesPath: p, model: [{ t: 'mark' }] } } });
        return k;
      })()`);
      // 작업 파일에 scan 계획이 담기고 scanPrev는 담기지 않는다 → 다시 연 상태(scanPrev 없음)를 흉내 내 또 적용
      const wf = await ev(`(async () => {
        const wfo = await buildWorkFileBytes();   // { parts, manifest, bytes(게터) }
        const txt = JSON.stringify(wfo.manifest);
        const n = txt.split('"scan":{').length - 1, np = txt.split('scanPrev').length - 1;
        contentEdits.forEach(v => { if (v.scan) delete v.scanPrev; });
        return { n, np, keys: [...contentEdits.entries()].filter(([, v]) => v.scan).length, errs: window.__errs.slice() };
      })()`);
      ok(wf.n === wf.keys && wf.np === 0 && !wf.errs.length, '작업 파일에 scan 계획 ' + wf.n + '쪽(편집본 ' + wf.keys + '쪽) · scanPrev는 담지 않음');
      const again = await ev(`(async () => {
        document.querySelectorAll('.merge-overlay').forEach(o => o.remove());
        window.__scanOpen = openScanCleanModal();
        for (let i = 0; i < 600 && (!document.querySelector('#scApply') || document.querySelector('#scApply').textContent.includes('판정 중')); i++) await new Promise(r => setTimeout(r, 200));
        document.querySelector('#scApply').click();
        for (let i = 0; i < 600 && !document.querySelector('#scSub').textContent.includes('정리했습니다'); i++) await new Promise(r => setTimeout(r, 200));
        const k = ${mk};
        const rec = contentEdits.get(k), b = rec.bytes;
        const pdf = await pdfjsLib.getDocument({ data: b.slice(0) }).promise; const page = await pdf.getPage(1);
        const vp = page.getViewport({ scale: 150 / 72 }); const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        const x = c.getContext('2d', { willReadFrequently: true }); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: x, viewport: vp }).promise;
        const id = x.getImageData(0, 0, c.width, c.height).data, g = new Uint8Array(c.width * c.height);
        let red = 0;
        for (let i = 0, j = 0; i < g.length; i++, j += 4) { g[i] = (id[j] * 77 + id[j + 1] * 150 + id[j + 2] * 29) >> 8; if (id[j] > 200 && id[j + 1] < 80 && id[j + 2] < 80) red++; }
        await pdf.destroy();
        return { angle: scanAnalyze(g, c.width, c.height, { dpi: 150 }).angle, red, model: (rec.model || []).length, scan: !!rec.scan, manual: (rec.scan.manual || []).length };
      })()`);
      ok(Math.abs(again.angle) <= 0.15, '다시 연 뒤 또 적용해도 두 번 돌지 않는다(다시 잰 기울기 ' + again.angle + '°)');
      ok(again.manual === 2, '다시 열어 또 정리해도 직접 지운 곳이 그대로 (' + again.manual + '개)');
      ok(again.red > 1000 && again.model === 1 && again.scan, '다시 연 뒤 또 정리해도 내부 편집 내용(빨간 표시)이 남는다 ' + JSON.stringify(again));
    }
  } catch (e) { fail++; console.error(e); }
  finally {
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (e) {}
    await sleep(800);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    console.log(`\n결과: 통과 ${pass} · 실패 ${fail}`);
    process.exit(fail ? 1 : 0);
  }
})();
