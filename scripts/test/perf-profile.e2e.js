// ⏱ 런타임 성능 프로파일 — 실제 문서로 분석·미리보기·적용 구간별 시간을 잰다.
//   실행: npx electron scripts/test/perf-profile.e2e.js "D:\경로\문서.pdf"
//   ⚠ show:true 여야 한다 — 오프스크린은 rAF가 1fps로 조여져 렌더 시간이 왜곡된다.
const path = require('path');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');
const TARGET = process.argv.find(a => /\.pdf$/i.test(a));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1440, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 1500));

  let res;
  try {
    res = await win.webContents.executeJavaScript(`(async () => {
      const T = [];
      const mark = (n, ms, x) => T.push([n, Math.round(ms), x === undefined ? '' : String(x)]);
      const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 300000)) { if (f()) return true; await new Promise(r => setTimeout(r, 30)); } return false; };
      const P = ${JSON.stringify(TARGET)};
      const t_read = performance.now();
      const ab = window.electronAPI.readFile(P);
      mark('파일 읽기(fs)', performance.now() - t_read, (ab.byteLength/1048576).toFixed(1) + 'MB');
      const name = P.split(/[\\/]/).pop();
      const file = { name, size: ab.byteLength, type: 'application/pdf', arrayBuffer: () => Promise.resolve(ab.slice(0)) };

      // ── 1. 분석 ──
      // 메인 스레드 포화 측정 — 4ms 간격 타이머가 몇 번이나 제때 돌았는지
      let ticks = 0, worst = 0, prev = performance.now();
      const iv = setInterval(() => { const n = performance.now(); const d = n - prev; prev = n; ticks++; if (d > worst) worst = d; }, 4);
      const t0 = performance.now();
      startLoad([file]);
      await waitFor(() => pageResults.length > 0 && pageResults.every(r => r && r.thumbnail !== undefined), 600000);
      const tAnalyze = performance.now() - t0;
      mark('분석 전체(열기→썸네일 완료)', tAnalyze, pageResults.length + '쪽');
      mark('  쪽당', tAnalyze / Math.max(1, pageResults.length));
      clearInterval(iv);
      const expect = tAnalyze / 4;
      mark('  메인스레드 여유(타이머 실행률 %)', Math.round(ticks / expect * 100), 'ticks=' + ticks + ' / 기대 ' + Math.round(expect) + ', 최장 정지 ' + Math.round(worst) + 'ms');
      const cc = pageResults.filter(r => r && r.isColor).length;
      mark('  컬러 판정', 0, cc + '쪽 컬러 / ' + (pageResults.length - cc) + '쪽 흑백');
      const tw = pageResults.map(r => (r && r.thumbW) || 0);
      mark('  썸네일 폭', 0, '최소 ' + Math.min(...tw) + ' / 최대 ' + Math.max(...tw) + 'px, 보정대상 '
           + pageResults.filter(r => r && r.thumbLow).length + '쪽');
      mark('  코어', 0, 'cores=' + navigator.hardwareConcurrency);
      const PR = window.__PROF || {};
      mark('  ├ 캔버스 생성', PR.canvas || 0, PR.px ? PR.px + 'px' : '');
      mark('  ├ page.render (메인스레드 래스터)', PR.render || 0);
      mark('  ├ getImageData', PR.gid || 0);
      mark('  ├ 픽셀 샘플 판정', PR.sample || 0);
      mark('  ├ 나머지 setup', PR.setup || 0);
      mark('  └ toBlob JPEG 인코딩(비동기)', PR.blob || 0, (PR.n||0) + '장');

      await new Promise(r => setTimeout(r, 500));

      // ── 2. 편집 사이드바 열기 + 미리보기 ──
      const t1 = performance.now();
      toggleEditSidebar(true);
      await new Promise(r => setTimeout(r, 600));
      mark('편집 사이드바 열기', performance.now() - t1);

      // ── 3. 편집 옵션 1회 변경(여백) → 반영까지 ──
      const en = document.getElementById('esMgEnabled');
      en.checked = true; en.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 400));
      await waitFor(() => !_liveRunning && !_liveQueued, 300000);
      const t2 = performance.now();
      const m = document.getElementById('esMgTop');
      m.value = '7'; m.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 250));
      await waitFor(() => !_liveRunning && !_liveQueued, 300000);
      await new Promise(r => setTimeout(r, 150));
      mark('여백 1회 변경 → 미리보기 반영', performance.now() - t2);

      // ── 4. 적용(전체 파이프라인) ──
      const t3 = performance.now();
      await applyChanges();
      await waitFor(() => !!processedPdfBytes, 600000);
      mark('적용(processedPdfBytes 생성)', performance.now() - t3,
           processedPdfBytes ? (processedPdfBytes.byteLength/1048576).toFixed(1)+'MB' : '');

      return T;
    })()`);
  } catch (e) {
    console.error('하네스 오류:', e && e.message);
    app.exit(1); return;
  }
  console.log('\n=== ⏱ 성능 프로파일: ' + TARGET + ' ===');
  for (const [n, ms, x] of res) console.log(String(ms).padStart(8) + ' ms  ' + n + (x ? '   [' + x + ']' : ''));
  app.exit(0);
});
