// 🖼 폰트 안전화(Ghostscript)가 이미지를 다시 굽지 않는지.
//   pdfwrite는 기본값 AutoFilterColorImages=true 때문에 무손실(Flate) 이미지를 '사진 같다'고
//   판단하면 JPEG로 재압축한다 — 실측(사진 원고 4.94MB): 1.04MB로 줄고 픽셀 차이가 2.26/255.
//   실행: node scripts/test/gs-image-lossless.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  ✔', n); } else { fail++; console.log('  ✘', n, x !== undefined ? JSON.stringify(x) : ''); } };

// main.js가 실제로 넘기는 인자에 무손실 설정이 들어 있는가 (소스를 직접 본다)
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const gsBlock = mainSrc.slice(mainSrc.indexOf("'-sDEVICE=pdfwrite'"), mainSrc.indexOf("'-o', outPath"));
console.log('\n[1] gs 인자에 이미지 보호 설정이 있는가');
for (const flag of ['-dAutoFilterColorImages=false', '-dColorImageFilter=/FlateEncode',
                    '-dAutoFilterGrayImages=false', '-dGrayImageFilter=/FlateEncode',
                    '-dDownsampleColorImages=false', '-dAutoRotatePages=/None']) {
  ck('  ' + flag, gsBlock.includes(flag));
}

// gs를 찾아 실제로 돌려 본다 (없으면 [2]는 건너뛴다)
function findGs() {
  const cands = [path.join(ROOT, 'vendor', 'gs', 'bin', 'gswin64c.exe'), 'gswin64c'];
  try { const pf = process.env['ProgramFiles'] || 'C:\Program Files';
    for (const d of fs.readdirSync(path.join(pf, 'gs'))) cands.push(path.join(pf, 'gs', d, 'bin', 'gswin64c.exe')); } catch (e) {}
  for (const d of ['D:\Ghostscript']) {
    try { for (const v of fs.readdirSync(d)) cands.push(path.join(d, v, 'bin', 'gswin64c.exe')); } catch (e) {}
  }
  for (const c of cands) { try { execFileSync(c, ['-v'], { windowsHide: true, stdio: 'ignore' }); return c; } catch (e) {} }
  return null;
}
const GS = findGs();
console.log('\n[2] 무손실 이미지가 JPEG로 바뀌지 않는가');
if (!GS) { console.log('  – Ghostscript를 찾지 못해 건너뜁니다'); }
else {
  // 색 경계가 뚜렷한 PNG(무손실) — JPEG로 다시 구우면 경계가 뭉갠다
  const W = 600, H = 400;
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) { const o = y * (1 + W * 3); raw[o] = 0;
    for (let x = 0; x < W; x++) { const i = o + 1 + x * 3;
      const on = (Math.floor(x / 7) + Math.floor(y / 7)) % 2;      // 잘게 나뉜 체크무늬
      raw[i] = on ? 250 : 10; raw[i + 1] = on ? 20 : 240; raw[i + 2] = 60; } }
  const crc = (b) => { let c = ~0; for (const v of b) { c ^= v; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t, 'latin1'), d]); const cc = Buffer.alloc(4); cc.writeUInt32BE(crc(td));
    return Buffer.concat([l, td, cc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);

  (async () => {
    const { PDFDocument } = require('pdf-lib');
    const d = await PDFDocument.create();
    const img = await d.embedPng(png);
    const p = d.addPage([595, 842]);
    p.drawImage(img, { x: 40, y: 400, width: 500, height: 333 });
    const inP = path.join(os.tmpdir(), 'pdfedit_gsq_in.pdf');
    const outP = path.join(os.tmpdir(), 'pdfedit_gsq_out.pdf');
    fs.writeFileSync(inP, await d.save({ useObjectStreams: false }));

    // main.js와 같은 인자 구성 (embed 모드)
    const winFonts = path.join(process.env.WINDIR || 'C:\Windows', 'Fonts');
    execFileSync(GS, ['-dNOPAUSE', '-dBATCH', '-sDEVICE=pdfwrite', '-dAutoRotatePages=/None',
      '-dEmbedAllFonts=true', '-dSubsetFonts=false', '-dCompressFonts=true', '-sFONTPATH=' + winFonts,
      '-dAutoFilterColorImages=false', '-dColorImageFilter=/FlateEncode',
      '-dAutoFilterGrayImages=false', '-dGrayImageFilter=/FlateEncode',
      '-dPassThroughJPEGImages=true',
      '-dDownsampleColorImages=false', '-dDownsampleGrayImages=false', '-dDownsampleMonoImages=false',
      '-dCompatibilityLevel=1.7', '-o', outP, inP], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });

    const before = fs.readFileSync(inP).toString('latin1');
    const after = fs.readFileSync(outP).toString('latin1');
    const dct = (s) => (s.match(/\/DCTDecode/g) || []).length;
    ck('원본에는 JPEG 이미지가 없다', dct(before) === 0, dct(before));
    ck('gs를 거쳐도 JPEG로 바뀌지 않는다', dct(after) === 0, dct(after));
    // 무손실이면 이미지 데이터가 줄어들 이유가 없다(체크무늬는 JPEG로 굽으면 크게 줄어든다)
    const shrink = fs.statSync(outP).size / fs.statSync(inP).size;
    ck('용량이 급감하지 않는다(재압축 흔적)', shrink > 0.5, +shrink.toFixed(2));
    for (const f of [inP, outP]) { try { fs.unlinkSync(f); } catch (e) {} }
    console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
    process.exit(fail ? 1 : 0);
  })();
}
if (!GS) { console.log(`\n결과: ${pass} 통과 / ${fail} 실패`); process.exit(fail ? 1 : 0); }
