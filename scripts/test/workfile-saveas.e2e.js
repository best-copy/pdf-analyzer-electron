// 📑 작업 파일(.pdfw)을 열어 추가 작업 → '다른 이름으로 저장'
//   실행: npx electron scripts/test/workfile-saveas.e2e.js   (창을 띄우지 않는다 — show:false)
// 확인: 새 파일이 생기고 처음 연 파일은 바이트 그대로, 새 파일에 추가 작업이 담김,
//       이후 '💼 작업 저장'은 새 파일에 덮어씀, 우클릭도 다른 이름으로 저장, '지금 작업 파일' 표시.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-e2e-saveas'));
app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfsaveas_'));
  // main.js dialog:saveFilePath와 같은 규칙 — 같은 이름이 있으면 '-1'을 붙인 이름을 기본으로 준다(uniqueSavePath)
  const asked = [];
  ipcMain.handle('dialog:saveFilePath', (_e, { defaultName }) => {
    asked.push(defaultName);
    const ext = path.extname(defaultName), stem = path.basename(defaultName, ext);
    let p = path.join(dir, defaultName);
    for (let i = 1; fs.existsSync(p) && i < 1000; i++) p = path.join(dir, `${stem}-${i}${ext}`);
    return p;
  });
  ipcMain.handle('dialog:confirmSavePath', (_e, { filePath }) => filePath);

  const win = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));

  const out = [];
  const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
  const js = (s) => win.webContents.executeJavaScript(`(async () => {
    const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 60000)) { if (f()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
    ${s}
  })()`);
  const A = path.join(dir, '도록.pdfw'), B = path.join(dir, '도록-1.pdfw');

  // ① 문서를 열고 1쪽을 돌린 뒤 작업 파일(도록.pdfw)로 저장
  await js(`
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 3; i++) d.addPage([300, 420]).drawText('p' + i, { x: 20, y: 380, size: 14, font: f, color: rgb(0,0,0) });
    const b = await d.save();
    startLoad([{ name: '도록.pdf', size: b.length, type: 'application/pdf', arrayBuffer: () => Promise.resolve(b.buffer.slice(0)) }]);
    await waitFor(() => pageResults.length === 3 && pageResults.every(r => r && r.thumbnail));
    // 문서를 연 직후 자동 방향 맞춤이 한 번 돈다 — 그 전에 돌리면 '가로로 누운 쪽'으로 보고 되돌린다
    await new Promise(r => setTimeout(r, 1500));
    rotatePage(0, 90);
    return await saveWorkFile();`);
  ck('처음 저장 → 도록.pdfw', fs.existsSync(A));
  const aBytes = fs.readFileSync(A);

  // ② 탭을 닫고 도록.pdfw를 연다 → 추가 작업(2쪽 회전)
  const st = await js(`
    closeTab(activeTabId);
    await new Promise(r => setTimeout(r, 300));
    await openWorkFilePath(${JSON.stringify(A)});
    await waitFor(() => pageResults.length === 3 && pageResults.every(r => r && r.thumbnail));
    await new Promise(r => setTimeout(r, 800));
    const note = document.getElementById('workCurNote');
    const r = { cur: currentWorkPath(), noteShown: note.style.display !== 'none', note: note.textContent,
                asBtn: !document.getElementById('workSaveAsBtn').disabled };
    rotatePage(1, 180);
    return r;`);
  ck('연 작업 파일 = 지금 작업 파일', st.cur === A, st.cur);
  ck("'지금 작업 파일: 도록.pdfw' 표시", st.noteShown && /도록\.pdfw/.test(st.note), st.note);
  ck('📑 다른 이름으로 저장 버튼 사용 가능', st.asBtn);

  // ③ 📑 다른 이름으로 저장 (버튼 클릭)
  const sa = await js(`
    document.getElementById('workSaveAsBtn').click();
    await waitFor(() => /다른 이름으로 저장 완료/.test(document.getElementById('success').textContent), 30000);
    return { cur: currentWorkPath(), msg: document.getElementById('success').textContent,
             note: document.getElementById('workCurNote').textContent };`);
  ck('기본 이름 = 지금 작업 파일 이름', asked[asked.length - 1] === '도록.pdfw', asked);
  ck('새 파일 도록-1.pdfw 생성', fs.existsSync(B));
  ck('처음 연 도록.pdfw는 바이트 그대로', Buffer.compare(aBytes, fs.readFileSync(A)) === 0);
  ck('지금 작업 파일이 새 파일로 바뀜', sa.cur === B, sa.cur);
  ck("표시도 '도록-1.pdfw'로 바뀜", /도록-1\.pdfw/.test(sa.note), sa.note);
  ck('완료 메시지에 새 파일·원래 파일 안내', /새 파일:/.test(sa.msg) && /그대로 남아/.test(sa.msg), sa.msg.slice(0, 80));

  // ④ 이후 💼 작업 저장 → 새 파일에 덮어쓰고, 처음 파일은 여전히 그대로
  const bBefore = fs.statSync(B).mtimeMs;
  await new Promise(r => setTimeout(r, 50));
  await js(`rotatePage(2, 90); return await saveWorkFile();`);
  ck('💼 작업 저장은 새 파일에 덮어씀', fs.statSync(B).mtimeMs > bBefore);
  ck('처음 파일은 여전히 그대로', Buffer.compare(aBytes, fs.readFileSync(A)) === 0);
  ck('파일이 더 늘지 않음', fs.readdirSync(dir).filter(f => f.endsWith('.pdfw')).length === 2, fs.readdirSync(dir));

  // ⑤ 두 파일을 다시 열어 내용 비교 — 처음 파일엔 1쪽 회전만, 새 파일엔 추가 작업까지
  const rot = async (p) => js(`
    closeTab(activeTabId);
    await new Promise(r => setTimeout(r, 300));
    await openWorkFilePath(${JSON.stringify(p)});
    await waitFor(() => pageResults.length === 3 && pageResults.every(r => r && r.thumbnail));
    return pageResults.map(r => (r.rotation || 0) % 360);`);
  const ra = await rot(A), rb = await rot(B);
  ck('처음 파일 내용 = 1쪽만 회전', JSON.stringify(ra) === JSON.stringify([90, 0, 0]), ra);
  ck('새 파일 내용 = 추가 작업까지(2·3쪽 회전)', JSON.stringify(rb) === JSON.stringify([90, 180, 90]), rb);

  // ⑥ 💼 작업 저장 버튼 우클릭 = 다른 이름으로 저장
  const rc = await js(`
    document.getElementById('success').textContent = '';
    document.getElementById('workSaveBtn').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await waitFor(() => /다른 이름으로 저장 완료/.test(document.getElementById('success').textContent), 30000);
    return currentWorkPath();`);
  // 지금 파일이 도록-1.pdfw이므로 기본 이름도 그것 → 대화상자가 '-1'을 붙인다
  ck('우클릭 → 다른 이름으로 저장(도록-1-1.pdfw)', rc === path.join(dir, '도록-1-1.pdfw') && fs.existsSync(rc), rc);

  let fail = 0;
  out.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${out.length - fail} 통과 / ${fail} 실패\n`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  win.destroy();
  app.exit(fail ? 1 : 0);
});
