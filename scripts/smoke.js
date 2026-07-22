// 스모크 테스트 — 회귀 안전망 (npm run smoke)
// 1) 모든 JS 파일 구문 검사 (node --check)
// 2) 앱을 --enable-logging으로 12초 부팅해 렌더러/메인의 미처리 오류 검출
// 실패 시 종료코드 1 — 배포 전 반드시 통과해야 한다.
const { execFileSync, spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JS_FILES = [
  'main.js', 'preload.js',
  'src/app-core.js', 'src/app-process.js', 'src/app-ui.js',
  'src/worker-gray.js', 'src/worker-assemble.js',
];

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
if (failed) { console.error('\n구문 검사 실패'); process.exit(1); }

// ── 2) 부팅 검사 ─────────────────────────────────────────────────────────────
const electron = require('electron'); // plain node에서는 실행 파일 경로 문자열
const BOOT_MS = 12000;
// 무시할 크로미움 노이즈
const NOISE = /network service|gpu process|dxgi|d3d11|disk_cache|gpu_channel|CreateFile/i;
// 잡아야 할 실제 오류
const ERROR_RE = /Uncaught|ReferenceError|TypeError|SyntaxError|is not defined|is not a function/;

console.log(`\n  ⏳ 앱 부팅 검사 (${BOOT_MS / 1000}초)…`);
const child = spawn(electron, ['.', '--enable-logging'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
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
  console.log('  ✔ 부팅 오류 없음');
  console.log('\n스모크 테스트 통과 ✅');
  process.exit(0);
}, BOOT_MS);
