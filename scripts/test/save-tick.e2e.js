// ⏱ pdf-lib save() 병목 진단 — 직렬화 자체가 느린가, tick(setTimeout) 대기가 느린가.
//   pdf-lib은 objectsPerTick(기본 50)개마다 setTimeout(…,0)으로 이벤트 루프에 양보한다.
//   중첩 타이머는 브라우저가 최소 4ms로 조이므로, 객체가 많으면 대기만으로 수 초가 된다.
//   실행: npx electron scripts/test/save-tick.e2e.js "D:\경로\문서.pdf"
const path = require('path');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');
const TARGET = process.argv.find(a => /\.pdf$/i.test(a));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1440, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 1500));

  let out;
  try {
    out = await win.webContents.executeJavaScript(`(async () => {
      const rows = [];
      const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms||600000)) { if (f()) return true; await new Promise(r => setTimeout(r, 30)); } return false; };
      const P = ${JSON.stringify(TARGET)};
      const ab = window.electronAPI.readFile(P);
      const name = P.split(/[\\/]/).pop();
      startLoad([{ name, size: ab.byteLength, type: 'application/pdf', arrayBuffer: () => Promise.resolve(ab.slice(0)) }]);
      await waitFor(() => pageResults.length > 0 && pageResults.every(r => r && r.thumbnail !== undefined));
      await new Promise(r => setTimeout(r, 400));
      await applyChanges();
      await waitFor(() => !!processedPdfBytes);

      const doc = (typeof _baseAssembled !== 'undefined' && _baseAssembled) ? _baseAssembled.outDoc : null;
      if (!doc) return { err: '_baseAssembled 없음' };
      const objs = doc.context.enumerateIndirectObjects().length;
      const opt = { useObjectStreams: false, updateFieldAppearances: false };

      // 같은 문서를 여러 설정으로 저장해 시간을 잰다 (결과 바이트 길이도 확인)
      rows.push(['(선택된 objectsPerTick)', pdfSaveOpts(doc).objectsPerTick, '']);
      for (const [label, o] of [
        ['예전 방식 (objectsPerTick 50)', { ...opt, objectsPerTick: 50 }],
        ['지금 방식 (savePdfDoc)', null],
      ]) {
        const t = performance.now();
        const b = o ? await doc.save(o) : await savePdfDoc(doc);
        rows.push([label, Math.round(performance.now() - t), (b.byteLength / 1048576).toFixed(1) + 'MB']);
        if (!o) rows.push(['  └ 바이트 지문', 0, [...b.slice(0, 24)].join(',') + ' … len ' + b.byteLength]);
      }
      return { objs, pages: pageResults.length, rows };
    })()`);
  } catch (e) { console.error('하네스 오류:', e && e.message); app.exit(1); return; }

  if (out.err) { console.log('  ✘', out.err); app.exit(1); return; }
  console.log(`\n=== pdf-lib save() 진단 — ${out.pages}쪽 / 간접객체 ${out.objs.toLocaleString()}개 ===`);
  console.log(`  (기본 설정이면 tick 횟수 ≈ ${Math.round(out.objs / 50).toLocaleString()}회 × setTimeout)`);
  for (const [l, ms, sz] of out.rows) console.log('  ' + String(ms).padStart(7) + ' ms  ' + l.padEnd(28) + sz);
  app.exit(0);
});
