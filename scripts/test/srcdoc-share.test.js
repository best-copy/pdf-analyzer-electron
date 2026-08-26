// 🔁 원본 PDF 문서 공유 캐시 안전성 검증
// getSourceDoc()은 PDFDocument.load(원본)를 한 번만 하고 그 문서를 흑백변환·조립·다운로드
// base가 공유한다. 전제는 "copyPages는 소스를 바꾸지 않는다" — 이 전제를 실제 pdf-lib로 확인한다.
// (틀리면 두 번째 페이지부터 조용히 깨진 PDF가 나온다)
const path = require('path');
const PDFLib = require(path.join(__dirname, '..', '..', 'src/libs/pdf-lib.min.js'));

let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  ✔', n); } else { fail++; console.log('  ✘', n, x !== undefined ? JSON.stringify(x) : ''); } };

(async () => {
  // 4쪽짜리 원고 — 페이지마다 다른 글자·크기(구분 가능해야 비교가 의미 있다)
  const mk = async () => {
    const doc = await PDFLib.PDFDocument.create();
    const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    for (let i = 0; i < 4; i++) {
      const p = doc.addPage([300 + i * 10, 400]);
      p.drawText('PAGE ' + (i + 1), { x: 20, y: 200, size: 24 + i, font });
      if (i === 2) p.setRotation(PDFLib.degrees(90));
    }
    return new Uint8Array(await doc.save());
  };
  const bytes = await mk();

  console.log('\n[1] 매번 새로 load = 기준(정답)');
  const fresh = [];
  for (let i = 0; i < 4; i++) {
    const src = await PDFLib.PDFDocument.load(bytes.slice(0));
    const out = await PDFLib.PDFDocument.create();
    const [pg] = await out.copyPages(src, [i]);
    out.addPage(pg);
    fresh.push(Buffer.from(await out.save({ useObjectStreams: false, updateFieldAppearances: false })));
  }
  ck('4쪽 각각 단일페이지 PDF 생성', fresh.length === 4 && fresh.every(b => b.length > 400));

  console.log('\n[2] 문서 하나를 공유해 반복 copyPages');
  const shared = await PDFLib.PDFDocument.load(bytes.slice(0));
  const reuse = [];
  for (let i = 0; i < 4; i++) {
    const out = await PDFLib.PDFDocument.create();
    const [pg] = await out.copyPages(shared, [i]);
    out.addPage(pg);
    reuse.push(Buffer.from(await out.save({ useObjectStreams: false, updateFieldAppearances: false })));
  }
  for (let i = 0; i < 4; i++) ck(`${i + 1}쪽 결과가 새로 load한 것과 완전 동일`, reuse[i].equals(fresh[i]));

  console.log('\n[3] 공유 문서 자신은 그대로 (copyPages가 소스를 건드리지 않음)');
  ck('페이지 수 불변', shared.getPageCount() === 4);
  ck('회전값 불변', shared.getPage(2).getRotation().angle === 90);
  const after = Buffer.from(await shared.save({ useObjectStreams: false, updateFieldAppearances: false }));
  const untouched = await PDFLib.PDFDocument.load(bytes.slice(0));
  ck('재저장 바이트가 손대지 않은 사본과 동일',
     after.equals(Buffer.from(await untouched.save({ useObjectStreams: false, updateFieldAppearances: false }))));

  console.log('\n[4] 동시(병렬) copyPages — 프리웜과 적용이 겹칠 때의 상황');
  const par = await Promise.all([0, 1, 2, 3].map(async i => {
    const out = await PDFLib.PDFDocument.create();
    const [pg] = await out.copyPages(shared, [i]);
    out.addPage(pg);
    return Buffer.from(await out.save({ useObjectStreams: false, updateFieldAppearances: false }));
  }));
  for (let i = 0; i < 4; i++) ck(`병렬 ${i + 1}쪽도 동일`, par[i].equals(fresh[i]));

  console.log('\n[5] 여러 쪽 한 번에 복사(조립 경로)도 동일');
  const mkAll = async (src) => {
    const out = await PDFLib.PDFDocument.create();
    (await out.copyPages(src, [3, 1, 0])).forEach(p => out.addPage(p));
    return Buffer.from(await out.save({ useObjectStreams: false, updateFieldAppearances: false }));
  };
  ck('공유 문서 기준 조립 = 새 문서 기준 조립',
     (await mkAll(shared)).equals(await mkAll(await PDFLib.PDFDocument.load(bytes.slice(0)))));

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
