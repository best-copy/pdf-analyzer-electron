// 🔤 사전 정의 CMap(한국어 등 CID 인코딩) 글자가 화면에 그려지는지.
//   pdf.js는 UniKS-UTF16-H 같은 CMap을 **외부 파일**에서 읽어야 한다. 안 알려주면 폰트 로드가
//   통째로 실패해 그 글자가 아예 안 그려진다 — 아크로뱃이 넣은 머리글·바닥글이 사라지던 원인.
//   실행: npx electron scripts/test/cmap-cid-font.e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  ✔', n); } else { fail++; console.log('  ✘', n, x !== undefined ? JSON.stringify(x) : ''); } };

// 비임베드 CID 폰트 + 사전 정의 CMap(UniKS-UTF16-H)으로 글자를 찍는 최소 PDF
function makePdf() {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    null,   // 아래에서 채운다
    '<< /Type /Font /Subtype /Type0 /BaseFont /Batang /Encoding /UniKS-UTF16-H /DescendantFonts [6 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Batang /CIDSystemInfo 7 0 R /FontDescriptor 8 0 R /DW 1000 >>',
    '<< /Registry (Adobe) /Ordering (Korea1) /Supplement 2 >>',
    '<< /Type /FontDescriptor /FontName /Batang /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>',
  ];
  const c = 'BT /F1 60 Tf 30 80 Td <00410042> Tj ET';   // UTF-16 "AB"
  objs[3] = '<< /Length ' + c.length + ' >>\nstream\n' + c + '\nendstream';
  let pdf = '%PDF-1.7\n'; const off = [];
  objs.forEach((o, i) => { off[i] = pdf.length; pdf += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
  const xref = pdf.length;
  pdf += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
  off.forEach(o => { pdf += String(o).padStart(10, '0') + ' 00000 n \n'; });
  pdf += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(pdf, 'latin1');
}

app.whenReady().then(async () => {
  const f = path.join(os.tmpdir(), `pdfedit_cmap_${Date.now()}.pdf`);
  fs.writeFileSync(f, makePdf());
  const win = new BrowserWindow({ show: true, width: 800, height: 600,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 1500));

  try {
    console.log('\n[1] CMap 파일이 함께 배포되는가');
    const dir = await win.webContents.executeJavaScript('window.electronAPI.cmapDir()');
    ck('cmapDir 경로를 알려준다', !!dir, dir);
    for (const n of ['UniKS-UTF16-H', 'Adobe-Korea1-UCS2', 'UniJIS-UCS2-H', 'UniGB-UCS2-H']) {
      ck('  ' + n + '.bcmap 있음', dir && fs.existsSync(path.join(dir, n + '.bcmap')));
    }

    console.log('\n[2] 비임베드 CID 폰트 글자가 실제로 그려지는가');
    const r = await win.webContents.executeJavaScript(`(async () => {
      const ab = window.electronAPI.readFile(${JSON.stringify(f)});
      const draw = async (docPromise) => {
        const pdf = await docPromise.promise;
        const page = await pdf.getPage(1);
        const vp = page.getViewport({ scale: 1 });
        const cv = document.createElement('canvas');
        cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
        const x = cv.getContext('2d', { willReadFrequently: true });
        x.fillStyle = '#fff'; x.fillRect(0, 0, cv.width, cv.height);
        let err = null;
        try { await page.render({ canvasContext: x, viewport: vp }).promise; } catch (e) { err = String(e.message || e); }
        const d = x.getImageData(0, 0, cv.width, cv.height).data;
        let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 140) n++;
        const txt = (await page.getTextContent()).items.map(i => i.str).join('');
        await pdf.destroy();
        return { dark: n, err, txt };
      };
      const ours = await draw(openPdfDoc({ data: new Uint8Array(ab.slice(0)) }));
      const bare = await draw(pdfjsLib.getDocument({ data: new Uint8Array(ab.slice(0)) }));   // CMap 없이 (예전 방식)
      return { ours, bare };
    })()`);
    ck('앱 경로(openPdfDoc)에서는 글자가 그려진다', r.ours.dark > 50, r.ours);
    ck('글자를 텍스트로도 읽어낸다', /A/.test(r.ours.txt) && /B/.test(r.ours.txt), r.ours.txt);
    ck('CMap 없이 열면 안 그려진다(회귀 감지용)', r.bare.dark < 10, r.bare);
  } catch (e) { console.log('  ✘ 하네스 오류:', e && e.message); fail++; }
  try { fs.unlinkSync(f); } catch (e) {}
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  app.exit(fail ? 1 : 0);
});
