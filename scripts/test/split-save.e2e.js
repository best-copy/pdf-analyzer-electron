// ✂ 분리 저장 — 적용본을 여러 PDF로 나눠 한 폴더에 저장 (실제 화면·preload·파일 쓰기)
//   실행: npx electron scripts/test/split-save.e2e.js   (창을 띄우지 않는다 — show:false)
// 확인: 쪽 수 단위·쪽 범위 두 방식, 나눈 파일의 쪽 수와 **내용(쪽 번호)**, 같은 이름 덮어쓰기 방지,
//       잘못 적은 범위는 저장 버튼이 잠기는지.
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');
const { PDFDocument } = require('pdf-lib');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-e2e-split'));
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfedit_split_'));
// main.js의 폴더 선택 다이얼로그 자리 — 검사에서는 임시 폴더를 바로 준다
ipcMain.handle('dialog:pickSplitFolder', () => outDir);

const out = [];
const ck = (n, c, x) => { out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]); };

// 나눈 파일의 쪽 수와, 각 쪽에 적힌 번호(=원본 쪽 번호)를 읽는다
async function pagesOf(file) {
  const doc = await PDFDocument.load(fs.readFileSync(file), { ignoreEncryption: true });
  return doc.getPageCount();
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));

  const res = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 120000)) { if (f()) return true; await sleep(50); } return false; };
    const { PDFDocument, StandardFonts, rgb } = PDFLib;

    // 25쪽 — 쪽마다 'P<번호>' (나눈 파일이 어느 쪽을 담았는지 글자로 확인)
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 25; i++) d.addPage([300, 300]).drawText('P' + i, { x: 40, y: 150, size: 40, font: f, color: rgb(0, 0, 0) });
    const b = await d.save();
    startLoad([{ name: '원고.pdf', size: b.length, type: 'application/pdf', arrayBuffer: () => Promise.resolve(b.buffer.slice(0)) }]);
    await waitFor(() => pageResults.length === 25 && isTabReady(tabs.get(activeTabId)));

    setOutlineEnabled(false);   // 검사 하네스에는 Ghostscript IPC가 없다(폰트 안전화는 별도 검사)
    // 적용 전에도 우클릭(원본 그대로 나누기)이 되어야 하므로 잠그지 않는다 — disabled면 우클릭도 안 먹는다
    const sBtn = document.getElementById('splitSaveBtn');
    ck('적용 전에도 ✂ 분리 저장을 누를 수 있음(흐리게)', !sBtn.disabled && sBtn.classList.contains('btn-dim'));
    ck('적용 전 좌클릭은 적용부터 하라고 안내', await (async () => {
      await splitSaveProcessed();
      return /오른쪽/.test(document.getElementById('error').textContent);
    })(), document.getElementById('error').textContent.slice(0, 30));

    // 우클릭 = 원본 그대로 나누기 (아무 작업도 하지 않았을 때)
    {
      const p = splitSaveOriginal({ preventDefault() {} });
      await waitFor(() => !!document.querySelector('.split-preview'), 60000);
      ck('원본 나누기 창은 원본이라고 알려 줌', /원본 그대로/.test(document.querySelector('.merge-sub').textContent));
      document.querySelector('input[name=splitMode][value=range]').checked = true;
      const spec = document.querySelector('#splitSpec');
      spec.value = '24-25'; spec.dispatchEvent(new Event('input'));
      document.querySelector('#splitConfirm').click();
      await p;
      ck('원본 나누기 저장됨', /원본 PDF를 1개로 나눠 저장/.test(document.getElementById('success').textContent),
         document.getElementById('success').textContent.slice(0, 30));
    }
    await applyChanges();
    await waitFor(() => !!processedPdfBytes);
    ck('적용 후 ✂ 분리 저장 열림', !document.getElementById('splitSaveBtn').disabled);

    // ── 방식 ① 10쪽 단위 ──
    const run = async (fill) => {
      const p = splitSaveProcessed();
      await waitFor(() => !!document.querySelector('.split-preview'), 60000);
      await fill();
      document.querySelector('#splitConfirm').click();
      await p;
    };
    await run(async () => {
      const prev = document.querySelector('#splitPreview');
      ck('창이 완성본 쪽 수를 보여 줌', /25쪽/.test(document.querySelector('.merge-sub').textContent));
      ck('기본 10쪽 단위 미리보기 = 3개', /파일 3개/.test(prev.textContent), prev.textContent.slice(0, 60));
      // 잘못 적은 범위는 저장 버튼이 잠긴다
      document.querySelector('input[name=splitMode][value=range]').checked = true;
      const spec = document.querySelector('#splitSpec');
      spec.value = '1-99'; spec.dispatchEvent(new Event('input'));
      ck('문서 밖 범위 → 저장 잠김·이유 표시', document.querySelector('#splitConfirm').disabled && /25쪽까지/.test(prev.textContent), prev.textContent.slice(0, 40));
      // 다시 10쪽 단위로
      document.querySelector('input[name=splitMode][value=every]').checked = true;
      document.querySelector('#splitEveryN').dispatchEvent(new Event('change'));
    });
    ck('① 저장 성공 메시지', /3개로 나눠 저장/.test(document.getElementById('success').textContent), document.getElementById('success').textContent.slice(0, 40));

    // ── 방식 ② 쪽 범위 21-25, 1-2 ──
    await run(async () => {
      document.querySelector('input[name=splitMode][value=range]').checked = true;
      const spec = document.querySelector('#splitSpec');
      spec.value = '21-25, 1-2'; spec.dispatchEvent(new Event('input'));
      ck('② 미리보기 = 2개', /파일 2개/.test(document.querySelector('#splitPreview').textContent));
    });
    ck('② 저장 성공 메시지', /2개로 나눠 저장/.test(document.getElementById('success').textContent));

    // ── 같은 조건으로 한 번 더 → 덮어쓰지 않고 -1 ──
    await run(async () => {
      document.querySelector('input[name=splitMode][value=range]').checked = true;
      const spec = document.querySelector('#splitSpec');
      spec.value = '21-25'; spec.dispatchEvent(new Event('input'));
    });
    return out;
  })()`);
  res.forEach(r => out.push(r));

  // 디스크에 실제로 만들어진 파일 확인 — ①(01-10·11-20·21-25) ②(21-25→-1·01-02) ③(21-25→-2)
  const files = fs.readdirSync(outDir).filter(f => f !== '원고_24-25.pdf').sort();   // 우클릭(원본) 결과는 따로 본다
  ck('만들어진 파일 목록', JSON.stringify(files) === JSON.stringify(
    ['원고_01-02.pdf', '원고_01-10.pdf', '원고_11-20.pdf', '원고_21-25-1.pdf', '원고_21-25-2.pdf', '원고_21-25.pdf']), files);
  const counts = {};
  for (const f of files) counts[f] = await pagesOf(path.join(outDir, f));
  ck('파일마다 쪽 수가 맞음', JSON.stringify(counts) === JSON.stringify(
    { '원고_01-02.pdf': 2, '원고_01-10.pdf': 10, '원고_11-20.pdf': 10, '원고_21-25-1.pdf': 5, '원고_21-25-2.pdf': 5, '원고_21-25.pdf': 5 }), counts);

  // 내용 확인 — 21-25 파일의 첫 쪽에 'P21'이 있어야 한다(엉뚱한 구간을 담지 않았는지)
  const texts = await win.webContents.executeJavaScript(`(async () => {
    const read = async (p) => {
      const ab = await window.electronAPI.readFile(p);
      const doc = await pdfjsLib.getDocument({ data: new Uint8Array(ab) }).promise;
      const t = [];
      for (let i = 1; i <= doc.numPages; i++) t.push((await (await doc.getPage(i)).getTextContent()).items.map(x => x.str).join(''));
      await doc.destroy();
      return t;
    };
    return { last: await read(${JSON.stringify(path.join(outDir, '원고_21-25.pdf'))}),
             mid:  await read(${JSON.stringify(path.join(outDir, '원고_11-20.pdf'))}) };
  })()`);
  ck('우클릭(원본) 파일이 만들어짐', fs.existsSync(path.join(outDir, '원고_24-25.pdf')));
  ck('우클릭(원본) 파일 쪽 수 = 2', await pagesOf(path.join(outDir, '원고_24-25.pdf')) === 2);
  ck('21-25 파일 내용 = P21~P25', JSON.stringify(texts.last) === JSON.stringify(['P21','P22','P23','P24','P25']), texts.last);
  ck('11-20 파일 내용 = P11~P20', JSON.stringify(texts.mid) === JSON.stringify(['P11','P12','P13','P14','P15','P16','P17','P18','P19','P20']), texts.mid);

  let fail = 0;
  out.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(fail ? `FAIL ${fail}/${out.length}` : `PASS ${out.length}/${out.length}`);
  try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (e) {}
  win.destroy();
  app.exit(fail ? 1 : 0);
});
