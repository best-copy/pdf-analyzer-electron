// 📊 사용 기록 요약 — '사용 기록 분석해줘'에서 Claude가 돌려 읽는다 (사람이 봐도 된다)
//   node scripts/usage-report.js [--days 30] [--dir <usage-log 폴더>] [--out 보고서.md]
//   기본 폴더 = <드라이브>:\PDF분석기-사용기록(C: 밖에서 실행할 때 — 시스템 복원 대비) + 옛 %APPDATA%\pdf-analyzer\usage-log (main.js usageDir)
//   기록 형식: 날짜.jsonl 한 줄 = { ts, t: start|open|click|set|key|busy|ok|error, … } · memos.jsonl = 💬 불편 메모
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const DAYS = +arg('--days', 30);
// 기본 = 모든 드라이브의 '<드라이브>\PDF분석기-사용기록'(C: 밖에서 실행할 때 — 시스템 복원 대비) + 옛 %APPDATA% 폴더, 같은 줄은 한 번만
const LEGACY = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'pdf-analyzer', 'usage-log');
const DIRS = process.argv.includes('--dir') ? [arg('--dir', '')]
  : [LEGACY, ...'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(d => d + ':\\PDF분석기-사용기록')].filter(d => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } });
const DIR = DIRS.join(' + ') || LEGACY;
const OUT = arg('--out', '');

function readDir() {
  const cut = Date.now() - DAYS * 86400000, ev = [], memos = [], seen = new Set();
  for (const D of DIRS) {
  if (!fs.existsSync(D)) continue;
  for (const f of fs.readdirSync(D).sort()) {
    const file = path.join(D, f);
    if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) || f === 'memos.jsonl') {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        if (seen.has(f + '|' + line)) continue;
        seen.add(f + '|' + line);
        let o; try { o = JSON.parse(line); } catch (e) { continue; }
        if (!o || !(o.ts >= cut)) continue;
        (f === 'memos.jsonl' ? memos : ev).push(o);
      }
    }
  }
  }
  ev.sort((a, b) => a.ts - b.ts);
  return { ev, memos };
}
const norm = s => String(s || '').replace(/\d+(\.\d+)?/g, '#').replace(/\s+/g, ' ').trim();   // 숫자만 다른 문구는 같은 것으로
const day = ts => new Date(ts).toISOString().slice(0, 10);
const med = a => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const sec = ms => (ms / 1000).toFixed(1) + '초';
function count(arr, keyOf) { const m = new Map(); for (const x of arr) { const k = keyOf(x); if (k == null || k === '') continue; m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]); }

