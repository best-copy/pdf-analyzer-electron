// 투명도 흑백 합성 그룹(src/libs/gray-blend.js) 단위 검증 — 앱 파일을 그대로 싣고 pdf-lib 합성 PDF로 판정한다.
//   실행: node scripts/test/gray-blend.test.js   (npm run smoke가 함께 돌린다)
// 회귀: 흑백변환한 투명도 쪽에 페이지 그룹이 없어 gs·프린터가 겹친 회색을 C=M=Y+K로 섞음(A1 포맥스 실파일),
//       임포징(embedPage)으로 판에 올리면 그룹이 사라져 되살아남. 반대로 컬러가 있는 쪽에 달면 색이 회색이 된다.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const PDFLib = require(path.join(ROOT, 'src/libs/pdf-lib.min.js'));
const { create } = require(path.join(ROOT, 'src/libs/gray-blend.js'));
const { addGrayBlendGroups, pageUsesTransparency, pageIsNeutral } = create(PDFLib);
const { PDFDocument, PDFName, rgb, grayscale, cmyk } = PDFLib;
const N = n => PDFName.of(n);

let pass = 0, fail = 0;
const ck = (name, ok, info) => { if (ok) { pass++; console.log('  ✔ ' + name); } else { fail++; console.log('  ✘ ' + name, info !== undefined ? JSON.stringify(info) : ''); } };
const hasGrayGroup = (doc, i) => { const g = doc.context.lookup(doc.getPage(i).node.get(N('Group'))); return !!(g && String(g.get(N('CS'))) === '/DeviceGray'); };

