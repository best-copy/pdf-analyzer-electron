// ════════════════════════════════════════════════════════════════════════
// 📊 사용 기록 · 💬 불편 메모 (2026-10-29 — 이 PC 안에만, 밖으로 보내지 않는다)
//   무엇을 언제 썼는지·얼마나 걸렸는지·어디서 막혔는지를 모아 main이 userData/usage-log/날짜.jsonl에 쌓는다.
//   '사용 기록 분석해줘' → scripts/usage-report.js가 요약 → 자주 쓰는데 느린 것·자주 실패하는 것·늘 바꾸는 설정을 고친다.
//   ⚠ 문서 내용·파일 이름·고객 정보는 남기지 않는다 — 글은 usageSanitize로 따옴표 안·경로·파일 이름을 지우고,
//     글 입력칸의 값은 적지 않는다(숫자·켜기/끄기·고른 항목 이름만).
//   기존 코드를 고치지 않고 전역 함수(showError·showSuccess·showLoading·hideLoading·prepareFiles)를 감싸고,
//   클릭·설정 바꾸기·단축키는 문서 전체에서 엿듣는다. app-enhance.js 뒤에 읽는다.
// 사건 줄: { ts, t, … } — t: start·open·click·set·key·busy·ok·error·memo(따로 memos.jsonl)
// ════════════════════════════════════════════════════════════════════════
(function (root) {
  'use strict';
  // 글에서 사람·문서를 알 수 있는 것을 지운다 — 따옴표 안, 경로, 파일 이름, 메일·전화, 긴 숫자
  function usageSanitize(s, max) {
    let t = String(s == null ? '' : s);
    t = t.replace(/'[^'\n]{0,200}'|"[^"\n]{0,200}"|‘[^’\n]{0,200}’|“[^”\n]{0,200}”|「[^」\n]{0,200}」|『[^』\n]{0,200}』/g, '‹…›');
    t = t.replace(/[A-Za-z]:[\\/][^\s,·)(]*/g, '‹경로›').replace(/\\\\[^\s,·)(]+/g, '‹경로›').replace(/(?:^|\s)\/[^\s,·)(]+\/[^\s,·)(]*/g, ' ‹경로›');
    t = t.replace(/[^\s'"()\[\],·:]+\.(pdfw?|hwpx?|docx?|xlsx?|pptx?|ai|psd|indd|png|jpe?g|gif|bmp|webp|tiff?|avif|zip|7z|rar|alz|egg|svg|pdfupd|json|html?)\b/gi, '‹파일›');
    t = t.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '‹메일›').replace(/\b0\d{1,2}[- ]?\d{3,4}[- ]?\d{4}\b/g, '‹전화›').replace(/\d{7,}/g, '‹숫자›');
    t = t.replace(/\s+/g, ' ').trim();
    return max && t.length > max ? t.slice(0, max) + '…' : t;
  }
  root.usageSanitize = usageSanitize;
  if (typeof module !== 'undefined' && module.exports) module.exports = { usageSanitize };
  if (typeof window === 'undefined' || !window.electronAPI || !window.electronAPI.usageAppend) return;

  const api = window.electronAPI;
  const q = [], recent = [];
  function log(t, o) {
    const e = Object.assign({ ts: Date.now(), t }, o || {});
    q.push(e); recent.push(e); if (recent.length > 40) recent.shift();
    if (q.length >= 50) flush();
  }
  function flush() { if (!q.length) return; const lines = q.splice(0); try { api.usageAppend(lines); } catch (e) {} }
  setInterval(flush, 10000);
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
  root.usageLog = log; root.usageFlush = flush; root.usageRecent = () => recent.slice();

  const pages = () => { try { return (typeof pageResults !== 'undefined' && pageResults) ? pageResults.filter(Boolean).length : 0; } catch (e) { return 0; } };
  // 지금 어디서(떠 있는 창 제목 · 편집 모드) — 버튼 이름만으로는 어느 창인지 모른다
  function ctx() {
    try {
      const ovs = [...document.querySelectorAll('.merge-overlay, .pr-modal, .pt-box')].filter(el => el.offsetParent !== null || el.classList.contains('merge-overlay'));
      const top = ovs[ovs.length - 1];
      if (top) { const h = top.querySelector('.merge-title, h3, h2'); if (h) return usageSanitize(h.textContent, 40); if (top.classList.contains('pt-box')) return '묻는 창'; }
      if (document.body.classList.contains('edit-fullscreen')) return '편집 모드';
    } catch (e) {}
    return '';
  }

  // ── 전역 함수 감싸기 ──
  const wrap = (name, before) => {
    const f = root[name];
    if (typeof f !== 'function' || f.__usage) return;
    const w = function () { try { before.apply(this, arguments); } catch (e) {} return f.apply(this, arguments); };
    w.__usage = true; root[name] = w;
  };
  wrap('showError', m => log('error', { m: usageSanitize(m, 200), c: ctx(), p: pages() }));
  wrap('showSuccess', m => log('ok', { m: usageSanitize(String(m).split('\n')[0], 120), c: ctx() }));
  let busy = null;
  wrap('showLoading', m => { if (!busy) busy = { t0: performance.now(), m: usageSanitize(m, 80) }; });
  wrap('hideLoading', () => {
    if (!busy) return;
    const ms = Math.round(performance.now() - busy.t0);
    if (ms >= 800) log('busy', { m: busy.m, ms, p: pages() });
    busy = null;
  });
  wrap('prepareFiles', items => {
    (items || []).forEach(it => {
      const n = String((it && (it.name || it.path)) || '');
      const ext = ((n.match(/\.([A-Za-z0-9]{1,6})$/) || [])[1] || '').toLowerCase();
      let mb = 0; try { mb = it.path && api.fileSize ? Math.round(api.fileSize(it.path) / 104857.6) / 10 : 0; } catch (e) {}
      log('open', { ext, mb, n: items.length });
    });
  });

  // ── 클릭(버튼·칩) ──
  const NO_TEXT = '.recent-chip, .recent-item, .tab, .tab-item, .doc-tab, [data-page], [data-sb-page], .rbv-pghead, .ie-row, .page-card, .chapter-divider';
  document.addEventListener('click', e => {
    try {
      const el = e.target && e.target.closest && e.target.closest('button, .es-chip, .opt-btn, .sbp-opt, [role="button"]');
      if (!el) return;
      const o = { id: el.id || undefined, c: ctx() };
      if (!el.matches(NO_TEXT) && !el.closest(NO_TEXT)) o.l = usageSanitize(el.getAttribute('aria-label') || el.textContent, 40) || undefined;
      if (!o.id && !o.l) return;
      log('click', o);
    } catch (err) {}
  }, true);
  // ── 설정 바꾸기(고른 항목·숫자·켜기/끄기만 — 글 입력값은 적지 않는다) ──
  document.addEventListener('change', e => {
    try {
      const el = e.target;
      if (!el || !el.tagName) return;
      const o = { id: el.id || el.name || undefined, c: ctx() };
      if (el.tagName === 'SELECT') o.v = usageSanitize(el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : el.value, 40);
      else if (el.type === 'checkbox' || el.type === 'radio') o.v = !!el.checked;
      else if (el.type === 'number' || el.type === 'range') o.v = +el.value;
      else return;   // 글자 입력칸 — 값을 남기지 않는다
      if (!o.id) { const lb = el.closest('label'); if (lb) o.l = usageSanitize(lb.textContent, 30); }
      log('set', o);
    } catch (err) {}
  }, true);
  // ── 단축키(Ctrl/Alt 조합·Esc·Delete·F키) ──
  document.addEventListener('keydown', e => {
    try {
      if (e.repeat) return;
      const special = e.key === 'Escape' || e.key === 'Delete' || /^F\d{1,2}$/.test(e.key);
      if (!(e.ctrlKey || e.altKey || e.metaKey) && !special) return;
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
      const k = (e.ctrlKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '') + (e.metaKey ? 'Meta+' : '')
        + (e.code && /^Key|^Digit/.test(e.code) ? e.code.replace(/^Key|^Digit/, '') : e.key);
      log('key', { k, c: ctx() });
      if (k === 'Ctrl+Shift+M') { e.preventDefault(); e.stopPropagation(); root.openUsageMemo(); }
    } catch (err) {}
  }, true);

  // ── 켤 때 한 줄 ──
  (async () => {
    let v = ''; try { v = api.appVersion ? await api.appVersion() : ''; } catch (e) {}
    log('start', { v, cores: navigator.hardwareConcurrency || 0, mem: navigator.deviceMemory || 0, scr: `${screen.width}x${screen.height}@${window.devicePixelRatio}` });
  })();

  // ── 💬 불편 메모 — 쓴 글 + 그 순간의 상황(창·쪽 수·최근 사건 15개) ──
  root.openUsageMemo = function openUsageMemo() {
    if (document.querySelector('.um-box')) return;
    const situ = { c: ctx(), p: pages(), recent: recent.slice(-15) };
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:100070;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.className = 'pt-box um-box';
    box.style.cssText = 'width:min(560px,92vw);padding:20px 22px;';
    box.innerHTML = '<div class="um-head">💬 불편 메모</div>'
      + '<div class="um-sub">불편한 점·바라는 점을 적어 주세요. 지금 상황(' + (situ.c ? '‹' + situ.c.replace(/[<>&]/g, '') + '›' : '첫 화면')
      + (situ.p ? ' · ' + situ.p + '쪽 문서' : '') + ' · 최근 동작 ' + situ.recent.length + '개)이 함께 저장됩니다.<br>이 PC에만 남고, 나중에 \'사용 기록 분석해줘\'라고 하면 함께 봅니다.</div>'
      + '<textarea class="pt-input um-text" rows="5" placeholder="예) 복제 2부에서 거터를 매번 3mm로 바꿔야 해서 번거로움"></textarea>'
      + '<div class="um-btns"><button class="pt-btn um-cancel">취소</button><button class="pt-btn pt-ok um-ok">💾 남기기 (Ctrl+Enter)</button></div>';
    ov.append(box); document.body.appendChild(ov);
    const ta = box.querySelector('.um-text');
    const done = async save => {
      const text = ta.value.trim();
      ov.remove();
      if (!save || !text) return;
      const memo = { ts: Date.now(), text: text.slice(0, 4000), c: situ.c, p: situ.p, recent: situ.recent };
      flush();
      const ok = api.usageMemo ? await api.usageMemo(memo) : false;
      if (typeof showSuccess === 'function' && ok) showSuccess('💬 메모를 남겼습니다 — 이 PC의 사용 기록에 함께 저장됐습니다.\n개선할 때 \'사용 기록 분석해줘\'라고 말씀하시면 메모와 기록을 함께 보고 고칠 점을 정리합니다.');
      else if (typeof showError === 'function' && !ok) showError('메모를 저장하지 못했습니다.');
    };
    box.querySelector('.um-cancel').onclick = () => done(false);
    box.querySelector('.um-ok').onclick = () => done(true);
    ov.onclick = e => { if (e.target === ov) done(false); };
    ta.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); done(true); }
    });
    setTimeout(() => ta.focus(), 30);
  };
})(typeof window !== 'undefined' ? window : globalThis);