const { ev, memos } = readDir();
const L = [];
const P = s => L.push(s);
P(`# 📊 사용 기록 요약 — 최근 ${DAYS}일`);
P(`폴더: ${DIR}`);
if (!ev.length && !memos.length) { P('\n기록이 없습니다. (앱을 쓰면 쌓입니다 — 검사 모드는 기록하지 않음)'); }
else {
  const days = [...new Set(ev.map(e => day(e.ts)))];
  const starts = ev.filter(e => e.t === 'start');
  P(`기간: ${days[0] || '-'} ~ ${days[days.length - 1] || '-'} · 쓴 날 ${days.length}일 · 켠 횟수 ${starts.length} · 사건 ${ev.length}개 · 메모 ${memos.length}개`);
  if (starts.length) { const s = starts[starts.length - 1]; P(`최근 버전 ${s.v || '?'} · 코어 ${s.cores} · 메모리 ${s.mem}GB · 화면 ${s.scr}`); }

  const opens = ev.filter(e => e.t === 'open');
  P(`\n## 📂 연 문서 ${opens.length}개`);
  P(count(opens, e => e.ext || '(없음)').map(([k, n]) => `${k} ${n}`).join(' · ') || '-');
  if (opens.length) { const mb = opens.map(e => e.mb || 0); P(`크기: 중앙 ${med(mb)}MB · 최대 ${Math.max(...mb)}MB`); }

  const busy = ev.filter(e => e.t === 'busy');
  P(`\n## ⏱ 오래 걸린 작업 (0.8초 이상 ${busy.length}번) — 합계 시간 순`);
  const bg = new Map();
  for (const b of busy) { const k = norm(b.m); const g = bg.get(k) || { n: 0, ms: [], p: [] }; g.n++; g.ms.push(b.ms); if (b.p) g.p.push(b.p); bg.set(k, g); }
  [...bg.entries()].sort((a, b) => b[1].ms.reduce((s, x) => s + x, 0) - a[1].ms.reduce((s, x) => s + x, 0)).slice(0, 25)
    .forEach(([k, g]) => P(`- ${k || '(문구 없음)'} — ${g.n}번 · 중앙 ${sec(med(g.ms))} · 최대 ${sec(Math.max(...g.ms))} · 합계 ${sec(g.ms.reduce((s, x) => s + x, 0))}${g.p.length ? ` · 문서 중앙 ${med(g.p)}쪽` : ''}`));

  const errs = ev.filter(e => e.t === 'error');
  P(`\n## ⚠ 오류 ${errs.length}번 — 많은 순`);
  const eg = new Map();
  for (const e of errs) { const k = norm(e.m); const g = eg.get(k) || { n: 0, last: 0, c: new Map() }; g.n++; g.last = e.ts; if (e.c) g.c.set(e.c, (g.c.get(e.c) || 0) + 1); eg.set(k, g); }
  [...eg.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 25)
    .forEach(([k, g]) => P(`- ${k} — ${g.n}번 · 마지막 ${day(g.last)}${g.c.size ? ` · 창: ${[...g.c.keys()].slice(0, 3).join(', ')}` : ''}`));

  const oks = ev.filter(e => e.t === 'ok');
  P(`\n## ✔ 끝낸 작업(성공 안내) — 많은 순`);
  count(oks, e => norm(e.m)).slice(0, 30).forEach(([k, n]) => P(`- ${k} — ${n}번`));

  const clicks = ev.filter(e => e.t === 'click');
  P(`\n## 🖱 많이 누른 버튼 (${clicks.length}번)`);
  count(clicks, e => (e.l || e.id || '') + (e.c ? `  ‹${e.c}›` : '')).slice(0, 40).forEach(([k, n]) => P(`- ${k} — ${n}`));

  const sets = ev.filter(e => e.t === 'set');
  P(`\n## ⚙ 자주 바꾼 설정 (${sets.length}번) — 늘 같은 값으로 바꾸면 기본값 후보`);
  const sg = new Map();
  for (const s of sets) { const k = (s.id || s.l || '?') + (s.c ? `  ‹${s.c}›` : ''); const g = sg.get(k) || new Map(); g.set(String(s.v), (g.get(String(s.v)) || 0) + 1); sg.set(k, g); }
  [...sg.entries()].map(([k, g]) => [k, g, [...g.values()].reduce((a, b) => a + b, 0)]).sort((a, b) => b[2] - a[2]).slice(0, 30)
    .forEach(([k, g, n]) => P(`- ${k} — ${n}번: ${[...g.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([v, c]) => `${v}(${c})`).join(' · ')}`));

  const keys = ev.filter(e => e.t === 'key');
  P(`\n## ⌨ 단축키`);
  P(count(keys, e => e.k).slice(0, 25).map(([k, n]) => `${k} ${n}`).join(' · ') || '-');

  // 되돌림 신호: 성공 직후 30초 안 되돌리기·실행취소
  const undo = ev.filter(e => (e.t === 'click' && /되돌리|실행취소|↶|↺/.test(e.l || '')) || (e.t === 'key' && /Ctrl\+Z$/.test(e.k || '')));
  P(`\n## ↺ 되돌리기 ${undo.length}번 — 바로 앞 성공 작업`);
  count(undo.map(u => { const prev = [...oks].reverse().find(o => o.ts <= u.ts && u.ts - o.ts < 30000); return prev ? norm(prev.m) : null; }), x => x).slice(0, 15).forEach(([k, n]) => P(`- ${k} — ${n}번`));
}
P(`\n## 💬 불편 메모 ${memos.length}개`);
memos.forEach(m => {
  P(`\n### ${new Date(m.ts).toLocaleString('ko-KR')}${m.c ? ` · ${m.c}` : ''}${m.p ? ` · ${m.p}쪽 문서` : ''}`);
  P(m.text);
  if (Array.isArray(m.recent) && m.recent.length) P('직전 동작: ' + m.recent.slice(-8).map(e => e.t === 'click' ? `🖱${e.l || e.id}` : e.t === 'set' ? `⚙${e.id || e.l}=${e.v}` : e.t === 'key' ? `⌨${e.k}` : e.t === 'error' ? `⚠${(e.m || '').slice(0, 40)}` : e.t === 'busy' ? `⏱${(e.m || '').slice(0, 20)} ${sec(e.ms)}` : e.t).join(' → '));
});
const text = L.join('\n') + '\n';
if (OUT) { fs.writeFileSync(OUT, text, 'utf8'); console.log('보고서: ' + OUT); }
else process.stdout.write(text);
