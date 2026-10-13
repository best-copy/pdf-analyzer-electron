// 주석(펜 메모·형광펜·도장 그림)이 모아찍기·용지 크기 변환에서 사라지지 않는다 — 2026-10-13 실파일 '페이지 오류.pdfw'
//   (60쪽 슬라이드 그림이 도장 주석이라 모아찍기 칸이 통째로 비었고, 154쪽의 펜 메모가 전부 사라졌다)
//   실행: npx electron scripts/test/annot-imposition.e2e.js   (창을 띄우지 않는다 · gs 필요)
//   합성 문서 2쪽: 1쪽 = 본문 글자 + 인쇄 표시 Ink(초록), 2쪽 = 본문 비움 + 인쇄 표시 Stamp(빨강) + 인쇄 표시 없는 주석(파랑)
//   · 모아찍기(1면 2쪽)·용지 크기 변환(A4 맞춤) 결과를 gs로 그려 빨강·초록이 있고 파랑이 없는지
//   · 결과에 원래 /Annots가 따라오지 않는지(평탄화한 노드를 실음)
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

function findGs() {
  const dirs = ['D:/Ghostscript', 'C:/Program Files/gs'];
  for (const d of dirs) {
    try {
      for (const v of fs.readdirSync(d).sort().reverse()) {
        const p = path.join(d, v, 'bin', 'gswin64c.exe');
        if (fs.existsSync(p)) return p;
      }
      const p = path.join(d, 'bin', 'gswin64c.exe'); if (fs.existsSync(p)) return p;
    } catch (e) {}
  }
  return 'gswin64c';
}
// 결과 1쪽을 그려 색 화소 세기
function countColors(pdfPath) {
  const out = path.join(os.tmpdir(), 'annot-imp-' + process.pid + '.ppm');
  execFileSync(findGs(), ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=ppmraw', '-r36', '-dFirstPage=1', '-dLastPage=1', '-o', out, pdfPath]);
  const b = fs.readFileSync(out); fs.unlinkSync(out);
  let p = 0, fields = [];
  while (fields.length < 4) {   // P6 w h max — # 주석 줄은 건너뛴다
    while (/\s/.test(String.fromCharCode(b[p]))) p++;
    if (b[p] === 0x23) { while (b[p] !== 0x0a) p++; continue; }
    let s = ''; while (!/\s/.test(String.fromCharCode(b[p]))) s += String.fromCharCode(b[p++]);
    fields.push(s);
  }
  p++;
  let red = 0, green = 0, blue = 0;
  for (let i = p; i + 2 < b.length; i += 3) {
    const r = b[i], g = b[i + 1], bl = b[i + 2];
    if (r > 200 && g < 60 && bl < 60) red++;
    else if (g > 150 && r < 80 && bl < 80) green++;
    else if (bl > 200 && r < 60 && g < 60) blue++;
  }
  return { red, green, blue };
}

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-e2e-annotimp'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  win.webContents.on('console-message', (e, l, m) => { if (l >= 3 && !/No handler|Security/.test(m)) console.log('[앱오류]', m.slice(0, 300)); });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));
  const checks = [];
  const ck = (n, c, x) => checks.push([c ? '✔' : '✘', n, x]);
  try {
    const run = async (setup) => win.webContents.executeJavaScript(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 120000)) { if (f()) return true; await sleep(80); } return false; };
      if (!tabs.size) {
        const { PDFDocument, StandardFonts, rgb, PDFName } = PDFLib;
        const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
        const ctx = d.context;
        const ap = (ops, w, h) => ctx.register(ctx.stream(ops, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, w, h] }));
        const annot = (pg, sub, rect, flags, apRef) => {
          const a = ctx.obj({ Type: 'Annot', Subtype: sub, Rect: rect, F: flags, AP: { N: apRef } });
          pg.node.set(PDFName.of('Annots'), ctx.obj([...(pg.node.lookup(PDFName.of('Annots')) ? pg.node.lookup(PDFName.of('Annots')).asArray() : []), ctx.register(a)]));
        };
        const p1 = d.addPage([400, 300]);
        p1.drawText('BODY', { x: 30, y: 240, size: 30, font: f, color: rgb(0, 0, 0) });
        annot(p1, 'Ink', [200, 50, 360, 150], 4, ap('0 0.8 0 rg 0 0 80 50 re f', 80, 50));          // 초록 펜 메모(모양 상자의 2배로 늘려 그림)
        const p2 = d.addPage([400, 300]);
        p2.node.set(PDFName.of('Contents'), ctx.register(ctx.stream('')));                      // 본문 비움 — 슬라이드가 전부 도장
        annot(p2, 'Stamp', [40, 40, 360, 260], 4, ap('1 0 0 rg 0 0 100 100 re f', 100, 100));      // 빨강 도장
        annot(p2, 'Square', [10, 10, 60, 60], 0, ap('0 0 1 rg 0 0 10 10 re f', 10, 10));          // 파랑 — 인쇄 표시 없음
        const b = await d.save();
        startLoad([{ name: '주석.pdf', size: b.length, type: 'application/pdf', arrayBuffer: () => Promise.resolve(b.buffer.slice(0)) }]);
        await waitFor(() => pageResults.length === 2 && isTabReady(tabs.get(activeTabId)));
        setOutlineEnabled(false);
      }
      ${setup}
      invalidateProcessed(); await applyChanges(); await waitFor(() => !!processedPdfBytes, 120000);
      const doc = await PDFLib.PDFDocument.load(processedPdfBytes.slice(0));
      const annots = doc.getPages().map(p => { const a = p.node.lookup(PDFLib.PDFName.of('Annots')); return a ? a.asArray().map(r => String(doc.context.lookup(r).get(PDFLib.PDFName.of('Subtype')))).join(',') : ''; }).filter(Boolean).join(' | ');
      return { path: window.electronAPI.writeTempFile(processedPdfBytes.slice(0), 'pdf'), pages: doc.getPageCount(), annots };
    })()`);

    const nup = await run(`qpSetNup('2');`);
    const c1 = countColors(nup.path);
    ck('모아찍기: 앞면 한 장에 2쪽(기본 양면이라 빈 뒷면 포함 2장)', nup.pages === 2, nup.pages);
    ck('모아찍기: 본문이 빈 쪽의 도장 그림(빨강)이 나옴', c1.red > 500, c1);
    ck('모아찍기: 펜 메모(초록)가 나옴', c1.green > 100, c1);
    ck('모아찍기: 인쇄 표시 없는 주석(파랑)은 안 나옴(아크로뱃 인쇄와 같음)', c1.blue === 0, c1);
    ck('모아찍기: 결과에 원래 주석이 따라오지 않음', !nup.annots);
    fs.unlinkSync(nup.path);

    const fit = await run(`qpSetNup('1'); qpSetPaper('A4');`);
    // 2쪽(도장)이 빨강 — 1쪽만 그리므로 2쪽은 따로 확인
    const doc2 = path.join(os.tmpdir(), 'annot-imp-p2-' + process.pid + '.pdf');
    execFileSync(findGs(), ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=pdfwrite', '-dFirstPage=2', '-dLastPage=2', '-o', doc2, fit.path]);
    const c2 = countColors(fit.path), c3 = countColors(doc2);
    ck('용지 크기 변환(A4): 펜 메모(초록)가 나옴', c2.green > 100, c2);
    ck('용지 크기 변환(A4): 도장 그림(빨강)이 나옴 · 파랑 없음', c3.red > 500 && c3.blue === 0, c3);
    fs.unlinkSync(fit.path); fs.unlinkSync(doc2);
  } catch (e) { ck('실행 오류', false, e && e.message); }
  let fail = 0;
  checks.forEach(([m, n, x]) => { if (m !== '✔') fail++; console.log(m, n, m === '✔' ? '' : JSON.stringify(x)); });
  console.log(`결과: ${checks.length - fail} 통과 / ${fail} 실패`);
  app.exit(fail ? 1 : 0);
});
