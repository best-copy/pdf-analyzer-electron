// 💼 2GB 넘는 작업 파일(.pdfw) 저장·열기 — 원본·적용본을 한 버퍼로 합치지 않고 조각으로 이어 쓰고, 구간별로 읽는다.
//   실행: npx electron scripts/test/workfile-2gb.e2e.js   (창을 띄우지 않는다 · 임시 폴더에 약 2.3GB를 잠깐 쓴다)
// 회귀: 줄여 연 대용량 원고(≈1.9GB) + 적용본이면 합친 크기가 버퍼 한계(약 2,044MB)를 넘어 작업 저장이 실패했다.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');
const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(os.tmpdir(), 'pdfedit_e2e_2gb.pdfw');

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-e2e-2gb'));
// 하네스에는 main.js가 없다 — 덮어쓰기 확인 IPC만 대역으로
ipcMain.handle('dialog:confirmSavePath', (_e, { filePath }) => filePath);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 800, height: 600,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2000));
  let res;
  try {
    res = await win.webContents.executeJavaScript(`(async () => {
      const out = [];
      const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
      const MB = 1 << 20;
      // 원본·적용본 각각 1.15GB — 합치면 2.3GB (패턴을 넣어 조각이 섞이면 드러나게)
      const mk = (n, seed) => { const u = new Uint8Array(n); for (let i = 0; i < n; i += 4096) u[i] = (i / 4096 + seed) & 255; u[n - 1] = seed; return u; };
      const pdf = mk(1150 * MB, 11), result = mk(1150 * MB, 77), small = new Uint8Array([1, 2, 3]);
      const manifest = { v: 1, doc: { name: '대용량', pages: 1 }, state: { applied: true },
        entries: [{ k: 'pdf', name: 'a.pdf' }, { k: 'result', name: 'r.pdf' }, { k: 'analysis', name: 'x' }] };
      // 예전 방식 — 한 버퍼로 합치기
      let oldErr = '';
      try { packWorkFile(manifest, [pdf, result, small]); } catch (e) { oldErr = e.name + ': ' + e.message; }
      ck('예전 방식(한 버퍼로 합침)은 2GB를 넘으면 실패', !!oldErr, oldErr.slice(0, 80));
      // 새 방식 — 조각 목록으로 저장
      const { parts, total } = packWorkFileParts(manifest, [pdf, result, small]);
      const t0 = Date.now();
      const saved = await window.electronAPI.saveFileTo({ filePath: ${JSON.stringify(OUT)}, buffer: parts, kind: 'pdfw' });
      const size = window.electronAPI.fileSize(${JSON.stringify(OUT)});
      ck('조각 저장 성공 · 파일 크기 = 조각 합계(2GB 초과)', !!saved && size === total && size > 2 * 1024 * MB, { size, total, sec: ((Date.now() - t0) / 1000).toFixed(1) });
      // 새 방식 — 구간별로 열기
      const t1 = Date.now();
      const un = readWorkFileFromPath(${JSON.stringify(OUT)});
      const same = (a, b) => a.length === b.length && [0, 4096, 123 * 4096, a.length - 4096 - (a.length % 4096), a.length - 1].every(i => a[i] === b[i]);
      ck('구간별로 열기 성공 · 원본·적용본 바이트 일치', un.blobs.length === 3 && same(un.blobs[0], pdf) && same(un.blobs[1], result) && un.blobs[2][2] === 3,
         { lens: un.blobs.map(b => b.length), sec: ((Date.now() - t1) / 1000).toFixed(1) });
      ck('정보(JSON)도 그대로', un.manifest.doc.name === '대용량' && un.manifest.state.applied === true);
      return out;
    })()`);
  } catch (e) { res = [['✘', '실행 오류', String(e && e.message || e)]]; }
  try { fs.unlinkSync(OUT); } catch (e) {}
  let fail = 0;
  res.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${res.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
