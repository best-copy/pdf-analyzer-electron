// ✂ 재단선·블리드 통합 E2E — 트림 인식 배치 / 재단선 모양 2종·기억 / 재단 치수 표기·위치
//   실행: npx electron scripts/test/imposition-marks.e2e.js
const path = require('path');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1440, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));

  let res;
  try {
    res = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
    const MM = 72 / 25.4;
    const { PDFDocument } = PDFLib;

    // ── ① 트림 인식 배치 — 블리드가 있는 원고는 '트림'이 칸에 맞아야 한다 ──
    const d = await PDFDocument.create(); d.addPage([100, 100]);
    const plain = new Uint8Array(await d.save());
    const bled = (await buildBleedBytes(plain, 3, null, { crop: false })).bytes;   // 117×117, TrimBox 기록
    const probe = async (bytes, bleedOpt) => {
      const src = await PDFDocument.load(bytes.slice(0));
      const o = await PDFDocument.create();
      const emb = await embedAllPages(o, src, null);
      const pg = o.addPage([400, 400]);
      return drawPlaced(pg, emb[0], { x: 100, y: 100, w: 200, h: 200 }, { bleed: bleedOpt, place: { scale: 'fit' } });
    };
    const near = (a, b) => Math.abs(a - b) < 0.05;
    let t = await probe(bled, 0);
    ck('블리드 원고 + 임포징 블리드 0 → 트림이 칸과 일치', near(t.w, 200) && near(t.h, 200) && near(t.x, 100), t);
    t = await probe(bled, 3);
    ck('블리드 원고 + 임포징 블리드 3 → 이중 적용 안 함(칸과 일치)', near(t.w, 200) && near(t.h, 200), t);
    t = await probe(plain, 3);
    ck('블리드 없는 원고 + 임포징 블리드 3 → 종전대로 칸 크기 트림', near(t.w, 200) && near(t.h, 200), t);
    t = await probe(plain, 0);
    ck('블리드도 원고 여백도 없음 → 칸 크기', near(t.w, 200) && near(t.h, 200), t);

    // ── ② 재단선 모양: '겹침 없음'은 이웃과 마주 보는 쪽 마크를 짧게 잘라야 한다 ──
    const twoTrims = [{ x: 50, y: 50, w: 100, h: 60 }, { x: 170, y: 50, w: 100, h: 60 }];   // 사이 20pt
    const markBytes = async (shape) => {
      const o = await PDFDocument.create();
      const pg = o.addPage([400, 200]);
      drawTrimMarks(pg, twoTrims, { cropStyle: { shape, gap: 1, len: 4, th: 0.4 } });
      return (await o.save()).length;
    };
    const bCorner = await markBytes('corner'), bNo = await markBytes('notouch');
    ck('두 모양 모두 그려짐', bCorner > 500 && bNo > 500, { bCorner, bNo });
    ck("'겹침 없음'은 마주 보는 쪽 마크가 짧아짐(다른 그림)", bCorner !== bNo, { bCorner, bNo });

    // ── ③ 재단선 설정 기억 (모양·수치·치수표기) ──
    const g = id => document.getElementById(id);
    g('impCropShape').value = 'notouch'; g('impCropGap').value = 2; g('impCropLen').value = 5;
    g('impCropTh').value = 0.8; g('impCropCenter').checked = true; g('impCropDims').checked = true;
    saveImpCropStyle();
    g('impCropShape').value = 'corner'; g('impCropGap').value = 1; g('impCropCenter').checked = false; g('impCropDims').checked = false;
    restoreImpCropStyle();
    ck('마지막 재단선 설정이 복원됨',
       g('impCropShape').value === 'notouch' && +g('impCropGap').value === 2 && +g('impCropLen').value === 5
       && +g('impCropTh').value === 0.8 && g('impCropCenter').checked,
       { shape: g('impCropShape').value, gap: g('impCropGap').value });
    // 📏 재단 치수는 '시험' 기능이라 기억하지 않는다 — 다시 열면 항상 꺼진 상태
    ck('재단 치수는 복원되지 않음(기본 꺼짐)', g('impCropDims').checked === false, g('impCropDims').checked);
    ck('_impCropStyle이 모양을 함께 넘김', _impCropStyle().shape === 'notouch', _impCropStyle());

    // ── ④ 재단 치수 = 재단기에 넣는 '자를 때마다의 거리' ──
    // 90×50mm 카드 4벌을 A4에 100% 배치(여백 12, 거터 6) → 가로 12·90·6·90·12 순서가 찍혀야 한다
    const cards = await PDFDocument.create();
    for (let i = 0; i < 4; i++) cards.addPage([90 * MM, 50 * MM]);
    const cardBytes = new Uint8Array(await cards.save());
    const sheet = [210 * MM, 297 * MM];
    const nupOpts = {
      across: 2, down: 2, sides: 1, order: 'sequential', sheet,
      margin: 12, hgap: 6, vgap: 6, crop: true, cropDims: true,
      cropStyle: { shape: 'corner', gap: 1, len: 4, th: 0.4 },
      place: { scale: 'orig', align: 'cc' },
    };
    const nup = await buildNupBytes(cardBytes, nupOpts, null);
    const readNums = async (bytes) => {
      const doc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
      const pg = await doc.getPage(1);
      const tc = await pg.getTextContent();
      const items = tc.items.filter(i => /^[0-9]+.[0-9]$/.test(i.str.trim()));
      const vp = pg.getViewport({ scale: 1 });
      const out2 = { strs: items.map(i => i.str.trim()), items, vp };
      await doc.destroy();
      return out2;
    };
    const r4 = await readNums(nup.bytes);
    ck('가로 재단 순서 = 12 · 90 · 6 · 90 · 12',
       ['12.0', '90.0', '6.0', '90.0', '12.0'].every(v => r4.strs.includes(v)), r4.strs);
    ck('절대 좌표가 아니라 구간 거리', !r4.strs.includes('102.0') && !r4.strs.includes('198.0'), r4.strs);
    const nums = r4.strs;

    // 치수 표기를 끄면 숫자가 없어야 한다
    const nup2 = await buildNupBytes(cardBytes, Object.assign({}, nupOpts, { cropDims: false }), null);
    const r5 = await readNums(nup2.bytes);
    ck('끄면 치수가 인쇄되지 않음', r5.strs.length === 0, r5.strs);
    const nums2 = r5.strs;

    // ── ⑤ 치수 위치: 종이 맨 가장자리(비인쇄 영역)에 걸리지 않아야 한다 ──
    const doc3 = await pdfjsLib.getDocument({ data: nup.bytes.slice(0) }).promise;
    const pg3 = await doc3.getPage(1);
    const items = (await pg3.getTextContent()).items.filter(i => /^[0-9]+.[0-9]$/.test(i.str.trim()));
    const vp = pg3.getViewport({ scale: 1 });
    const MMpt = 72 / 25.4;
    const margins = items.map(i => {
      const x = i.transform[4], y = i.transform[5];
      return Math.min(x, y, vp.width - x, vp.height - y) / MMpt;
    });
    await doc3.destroy();
    ck('모든 치수가 종이 가장자리에서 4mm 이상 안쪽', margins.every(m => m >= 3.9), margins.map(m => +m.toFixed(1)));

    // ── ⑥ 실사례: 사방 3mm 블리드가 포함된 303×426 원고 → 재단 후 297×420 ──
    // TrimBox가 있으면 자동, 없으면 '원고 블리드'로 알려 준다(예전엔 303×426으로 잘려 나왔다).
    const mkSrc = async (withTrim) => {
      const dd = await PDFDocument.create();
      for (let i = 0; i < 2; i++) {
        const p2 = dd.addPage([303 * MM, 426 * MM]);
        if (withTrim) p2.node.set(PDFLib.PDFName.of('TrimBox'), dd.context.obj([3 * MM, 3 * MM, 300 * MM, 423 * MM]));
      }
      return new Uint8Array(await dd.save());
    };
    const trimOf = async (src, extra) => {
      const r = await buildNupBytes(src, Object.assign({
        across: 1, down: 1, sides: 1, order: 'sequential', sheet: [315 * MM, 450 * MM],
        margin: 5, hgap: 0, vgap: 0, crop: true, cropDims: true,
        place: { scale: 'orig', align: 'cc' },
      }, extra), null);
      return r.trimMm;
    };
    let tm = await trimOf(await mkSrc(true), {});
    ck('TrimBox 원고 → 재단 297×420', tm && tm[0] === 297 && tm[1] === 420, tm);
    tm = await trimOf(await mkSrc(false), { srcBleed: 3 });
    ck('TrimBox 없어도 원고 블리드 3 → 297×420', tm && tm[0] === 297 && tm[1] === 420, tm);
    tm = await trimOf(await mkSrc(false), { srcBleed: 0 });
    ck('알려 주지 않으면 용지 크기 그대로(303×426)', tm && tm[0] === 303 && tm[1] === 426, tm);
    return out;
  })()`);
  } catch (e) { console.error('  ✘ 스크립트 실행 오류:', e && e.message); app.exit(1); return; }

  let fail = 0;
  res.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${res.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
