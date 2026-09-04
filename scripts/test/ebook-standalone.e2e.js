// 📖 E북시안도구.html(독립 배포본)이 실제로 뜨고, 한국어 CMap을 갖고 있는지.
//   실행: npx electron scripts/test/ebook-standalone.e2e.js
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');
const TOOL = path.join(ROOT, 'dist', 'E북시안도구.html');

let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  ✔', n); } else { fail++; console.log('  ✘', n, x !== undefined ? JSON.stringify(x) : ''); } };

app.whenReady().then(async () => {
  ck('도구 파일이 있다', fs.existsSync(TOOL));
  if (!fs.existsSync(TOOL)) { console.log('\n결과: ' + pass + ' 통과 / ' + (++fail) + ' 실패'); app.exit(1); return; }
  const win = new BrowserWindow({ show: true, width: 1000, height: 800 });
  const errs = [];
  // Electron 개발 경고(CSP)는 제품 문제와 무관하므로 제외한다
  win.webContents.on('console-message', (e, l, m) => {
    if (l >= 2 && !/Security Warning|unsafe-eval|electronjs.org/i.test(m)) errs.push(m);
  });
  await win.loadFile(TOOL);
  await new Promise(r => setTimeout(r, 1200));
  try {
    const r = await win.webContents.executeJavaScript(`(() => ({
      ui: !!document.getElementById('drop') && !!document.getElementById('go'),
      opts: ['dpi','target','view','bstyle','bind'].filter(id => !document.getElementById(id)),
      hasOpen: typeof openPdfDoc === 'function',
      hasReader: typeof LocalCMapReader === 'function',
      cmaps: typeof CMAPS === 'object' ? Object.keys(CMAPS).length : -1,
      korean: typeof CMAPS === 'object' ? ['UniKS-UTF16-H','Adobe-Korea1-UCS2'].filter(n => !CMAPS[n]) : ['?'],
      pdfjs: typeof pdfjsLib === 'object',
      builders: ['ebookRenderPages','buildEbookProofHtml','ebookSpreads','ebookSoloSpreads']
        .filter(n => typeof window[n] !== 'function'),
    }))()`);
    console.log('\n[1] 화면·옵션');
    ck('드롭 영역과 만들기 버튼', r.ui, r);
    ck('생성 옵션이 모두 있다', r.opts.length === 0, r.opts);
    console.log('\n[2] 빌더·pdf.js');
    ck('pdf.js 로드됨', r.pdfjs);
    ck('코어 함수가 전부 있다', r.builders.length === 0, r.builders);
    console.log('\n[3] 한국어 CMap 인라인');
    ck('openPdfDoc 정의됨', r.hasOpen);
    ck('CMap 리더 정의됨', r.hasReader);
    ck('CMap이 인라인되어 있다', r.cmaps > 10, r.cmaps);
    ck('한국어 핵심 CMap 포함', r.korean.length === 0, r.korean);
    console.log('\n[4] 오류 없음');
    ck('콘솔 오류 없음', errs.length === 0, errs.slice(0, 3));
  } catch (e) { console.log('  ✘ 하네스 오류:', e && e.message); fail++; }
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  app.exit(fail ? 1 : 0);
});
