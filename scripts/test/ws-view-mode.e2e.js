// ✏ 편집 모드 미리보기: 항상 '결과'(흑백 반영)로 시작하고, '📄 원본 보기'로만 원본이 보인다
//   실행: npx electron scripts/test/ws-view-mode.e2e.js            (합성 문서)
//         set WSVIEW_PDFW=D:\...\test.pdfw & npx electron scripts/test/ws-view-mode.e2e.js   (실파일)
// 회귀: 예전엔 규칙이 셋으로 갈려 — 흑백만 적용하고 편집 모드에 들어가면 **원본(컬러)**,
//   여백을 주면 결과(흑백) — 같은 문서인데 화면 색이 왔다 갔다 했다.
const path = require('path');
const os = require('os');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-e2e-wsview'));
const PDFW = process.env.WSVIEW_PDFW || '';

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1500, height: 1000,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));

  const res = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 300000)) { if (f()) return true; await sleep(120); } return false; };
    setOutlineEnabled(false);

    const pdfw = ${JSON.stringify(PDFW)};
    if (pdfw) {
      await openWorkFilePath(pdfw);
    } else {
      // 컬러 면(파랑)과 검정 글자 — 흑백으로 바꾸면 채도가 사라진다
      const { PDFDocument, StandardFonts, rgb } = PDFLib;
      const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
      for (let i = 1; i <= 4; i++) {
        const p = d.addPage([300, 420]);
        p.drawRectangle({ x: 0, y: 0, width: 300, height: 420, color: rgb(0.15, 0.35, 0.85) });
        p.drawText('P' + i, { x: 30, y: 360, size: 30, font: f, color: rgb(0, 0, 0) });
      }
      const b = await d.save();
      startLoad([{ name: '컬러.pdf', size: b.length, type: 'application/pdf', arrayBuffer: () => Promise.resolve(b.buffer.slice(0)) }]);
    }
    await waitFor(() => pageResults.length && pageResults.every(x => x && x.thumbnail), 300000);

    // 흑백변환 적용 (사용자 흐름: 전체 선택 → 적용)
    if (!processingOptions.bw) toggleOption('bw');
    pageResults.forEach(r => selectedPages.add(r.pageNum));
    invalidateProcessed();
    await applyChanges();
    await waitFor(() => !!processedPdfBytes, 600000);

    // 미리보기 캔버스의 채도 픽셀 비율 — 다시 그리는 중일 수 있으니 값이 멈출 때까지 기다린다
    const satNow = () => {
      const c = document.querySelector('#previewGrid canvas');
      if (!c || !c.width) return null;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let sat = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const mx = Math.max(d[i], d[i+1], d[i+2]), mn = Math.min(d[i], d[i+1], d[i+2]);
        if (mx - mn > 18) sat++;
        n++;
      }
      return +(100 * sat / n).toFixed(2);
    };
    // want: 'gray' | 'color' — 그 상태가 될 때까지(최대 40초) 기다렸다가 마지막 값을 돌려준다
    const satPct = async (want) => {
      await waitFor(() => document.querySelectorAll('#previewGrid canvas').length > 0, 120000);
      const okv = v => v !== null && (want === 'color' ? v > 5 : v < 1.5);
      const t = Date.now(); let v = null, stable = 0, prev = null;
      while (Date.now() - t < 40000) {
        v = satNow();
        if (okv(v)) { stable = (v === prev) ? stable + 1 : 0; if (stable >= 1) return v; }
        prev = v;
        await sleep(700);
      }
      return v;
    };

    // ① 편집 모드 진입 — 편집 옵션이 하나도 없어도 결과(흑백)가 보여야 한다
    enterEditWorkspace();
    const s1 = await satPct('gray');
    ck('① 편집 모드 진입 = 결과(흑백) 미리보기', s1 !== null && s1 < 1.5, s1);
    ck('① 한 줄 표시가 결과라고 알림', /결과 미리보기/.test(document.getElementById('pvViewNote').textContent),
       document.getElementById('pvViewNote').textContent);
    ck('① 결과 보기 버튼이 눌려 있음', document.getElementById('pvViewResult').classList.contains('active'));

    // ② 여백을 줘도 그대로 결과(흑백) — 예전엔 여기서만 흑백이었다
    const es = tabs.get(activeTabId).editSettings;
    es.margin = Object.assign({}, es.margin || {}, { on: true, top: 10, bottom: 10, left: 10, right: 10 });
    invalidateProcessed();
    scheduleLivePreview();
    await sleep(1500);
    const s2 = await satPct('gray');
    ck('② 여백을 줘도 결과(흑백) 유지', s2 !== null && s2 < 1.5, s2);

    // ③ 📄 원본 보기 → 컬러로 보이고, 표시도 원본이라고 알린다
    document.getElementById('pvViewOriginal').click();
    await sleep(500);
    const s3 = await satPct('color');
    ck('③ 원본 보기 = 컬러', s3 !== null && s3 > 5, s3);
    ck('③ 한 줄 표시가 원본이라고 경고', /원본 보는 중/.test(document.getElementById('pvViewNote').textContent),
       document.getElementById('pvViewNote').textContent);

    // ④ 원본 보기 중에 설정을 바꿔도 결과로 튀지 않는다
    es.margin.top = 20;
    invalidateProcessed();
    scheduleLivePreview();
    await sleep(1500);
    const s4 = await satPct('color');
    ck('④ 원본 보기 중 설정 변경 — 원본 유지', s4 !== null && s4 > 5, s4);

    // ⑤ 🖨 결과 보기로 되돌리면 다시 흑백
    document.getElementById('pvViewResult').click();
    await sleep(2500);
    const s5 = await satPct('gray');
    ck('⑤ 결과 보기로 복귀 = 흑백', s5 !== null && s5 < 1.5, s5);

    // ⑥ 나갔다 다시 들어오면 항상 결과부터
    document.getElementById('pvViewOriginal').click();
    await sleep(300);
    exitEditWorkspace(false);
    await sleep(500);
    enterEditWorkspace();
    const s6 = await satPct('gray');
    ck('⑥ 다시 들어오면 결과부터(원본 보기는 기억하지 않음)', s6 !== null && s6 < 1.5, s6);
    return out;
  })()`);

  let fail = 0;
  res.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${res.length - fail} 통과 / ${fail} 실패\n`);
  win.destroy();
  app.exit(fail ? 1 : 0);
});
