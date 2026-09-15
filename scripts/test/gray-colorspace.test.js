// 흑백변환 — 색 연산자·색공간 → DeviceGray 단위 검증 (앱 파일의 실제 코드를 그대로 올려 쓴다: 복사본 드리프트 방지)
//   실행: node scripts/test/gray-colorspace.test.js   (npm run smoke가 함께 돌린다)
// 회귀:
//  · '/DeviceGray cs 0 sc'(이미 회색인 검정)가 1-t = 흰색으로 뒤집혀 글자가 사라짐
//  · DeviceN 2성분 '0.3 0.8 scn'이 '0.3 0.2000 g'로 깨짐(피연산자가 남음)
//  · 별색 변환 함수가 Type 2가 아니면 단순 반전으로 짐작, Indexed·Lab·회색 ICC는 흑백으로 안 바뀜
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const pako = require(path.join(ROOT, 'src/libs/pako.min.js'));
const PDFLib = require(path.join(ROOT, 'src/libs/pdf-lib.min.js'));

// 워커 — worker-gray.js 그대로
const wctx = vm.createContext({ importScripts() {}, self: {}, console, pako });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/worker-gray.js'), 'utf8'), wctx, { filename: 'worker-gray.js' });
// 메인 — app-process.js의 색공간 설명자 빌더 구간만 떼어 실행
const ap = fs.readFileSync(path.join(ROOT, 'src/app-process.js'), 'utf8');
const s0 = ap.indexOf('    // ── 색공간 설명자');
const s1 = ap.indexOf('    const _dotGainCtx = new WeakMap();', s0);
if (s0 < 0 || s1 < 0) { console.log('  ✘ app-process.js에서 색공간 설명자 구간을 찾지 못함'); process.exit(1); }
// 구간이 부르는 스트림 풀기 헬퍼(구간 밖에 있다)도 같은 파일에서 떼어 온다
const exFn = name => {
  const a = ap.indexOf('    function ' + name + '(');
  if (a < 0) { console.log('  ✘ app-process.js에서 함수를 찾지 못함: ' + name); process.exit(1); }
  return ap.slice(a, ap.indexOf('\n    }', a) + 6);
};
const helpers = ['inflateLenient', 'imgFilterNameOf', 'pdfStreamDecoded'].map(exFn).join('\n');
const mctx = vm.createContext({ PDFLib, pako, console });
vm.runInContext(helpers + '\n' + ap.slice(s0, s1) + '\nthis.buildCsGrayMap = buildCsGrayMap;', mctx, { filename: 'app-process.js(색공간)' });

let pass = 0, fail = 0;
const ck = (name, ok, info) => { if (ok) { pass++; console.log('  ✔ ' + name); } else { fail++; console.log('  ✘ ' + name, info !== undefined ? JSON.stringify(info) : ''); } };
const B = str => Uint8Array.from(Buffer.from(str, 'latin1'));
const S = u8 => Buffer.from(u8).toString('latin1');
const near = (a, b) => Math.abs(a - b) < 0.006;
const lumRGB = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const lumCMYK = (c, m, y, k) => lumRGB((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k));

