// 🔄 폰트 안전화(Ghostscript) 뒤 페이지가 180° 뒤집히던 문제 회귀 테스트
//   실행: node scripts/test/gs-autorotate.test.js
// 원인: pdfwrite의 기본값 -dAutoRotatePages=/PageByPage 가 글자 방향을 보고 페이지를 돌린다.
//       글자가 없는 페이지(삽입한 빈 페이지 등)에서 특히 엉뚱하게 뒤집혔다.
// 여기서는 ① main.js가 /None 을 넘기는지 ② 실제 gs 실행에서 회전이 생기는지/안 생기는지를 본다.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..', '..');

globalThis.window = globalThis; globalThis.self = globalThis;
globalThis.PDFLib = require(path.join(ROOT, 'src/libs/pdf-lib.min.js'));
const { PDFDocument, StandardFonts, rgb } = globalThis.PDFLib;

let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  ✔', n, x === undefined ? '' : JSON.stringify(x)); } else { fail++; console.log('  ✘', n, x === undefined ? '' : JSON.stringify(x)); } };

function findGs() {
  const cands = ['D:/Ghostscript/gs10.07.1/bin/gswin64c.exe'];
  try {
    const roots = ['C:/Program Files/gs', 'D:/Ghostscript'];
    for (const r of roots) {
      if (!fs.existsSync(r)) continue;
      for (const d of fs.readdirSync(r)) {
        const p = path.join(r, d, 'bin', 'gswin64c.exe');
        if (fs.existsSync(p)) cands.push(p);
      }
    }
  } catch (e) { }
  return cands.find(p => fs.existsSync(p)) || null;
}

(async () => {
  // ① main.js가 gs에 /None 을 넘기는가 (이 줄이 사라지면 같은 사고가 재발한다)
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const i = mainSrc.indexOf("'-sDEVICE=pdfwrite'");
  const seg = mainSrc.slice(Math.max(0, i - 200), i + 400);
  ck('main.js가 -dAutoRotatePages=/None 을 넘김', seg.includes("'-dAutoRotatePages=/None'"));

  const gs = findGs();
  if (!gs) { console.log('\n  ⚠ Ghostscript를 찾지 못해 실행 검증은 건너뜁니다.\n'); process.exit(fail ? 1 : 0); }

  // ② 실제 gs 실행 — 글자 있는 쪽 + 빈 쪽이 섞인 문서(사용자 사례와 같은 구성)
  // 재현 조건: 페이지 안의 '글자 방향'이 정방향이 아닌 쪽이 있으면 gs가 그 페이지를 돌려 버린다
  //   (합본·프레젠테이션 원고에서 흔하다 — 세로 제목, 뒤집힌 라벨 등)
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const { degrees } = globalThis.PDFLib;
  const page = (draw) => { const p = doc.addPage([612, 858]); if (draw) draw(p); };
  page(p => p.drawText('Normal text page', { x: 60, y: 700, size: 20, font, color: rgb(0, 0, 0) }));
  page(null);                                                  // 빈 페이지
  page(p => p.drawText('Upside down text', { x: 520, y: 160, size: 20, font, color: rgb(0, 0, 0), rotate: degrees(180) }));
  page(p => p.drawText('Sideways text', { x: 80, y: 120, size: 20, font, color: rgb(0, 0, 0), rotate: degrees(90) }));
  page(p => { for (let i = 0; i < 12; i++) p.drawText('line ' + i, { x: 520, y: 120 + i * 40, size: 16, font, color: rgb(0, 0, 0), rotate: degrees(180) }); });
  page(p => p.drawText('Normal again', { x: 60, y: 700, size: 20, font, color: rgb(0, 0, 0) }));
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gsrot_'));
  const inp = path.join(tmp, 'in.pdf');
  fs.writeFileSync(inp, Buffer.from(await doc.save({ useObjectStreams: false })));

  const baseArgs = ['-dNOPAUSE', '-dBATCH', '-sDEVICE=pdfwrite', '-dEmbedAllFonts=true', '-dSubsetFonts=false',
    '-dCompressFonts=true', '-sFONTPATH=C:\\Windows\\Fonts', '-dPassThroughJPEGImages=true',
    '-dDownsampleColorImages=false', '-dDownsampleGrayImages=false', '-dDownsampleMonoImages=false',
    '-dCompatibilityLevel=1.6'];
  const run = (extra, out) => cp.execFileSync(gs, [...extra, ...baseArgs, '-o', out, inp], { stdio: 'pipe' });
  const rotsOf = async f => {
    const d = await PDFDocument.load(new Uint8Array(fs.readFileSync(f)), { updateMetadata: false });
    return d.getPages().map(p => p.getRotation().angle);
  };

  const noFlag = path.join(tmp, 'nof.pdf'), withFlag = path.join(tmp, 'fix.pdf');
  run([], noFlag);
  run(['-dAutoRotatePages=/None'], withFlag);
  const a = await rotsOf(noFlag), b = await rotsOf(withFlag);
  ck('옵션 없이 돌리면 gs가 페이지를 돌린다(문제 재현)', a.some(v => v !== 0), a);
  ck('/None 을 주면 회전이 생기지 않는다(수정 확인)', b.every(v => v === 0), b);
  ck('쪽수는 그대로', b.length === 6, b.length);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패\n`);
  process.exit(fail ? 1 : 0);
})();
