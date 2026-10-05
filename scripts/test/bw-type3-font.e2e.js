// 흑백변환이 **Type3 글꼴**(컬러 이모지)을 놓치던 문제 회귀
//   실행: npx electron scripts/test/bw-type3-font.e2e.js
// 실파일 '스포츠대학 발전 포럼_링제본_35부_68.pdfw' 48~50쪽 🏟🤝: 컬러 이모지(NotoColorEmoji)를 PDF로 내보내면
//   Type3 글꼴이 되고, 글리프(d0)가 **글꼴 자신의 /Resources**에 든 폼을 그린다. 흑백변환은 페이지·폼 리소스만 훑어
//   그 폼이 RGB로 남았다(앱 화면·프린터 모두 컬러). app-process processFonts가 글리프 스트림과 글꼴 리소스를 바꾼다.
const path = require('path');
const os = require('os');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-type3-e2e'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));

  const res = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
    try {
    const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 30000)) { if (f()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
    const { PDFDocument, PDFName } = PDFLib;
    const N = n => PDFName.of(n);
    // 합성: 1쪽 — Type3 글꼴 /T1의 글리프 'a'(d0)가 글꼴 리소스의 폼 /X0(빨강·파랑 사각형)을 그린다.
    //        글리프 'b'(d0)는 스트림 안에서 직접 rg로 칠한다(글꼴 리소스 없이).
    const d = await PDFDocument.create();
    const ctx = d.context;
    const form = ctx.register(ctx.flateStream('1 0 0 rg 0 0 500 1000 re f 0 0 1 rg 500 0 500 1000 re f',
      { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1000, 1000],
        Group: { Type: 'Group', S: 'Transparency', I: true } }));
    const procA = ctx.register(ctx.flateStream('1000 0 d0 /X0 Do'));
    const procB = ctx.register(ctx.flateStream('1000 0 d0 0 0.6 0.2 rg 0 0 1000 1000 re f'));
    const font = ctx.register(ctx.obj({
      Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 1000, 1000], FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      CharProcs: { a: procA, b: procB }, Encoding: { Type: 'Encoding', Differences: [97, 'a', 'b'] },
      FirstChar: 97, LastChar: 98, Widths: [1000, 1000], Resources: { XObject: { X0: form } } }));
    const p = d.addPage([300, 200]);
    p.node.set(N('Resources'), ctx.obj({ Font: { T1: font } }));
    p.node.set(N('Contents'), ctx.register(ctx.flateStream('BT /T1 80 Tf 20 60 Td (ab) Tj ET')));
    const bytes = await d.save();

    const colorPx = async b => {
      const doc = await pdfjsLib.getDocument({ data: b.slice(0) }).promise;
      const pg = await doc.getPage(1); const vp = pg.getViewport({ scale: 1 });
      const c = new OffscreenCanvas(Math.ceil(vp.width), Math.ceil(vp.height)); const cx = c.getContext('2d');
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
      await pg.render({ canvasContext: cx, viewport: vp }).promise;
      const px = cx.getImageData(0, 0, c.width, c.height).data; let n = 0, ink = 0;
      for (let k = 0; k < px.length; k += 4) { if (Math.max(px[k], px[k+1], px[k+2]) - Math.min(px[k], px[k+1], px[k+2]) > 25) n++; if (px[k] + px[k+1] + px[k+2] < 600) ink++; }
      await doc.destroy();
      return { n, ink };
    };
    const before = await colorPx(bytes);
    ck('합성 원고: 이모지 글리프가 컬러로 그려짐(시험이 의미 있음)', before.n > 500, before);

    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    startLoad([{ name: 'type3.pdf', size: bytes.byteLength, type: 'application/pdf', arrayBuffer: () => Promise.resolve(buf.slice(0)) }]);
    await waitFor(() => pageResults.length > 0 && pageResults.every(r => r && r.thumbnail) && isTabReady(tabs.get(activeTabId)), 120000);
    await new Promise(r => setTimeout(r, 800));
    processingOptions.bw = true; processingOptions.inkNorm = true;
    selectedPages.clear(); selectedPages.add(1);

    await applyChanges();
    await waitFor(() => !!processedPdfBytes, 120000);
    const applied = await colorPx(processedPdfBytes);
    ck('적용본(화면): 컬러 픽셀 0 · 글리프는 그대로 보임', applied.n === 0 && applied.ink > 500, applied);

    const opt = await buildOptimizedOutput(() => {});
    const optBytes = opt && (opt.bytes || opt);
    const saved = await colorPx(optBytes);
    ck('저장본(다운로드): 컬러 픽셀 0', saved.n === 0 && saved.ink > 500, saved);

    // 저장본 안의 글꼴 리소스 폼·글리프 스트림에 색 연산자(rg)가 남지 않았는가
    const sd = await PDFDocument.load(optBytes);
    const L = o => o && o.objectNumber != null ? sd.context.lookup(o) : o;
    const fRes = L(L(sd.getPage(0).node.get(N('Resources'))).get(N('Font')));
    const f = L(fRes.get(N('T1')));
    const txt = s => new TextDecoder('latin1').decode(pako.inflate(s.contents));
    const x0 = L(L(L(f.get(N('Resources'))).get(N('XObject'))).get(N('X0')));
    const procs = L(f.get(N('CharProcs')));
    const rgLeft = [txt(x0), ...[...procs.entries()].map(([, v]) => txt(L(v)))].filter(t => /(?<![\\w\\/.#-])rg(?=\\s|$)/.test(t)).length;
    ck('글꼴 리소스 폼·글리프 스트림에 rg가 남지 않음', rgLeft === 0, rgLeft);
    ck('저장 전 컬러 검수(pageIsNeutral)도 무채색으로 봄', pageIsNeutral(sd, sd.getPage(0).node) === true);
    return { out };
    } catch (e) { out.push(['✘', '예외', String(e && e.stack || e).slice(0, 500)]); return { out }; }
  })()`);

  let fail = 0;
  res.out.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${res.out.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
