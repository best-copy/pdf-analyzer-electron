// ⚙ 오른쪽 기본 설정 패널(서식 파일 · 인쇄 설정 · 페이지 설정) — 실제 화면·preload·조립 워커
//   실행: npx electron scripts/test/quick-panel.e2e.js   (창을 띄우지 않는다 — show:false)
// 확인:
//   · 문서를 열면 오른쪽에 뜨고, 접기/펴기가 기억되며, 편집 모드에서는 숨는다
//   · 인쇄 설정이 편집 모드와 **같은 설정**을 바꾼다(용지·방향·1면 N쪽=임포징 모아찍기·배율·제본)
//   · '원본 배율 조정' 끔 = 저장본에서 원고가 100% 크기(용지는 A4)
//   · 페이지 설정(머리글·쪽 번호·워터마크)
//   · 서식 파일: ＋ 서식 추가 → 그림 목록에 나타남 → 원본과 같음 → 그 서식을 누르면 설정 복원
const path = require('path');
const os = require('os');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-e2e-quickpanel'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));

  let res;
  try {
    res = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 120000)) { if (f()) return true; await sleep(50); } return false; };
    const g = id => document.getElementById(id);
    const pick = (id, v) => { const el = g(id); el.value = v; el.dispatchEvent(new Event('change')); };
    const tick = (id, on) => { const el = g(id); el.checked = on; el.dispatchEvent(new Event('change')); };
    const shown = () => getComputedStyle(g('quickPanel')).display !== 'none';
    try { localStorage.removeItem('editPresets'); localStorage.removeItem('qpClosed'); } catch (e) {}
    toggleQuickPanel(true);

    ck('문서가 없으면 패널이 숨어 있음', !shown());
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 4; i++) d.addPage([300, 300]).drawText('P' + i, { x: 40, y: 150, size: 40, font: f, color: rgb(0, 0, 0) });
    const b = await d.save();
    startLoad([{ name: '원고.pdf', size: b.length, type: 'application/pdf', arrayBuffer: () => Promise.resolve(b.buffer.slice(0)) }]);
    await waitFor(() => pageResults.length === 4 && isTabReady(tabs.get(activeTabId)));
    await sleep(1200);
    setOutlineEnabled(false);

    ck('문서를 열면 오른쪽에 패널', shown() && Math.abs(g('quickPanel').getBoundingClientRect().right - document.documentElement.clientWidth) <= 1,
       [g('quickPanel').getBoundingClientRect().right, document.documentElement.clientWidth]);
    ck('본문이 패널만큼 비켜남', parseFloat(getComputedStyle(document.body).paddingRight) >= g('quickPanel').offsetWidth);
    ck('편집 모드 탭이 패널 왼쪽으로', g('editToggle').getBoundingClientRect().right <= g('quickPanel').getBoundingClientRect().left + 1);
    toggleQuickPanel(false);
    ck('접으면 숨고 ⚙ 탭이 보임', !shown() && getComputedStyle(g('qpToggle')).display !== 'none' && localStorage.getItem('qpClosed') === '1');
    toggleQuickPanel(true);
    ck('다시 펴짐', shown());

    // ── 인쇄 설정 ──
    setQpTab('print');
    ck('인쇄 설정 탭이 보임', !document.querySelector('[data-qppane=print]').hidden && document.querySelector('[data-qppane=forms]').hidden);
    ck('처음엔 원본과 같음 · 1면 1쪽 · 제본 없음', g('qpPaper').value === 'none' && g('qpNup').value === '1' && g('qpBind').value === '');
    ck('원본과 같음이면 방향·배율 칸이 꺼짐', g('qpOrient').disabled && g('qpFit').disabled);
    pick('qpPaper', 'A4');
    ck('용지 A4 → 편집 설정 규격 A4', editSettings.scaling.mode === 'standard' && editSettings.scaling.paper === 'A4');
    ck('편집 모드 칸도 A4', g('esPaperSel').value === 'A4');
    pick('qpOrient', 'portrait');
    ck('방향 세로 → 설정', editSettings.scaling.orient === 'portrait');
    ck('배율 조정 기본 켬', g('qpFit').checked && !g('qpFit').disabled);
    tick('qpFit', false);
    ck('배율 조정 끔 → keep100 · 편집 모드 체크도', editSettings.scaling.keep100 === true && g('esKeep100').checked);
    // 저장본: 용지 A4, 원고는 100%(글자 크기 40)
    {
      const bytes = await buildOptimizedBase();
      const doc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
      const pg = await doc.getPage(1); const vp = pg.getViewport({ scale: 1 });
      const it = (await pg.getTextContent()).items.find(x => x.str === 'P1');
      await doc.destroy();
      ck('저장본 A4 · 원고 100%', Math.round(vp.width) === 595 && Math.round(vp.height) === 842 && it && Math.abs(Math.hypot(it.transform[0], it.transform[1]) - 40) < 0.5,
         [Math.round(vp.width), Math.round(vp.height), it && it.transform[0]]);
    }
    tick('qpFit', true);
    ck('배율 조정 켬 → keep100 해제', !editSettings.scaling.keep100);

    // 1면 2쪽 = 임포징 모아찍기
    pick('qpNup', '2');
    ck('1면 2쪽 → 임포징 모아찍기 켜짐', _impEnabled && _impMode === 'nup');
    ck('칸 2×1', g('impAcross').value === '2' && g('impDown').value === '1');
    ck('대지 = A4, 쪽 규격화는 끔(두 번 줄지 않게)', g('bkPaper').value === 'A4' && editSettings.scaling.mode === 'none');
    ck('패널은 여전히 A4 · 1면 2쪽', g('qpPaper').value === 'A4' && g('qpNup').value === '2' && g('qpNupIco').textContent === '2');
    ck('모아찍기 중 방향 칸 꺼짐', g('qpOrient').disabled);
    pick('qpNup', '4');
    ck('1면 4쪽 → 2×2', g('impAcross').value === '2' && g('impDown').value === '2');
    pick('qpPaper', 'A3');
    ck('모아찍기 중 용지 바꾸면 대지가 바뀜', g('bkPaper').value === 'A3' && editSettings.scaling.mode === 'none');
    ck('모아찍기 중 A5는 고를 수 없음', g('qpPaper').querySelector('option[value=A5]').disabled);
    tick('qpFit', false);
    ck('모아찍기 중 배율 조정 끔 → 배치 100%', _impScale === 'orig');
    tick('qpFit', true);
    pick('qpNup', '1');
    ck('1면 1쪽 → 모아찍기 끔, 대지 용지가 쪽 용지로', !_impEnabled && editSettings.scaling.mode === 'standard' && editSettings.scaling.paper === 'A3');
    // 다른 임포징(중철)이 켜져 있으면 알려 준다
    setImpMode('booklet'); toggleImpEnabled(true); qpSync();
    ck('중철 사용 중이면 1면 N쪽이 그렇게 표시', g('qpNup').value === 'other' && /중철/.test(g('qpNup').selectedOptions[0].textContent) && /중철/.test(g('qpPrintState').textContent));
    toggleImpEnabled(false); setImpMode(''); qpSync();

    pick('qpBind', 'left');
    ck('제본 왼쪽 → 제본여백 켜짐', editSettings.bind.enabled && editSettings.bind.side === 'left' && g('esBindEnabled').checked);
    pick('qpBind', '');
    ck('제본여백 없음 → 꺼짐', !editSettings.bind.enabled);

    // ── 페이지 설정 ──
    setQpTab('page');
    tick('qpHf', true);
    ck('머리글·바닥글 넣기 → 켜짐 + 문구 없으면 안내', editSettings.hf.enabled && /문구가 비어/.test(g('qpPageState').textContent));
    tick('qpHf', false);
    tick('qpPn', true);
    ck('쪽 번호 넣기 → 켜짐', editSettings.pn.enabled && g('esPnEnabled').checked);
    pick('qpWm', '대외비');
    ck('워터마크 대외비 → 켜짐', editSettings.wm.enabled && editSettings.wm.text === '대외비');

    // ── 서식 파일 ──
    setQpTab('forms');
    ck('서식이 없으면 원본과 같음 + 안내', document.querySelectorAll('#qpFormList .qp-form').length === 1 && /아직 없습니다/.test(g('qpFormList').textContent));
    promptText = async () => '테스트 서식';
    await qpAddForm();
    const items = [...document.querySelectorAll('#qpFormList .qp-form')];
    ck('＋ 서식 추가 → 목록에 그림과 함께', items.length === 2 && items[1].querySelector('svg') && /테스트 서식/.test(items[1].textContent), items.map(x => x.textContent.trim().slice(0, 30)));
    ck('설명에 설정 요약', /A3/.test(items[1].textContent) && /쪽 번호/.test(items[1].textContent) && /워터마크/.test(items[1].textContent), items[1].querySelector('.qp-form-desc').textContent);
    ck('편집 모드 프로파일 목록에도 있음', [...g('esPresetSel').options].some(o => o.value === '테스트 서식'));
    items[0].click();
    ck('원본과 같음 → 설정 초기화', editSettings.scaling.mode === 'none' && !editSettings.pn.enabled && !editSettings.wm.enabled);
    document.querySelectorAll('#qpFormList .qp-form')[1].click();
    ck('서식을 누르면 설정 복원', editSettings.scaling.mode === 'standard' && editSettings.scaling.paper === 'A3' && editSettings.pn.enabled && editSettings.wm.text === '대외비');
    ck('적용한 서식이 강조됨', document.querySelectorAll('#qpFormList .qp-form')[1].classList.contains('active'));

    // 편집 모드에서는 숨고, 편집 모드에서 바꾼 값이 나오면 패널에 보인다
    enterEditWorkspace();
    ck('편집 모드에서는 패널 숨김', !shown());
    setScaleMode('standard'); g('esPaperSel').value = 'B5'; g('esPaperSel').dispatchEvent(new Event('change'));
    exitEditWorkspace(false);
    setQpTab('print');
    ck('편집 모드에서 바꾼 B5가 패널에', shown() && g('qpPaper').value === 'B5');
    return out;
  })()`);
  } catch (e) { res = [['✘', '하네스 오류', String(e && e.message || e)]]; }

  let fail = 0;
  res.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(fail ? `FAIL ${fail}/${res.length}` : `PASS ${res.length}/${res.length}`);
  win.destroy();
  app.exit(fail ? 1 : 0);
});
