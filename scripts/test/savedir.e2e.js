// 💾 저장 기본 폴더 = '문서를 연 폴더' E2E (실제 앱 화면 + 실제 preload 구동)
//   실행: npx electron scripts/test/savedir.e2e.js
// 파일을 여는 실제 경로(prepareFiles)를 태우고, 렌더러→preload→main으로
// 'app:docDir'가 그 파일의 폴더로 도착하는지 확인한다. (main.js는 이 값을
// _lastSaveDir에 넣어 저장 다이얼로그 기본 폴더로 쓴다)
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');

const ROOT = path.join(__dirname, '..', '..');

// 테스트용 실제 PDF 한 장 (pdf-lib 없이 최소 PDF 수제작)
function makeTestPdf(dir) {
  const objs = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj',
  ];
  let pdf = '%PDF-1.4\n';
  const off = [];
  for (const o of objs) { off.push(pdf.length); pdf += o + '\n'; }
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
       + off.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')
       + `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  const p = path.join(dir, 'savedir_test.pdf');
  fs.writeFileSync(p, pdf, 'latin1');
  return p;
}

app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'savedir_'));
  const pdfPath = makeTestPdf(dir);

  let got = null;
  ipcMain.on('app:docDir', (_e, d) => { got = d; });   // main.js와 같은 채널

  const win = new BrowserWindow({
    show: false, width: 1000, height: 800,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false },
  });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));

  const out = [];
  const ck = (n, c, x) => { out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]); };

  const hasApi = await win.webContents.executeJavaScript('typeof window.electronAPI.setSaveDir');
  ck('preload에 setSaveDir 노출', hasApi === 'function', hasApi);

  // 실제 파일 열기 경로를 그대로 태운다
  const n = await win.webContents.executeJavaScript(
    `prepareFiles([{ name: 'savedir_test.pdf', path: ${JSON.stringify(pdfPath)} }]).then(a => a.length)`);
  ck('파일 준비 성공', n === 1, n);
  await new Promise(r => setTimeout(r, 300));
  ck('main이 받은 폴더 = 원본 파일 폴더', got && path.resolve(got) === path.resolve(dir), { got, dir });

  // 윈도우 역슬래시 경로도 폴더만 정확히 떨어지는지
  const winPath = 'C:\\문서\\인쇄\\a.pdf';
  await win.webContents.executeJavaScript(`reportSaveDir(${JSON.stringify(winPath)})`);
  await new Promise(r => setTimeout(r, 200));
  ck('역슬래시 경로 → 폴더만 전달', got === path.dirname(winPath), got);

  let fail = 0;
  out.forEach(([m, nm, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${nm} ${x}`); });
  console.log(`\n결과: ${out.length - fail} 통과 / ${fail} 실패\n`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  app.exit(fail ? 1 : 0);
});
