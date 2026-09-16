// 스모크 테스트 — 회귀 안전망 (npm run smoke)
// 1) 모든 JS 파일 구문 검사 (node --check)
// 2) 앱을 --enable-logging으로 12초 부팅해 렌더러/메인의 미처리 오류 검출
// 실패 시 종료코드 1 — 배포 전 반드시 통과해야 한다.
const { execFileSync, spawn } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JS_FILES = [
  'main.js', 'preload.js',
  'src/app-core.js', 'src/app-process.js', 'src/app-ui.js', 'src/seam-repair.js',
  'src/worker-gray.js', 'src/worker-assemble.js', 'src/libs/gray-jpeg.js', 'src/libs/gray-blend.js',
];

// 인라인 스크립트를 품은 HTML — 구문이 깨져도 앱은 조용히 '그 창만' 죽으므로 꼭 검사한다
// (실제로 license.html의 인라인 스크립트가 깨진 채 스모크를 통과한 적이 있다)
const HTML_FILES = ['src/index.html', 'src/editor.html', 'src/license.html'];

let failed = false;

// ── 1) 구문 검사 ─────────────────────────────────────────────────────────────
for (const f of JS_FILES) {
  try {
    execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' });
    console.log(`  ✔ syntax  ${f}`);
  } catch (e) {
    console.error(`  ✘ syntax  ${f}\n${e.stderr}`);
    failed = true;
  }
}
// ── 1-b) HTML 안의 <script> 블록 구문 검사 ──────────────────────────────────
for (const f of HTML_FILES) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  const html = fs.readFileSync(p, 'utf8');
  // 판단은 여는 태그(m[1])만 보고 한다 — 본문(m[2])까지 보면 body 안의 type="button" 같은
  // 평범한 HTML 문자열에 걸려 그 파일 전체가 조용히 검사에서 빠진다(실제로 그랬다).
  const blocks = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(m => !/\bsrc\s*=/i.test(m[1]))                                     // 외부 파일은 위에서 검사
    .filter(m => !/\btype\s*=\s*["'](?!text\/javascript|module)/i.test(m[1])); // JSON 등 비-JS 블록 제외
  let bad = '';
  blocks.forEach((m, i) => {
    const tmp = path.join(os.tmpdir(), `smoke_${path.basename(f)}_${i}.js`);
    fs.writeFileSync(tmp, m[2], 'utf8');
    try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
    catch (e) {
      // 오류 줄번호를 HTML 기준으로 환산해 알려준다
      const base = html.slice(0, m.index).split(/\r?\n/).length;
      const rel = ((e.stderr || '').toString().match(/smoke_[^:]+:(\d+)/) || [])[1];
      bad += `\n    블록${i + 1}${rel ? ` (HTML ${base + (+rel) - 1}줄쯤)` : ''}: `
           + ((e.stderr || '').toString().split(/\r?\n/).filter(l => /Error/.test(l))[0] || '구문 오류').trim();
    }
    try { fs.unlinkSync(tmp); } catch (e2) {}
  });
  if (bad) { console.error(`  ✘ syntax  ${f}${bad}`); failed = true; }
  else console.log(`  ✔ syntax  ${f} (인라인 script ${blocks.length}개)`);
}


// ── 1-c) 창 없이 도는 단위 테스트 (Electron을 띄우지 않는다) ─────────────────
for (const t of ['scripts/test/seam-repair.test.js', 'scripts/test/inline-image.test.js', 'scripts/test/gray-colorspace.test.js', 'scripts/test/gray-jpeg.test.js', 'scripts/test/gray-blend.test.js', 'scripts/test/inflate-tolerant.test.js',
                 'scripts/test/workfile.test.js', 'scripts/test/download-name.test.js']) {
  try {
    execFileSync(process.execPath, [path.join(ROOT, t)], { stdio: 'pipe' });
    console.log(`  ✔ test    ${t}`);
  } catch (e) {
    const bad = (e.stdout || '').toString().split(/\r?\n/).filter(l => /✘/.test(l)).join('\n');
    console.error(`  ✘ test    ${t}\n${bad || e.stderr}`);
    failed = true;
  }
}

if (failed) { console.error('\n구문 검사·단위 테스트 실패'); process.exit(1); }

// ── 2) 부팅 검사 ─────────────────────────────────────────────────────────────
const electron = require('electron'); // plain node에서는 실행 파일 경로 문자열
const BOOT_MS = 12000;
// 무시할 크로미움 노이즈
const NOISE = /network service|gpu process|dxgi|d3d11|disk_cache|gpu_channel|CreateFile/i;
// 잡아야 할 실제 오류
const ERROR_RE = /Uncaught|ReferenceError|TypeError|SyntaxError|is not defined|is not a function/;

console.log(`\n  ⏳ 앱 부팅 검사 (${BOOT_MS / 1000}초)…`);
// TEST_WINDOW=left(옛 이름 PDFEDIT_TEST_WINDOW도 함께 넘긴다) — 검사로 띄우는 앱 창은 가장 왼쪽 모니터에 (주 모니터는 사용자 작업 공간)
const child = spawn(electron, ['.', '--enable-logging'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { TEST_WINDOW: 'left', PDFEDIT_TEST_WINDOW: 'left' }) });
let logs = '';
child.stdout.on('data', d => { logs += d; });
child.stderr.on('data', d => { logs += d; });

setTimeout(() => {
  child.kill();
  const bad = logs.split(/\r?\n/).filter(l => ERROR_RE.test(l) && !NOISE.test(l));
  if (bad.length) {
    console.error('  ✘ 부팅 중 오류 검출:');
    bad.slice(0, 10).forEach(l => console.error('    ' + l.trim()));
    process.exit(1);
  }
  // 부팅 완료 신호(main.js 검사 모드가 세 app-*.js의 전역 함수를 확인해 찍는다).
  // 오류 로그가 없다는 것만으로는 부팅을 증명하지 못한다 — 앱이 곧바로 꺼져도 로그는 비어 있다.
  const missing = (logs.match(/\[SMOKE\] BOOT_MISSING (.*)/) || [])[1];
  if (missing || !/\[SMOKE\] BOOT_OK/.test(logs)) {
    console.error(missing ? `  ✘ 스크립트가 끝까지 실행되지 않음 — 없는 전역: ${missing}`
      : '  ✘ 부팅 완료 신호가 없음 — 앱이 곧바로 꺼졌거나(단일 인스턴스 잠금 등) 화면이 로드되지 않음');
    process.exit(1);
  }
  console.log('  ✔ 부팅 완료 신호 확인 · 부팅 오류 없음');
  console.log('\n스모크 테스트 통과 ✅');
  process.exit(0);
}, BOOT_MS);
