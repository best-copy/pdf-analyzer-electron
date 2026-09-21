// ◐ Dot Gain 보정 4단계 — 선택하면 컬러→흑백 페이지의 중간 톤만 밝아지고, 원래 흑백인 페이지는 그대로인지
//   실행: npx electron scripts/test/dotgain.e2e.js   (창을 띄우지 않는다 — show:false)
const path = require('path');
const os = require('os');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-e2e-dotgain'));
app.on('window-all-closed', () => {});   // 첫 창을 닫고 '다시 켠 것처럼' 새 창을 여는 동안 앱이 끝나지 않게
app.whenReady().then(async () => {
  const mkWin = async () => {
    const w = new BrowserWindow({ show: false, width: 1200, height: 900,
      webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
    await w.loadFile(path.join(ROOT, 'src/index.html'));
    await new Promise(r => setTimeout(r, 2500));
    return w;
  };
  let win = await mkWin();
  const res = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 120000)) { if (f()) return true; await sleep(50); } return false; };
    const { PDFDocument, rgb } = PDFLib;
    const d = await PDFDocument.create();
    d.addPage([300, 300]).drawRectangle({ x: 20, y: 20, width: 260, height: 260, color: rgb(0.2, 0.6, 0.9) });   // 1쪽 컬러
    d.addPage([300, 300]).drawRectangle({ x: 20, y: 20, width: 260, height: 260, color: rgb(0.5, 0.5, 0.5) });   // 2쪽 회색(RGB)
    const b = await d.save();
    startLoad([{ name: 'dg.pdf', size: b.length, type: 'application/pdf', arrayBuffer: () => Promise.resolve(b.buffer.slice(0)) }]);
    await waitFor(() => pageResults.length === 2 && pageResults.every(r => r && r.thumbnail !== undefined) && isTabReady(tabs.get(activeTabId)));
    ck('1쪽 컬러·2쪽 흑백으로 분석', pageResults[0].isColor && !pageResults[1].isColor, pageResults.map(r => r.isColor));
    const sel = document.getElementById('dotGainSelect');
    // 켜면 항상 '없음(0)' — 드롭다운이 없던 시절과 같은 밝기
    ck('켜면 기본 = 없음(0)', sel.value === '0' && getDotGain() === 0, [sel.value, document.getElementById('sb-dotGainSelect').value, getDotGain()]);
    ck('드롭다운 4단계', sel && [...sel.options].map(o => o.value).join(',') === '0,10,15,20', sel && [...sel.options].map(o => o.value));

    // 결과 PDF에서 쪽별 채움 회색값
    const grayOf = async bytes => {
      const doc = await PDFDocument.load(bytes);
      return doc.getPages().map(p => {
        const cs = p.node.get(PDFLib.PDFName.of('Contents'));
        const obj = doc.context.lookup(cs);
        const parts = obj && obj.asArray ? obj.asArray().map(x => doc.context.lookup(x)) : [obj];
        const txt = parts.map(s => { try { return new TextDecoder('latin1').decode(pako.inflate(s.contents)); } catch (e) { return new TextDecoder('latin1').decode(s.contents); } }).join('\\n');
        const m = txt.match(/(-?[\\d.]+)\\s+g(?=\\s)/);
        return m ? +m[1] : null;
      });
    };
    selectedPages.add(1);                 // 1쪽 흑백변환 대상
    if (!processingOptions.bw) toggleOption('bw');
    const results = {};
    for (const g of [0, 10, 15, 20]) {
      setDotGain(g);
      await waitFor(() => !_inkPrewarmPromise);
      await applyChanges();
      results[g] = await grayOf(processedPdfBytes);
      if (g === 0) selectedPages.add(1);  // 적용하면 선택이 풀린다(확정 표시로 유지됨)
    }
    const expect = g => dotGainCurve(0.299 * 0.2 + 0.587 * 0.6 + 0.114 * 0.9, g);
    ck('없음: 컬러 쪽 = 원래 휘도', Math.abs(results[0][0] - expect(0)) < 0.001, results[0]);
    ck('10·15·20%: 컬러 쪽이 곡선대로 밝아짐', [10, 15, 20].every(g => Math.abs(results[g][0] - expect(g)) < 0.001), [10, 15, 20].map(g => [results[g][0], +expect(g).toFixed(4)]));
    ck('단계가 오를수록 더 밝게', results[10][0] < results[15][0] && results[15][0] < results[20][0], [results[10][0], results[15][0], results[20][0]]);
    ck('흑백 쪽(잉크 정규화)은 단계와 무관하게 0.5', [0, 10, 15, 20].every(g => Math.abs(results[g][1] - 0.5) < 0.001), [0, 10, 15, 20].map(g => results[g][1]));
    ck('Dot Gain이 서명에 들어감(캐시가 갈림)', /#dg20/.test(baseSignature()), baseSignature().slice(-12));
    setDotGain(15);
    return out;
  })()`);
  // 앱을 다시 켠 것처럼 새 창 — 15를 골랐어도, 옛 버전 저장값(20)이 남아 있어도 '없음'으로 시작하는지
  await win.webContents.executeJavaScript(`localStorage.setItem('dotGainLevel', '20')`);   // 옛 버전이 남긴 저장값
  win.destroy();
  win = await mkWin();
  const restored = await win.webContents.executeJavaScript(`[document.getElementById('dotGainSelect').value, getDotGain()]`);
  res.push([restored[0] === '0' && restored[1] === 0 ? '✔' : '✘', '다시 켜면 없음(고른 단계·옛 저장값 무시)', JSON.stringify(restored)]);

  let fail = 0;
  res.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${res.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
