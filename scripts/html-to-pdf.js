// 설명서·보고서 HTML → A4 PDF (같은 이름 .pdf)
//   npx electron scripts/html-to-pdf.js docs/사용설명서_PDF분석기_v3.8.html
const path = require('path'); const fs = require('fs'); const os = require('os');
const { app, BrowserWindow } = require('electron');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-topdf'));
app.whenReady().then(async () => {
  const src = require('path').resolve(process.argv[process.argv.length - 1]);
  const w = new BrowserWindow({ show: false });
  await w.loadFile(src);
  const pdf = await w.webContents.printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true });
  fs.writeFileSync(src.replace(/\.html$/, '.pdf'), pdf);
  console.log('ok', pdf.length);
  app.exit(0);
});
