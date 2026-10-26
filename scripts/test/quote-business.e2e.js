// 📋 견적서 = 거래관리(business-mgmt) 견적서 구조 — 품목 · 단가산출내역(그룹 → 품목 단가) · 할인 행 · 보내기 형식 (2026-10-25)
//   실행: node scripts/test/quote-business.e2e.js
//   실제 앱 본체(TEST_WINDOW=left · 검사용 사용자 폴더). 컬러 2쪽·흑백 3쪽 문서를 열고 견적서 입력칸을 직접 바꿔 본다.
// 확인: ① 기본 견적 = '교재' 그룹(컬러·흑백·제본비) → 품목 '교재'(수량 1부)에 연결, 단가 = 그룹 소계(읽기 전용)
//       ② 품목 수량 = 부수 ③ 단가산출 행을 바꾸면 연결 품목 단가가 따라옴 ④ 개별 품목(단가·수량 직접) ⑤ 할인 행(양수 입력 → 차감)
//       ⑥ 둘째 그룹을 개별 품목에 연결 → 단가 자동 · 그룹 2개면 단가산출 합계 숨김 ⑦ 연결 해제 → 다시 직접 입력
//       ⑧ 인쇄 HTML(그룹 소계 행·비고·작업내역) ⑨ 거래관리 보내기 = 거래관리 저장 형식(items·calcRows·calcHeaders, 연결 id 일치, 합계 일치)
//       ⑩ 작업 파일 저장 → 다시 열기(단가산출내역·고객명까지, 화면도) ⑪ 옛 견적(부수·할인율 칸) → 그룹 + 연결 품목으로 옮기기
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const electron = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = 9377;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = u => new Promise((res, rej) => http.get(u, r => { let s = ''; r.on('data', d => s += d); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } }); }).on('error', rej));
async function connect() {
  for (let i = 0; i < 200; i++) {
    try {
      const t = (await getJson(`http://127.0.0.1:${PORT}/json`)).find(x => x.type === 'page' && /index\.html/.test(x.url));
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
        let id = 0; const w = new Map();
        ws.onmessage = m => { const d = JSON.parse(m.data); if (w.has(d.id)) { w.get(d.id)(d); w.delete(d.id); } };
        const call = (method, params) => new Promise(r => { const k = ++id; w.set(k, r); ws.send(JSON.stringify({ id: k, method, params })); });
        const ev = expr => call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
          .then(d => d.result && d.result.result ? d.result.result.value : { __err: JSON.stringify(d).slice(0, 400) });
        return { ev, call };
      }
    } catch (e) {}
    await sleep(300);
  }
  throw new Error('CDP 연결 실패');
}

const out = [];
const ck = (n, c, x) => { out.push(c ? '✔' : '✘'); console.log(`  ${c ? '✔' : '✘'} ${n} ${x === undefined ? '' : JSON.stringify(x).slice(0, 320)}`); };

