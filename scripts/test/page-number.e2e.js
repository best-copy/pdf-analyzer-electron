// 🔢 페이지 번호(머리글·바닥글과 독립) — 실제 앱 파이프라인으로 찍고 텍스트·좌표로 검증한다.
//   실행: npx electron scripts/test/page-number.e2e.js
// 확인 항목: 번호 서식 · 시작 위치/시작 번호 · 제외 페이지 · 내각/외각 홀짝 대칭 · 상단/하단
const path = require('path');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  ✔', n); } else { fail++; console.log('  ✘', n, x !== undefined ? JSON.stringify(x) : ''); } };

app.whenReady().then(async () => {
  setTimeout(() => { console.log('\n✘ 시간 초과(5분)'); app.exit(1); }, 300000).unref();
  const win = new BrowserWindow({ show: true, width: 1440, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('    [renderer]', msg); });
  try {
    await win.loadFile(path.join(ROOT, 'src/index.html'));
    await new Promise(r => setTimeout(r, 1600));
    const run = js => win.webContents.executeJavaScript(js);

    // 10쪽짜리 시험 문서를 만들어 실제 열기 경로로 연다
    await run(`(async () => {
      const doc = await PDFLib.PDFDocument.create();
      for (let i = 0; i < 10; i++) {
        const p = doc.addPage([595.28, 841.89]);
        p.drawText('BODY ' + (i + 1), { x: 60, y: 500, size: 20 });
      }
      const bytes = new Uint8Array(await doc.save());
      const file = { name: '번호시험.pdf', size: bytes.byteLength, type: 'application/pdf',
                     arrayBuffer: () => Promise.resolve(bytes.buffer.slice(0)) };
      const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 120000)) { if (f()) return true; await new Promise(r => setTimeout(r, 40)); } return false; };
      startLoad([file]);
      await waitFor(() => pageResults.length > 0 && pageResults.every(r => r && r.thumbnail !== undefined));
      window.__waitFor = waitFor;
      return pageResults.length;
    })()`);

    // 설정을 넣고 적용 → 결과 PDF에서 쪽마다 텍스트와 좌표를 뽑는다
    const readOut = async (pn) => run(`(async () => {
      Object.assign(activeLayoutSettings().pn, ${JSON.stringify(pn)});
      syncPnUI();
      processedPdfBytes = null;
      await applyChanges();
      await window.__waitFor(() => !!processedPdfBytes);
      const pdf = await openPdfDoc({ data: processedPdfBytes.slice(0) }).promise;
      const out = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const pg = await pdf.getPage(i);
        const vp = pg.getViewport({ scale: 1 });
        const tc = await pg.getTextContent();
        // 본문('BODY N')이 아닌 조각만 = 우리가 찍은 페이지 번호
        const items = tc.items.filter(t => t.str && t.str.trim() && !/^BODY/.test(t.str.trim()));
        out.push(items.map(t => ({ s: t.str.trim(), x: Math.round(t.transform[4]), y: Math.round(t.transform[5]), w: Math.round(vp.width) })));
      }
      await pdf.destroy();
      return out;
    })()`);

    // ── 1. 기본: 하단 중앙, {page} ────────────────────────────────────────
    console.log('\n[1] 하단 중앙 · 서식 {page}');
    let r = await readOut({ enabled: true, fmt: '{page}', pos: 'bottom-center', start: 1, numFrom: 1, exclude: '', size: 12, offX: 0, offY: 0, bold: false });
    ck('모든 쪽에 번호가 있다', r.every(p => p.length === 1), r.map(p => p.length));
    ck('번호가 1~10', r.map(p => p[0] && p[0].s).join(',') === '1,2,3,4,5,6,7,8,9,10', r.map(p => p[0] && p[0].s));
    ck('하단에 있다 (y가 작다)', r.every(p => p[0].y < 60), r[0]);
    ck('가운데 정렬 (좌우 대칭)', r.every(p => Math.abs(p[0].x - p[0].w / 2) < 12), r[0]);

    // ── 2. 서식·시작 위치·시작 번호 ──────────────────────────────────────
    console.log('\n[2] 서식 {page} / {total} · 시작 위치 3 · 시작 번호 1');
    r = await readOut({ fmt: '{page} / {total}', start: 3, numFrom: 1, exclude: '' });
    ck('1·2쪽은 번호 없음', r[0].length === 0 && r[1].length === 0, [r[0], r[1]]);
    ck('3쪽 = 1 / 8 (전체도 본문 기준)', r[2][0] && r[2][0].s === '1 / 8', r[2]);
    ck('10쪽 = 8 / 8', r[9][0] && r[9][0].s === '8 / 8', r[9]);

    // ── 3. 제외 페이지 ──────────────────────────────────────────────────
    console.log('\n[3] 제외 페이지 "1, 4-6"');
    r = await readOut({ fmt: '{page}', start: 1, numFrom: 1, exclude: '1, 4-6' });
    ck('1쪽 제외', r[0].length === 0, r[0]);
    ck('4·5·6쪽 제외', [3, 4, 5].every(i => r[i].length === 0), [r[3], r[4], r[5]]);
    ck('2·3·7쪽은 찍힘', [1, 2, 6].every(i => r[i].length === 1), [r[1], r[2], r[6]]);
    ck('제외해도 번호는 이어진다(7쪽=7)', r[6][0] && r[6][0].s === '7', r[6]);

    // ── 4. 외각(바깥쪽) — 홀·짝 좌우 대칭 ────────────────────────────────
    console.log('\n[4] 하단 외각 — 홀수쪽 오른쪽 · 짝수쪽 왼쪽');
    r = await readOut({ fmt: '{page}', start: 1, numFrom: 1, exclude: '', pos: 'bottom-outer' });
    const odd = r[0][0], even = r[1][0];
    ck('홀수쪽(1p)은 오른쪽', odd && odd.x > odd.w * 0.6, odd);
    ck('짝수쪽(2p)은 왼쪽', even && even.x < even.w * 0.4, even);
    ck('좌우가 거울 대칭', odd && even && Math.abs((odd.w - odd.x) - even.x) < 20, [odd, even]);

    // ── 5. 내각(제본 쪽) — 외각의 반대 ───────────────────────────────────
    console.log('\n[5] 하단 내각 — 홀수쪽 왼쪽 · 짝수쪽 오른쪽');
    r = await readOut({ pos: 'bottom-inner' });
    ck('홀수쪽(1p)은 왼쪽', r[0][0] && r[0][0].x < r[0][0].w * 0.4, r[0]);
    ck('짝수쪽(2p)은 오른쪽', r[1][0] && r[1][0].x > r[1][0].w * 0.6, r[1]);

    // ── 6. 상단 + 위치 미세 이동 ─────────────────────────────────────────
    console.log('\n[6] 상단 중앙 + Y 이동');
    r = await readOut({ pos: 'top-center', offX: 0, offY: 0 });
    const topY = r[0][0].y;
    ck('상단에 있다', topY > 700, r[0]);
    const r2 = await readOut({ pos: 'top-center', offY: 10 });   // +Y = 아래로 10mm
    ck('Y +10mm면 아래로 내려간다', r2[0][0].y < topY - 25, [topY, r2[0][0].y]);
    const r3 = await readOut({ pos: 'top-center', offY: 0, offX: 20 });
    ck('X +20mm면 오른쪽으로 간다', r3[0][0].x > r[0][0].x + 50, [r[0][0].x, r3[0][0].x]);

    // ── 6-2. 번호 색상 — 렌더해서 실제 픽셀 색을 본다 ────────────────────
    // (텍스트 추출로는 색을 알 수 없다. 번호를 크게 키워 확실히 잡히게 한 뒤 표본을 뜬다)
    console.log('\n[6-2] 번호 색상');
    const colorOf = async (hex) => run(`(async () => {
      Object.assign(activeLayoutSettings().pn,
        { enabled: true, fmt: '8', pos: 'bottom-center', start: 1, numFrom: 1, exclude: '', size: 60, offX: 0, offY: 0, bold: false, color: ${JSON.stringify(hex)} });
      syncPnUI();
      processedPdfBytes = null;
      await applyChanges();
      await window.__waitFor(() => !!processedPdfBytes);
      const pdf = await openPdfDoc({ data: processedPdfBytes.slice(0) }).promise;
      const pg = await pdf.getPage(1);
      const vp = pg.getViewport({ scale: 2 });
      const cv = document.createElement('canvas');
      cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
      await pg.render({ canvasContext: ctx, viewport: vp }).promise;
      // 하단 20% 영역에서 가장 진한(흰색이 아닌) 픽셀을 찾는다 = 번호 글자
      const y0 = Math.floor(cv.height * 0.8);
      const d = ctx.getImageData(0, y0, cv.width, cv.height - y0).data;
      let best = null, bestSum = 1e9;
      for (let i = 0; i < d.length; i += 4) {
        const s = d[i] + d[i + 1] + d[i + 2];
        if (s < bestSum) { bestSum = s; best = [d[i], d[i + 1], d[i + 2]]; }
      }
      await pdf.destroy();
      return best;
    })()`);
    const near = (got, want, tol) => got && Math.abs(got[0] - want[0]) <= tol && Math.abs(got[1] - want[1]) <= tol && Math.abs(got[2] - want[2]) <= tol;
    const red = await colorOf('#ff0000');
    ck('빨강(#ff0000)으로 찍힌다', near(red, [255, 0, 0], 40), red);
    const blue = await colorOf('#0000ff');
    ck('파랑(#0000ff)으로 찍힌다', near(blue, [0, 0, 255], 40), blue);
    const gray = await colorOf('#333333');
    ck('기본 진회색(#333333)', near(gray, [51, 51, 51], 30), gray);

    // ── 7. 머리글·바닥글과 독립인지 ──────────────────────────────────────
    console.log('\n[7] 머리글·바닥글을 끈 채로도 동작한다');
    const hfOff = await run('activeLayoutSettings().hf.enabled === false');
    ck('머리글·바닥글은 꺼져 있다', hfOff === true, hfOff);
    ck('그래도 번호는 찍혔다', r3[0].length === 1, r3[0]);
  } catch (e) {
    fail++; console.log('  ✘ 예외:', (e && e.message) || e, '\n', (e && e.stack || '').split('\n').slice(0, 3).join('\n'));
  }
  console.log(`\n${fail ? '✘ 실패' : '✅ 통과'} — ${pass}개 성공, ${fail}개 실패`);
  app.exit(fail ? 1 : 0);
});
