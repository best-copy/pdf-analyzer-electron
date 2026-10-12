// 문서 탭을 오가도 ✔ 적용 결과·고른 서식이 풀리지 않는다 (2026-10-12 사용자 보고: 서식 적용 후 다른 탭에 다녀오면 적용이 풀림)
//   실행: npx electron scripts/test/tab-apply-keep.e2e.js   (창을 띄우지 않는다)
//   · 돌아오면 결과·결과 화면(쪽 그림도 다시 그리지 않고)·서식 표시가 그대로, 다른 탭에는 서식 표시가 없다
//   · 📖 임포징은 탭마다 따로 — A의 '1면 2쪽'이 B로 따라가지 않고, B에서 바꿔도 A는 그대로(결과도 유지)
//   · 탭들이 함께 쓰는 설정(Dot Gain)이 바뀌면 옛 결과를 되살리지 않는다
//   · 파일을 챕터로 더하면(합본 새 탭) 임포징을 이어받는다
const path = require('path'); const os = require('os');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');
app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-e2e-tabapply'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  win.webContents.on('console-message', (e, l, m) => { if (l >= 3 && !/No handler|Security/.test(m)) console.log('[앱오류]', m.slice(0, 300)); });
  await win.loadFile(path.join(ROOT, 'src/index.html')); await new Promise(r => setTimeout(r, 2500));
  const res = await win.webContents.executeJavaScript(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 120000)) { if (f()) return true; await sleep(80); } return false; };
    try { localStorage.removeItem('editPresets'); } catch (e) {}
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const mk = async (name, col) => { const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
      for (let i = 1; i <= 4; i++) { const p = d.addPage([300, 420]); p.drawRectangle({ x: 0, y: 0, width: 300, height: 420, color: col }); p.drawText(name + i, { x: 30, y: 300, size: 30, font: f }); }
      const b = await d.save(); return { name: name + '.pdf', size: b.length, type: 'application/pdf', arrayBuffer: () => Promise.resolve(b.buffer.slice(0)) }; };
    startLoad([await mk('A', rgb(0.2,0.4,0.9)), await mk('B', rgb(0.9,0.4,0.2))]);
    await waitFor(() => tabs.size === 2 && [...tabs.values()].every(isTabReady));
    const [idA, idB] = [...tabs.keys()];
    activateTab(idA); await sleep(500);
    setOutlineEnabled(false);
    // 서식: A4 · 1면 2쪽 · 흑백
    qpSetPaper('A4'); qpSetNup('2'); if (!processingOptions.bw) toggleOption('bw');
    const data = JSON.parse(JSON.stringify(Object.assign(presetFromSettings(activeLayoutSettings()), captureExtraPreset())));
    const ps = getPresets(); ps['테스트'] = data; savePresetsObj(ps); loadPresetList();
    qpApplyForm(''); await sleep(300);
    qpApplyForm('테스트'); await sleep(300);
    const snap = tag => ({ tag, tab: activeTabId === idA ? 'A' : 'B', paper: activeLayoutSettings().scaling.mode + '/' + activeLayoutSettings().scaling.paper,
      imp: _impEnabled + '/' + _impMode, bw: processingOptions.bw, sel: selectedPages.size, res: !!processedPdfBytes, form: _qpActiveForm,
      qpNup: document.getElementById('qpNup').value, prev: document.querySelectorAll('#previewGrid canvas').length,
      active: [...document.querySelectorAll('.qp-form.active')].map(b => b.dataset.qpform) });
    const out = [snap('서식 적용 직후')];
    pageResults.forEach(r => selectedPages.add(r.pageNum)); invalidateProcessed();
    await applyChanges(); await waitFor(() => !!processedPdfBytes, 120000); await sleep(1500);
    out.push(snap('✔ 적용 후'));
    setQpTab('print'); await sleep(800); setQpTab('page'); await sleep(800); setQpTab('forms'); await sleep(1500); out.push(snap('패널 탭 갔다 옴'));
    activateTab(idB); await sleep(1500); out.push(snap('B 탭'));
    activateTab(idA);
    // 결과 화면이 나타나는 첫 순간에 쪽 그림이 이미 채워져 있어야 한다(다시 그리기 대기 pv-pending 없음)
    await waitFor(() => document.querySelectorAll('#previewGrid .pv-cell').length > 0, 30000);
    const firstPend = document.querySelectorAll('#previewGrid .pv-cell.pv-pending').length;
    await sleep(2500); out.push(Object.assign(snap('A 로 돌아옴'), { firstPend }));
    activateTab(idB); await sleep(800); qpSetNup('4'); await sleep(800); out.push(snap('B에서 1면 4쪽으로 바꿈'));
    activateTab(idA); await sleep(2500); out.push(snap('A 로 돌아옴(B만 바뀜)'));
    activateTab(idB); await sleep(800); out.push(snap('B 다시'));
    setDotGain(10); await sleep(300);
    activateTab(idA); await sleep(1500);
    out.push(snap('A 로 돌아옴(공유 설정 바뀜)'));
    setDotGain(0);
    startLoad([await mk('C', rgb(0.3,0.8,0.3))]);
    await waitFor(() => activeTabId !== idA && tabs.has(activeTabId) && isTabReady(tabs.get(activeTabId)) && pageResults.length === 8, 120000); await sleep(800);
    out.push(snap('A에 챕터 추가(합본 탭)'));
    return out;
  })()`);
  const at = t => res.find(r => r.tag === t);
  const checks = [
    ['적용 직후 결과·결과 화면', at('✔ 적용 후').res && at('✔ 적용 후').prev > 0],
    ['패널 탭을 오가도 그대로', at('패널 탭 갔다 옴').res && at('패널 탭 갔다 옴').prev > 0],
    ['B 탭에는 A의 결과·서식 표시 없음', !at('B 탭').res && !at('B 탭').active.length],
    ['B 탭에는 A의 임포징이 따라가지 않음', at('B 탭').imp === 'false/' && at('B 탭').qpNup === '1', at('B 탭')],
    ['A로 돌아오면 결과가 그대로', at('A 로 돌아옴').res],
    ['A로 돌아오면 결과 화면이 다시 보임', at('A 로 돌아옴').prev > 0],
    ['결과 화면 쪽 그림이 다시 그리지 않고 그대로', at('A 로 돌아옴').firstPend === 0, at('A 로 돌아옴')],
    ['A로 돌아오면 서식 표시가 그대로', at('A 로 돌아옴').active.join() === '테스트'],
    ['B에서 1면 4쪽으로 바꿔도 A는 1면 2쪽·결과 그대로', at('A 로 돌아옴(B만 바뀜)').qpNup === '2' && at('A 로 돌아옴(B만 바뀜)').res && at('A 로 돌아옴(B만 바뀜)').active.join() === '테스트', at('A 로 돌아옴(B만 바뀜)')],
    ['B로 다시 가면 B의 1면 4쪽', at('B 다시').qpNup === '4' && at('B 다시').imp === 'true/nup'],
    ['공유 설정이 바뀌면 옛 결과를 되살리지 않음', !at('A 로 돌아옴(공유 설정 바뀜)').res && !at('A 로 돌아옴(공유 설정 바뀜)').active.length, at('A 로 돌아옴(공유 설정 바뀜)')],
    ['챕터를 더한 합본 탭은 임포징을 이어받음', at('A에 챕터 추가(합본 탭)').qpNup === '2' && at('A에 챕터 추가(합본 탭)').imp === 'true/nup', at('A에 챕터 추가(합본 탭)')],
  ];
  let fail = 0;
  checks.forEach(([n, ok, x]) => { if (!ok) fail++; console.log((ok ? '✔ ' : '✘ ') + n + (ok || !x ? '' : '  ' + JSON.stringify(x))); });
  console.log(`결과: ${checks.length - fail} 통과 / ${fail} 실패`);
  app.exit(fail ? 1 : 0);
});