(async () => {
  let child;
  try {
    child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env: { ...process.env, TEST_WINDOW: 'left' }, stdio: 'ignore' });
    const { ev } = await connect();
    for (let i = 0; i < 100 && !(await ev(`typeof startLoad === 'function' && document.readyState === 'complete'`)); i++) await sleep(300);
    await sleep(1500);
    await ev(`window.__errs = []; { const oe = window.showError; window.showError = m => { window.__errs.push(String(m)); try { oe(m); } catch (e) {} }; } window.confirm = () => true;
      localStorage.setItem('quoteDefaultPrices', JSON.stringify({ color: 200, bw: 60, binding: 2500 })); 1`);
    await ev(`(async () => { const d = await PDFLib.PDFDocument.create();
      for (let i = 0; i < 5; i++) { const p = d.addPage([300, 400]); p.drawRectangle({ x: 20, y: 20, width: 260, height: 360, color: i < 2 ? PDFLib.rgb(0.9, 0.1, 0.1) : PDFLib.rgb(0.3, 0.3, 0.3) }); }
      const b = await d.save(); startLoad([{ name: '교재.pdf', size: b.length, type: 'application/pdf', arrayBuffer: () => Promise.resolve(b.buffer.slice(0)) }]); return 1; })()`);
    for (let i = 0; i < 80 && !(await ev(`quoteItems.length >= 1 && !!document.querySelector('#quoteCalcBody .qc-group-row')`)); i++) await sleep(300);
    await sleep(500);

    const items = () => ev(`quoteItems.map(it => (it.isDiscount ? '할인' : it.name) + ':' + it.qty + '×' + it.price).join(' | ')`);
    const calc = () => ev(`quoteCalc.rows.map(r => r.isGroup ? '[' + r.content + (r.linkItemId ? '→' + ((quoteItems.find(i => i.calcLinkId === r.linkItemId) || {}).name || '?') : '') + ']' : r.content + ':' + r.price + '×' + r.pages).join(' ')`);
    const grand = () => ev(`document.getElementById('grandTotal').textContent`);
    const setIn = (sel, v, evt) => ev(`(() => { const el = ${sel}; el.value = ${JSON.stringify(String(v))}; el.dispatchEvent(new Event(${JSON.stringify(evt || 'input')}, { bubbles: true })); return 1; })()`);
    const itemRow = i => `document.querySelectorAll('#quoteItemBody tr')[${i}]`;
    const calcRow = i => `document.querySelectorAll('#quoteCalcBody tr')[${i}]`;

    // ①
    const r1 = { items: await items(), calc: await calc(), ro: await ev(`${itemRow(0)}.querySelector('.q-item-price').readOnly`) };
    ck('① 기본: [교재→교재] 컬러 200×2 · 흑백 60×3 · 제본비 2500×1 → 품목 교재 1부 × 3,080(읽기 전용)',
      r1.calc === '[교재→교재] 컬러인쇄:200×2 흑백인쇄:60×3 제본비:2500×1' && r1.items === '교재:1×3080' && r1.ro === true, r1);

    // ② 수량 = 부수
    await setIn(`${itemRow(0)}.querySelector('.q-item-qty')`, 5);
    ck('② 품목 수량(부수) 5 → 합계 15,400원', (await grand()) === '15,400원', await grand());

    // ③ 단가산출 행 → 연결 품목 단가
    await setIn(`${calcRow(1)}.querySelector('.qc-price')`, 300);
    const r3 = { items: await items(), price: await ev(`${itemRow(0)}.querySelector('.q-item-price').value`), sub: await ev(`${calcRow(0)}.querySelector('.qc-group-sub').textContent`) };
    ck('③ 컬러 단가 300 → 그룹 소계 3,280 → 품목 단가 3,280(화면도) · 합계 16,400', r3.items === '교재:5×3280' && r3.price === '3280' && /3,280/.test(r3.sub) && (await grand()) === '16,400원', r3);

    // ④ 개별 품목
    await ev(`addQuoteItem(); 1`);
    await setIn(`${itemRow(1)}.querySelector('.q-item-name')`, '포스터');
    await setIn(`${itemRow(1)}.querySelector('.q-item-qty')`, 10);
    await setIn(`${itemRow(1)}.querySelector('.q-item-price')`, 500);
    ck('④ 개별 품목 포스터 10 × 500 → 합계 21,400', (await items()) === '교재:5×3280 | 포스터:10×500' && (await grand()) === '21,400원', { items: await items(), g: await grand() });

    // ⑤ 할인 행
    await ev(`addQuoteDiscount(); 1`);
    await setIn(`${itemRow(2)}.querySelector('.q-item-price')`, 1000);
    ck('⑤ 할인 행 1,000(양수 입력) → 단가 −1000 · 합계 20,400', (await items()).endsWith('할인:1×-1000') && (await grand()) === '20,400원', { items: await items(), g: await grand() });

    // ⑥ 둘째 그룹 → 포스터에 연결
    await ev(`addQuoteCalcGroup(); addQuoteCalcRow(); 1`);
    await setIn(`${calcRow(4)}.querySelector('.qc-group-name')`, '포스터 단가');
    await setIn(`${calcRow(5)}.querySelector('.qc-content')`, 'A2 컬러출력');
    await setIn(`${calcRow(5)}.querySelector('.qc-price')`, 700);
    await setIn(`${calcRow(5)}.querySelector('.qc-pages')`, 1);
    const posterId = await ev(`quoteItems[1].calcLinkId`);
    await setIn(`${calcRow(4)}.querySelector('.qc-link')`, posterId, 'change');
    const r6 = { items: await items(), calc: await calc(), ro: await ev(`${itemRow(1)}.querySelector('.q-item-price').readOnly`), totalShown: await ev(`document.getElementById('qcTotalWrap').style.display`) };
    ck('⑥ [포스터 단가→포스터] A2 700×1 → 포스터 단가 700(읽기 전용) · 합계 22,400 · 그룹 2개라 단가산출 합계 숨김',
      r6.items.includes('포스터:10×700') && r6.ro === true && (await grand()) === '22,400원' && r6.totalShown === 'none', r6);

    // ⑦ 연결 해제
    await setIn(`${calcRow(4)}.querySelector('.qc-link')`, '', 'change');
    await setIn(`${itemRow(1)}.querySelector('.q-item-price')`, 650);
    ck('⑦ 연결 해제 → 포스터 단가 다시 직접(650)', (await items()).includes('포스터:10×650') && (await ev(`${itemRow(1)}.querySelector('.q-item-price').readOnly`)) === false, await items());
    await setIn(`${calcRow(4)}.querySelector('.qc-link')`, posterId, 'change');   // 다시 연결(보내기 확인용)

    // ⑧ 인쇄 HTML
    await setIn(`document.getElementById('q-customer')`, '한국대학교');
    await setIn(`document.getElementById('q-memo')`, '결제: 현금');
    await setIn(`document.getElementById('q-work-notes')`, '표지 별도 확인');
    const html = await ev(`buildQuoteHTML(true)`);
    ck('⑧ 인쇄 HTML: ▣ 단가산출내역 · 교재 소계 · 포스터 단가 소계 · 비고 · 작업내역 · 할인 행', /▣ 단가산출내역/.test(html) && /교재 소계/.test(html) && /포스터 단가 소계/.test(html)
      && /결제: 현금/.test(html) && /표지 별도 확인/.test(html) && /class="disc"/.test(html) && html.includes('22,400원'), html.length);

    // ⑨ 거래관리 보내기 — 그쪽 저장 형식
    const pay = await ev(`JSON.stringify(buildBusinessQuotePayload())`);
    const p = JSON.parse(pay);
    const linkOk = p.calcRows.filter(r => r.isGroup).every(r => !r.linkItemId || p.items.some(i => i.calcLinkId === r.linkItemId));
    const sumOk = p.items.reduce((s, i) => s + (i.isDiscount ? 1 : i.qty) * i.price, 0) === p.expectedTotal;
    // 거래관리가 열 때 하는 일(그룹 소계 → 연결 품목 단가)을 해도 값이 그대로인지
    let cur = null; const subs = {}; p.calcRows.forEach(r => { if (r.isGroup) { cur = r; subs[r.linkItemId] = 0; } else if (cur && cur.linkItemId) subs[cur.linkItemId] += r.price * r.pages; });
    const stableOk = Object.keys(subs).every(id => !id || p.items.find(i => i.calcLinkId === id).price === subs[id]);
    const shape = p.items.every(i => ['name', 'spec', 'qty', 'price', 'taxRate', 'calcLinkId'].every(k => k in i)) && p.calcRows.every(r => r.isGroup ? ('linkItemId' in r && 'content' in r) : ['content', 'price', 'pages'].every(k => k in r));
    ck('⑨ 보내기 v2: items(거래관리 품목 형식)·calcRows(그룹 linkItemId = 품목 calcLinkId)·calcHeaders·비고·작업내역', p.version === 2 && shape && linkOk
      && p.calcHeaders.content === '내용' && p.memo === '결제: 현금' && p.workNotes === '표지 별도 확인' && Array.isArray(p.calcTables), { v: p.version, shape, linkOk, items: p.items.length, rows: p.calcRows.length });
    ck('⑨ 합계 = 수량×단가 합(거래관리 계산식) = 22,400 · 거래관리가 그룹 소계를 다시 적용해도 단가 그대로', sumOk && p.expectedTotal === 22400 && stableOk, { exp: p.expectedTotal, sumOk, stableOk });

    // ⑩ 작업 파일 → 다시 열기
    const reopened = await ev(`(async () => { const r = buildWorkFileBytesSync(null); await openWorkFileBytes(r.bytes, 'test');
      return { tabs: tabs.size, items: quoteItems.map(it => (it.isDiscount ? '할인' : it.name) + ':' + it.qty + '×' + it.price).join(' | '),
               groups: quoteCalc.rows.filter(r => r.isGroup).map(r => r.content + '→' + ((quoteItems.find(i => i.calcLinkId === r.linkItemId) || {}).name || '')).join(','), memo: quoteCalc.memo,
               dom: [...document.querySelectorAll('#quoteItemBody tr')].map(tr => tr.querySelector('.q-item-qty').value + '×' + tr.querySelector('.q-item-price').value).join(' | '),
               calcDom: document.querySelectorAll('#quoteCalcBody tr').length, customer: document.getElementById('q-customer').value, grand: document.getElementById('grandTotal').textContent }; })()`);
    ck('⑩ 작업 파일 저장 → 다시 열기: 품목·단가산출 그룹 연결·비고 그대로', reopened.items === '교재:5×3280 | 포스터:10×700 | 할인:1×-1000' && reopened.groups === '교재→교재,포스터 단가→포스터' && reopened.memo === '결제: 현금', reopened);
    ck('⑩ 다시 연 화면도 되살린 견적(품목 행·단가산출 행·고객명·합계)', reopened.dom === '5×3280 | 10×700 | 1×1000' && reopened.calcDom === 6 && reopened.customer === '한국대학교' && reopened.grand === '22,400원', reopened);

    // ⑪ 옛 견적 옮기기
    const mig = await ev(`(() => { const m = migrateLegacyQuote([{ name: '컬러인쇄', spec: '', qty: 227, price: 200, copies: 3, discount: 0 }, { name: '흑백인쇄', spec: '', qty: 4, price: 60, copies: 3, discount: 0 },
        { name: '제본비', spec: '', qty: 1, price: 2500, copies: 3, discount: 0 }, { name: '코팅', spec: 'A4', qty: 2, price: 1000, copies: 3, discount: 10 }], '논문.pdf');
      return { items: m.items.map(i => i.name + ':' + i.qty + '×' + i.price).join(' | '), rows: m.calc.rows.map(r => r.isGroup ? '[' + r.content + ']' : r.content + ':' + r.price + '×' + r.pages).join(' '),
               link: m.calc.rows[0].linkItemId === m.items[0].calcLinkId }; })()`);
    ck('⑪ 옛 견적: [논문] 컬러 200×227 · 흑백 60×4 · 제본비 → 품목 논문 3부 × 48,140 · 코팅은 개별(6 × 900)',
      mig.rows === '[논문] 컬러인쇄:200×227 흑백인쇄:60×4 제본비:2500×1' && mig.items === '논문:3×48140 | 코팅:6×900' && mig.link, mig);

    ck('오류 표시 없음', !(await ev(`window.__errs.length`)), await ev(`window.__errs.slice()`));
  } catch (e) {
    ck('실행 오류', false, String(e && e.stack || e));
  } finally {
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (e) {}
    await sleep(800);
    const fail = out.filter(r => r === '✘').length;
    console.log(`\n결과: ${out.length - fail} 통과 / ${fail} 실패\n`);
    process.exit(fail ? 1 : 0);
  }
})();