// 반투명 ExtGState를 쓰는 쪽 — 색 연산자 문자열을 직접 넣는다
function rawPage(doc, ops, extraRes) {
  const page = doc.addPage([200, 200]);
  const gs = doc.context.obj({ Type: 'ExtGState', ca: 0.5, CA: 0.5 });
  const res = doc.context.obj({ ExtGState: { GS0: gs }, ...(extraRes || {}) });
  page.node.set(N('Resources'), res);
  const st = doc.context.flateStream(ops);
  page.node.set(N('Contents'), doc.context.register(st));
  return page;
}
(async () => {
  // 1) 회색만 + 반투명 → 그룹 추가
  {
    const d = await PDFDocument.create();
    rawPage(d, '/GS0 gs 0.3 g 10 10 100 100 re f 0.5 0.5 0.5 rg 20 20 50 50 re f 0 0 0 0.6 k 0 0 10 10 re f');
    ck('투명도 사용 감지', pageUsesTransparency(d, d.getPage(0).node));
    ck('회색·R=G=B·K만 → 무채색', pageIsNeutral(d, d.getPage(0).node));
    await addGrayBlendGroups(d);
    ck('① 무채색 투명도 쪽 → DeviceGray 그룹', hasGrayGroup(d, 0));
  }
  // 2) 빨강 한 점 → 안 단다(색이 사라지면 안 됨)
  {
    const d = await PDFDocument.create();
    rawPage(d, '/GS0 gs 0.3 g 10 10 100 100 re f 1 0 0 rg 20 20 5 5 re f');
    await addGrayBlendGroups(d);
    ck('② 컬러가 있으면 그룹 없음', !hasGrayGroup(d, 0));
  }
  // 3) 투명도 없음 → 안 단다(Acrobat 평탄화 방지)
  {
    const d = await PDFDocument.create();
    const p = d.addPage([200, 200]); p.drawRectangle({ x: 10, y: 10, width: 50, height: 50, color: grayscale(0.4) });
    await addGrayBlendGroups(d);
    ck('③ 투명도 없으면 그룹 없음', !hasGrayGroup(d, 0));
  }
  // 4) 별색 cs → 컬러로 친다 · 문자열 안의 'rg' 글자는 무시
  {
    const d = await PDFDocument.create();
    const sep = d.context.obj([N('Separation'), N('PANTONE'), N('DeviceCMYK'), d.context.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [1, 0, 0, 0], N: 1 })]);
    rawPage(d, '/GS0 gs /CS0 cs 1 scn 0 0 9 9 re f', { ColorSpace: { CS0: sep } });
    rawPage(d, '/GS0 gs BT /F1 9 Tf (1 0 0 rg \( nested \) rg) Tj ET 0.2 g 0 0 5 5 re f');
    await addGrayBlendGroups(d);
    ck('④ 별색 → 그룹 없음', !hasGrayGroup(d, 0));
    ck('④ 텍스트 문자열 속 연산자 글자는 무시', hasGrayGroup(d, 1));
  }
  // 5) 이미지: 회색 + SMask → 단다 · RGB 사진 + SMask → 안 단다
  {
    const d = await PDFDocument.create();
    const mk = cs => {
      const sm = d.context.register(d.context.stream(new Uint8Array([0, 128, 255, 64]), { Type: 'XObject', Subtype: 'Image', Width: 2, Height: 2, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }));   // 중간 투명도(그림자 등)
      const n = cs === 'DeviceRGB' ? 12 : 4;
      return d.context.register(d.context.stream(new Uint8Array(n), { Type: 'XObject', Subtype: 'Image', Width: 2, Height: 2, ColorSpace: cs, BitsPerComponent: 8, SMask: sm }));
    };
    for (const cs of ['DeviceGray', 'DeviceRGB']) {
      const p = d.addPage([100, 100]);
      p.node.set(N('Resources'), d.context.obj({ XObject: { Im0: mk(cs) } }));
      p.node.set(N('Contents'), d.context.register(d.context.flateStream('q 50 0 0 50 0 0 cm /Im0 Do Q')));
    }
    await addGrayBlendGroups(d);
    ck('⑤ 회색 이미지+SMask → 그룹', hasGrayGroup(d, 0));
    ck('⑤ RGB 이미지+SMask → 그룹 없음', !hasGrayGroup(d, 1));
  }
  // 6) 임포징: 무채색 투명도 쪽을 embedPage로 판에 올리면 판에 그룹 · 컬러 쪽과 섞인 판은 없음
  {
    const src = await PDFDocument.create();
    rawPage(src, '/GS0 gs 0.4 g 0 0 200 200 re f');                 // 무채색 투명도
    rawPage(src, '0 0 1 rg 0 0 200 200 re f');                     // 파랑(투명도 없음)
    const out = await PDFDocument.create();
    const [e0, e1] = await out.embedPages([src.getPage(0), src.getPage(1)]);
    const s0 = out.addPage([420, 220]); s0.drawPage(e0, { x: 10, y: 10 }); s0.drawPage(e0, { x: 210, y: 10 });
    const s1 = out.addPage([420, 220]); s1.drawPage(e0, { x: 10, y: 10 }); s1.drawPage(e1, { x: 210, y: 10 });
    s0.drawLine({ start: { x: 0, y: 0 }, end: { x: 5, y: 5 }, color: rgb(0, 0, 0) });   // 재단선(검정 RGB)
    const bytes = await out.save();
    const again = await PDFDocument.load(bytes);
    await addGrayBlendGroups(again);
    ck('⑥ 무채색 투명도 쪽만 올린 판 → 그룹(재단선 RGB 검정 포함)', hasGrayGroup(again, 0));
    ck('⑥ 컬러 쪽이 섞인 판 → 그룹 없음', !hasGrayGroup(again, 1));
    // 저장 전(아직 embed 안 된 상태)에서도 flush로 판정
    const out2 = await PDFDocument.create();
    const [f0] = await out2.embedPages([src.getPage(0)]);
    out2.addPage([220, 220]).drawPage(f0, { x: 10, y: 10 });
    await addGrayBlendGroups(out2);
    ck('⑥ 저장 전 문서도 판정(flush)', hasGrayGroup(out2, 0));
  }
  // 7) 인라인 이미지: 회색은 통과, RGB는 컬러 · 그룹이 이미 있으면 건드리지 않음
  {
    const d = await PDFDocument.create();
    rawPage(d, '/GS0 gs BI /W 2 /H 1 /CS /G /BPC 8 ID \x10\x20 EI 0.1 g');
    rawPage(d, '/GS0 gs BI /W 1 /H 1 /CS /RGB /BPC 8 ID \xff\x00\x00 EI');
    rawPage(d, '/GS0 gs BI /W 2 /H 1 /BPC 4 /CS[/I /G 1 <97FF>] ID  EI');
    rawPage(d, '/GS0 gs BI /W 2 /H 1 /BPC 4 /CS [/I /RGB 1 <FF8000FFFFFF>] ID  EI');
    const p = rawPage(d, '/GS0 gs 0.5 g 0 0 9 9 re f');
    p.node.set(N('Group'), d.context.obj({ S: 'Transparency', CS: 'DeviceRGB' }));
    await addGrayBlendGroups(d);
    ck('⑦ 회색 인라인 이미지 → 그룹', hasGrayGroup(d, 0));
    ck('⑦ RGB 인라인 이미지 → 그룹 없음', !hasGrayGroup(d, 1));
    ck('⑦ 사전 안 회색 색상표(/CS[/I /G …]) → 그룹', hasGrayGroup(d, 2));
    ck('⑦ 사전 안 RGB 색상표 → 그룹 없음', !hasGrayGroup(d, 3));
    ck('⑦ 원래 있던 그룹은 그대로', String(d.context.lookup(d.getPage(4).node.get(N('Group'))).get(N('CS'))) === '/DeviceRGB');
  }
  // 9) 두 값(0/255)뿐인 그림 마스크 → 스텐실(/Mask)로 바꿔 투명도 자체를 없앤다 — 평탄화가 회색을 RGB로 섞지 않게
  //    (실파일 '회재 선조…_중철' 5쪽: 회색 그룹을 달아도 Acrobat·일반 드라이버 평탄화가 C=M=Y 리치 그레이를 만들어 프린터가 컬러로 셈)
  {
    const d = await PDFDocument.create();
    const mk = (alpha, w) => {
      const sm = d.context.register(d.context.stream(new Uint8Array(alpha), { Type: 'XObject', Subtype: 'Image', Width: w, Height: 1, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }));
      return d.context.register(d.context.stream(new Uint8Array(w).fill(80), { Type: 'XObject', Subtype: 'Image', Width: w, Height: 1, ColorSpace: 'DeviceGray', BitsPerComponent: 8, SMask: sm }));
    };
    const imBin = mk([0, 255, 255, 0, 255, 255, 255, 255, 0], 9), imSoft = mk([0, 255, 128, 255], 4);
    [imBin, imSoft].forEach(im => {
      const p = d.addPage([100, 100]);
      p.node.set(N('Resources'), d.context.obj({ XObject: { Im0: im } }));
      p.node.set(N('Contents'), d.context.register(d.context.flateStream('q 90 0 0 10 5 45 cm /Im0 Do Q')));
    });
    d.getPage(0).node.set(N('Group'), d.context.obj({ Type: 'Group', S: 'Transparency', CS: 'DeviceGray' }));   // 예전 저장에서 단 그룹
    await addGrayBlendGroups(d);
    const bin = d.context.lookup(imBin), soft = d.context.lookup(imSoft);
    const st = d.context.lookup(bin.dict.get(N('Mask')));
    ck('⑨ 두 값 마스크 → SMask 없음·스텐실 /Mask', !bin.dict.get(N('SMask')) && st && String(st.dict.get(N('ImageMask'))) === 'true');
    const bits = st ? PDFLib.decodePDFRawStream(st).decode() : null;
    // 0(투명) 자리 = 1(칠하지 않음): x=0,3,8 → 1001 0000 1000 0000
    ck('⑨ 스텐실 비트 = 투명 자리', bits && bits[0] === 0x90 && bits[1] === 0x80, bits && [...bits]);
    ck('⑨ 투명도가 사라진 쪽은 예전 회색 그룹도 뗀다', !pageUsesTransparency(d, d.getPage(0).node) && !d.getPage(0).node.get(N('Group')));
    ck('⑨ 중간 투명도 마스크는 그대로 + 회색 그룹', !!soft.dict.get(N('SMask')) && !soft.dict.get(N('Mask')) && hasGrayGroup(d, 1));
  }
  // 10) 폼은 부른 쪽의 색공간을 이어받는다 — 쪽에서 '/C1 cs'(ICC RGB)만 정하고 폼 안은 'r g b scn'만(Figma 달력)
  //     옛 판정은 폼을 회색에서 시작해 무채색으로 읽고 컬러 쪽에 회색 그룹을 달았다(저장본 12쪽 중 7쪽이 흑백)
  {
    const d = await PDFDocument.create();
    const icc = d.context.register(d.context.flateStream('', { N: 3, Alternate: 'DeviceRGB' }));
    const mkForm = ops => d.context.register(d.context.flateStream(ops, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 200] }));
    const pinkForm = mkForm('0.95 0.6 0.7 scn 10 10 100 100 re f');
    const grayForm = mkForm('0.5 0.5 0.5 scn 10 10 100 100 re f');
    rawPage(d, '/C1 cs /GS0 gs /X1 Do', { ColorSpace: { C1: ['ICCBased', icc] }, XObject: { X1: pinkForm } });
    rawPage(d, '/C1 cs /GS0 gs /X1 Do', { ColorSpace: { C1: ['ICCBased', icc] }, XObject: { X1: grayForm } });
    rawPage(d, '/C1 cs /GS0 gs /X1 Do', { ColorSpace: { C1: ['ICCBased', icc] }, XObject: { X1: pinkForm } });
    d.getPage(2).node.set(N('Group'), d.context.obj({ Type: 'Group', S: 'Transparency', CS: 'DeviceGray' }));   // 옛 저장이 잘못 단 그룹
    ck('⑩ 폼 안 scn이 이어받은 ICC RGB 색 → 컬러', !pageIsNeutral(d, d.getPage(0).node));
    ck('⑩ 같은 상태의 R=G=B → 무채색', pageIsNeutral(d, d.getPage(1).node));
    await addGrayBlendGroups(d);
    ck('⑩ 컬러 쪽엔 그룹 없음 · 회색 쪽엔 그룹', !hasGrayGroup(d, 0) && hasGrayGroup(d, 1));
    ck('⑩ 옛 저장이 컬러 쪽에 단 회색 그룹은 뗀다', !d.getPage(2).node.get(N('Group')));
  }
  // 8) 앱 연결: 세 곳의 savePdfDoc이 저장 전에 부르고, 창·워커·편집기가 파일을 싣는다
  {
    const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
    const liner = 'function savePdfDoc(doc, extra) { return addGrayBlendGroups(doc).then(() => doc.save(pdfSaveOpts(doc, extra))); }';
    ck('⑧ app-core·worker-assemble·editor의 savePdfDoc', ['src/app-core.js', 'src/worker-assemble.js', 'src/editor.html'].every(f => rd(f).includes(liner)));
    ck('⑧ index.html·editor.html·워커가 gray-blend.js를 pdf-lib 뒤에 싣는다',
      /pdf-lib\.min\.js[\s\S]*libs\/gray-blend\.js[\s\S]*app-core\.js/.test(rd('src/index.html')) &&
      /pdf-lib\.min\.js[\s\S]*libs\/gray-blend\.js/.test(rd('src/editor.html')) &&
      /importScripts\('\.\/libs\/pdf-lib\.min\.js', '\.\/libs\/gray-blend\.js'/.test(rd('src/worker-assemble.js')));
  }
  console.log(`\n  ${pass} 통과 · ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  ✘ 예외', e && e.stack || e); process.exit(1); });
