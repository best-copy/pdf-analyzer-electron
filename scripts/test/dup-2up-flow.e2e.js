// 📖 대용량 작업 파일 + 복제 2-up 프리셋 — 사용자 흐름 그대로 (열기 → 프리셋 → ✔ 적용 → ⇩ 다운로드 → 우클릭 원본)
//   실행: set DUP_PDFW=D:\...\작업.pdfw & npx electron scripts/test/dup-2up-flow.e2e.js   (창 없음 · 작업 파일은 읽기만)
//   임시 폴더에 결과 PDF 두 개(각 ≈1GB)를 잠깐 쓰고 지운다.
// 회귀: 도록 150쪽(원본 998MB·적용본 952MB)에 '270-390_양면_2up_논문'을 불러 적용하면
//   "처리 중 오류: Array buffer allocation failed" → 적용본이 비어 다운로드가 흐리고 적용 버튼이 계속 반짝였다.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');
const ROOT = path.join(__dirname, '..', '..');
const PDFW = process.env.DUP_PDFW;
if (!PDFW || !fs.existsSync(PDFW)) { console.log('DUP_PDFW 에 작업 파일 경로를 주세요 — 건너뜀'); process.exit(0); }

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-e2e-dup2up-flow'));
const OUTS = [];
// 하네스에는 main.js가 없다 — 저장 경로·덮어쓰기 확인 IPC만 대역으로 (진짜 다이얼로그가 뜨면 멈춘다)
ipcMain.handle('dialog:saveFilePath', (_e, { defaultName }) => {
  const p = path.join(os.tmpdir(), `pdfedit_e2e_dupflow_${OUTS.length}.pdf`);
  OUTS.push(p);
  return p;
});
ipcMain.handle('dialog:confirmSavePath', (_e, { filePath }) => filePath);

const t0 = Date.now();
const sec = () => ((Date.now() - t0) / 1000).toFixed(0) + 's';
function metrics() {
  const m = app.getAppMetrics().find(x => x.type === 'Tab' || x.type === 'Renderer');
  return m ? Math.round(m.memory.privateBytes / 1024) + 'MB' : '?';
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 3) console.log('    [console.error]', msg.slice(0, 300)); });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));
  const run = code => win.webContents.executeJavaScript(`(async () => { try { ${code} } catch (e) { return { __err: String(e && e.stack || e) }; } })()`);
  const res = [];
  const ck = (n, c, x) => { res.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]); console.log(`  ${c ? '✔' : '✘'} [${sec()} · 렌더러 ${metrics()}] ${n} ${x === undefined ? '' : JSON.stringify(x).slice(0, 400)}`); };
  try {
    await run(`window.__errs = []; const oe = window.showError; window.showError = m => { window.__errs.push(String(m)); try { oe(m); } catch (e) {} };
               window.confirm = () => true; window.alert = () => {}; return 1;`);
    const opened = await run(`return await openWorkFilePath(${JSON.stringify(PDFW)});`);
    ck('작업 파일 열기', opened === true, opened);
    // 열자마자 도는 최적화본 프리웜이 끝날 때까지 (적용과 겹치면 메모리를 더 쓴다 — 실사용과 같게 기다려 준다)
    await new Promise(r => setTimeout(r, 4000));
    const st0 = await run(`return { pages: pageResults.filter(Boolean).length, applied: !!processedPdfBytes, errs: window.__errs.slice() };`);
    ck('적용본까지 복원(재계산 없음)', st0.applied && st0.pages === 150, st0);

    // 하네스에는 Ghostscript IPC가 없다 — 폰트 안전화는 끈다(저장 단계라 조판·메모리와 무관)
    const prof = await run(`
      try { _outlineEnabled = false; } catch (e) {}
      const list = loadImpProfiles();
      const idx = list.findIndex(p => p.n === '270-390_양면_2up_논문');
      document.getElementById('impProfile').value = String(idx);
      loadImpProfile();
      const b = document.getElementById('applyBtn');
      return { idx, impEnabled: _impEnabled, processed: !!processedPdfBytes, pulse: !!(b && b.classList.contains('needs-apply')) };`);
    ck('프리셋 불러오기 → 적용 필요(반짝) 상태', prof.idx >= 0 && prof.impEnabled && !prof.processed && prof.pulse, prof);

    const ap = await run(`
      const t = Date.now();
      await applyChanges();
      const b = document.getElementById('applyBtn'), d = document.getElementById('downloadBtn');
      return { sec: ((Date.now() - t) / 1000).toFixed(1), mb: processedPdfBytes ? Math.round(processedPdfBytes.length / 1048576) : 0,
               errs: window.__errs.slice(), pulse: !!(b && b.classList.contains('needs-apply')), dim: !!(d && d.classList.contains('btn-dim')) };`);
    ck('✔ 적용 성공 — 오류 없음', ap.mb > 0 && !ap.errs.some(e => /처리 중 오류/.test(e)), ap);
    ck('적용 후 반짝임 멈춤 · 다운로드 활성', !ap.pulse && !ap.dim, { pulse: ap.pulse, dim: ap.dim });
    ck('적용본 크기가 원고 수준(2배로 부풀지 않음)', ap.mb > 0 && ap.mb < 1400, ap.mb + 'MB');

    const pages = await run(`
      const doc = await PDFLib.PDFDocument.load(processedPdfBytes, { updateMetadata: false });
      const s = doc.getPage(0).getSize();
      return { n: doc.getPageCount(), w: Math.round(s.width / 72 * 25.4), h: Math.round(s.height / 72 * 25.4) };`);
    ck('결과: 150면(75시트 양면) · 270×390mm', pages.n === 150 && pages.w === 270 && pages.h === 390, pages);

    const dl = await run(`window.__errs.length = 0; await downloadProcessed(); return { errs: window.__errs.slice() };`);
    const f1 = OUTS[0];
    const s1 = f1 && fs.existsSync(f1) ? fs.statSync(f1).size : 0;
    ck('⇩ 다운로드 저장', s1 > 100 * 1048576 && !dl.errs.length, { mb: Math.round(s1 / 1048576), errs: dl.errs });

    const org = await run(`window.__errs.length = 0; await downloadOriginal(); return { errs: window.__errs.slice(), len: originalPdfBytes ? originalPdfBytes.length : 0 };`);
    const f2 = OUTS[1];
    const s2 = f2 && fs.existsSync(f2) ? fs.statSync(f2).size : 0;
    ck('우클릭 원본 저장 (null 오류 없음)', s2 > 0 && s2 === org.len && !org.errs.length, { mb: Math.round(s2 / 1048576), errs: org.errs });
  } catch (e) {
    ck('실행 오류', false, String(e && e.stack || e));
  }
  OUTS.forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
  const fail = res.filter(r => r[0] === '✘').length;
  console.log(`\n결과: ${res.length - fail} 통과 / ${fail} 실패 (${sec()})\n`);
  app.exit(fail ? 1 : 0);
});
