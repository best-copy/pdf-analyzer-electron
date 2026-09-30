// ❓ 왼쪽 패널 버튼 설명(?) · 📖 펼침 해상도 · 편집 모드 펼침 켜고 끄기 — 실제 화면
//   실행: npx electron scripts/test/sb-help-spread.e2e.js   (창을 띄우지 않는다 — show:false)
const path = require('path');
const os = require('os');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-e2e-sbhelp'));

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
    const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 60000)) { if (f()) return true; await sleep(50); } return false; };
    const g = id => document.getElementById(id);

    // ── ? 설명 ──
    const btns = [...document.querySelectorAll('#sbPanelBody button')];
    const titled = btns.filter(b => b.getAttribute('title'));
    ck('왼쪽 패널 버튼에 title 툴팁이 남아 있지 않음', titled.length === 0, titled.map(b => b.id));
    const rf = g('sb-refreshBtn');
    const q = rf.querySelector(':scope > .sbp-help');
    // (문서가 없어 버튼이 숨겨져 있다 — 자리는 DOM 순서와 계산된 스타일로 본다)
    ck('결과 새로고침 버튼 오른쪽에 ?', !!q && rf.lastElementChild === q && getComputedStyle(q).right === '4px' && getComputedStyle(q).left !== '4px');
    q.dispatchEvent(new MouseEvent('mouseenter'));
    const tip = g('sbHelpTip');
    ck('?에 올리면 설명이 뜸', tip && tip.style.display === 'block' && /F5/.test(tip.textContent), tip && tip.textContent);
    q.dispatchEvent(new MouseEvent('mouseenter'));
    q.dispatchEvent(new MouseEvent('mouseleave'));
    ck('떠나면 사라짐', tip.style.display === 'none');
    let pressed = 0; const orig = window.refreshResults; window.refreshResults = () => { pressed++; };
    q.click();
    window.refreshResults = orig;
    ck('?를 눌러도 버튼은 눌리지 않음', pressed === 0);
    ck('Dot Gain 선택 뒤에 ?', !!g('sb-dotGainSelect').nextElementSibling?.classList.contains('sbp-help'));
    // 편집 모드 패널도 같은 ? 표식 — title 대신, 칩 오른쪽 위 모서리에
    const ec = document.querySelector('#editSidebar [data-imp=booklet]');
    ck('편집 모드 칩에 title 대신 ?', !ec.getAttribute('title') && !!ec.lastElementChild?.classList.contains('sbp-help') && /중철/.test(ec.lastElementChild.dataset.help));
    const eTitled = [...document.querySelectorAll('#editSidebar button[title], #editSidebar select[title], #editSidebar label[title]')];
    ck('편집 모드 버튼·선택·이름표에 title 툴팁 없음', eTitled.length === 0, eTitled.map(e => e.id || e.textContent.trim().slice(0, 10)));
    // 코드가 title·글자를 나중에 바꿔도 ?가 유지된다
    rf.title = '새 설명';
    await sleep(0);
    ck('나중에 바뀐 title도 ?로 옮겨짐', !rf.getAttribute('title') && rf.querySelector('.sbp-help').dataset.help === '새 설명');
    rf.textContent = '🔄 결과 새로고침';
    await sleep(0);
    ck('글자를 통째로 바꿔도 ?가 다시 붙음', !!rf.querySelector(':scope > .sbp-help'));
    const fontTitle = document.querySelector('[data-sbsec=font] .sbp-title');
    ck('긴 설명문은 섹션 제목 옆 ?로', !!fontTitle.querySelector('.sbp-help') && !document.querySelector('[data-sbsec=font] .sbp-note'));

    // ── 펼침 해상도 ──
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 4; i++) d.addPage([420, 595]).drawText('P' + i, { x: 60, y: 300, size: 60, font: f, color: rgb(0, 0, 0) });
    const b = await d.save();
    startLoad([{ name: '원고.pdf', size: b.length, type: 'application/pdf', arrayBuffer: () => Promise.resolve(b.buffer.slice(0)) }]);
    await waitFor(() => pageResults.length === 4 && isTabReady(tabs.get(activeTabId)));
    await sleep(1000);
    setOutlineEnabled(false);
    const before = pageResults[0].thumbW;
    g('pagesGrid').scrollIntoView({ block: 'start' });   // 화면에 보이는 썸네일만 다시 굽는다
    await sleep(300);
    toggleSpreadView(true);
    const need = spreadRenderPx(480);
    await waitFor(() => pageResults[0].thumbW >= need * 0.95, 20000);
    ck('펼침을 켜면 보이는 썸네일을 펼침 크기로 다시 구움', pageResults[0].thumbW >= need * 0.95, { 전: before, 후: pageResults[0].thumbW, 목표: need });
    // 설명 창은 ? 바로 옆 — 보이는 ?로 잰다(문서가 없어 새로고침 버튼은 숨겨져 있다)
    const tip2 = g('sbHelpTip');
    const vq = [...document.querySelectorAll('#sbPanel .sbp-help')].find(e => e.offsetParent && e.getBoundingClientRect().width > 0);
    vq.dispatchEvent(new MouseEvent('mouseenter'));
    const tr = tip2.getBoundingClientRect(), qr = vq.getBoundingClientRect();
    ck('설명은 ? 바로 오른쪽 옆에', tr.left - qr.right >= 4 && tr.left - qr.right <= 16 && tr.top <= qr.bottom && tr.bottom >= qr.top, JSON.stringify([Math.round(qr.right), Math.round(tr.left), Math.round(qr.top), Math.round(tr.top)]));
    vq.dispatchEvent(new MouseEvent('mouseleave'));
    ck('펼침 렌더 폭이 예전(1.15배)보다 큼', spreadRenderPx(560) > Math.round(560 * 1.15), spreadRenderPx(560));
    // 결과 미리보기도 펼침 해상도
    editSettings.scaling.mode = 'standard'; editSettings.scaling.paper = 'A4';
    await applyChanges();
    await waitFor(() => document.querySelectorAll('#previewGrid canvas').length > 0, 30000);
    await sleep(500);
    const cv = document.querySelector('#previewGrid canvas');
    ck('결과 미리보기 펼침 캔버스 폭 = 새 해상도', cv && Math.abs(cv.width - spreadRenderPx(560)) <= 2, cv && cv.width);

    // ── 편집 모드에서 펼침 켜고 끄기 ──
    enterEditWorkspace();
    await sleep(300);
    const sb = g('spreadViewBtn');
    ck('편집 모드에서도 📖 펼침 버튼이 보임', getComputedStyle(sb).display !== 'none' && sb.offsetWidth > 0);
    ck('원본 페이지 보기 버튼은 여전히 숨김', [...document.querySelectorAll('#previewSection .preview-close')].filter(x => x !== sb).every(x => getComputedStyle(x).display === 'none'));
    sb.click();
    ck('편집 모드에서 펼침 끄기', !g('previewGrid').classList.contains('pv-spread') && !sb.classList.contains('active'));
    sb.click();
    ck('다시 켜기', g('previewGrid').classList.contains('pv-spread') && sb.classList.contains('active'));
    exitEditWorkspace(false);
    toggleSpreadView(false);
    return out;
  })()`);
  } catch (e) { res = [['✘', '하네스 오류', String(e && e.message || e)]]; }
  let fail = 0;
  res.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(fail ? `FAIL ${fail}/${res.length}` : `PASS ${res.length}/${res.length}`);
  win.destroy();
  app.exit(fail ? 1 : 0);
});