// ── 합성 리소스 ─────────────────────────────────────────────────────────────
(async () => {
  const pdf = await PDFLib.PDFDocument.create();
  const C = pdf.context;
  const N = n => PDFLib.PDFName.of(n);
  const stream = (txt, dict) => C.stream(txt, dict);
  const iccGray = stream('icc', { N: 1 }), iccRGB = stream('icc', { N: 3 });
  const fn2 = C.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [0, 1, 0, 0], N: 1 });
  const fn4 = stream('{ dup 0 exch 0 }', { FunctionType: 4, Domain: [0, 1], Range: [0, 1, 0, 1, 0, 1, 0, 1] });
  const fn0 = stream(Buffer.from([255, 0]).toString('latin1'), { FunctionType: 0, Domain: [0, 1], Range: [0, 1], Size: [2], BitsPerSample: 8 });
  const fnDN = stream('{ 0 0 }', { FunctionType: 4, Domain: [0, 1, 0, 1], Range: [0, 1, 0, 1, 0, 1, 0, 1] });
  const fn3 = C.obj({ FunctionType: 3, Domain: [0, 1], Bounds: [0.5], Encode: [0, 1, 0, 1],
    Functions: [C.obj({ FunctionType: 2, Domain: [0, 1], C0: [1], C1: [1], N: 1 }), C.obj({ FunctionType: 2, Domain: [0, 1], C0: [0], C1: [0], N: 1 })] });
  const csDict = C.obj({
    GrayICC: [N('ICCBased'), C.register(iccGray)],
    RgbICC: [N('ICCBased'), C.register(iccRGB)],
    Spot2: [N('Separation'), N('Magenta'), N('DeviceCMYK'), fn2],
    Spot4: [N('Separation'), N('Spot'), N('DeviceCMYK'), C.register(fn4)],
    Spot0: [N('Separation'), N('Spot'), N('DeviceGray'), C.register(fn0)],
    Spot3: [N('Separation'), N('Spot'), N('DeviceGray'), fn3],
    SpotBad: [N('Separation'), N('Spot'), N('DeviceCMYK'), C.obj({ FunctionType: 9 })],
    Duo: [N('DeviceN'), [N('Cyan'), N('Magenta')], N('DeviceCMYK'), C.register(fnDN)],
    Pal: [N('Indexed'), N('DeviceRGB'), 1, PDFLib.PDFHexString.of('FF00000000FF')],
    Pal85: [N('Indexed'), N('DeviceRGB'), 1, C.register(C.stream("rr<$!!<3~>", { Filter: 'ASCII85Decode' }))],   // 번호표가 ASCII85 스트림 (목차 PDF 실파일)
    Lab: [N('Lab'), C.obj({ WhitePoint: [0.95, 1, 1.09] })],
    PatCS: [N('Pattern')],
  });
  const res = C.obj({ ColorSpace: csDict });
  const map = mctx.buildCsGrayMap(pdf, res);

  const run = (content, m = map) => { const info = { stat: {} }; return { out: S(wctx.grayifyStream(B(content), m, 0, info)), stat: info.stat }; };
  // 결과에서 마지막 'x g' (또는 G) 값
  const lastGray = (out, op = 'g') => { const all = [...out.matchAll(new RegExp('(-?[\\d.]+)\\s+' + op + '(?=\\s|$)', 'g'))]; return all.length ? +all[all.length - 1][1] : NaN; };
  const noColorOps = out => !/(?:^|\s)(?:sc|scn|SC|SCN|rg|RG|k|K|cs|CS)(?=\s|$)/.test(out.replace(/\/PatCS\s+cs|\/Pattern\s+cs|\/P\d+\s+scn/g, ''));

  console.log('\n[1] 이미 회색인 색은 그대로 (예전: 흰색으로 반전)');
  let r = run('/DeviceGray cs 0 sc\n0 0 10 10 re f\n');
  ck('/DeviceGray cs 0 sc → 검정 0', near(lastGray(r.out), 0) && noColorOps(r.out), r.out);
  r = run('/GrayICC cs 0.3 scn\n');
  ck('회색 ICC(N=1) 0.3 → 0.3', near(lastGray(r.out), 0.3) && noColorOps(r.out), r.out);

  console.log('\n[2] 색공간 정의로 실제 색을 계산');
  r = run('/RgbICC cs 1 0 0 scn\n');
  ck('RGB ICC 빨강 → 0.299', near(lastGray(r.out), lumRGB(1, 0, 0)), r.out);
  r = run('/Spot2 cs 1 scn\n');
  ck('별색 Type 2 (마젠타 100%) → CMYK 계산', near(lastGray(r.out), lumCMYK(0, 1, 0, 0)), r.out);
  r = run('/Spot4 cs 0.5 scn\n');
  ck('별색 Type 4 PostScript (c=t,y=t) 0.5 → CMYK 계산', near(lastGray(r.out), lumCMYK(0.5, 0, 0.5, 0)), r.out);
  r = run('/Spot0 cs 0.25 scn\n');
  ck('별색 Type 0 표(선형 보간) 0.25 → 0.75', near(lastGray(r.out), 0.75), r.out);
  r = run('/Spot3 cs 0.8 scn\n');
  ck('별색 Type 3 이어붙임 0.8 → 둘째 구간 0', near(lastGray(r.out), 0), r.out);
  r = run('/SpotBad cs 0.4 scn\n');
  ck('풀 수 없는 함수 → 잉크 양으로 0.6', near(lastGray(r.out), 0.6) && noColorOps(r.out), r.out);
  r = run('/Duo cs 1 1 scn\n');
  ck('DeviceN 2성분 → 계산값, 피연산자 남지 않음', near(lastGray(r.out), lumCMYK(1, 1, 0, 0)) && !/\d\s+\d?\.?\d+\s+g/.test(r.out.replace(/^[\s\S]*?\n/, '')) && noColorOps(r.out), r.out);
  r = run('/Pal cs 1 sc\n');
  ck('Indexed 번호표 1번(파랑) → 0.114', near(lastGray(r.out), lumRGB(0, 0, 1)), r.out);
  r = run('/Pal85 cs 0 sc\n');
  ck('ASCII85 번호표 0번(빨강) → 0.299 (예전: 못 풀어 추정값)', near(lastGray(r.out), lumRGB(1, 0, 0)), r.out);
  r = run('/Lab cs 50 0 0 sc\n');
  ck('Lab L=50 → 0.5', near(lastGray(r.out), 0.5), r.out);

  console.log('\n[3] 상태 추적');
  r = run('/GrayICC cs\nq\n/Spot2 cs\nQ\n0.3 scn\n');
  ck('q/Q로 색공간 복원 — Q 뒤는 회색 ICC 기준', near(lastGray(r.out), 0.3), r.out);
  r = run('/GrayICC cs 0.2 scn /RgbICC cs 0 0 1 scn\n');
  ck('한 조각 안 cs 두 번 — 각자 기준(예전: 마지막 cs 기준)', r.out.includes('0.2000 g') && near(lastGray(r.out), lumRGB(0, 0, 1)), r.out);
  r = run('/GrayICC CS 0.4 SCN 0 0 1 RG\n');
  ck('선 색(CS/SCN/RG)은 G로', near(lastGray(r.out, 'G'), lumRGB(0, 0, 1)) && r.out.includes('0.4000 G'), r.out);
  r = run('/Spot2 cs\n0 0 10 10 re f\n');
  ck('cs 직후 초기색(별색 = 잉크 100%)을 회색으로', near(lastGray(r.out), lumCMYK(0, 1, 0, 0)), r.out);

  console.log('\n[4] 정의를 모를 때도 회색으로 (프린터 컬러 과금 방지)');
  r = run('/Nowhere cs 0.3 0.8 scn\n', {});
  ck('리소스에 없는 이름 2성분 → 잉크 합으로 추정, 색 연산자 없음', near(lastGray(r.out), 0) && noColorOps(r.out) && r.stat.guessed === 1, r);
  r = run('/Nowhere cs 0 sc\n', {});
  ck('리소스에 없는 이름 1성분 → 회색 값 그대로(반전하지 않음)', near(lastGray(r.out), 0), r.out);

  console.log('\n[5] 건드리면 안 되는 것');
  r = run('/Pattern cs /P0 scn\n0 0 10 10 re f\n');
  ck('/Pattern cs · /P0 scn 유지', r.out.includes('/Pattern cs') && r.out.includes('/P0 scn'), r.out);
  r = run('/PatCS cs /P8 scn\n');
  ck('명명 패턴 색공간 유지, /P8 이름 속 숫자 오매칭 없음', r.out.includes('/PatCS cs') && r.out.includes('/P8 scn') && !/P-/.test(r.out), r.out);
  r = run('% comment with paren (\n1 0 0 rg\n');
  ck('% 주석 속 "(" 뒤의 색도 변환', near(lastGray(r.out), lumRGB(1, 0, 0)) && r.out.startsWith('% comment with paren ('), r.out);
  r = run('BT (1 0 0 rg) Tj ET 0 1 0 rg\n');
  ck('문자열 속 "1 0 0 rg"는 그대로, 밖은 변환', r.out.includes('(1 0 0 rg)') && near(lastGray(r.out), lumRGB(0, 1, 0)), r.out);
  r = run('1 0 0 1 10 20 cm 12 Tf 0.5 g\n');
  ck('색 아닌 연산자·이미 회색 g는 그대로', r.out === '1 0 0 1 10 20 cm 12 Tf 0.5 g\n', r.out);

  console.log('\n[6] Dot Gain 보정 곡선 — 워커와 메인 스레드가 같은 식');
  {
    const c0 = ap.indexOf('    function dotGainCurve(');
    const c1 = ap.indexOf('\n    }', c0) + 6;
    const mainCurve = new Function(ap.slice(c0, c1) + '\nreturn dotGainCurve;')();
    let maxDiff = 0;
    for (const g of [0, 10, 15, 20, 25]) for (let i = 0; i <= 255; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(mainCurve(i / 255, g) - wctx.dotGainCurve(i / 255, g)));
    }
    ck('워커·메인 곡선 일치 (0·10·15·20·25%)', maxDiff < 1e-12, maxDiff);
    // 예전 20% 식(워커에 하드코딩돼 있던 것)과 같은 결과 — 기존 출력이 바뀌지 않는다
    const old20 = v => { const disc = 0.04 + 3.2 * v; const d = (1.8 - Math.sqrt(disc < 0 ? 0 : disc)) / 1.6; return 1 - Math.max(0, Math.min(1, d)); };
    let d20 = 0;
    for (let i = 0; i <= 255; i++) d20 = Math.max(d20, Math.abs(wctx.dotGainCurve(i / 255, 20) - old20(i / 255)));
    ck('20%는 예전 식과 동일', d20 < 1e-12, d20);
    const mid = g => wctx.dotGainCurve(0.5, g);
    ck('단계가 오를수록 중간 톤이 밝아지고 흑·백 끝은 그대로',
      mid(0) === 0.5 && mid(10) > 0.5 && mid(15) > mid(10) && mid(20) > mid(15)
      && [10, 15, 20].every(g => Math.abs(wctx.dotGainCurve(0, g)) < 1e-12 &&Math.abs(wctx.dotGainCurve(1, g) - 1) < 1e-12),
      [mid(0), mid(10), mid(15), mid(20)].map(x => +x.toFixed(4)));
  }

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  ✘ 테스트 실행 오류', e); process.exit(1); });
