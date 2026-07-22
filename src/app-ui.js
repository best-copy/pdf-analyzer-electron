    // ── 왼쪽 사이드바 ────────────────────────────────────────────────────────
    const sidebar = document.getElementById('thumbSidebar');
    const sbResizer = document.getElementById('sbResizer');
    const sbToggle  = document.getElementById('sbToggle');

    // 폭 조절 (드래그 핸들, localStorage 저장, 열 수는 CSS auto-fill로 자동)
    const SB_MIN = 180, SB_MAX = 560;
    function applySbWidth(w) {
      const width = Math.min(SB_MAX, Math.max(SB_MIN, Math.round(w)));
      document.documentElement.style.setProperty('--sb-width', width + 'px');
      try { localStorage.setItem('sbWidth', width); } catch(e) {}
    }
    applySbWidth(parseInt(localStorage.getItem('sbWidth')) || 280);

    // 사이드바 상단 패널 열기/닫기 토글 (상태는 localStorage에 저장)
    function toggleSbPanel(open) {
      const p = document.getElementById('sbPanel');
      if (p) p.classList.toggle('collapsed', !open);
      try { localStorage.setItem('sbPanelOpen', open ? '1' : '0'); } catch (e) {}
    }
    (function initSbPanel() {
      const open = localStorage.getItem('sbPanelOpen') !== '0';
      const cb = document.getElementById('sbPanelToggle');
      if (cb) cb.checked = open;
      const p = document.getElementById('sbPanel');
      if (p) p.classList.toggle('collapsed', !open);
    })();

    // 사이드바 '번호만 보기'(컴팩트) 토글 — 썸네일 숨기고 챕터·페이지 번호만 표시 (localStorage 저장)
    function toggleSbThumbs(compact) {
      sidebar.classList.toggle('sb-compact', !!compact);
      try { localStorage.setItem('sbCompact', compact ? '1' : '0'); } catch (e) {}
    }
    (function initSbCompact() {
      const compact = localStorage.getItem('sbCompact') === '1';
      const cb = document.getElementById('sbCompactToggle');
      if (cb) cb.checked = compact;
      sidebar.classList.toggle('sb-compact', compact);
    })();

    let sbResizing = false;
    sbResizer.addEventListener('mousedown', e => {
      e.preventDefault();
      sbResizing = true;
      sbResizer.classList.add('sb-resizing');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', e => { if (sbResizing) applySbWidth(e.clientX); });
    document.addEventListener('mouseup', () => {
      if (!sbResizing) return;
      sbResizing = false;
      sbResizer.classList.remove('sb-resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });

    let sbVisible = false;
    function showSidebar(visible) {
      sbVisible = visible;
      sidebar.style.display = visible ? 'grid' : 'none';
      document.body.classList.toggle('sidebar-open', visible);
      sbResizer.style.display = visible ? 'block' : 'none';
      sbToggle.style.display = (visible || pageResults.length) ? 'flex' : 'none';
      sbToggle.textContent = visible ? '◀' : '▶';
      // 편집 패널 토글 버튼: 분석 결과가 있을 때만 노출, 동시에 UI 동기화
      const et = document.getElementById('editToggle');
      if (et) et.style.display = pageResults.length ? 'flex' : 'none';
      if (pageResults.length) { if (typeof syncEditUI === 'function') syncEditUI(); }
      else document.body.classList.remove('edit-open');
    }
    sbToggle.addEventListener('click', () => showSidebar(!sbVisible));

    // ══════════════════════════════════════════════════════════════════════
    //  오른쪽 편집 사이드바 로직 — 크기·회전·조판(N-up)·테두리
    // ══════════════════════════════════════════════════════════════════════
    // 머리글/바닥글 임베드 폰트 (시스템 TTF/OTF — PDF에 subset 임베드)
    const WIN_FONTS = 'C:\\Windows\\Fonts\\';
    const DEFAULT_HF_FONT = WIN_FONTS + 'malgun.ttf';
    // 자주 쓰는 글꼴(상단 고정). 시스템 폰트 목록은 listFonts로 동적 로드.
    const FAVORITE_FONTS = [
      { name: '맑은 고딕',          file: WIN_FONTS + 'malgun.ttf' },
      { name: '맑은 고딕 Bold',     file: WIN_FONTS + 'malgunbd.ttf' },
      { name: '휴먼명조 (한글 명조)', file: WIN_FONTS + 'HMKMRHD.TTF' },
      { name: 'Arial',              file: WIN_FONTS + 'arial.ttf' },
      { name: 'Arial Bold',         file: WIN_FONTS + 'arialbd.ttf' },
      { name: 'Times New Roman',    file: WIN_FONTS + 'times.ttf' },
    ];
    let _systemFonts = null; // [{name,file}] (listFonts 캐시)
    const _fontBytesCache = new Map(); // 경로 → Uint8Array (디스크 1회 읽기)
    // 파일명 또는 절대경로 모두 허용 (절대경로면 그대로, 아니면 Windows Fonts 폴더 기준)
    function loadFontBytes(v) {
      const p = /[\\/]/.test(v) ? v : (WIN_FONTS + v);
      if (_fontBytesCache.has(p)) return _fontBytesCache.get(p);
      const u8 = new Uint8Array(window.electronAPI.readFile(p));
      _fontBytesCache.set(p, u8);
      return u8;
    }
    // 글꼴 드롭다운 채우기: 자주 쓰는 글꼴 + 전체 시스템 글꼴
    function populateFontDropdown() {
      const sel = document.getElementById('esHfFont');
      if (!sel) return;
      const ls = activeLayoutSettings();
      const cur = (ls && ls.hf.font) || DEFAULT_HF_FONT;
      sel.innerHTML = '';
      const favG = document.createElement('optgroup'); favG.label = '자주 쓰는 글꼴';
      FAVORITE_FONTS.forEach(f => {
        const o = document.createElement('option'); o.value = f.file; o.textContent = f.name; favG.appendChild(o);
      });
      sel.appendChild(favG);
      if (_systemFonts && _systemFonts.length) {
        const allG = document.createElement('optgroup'); allG.label = `전체 시스템 글꼴 (${_systemFonts.length})`;
        _systemFonts.forEach(f => {
          if (!f || !f.file) return;
          const o = document.createElement('option'); o.value = f.file; o.textContent = f.name || f.file; allG.appendChild(o);
        });
        sel.appendChild(allG);
      }
      setFontSelectValue(cur);
    }
    // 선택값이 목록에 없으면 임시 옵션으로 추가 후 선택
    function setFontSelectValue(path) {
      const sel = document.getElementById('esHfFont');
      if (!sel) return;
      if (![...sel.options].some(o => o.value === path)) {
        const o = document.createElement('option');
        o.value = path; o.textContent = path.split(/[\\/]/).pop();
        sel.insertBefore(o, sel.firstChild);
      }
      sel.value = path;
    }
    // 시스템 폰트 목록 1회 로드 (느릴 수 있어 비동기, 완료 후 드롭다운 갱신)
    let _fontListLoading = false;
    async function ensureFontList() {
      if (_systemFonts || _fontListLoading) return;
      _fontListLoading = true;
      try { _systemFonts = await window.electronAPI.listFonts(); }
      catch (e) { _systemFonts = []; }
      _fontListLoading = false;
      populateFontDropdown();
    }

    // data-속성 칩 활성화 토글
    function activateChip(attr, val) {
      document.querySelectorAll('[data-' + attr + ']').forEach(c =>
        c.classList.toggle('active', c.dataset[attr] === String(val)));
    }

    function toggleEditSidebar(force) {
      const open = (force === undefined)
        ? !document.body.classList.contains('edit-open') : !!force;
      document.body.classList.toggle('edit-open', open);
      if (open) { populateFontDropdown(); ensureFontList(); loadPresetList(); syncEditUI(); }
      else if (document.body.classList.contains('edit-fullscreen')) exitEditWorkspace(false);
    }

    // ── 전체화면 편집 작업공간 ─────────────────────────────────────────────
    // 사이드바를 넓은 작업공간으로 펼쳐 왼쪽=편집 컨트롤, 오른쪽=큰 미리보기로 보여준다.
    // '💾 저장하고 닫기'로 편집을 메인에 적용하고 닫는다. 별도 OS 창이 아니라 같은 렌더러 안이므로
    // 메모리 캐시(_baseCache·_pvDoc 등)·워커가 그대로 유지된다.
    function enterEditWorkspace() {
      if (!originalPdfBytes || !pageResults.filter(Boolean).length) { showError('먼저 PDF를 열어 주세요.'); return; }
      if (!document.body.classList.contains('edit-open')) toggleEditSidebar(true);
      document.body.classList.add('edit-fullscreen');
      // 오른쪽 미리보기 채우기: 편집이 있으면 강제로 1회 렌더(자동반영 토글과 무관), 없으면 원본 페이지 표시.
      if (shouldPreview()) runLivePreview();
      else showWorkspaceBasePreview();
    }
    function exitEditWorkspace(applied) {
      if (!document.body.classList.contains('edit-fullscreen')) return;
      document.body.classList.remove('edit-fullscreen');
      // 적용하지 않고 닫았고 적용 결과도 없으면 메인은 원본 페이지 그리드로 복귀
      if (!applied && !processedPdfBytes) closePreview();
    }
    async function saveAndCloseWorkspace() {
      if (processingOptions.bw && !selectedPages.size && !hasAnyActiveLayout()) {
        showError('흑백변환할 페이지를 선택하거나 편집 옵션을 설정하세요.'); return;
      }
      try {
        if (shouldPreview()) await applyChanges(); // 편집을 메인에 적용(processedPdfBytes 생성 + 결과 표시)
        exitEditWorkspace(true);
      } catch (e) {
        console.error('작업공간 저장 오류:', e);
        showError('편집 적용 중 오류: ' + (e && e.message ? e.message : String(e)));
      }
    }
    // 편집이 하나도 없을 때 작업공간 오른쪽에 원본 페이지를 그대로 보여준다(빈 화면 방지).
    function showWorkspaceBasePreview() {
      if (originalPdfBytes) renderProcessedPreview(originalPdfBytes, { live: true });
    }

    // ── 편집 설정 프리셋 (localStorage) ──────────────────────────────────────
    const PRESET_KEY = 'editPresets';
    function getPresets() { try { return JSON.parse(localStorage.getItem(PRESET_KEY) || '{}') || {}; } catch (e) { return {}; } }
    function savePresetsObj(o) { try { localStorage.setItem(PRESET_KEY, JSON.stringify(o)); } catch (e) {} }
    function presetFromSettings(es) {
      return { scaling: es.scaling, margins: es.margins, nUp: es.nUp, gutter: es.gutter, border: es.border, hf: es.hf, wm: es.wm };
    }
    // 자주 쓰는 작업 세팅 재사용 — 처리 옵션(흑백·잉크정규화) + 임포징 설정까지 스냅샷
    function captureExtraPreset() {
      const g = id => document.getElementById(id);
      return {
        proc: { bw: !!processingOptions.bw, inkNorm: !!processingOptions.inkNorm },
        imp: {
          mode: _impMode, bind: _bkBind, cutN: _cutN, cutSides: _cutSides,
          paper:  g('bkPaper') ? g('bkPaper').value : 'auto',
          gutter: g('bkGutter') ? g('bkGutter').value : '0',
          creep:  g('bkCreep') ? g('bkCreep').value : '0',
          margin: g('impMargin') ? g('impMargin').value : '0',
          bleed:  g('impBleed') ? g('impBleed').value : '0',
          crop:   !!(g('impCrop') && g('impCrop').checked),
          repCols: g('repCols') ? g('repCols').value : '',
          repRows: g('repRows') ? g('repRows').value : '',
        },
      };
    }
    function applyExtraPreset(c) {
      const g = id => document.getElementById(id);
      if (c.proc) {
        ['bw', 'inkNorm'].forEach(k => {
          if (typeof c.proc[k] === 'boolean' && !!processingOptions[k] !== c.proc[k]) toggleOption(k);
        });
      }
      if (c.imp) {
        const im = c.imp;
        if (im.mode)     setImpMode(im.mode);
        if (im.bind)     setBookletBind(im.bind);
        if (im.cutN)     setCutN(im.cutN);
        if (im.cutSides) setCutSides(im.cutSides);
        if (im.paper !== undefined) populatePaperSelect(im.paper);   // 없는 커스텀 용지는 auto 폴백
        if (g('bkGutter'))  g('bkGutter').value  = im.gutter ?? '0';
        if (g('bkCreep'))   g('bkCreep').value   = im.creep ?? '0';
        if (g('impMargin')) g('impMargin').value = im.margin ?? '0';
        if (g('impBleed'))  g('impBleed').value  = im.bleed ?? '0';
        if (g('impCrop'))   g('impCrop').checked = !!im.crop;
        if (g('repCols'))   g('repCols').value   = im.repCols || '';
        if (g('repRows'))   g('repRows').value   = im.repRows || '';
      }
    }
    function loadPresetList() {
      const sel = document.getElementById('esPresetSel'); if (!sel) return;
      const names = Object.keys(getPresets()).sort();
      const cur = sel.value;
      sel.innerHTML = '<option value="">프리셋 선택…</option>' +
        names.map(n => `<option value="${n.replace(/"/g, '&quot;')}">${n}</option>`).join('');
      if (names.includes(cur)) sel.value = cur;
    }
    function savePreset() {
      if (!editSettings) return;
      const inp = document.getElementById('esPresetName');
      const name = (inp.value || '').trim();
      if (!name) { showError('프리셋 이름을 입력하세요.'); inp.focus(); return; }
      const presets = getPresets();
      presets[name] = JSON.parse(JSON.stringify(
        Object.assign(presetFromSettings(activeLayoutSettings()), captureExtraPreset())));
      savePresetsObj(presets);
      inp.value = '';
      loadPresetList();
      document.getElementById('esPresetSel').value = name;
      showSuccess(`프리셋 '${name}' 을(를) 저장했습니다.`);
    }
    function loadPreset(name) {
      if (!name || !editSettings) return;
      const p = getPresets()[name]; if (!p) return;
      const c = JSON.parse(JSON.stringify(p));
      const def = newEditSettings();
      // 현재 포커스(전체 또는 특정 챕터)의 설정에 적용 — 적용 범위(scope) 자체는 유지
      const t = activeLayoutSettings();
      t.scaling = Object.assign(def.scaling, c.scaling || {});
      t.margins = Object.assign(def.margins, c.margins || {});
      t.nUp = c.nUp != null ? c.nUp : def.nUp;
      t.gutter = c.gutter != null ? c.gutter : def.gutter;
      t.border = c.border || def.border;
      t.hf = Object.assign(def.hf, c.hf || {});
      t.wm = Object.assign(def.wm, c.wm || {});
      applyExtraPreset(c);   // 처리 옵션·임포징 설정 복원 (구버전 프리셋엔 없으면 무시)
      syncEditUI();
      scheduleLivePreview();
      showSuccess(`프리셋 '${name}' 을(를) 적용했습니다. (편집·처리옵션·임포징 설정 포함)`);
    }
    function deletePreset() {
      const sel = document.getElementById('esPresetSel');
      const name = sel && sel.value;
      if (!name) { showError('삭제할 프리셋을 선택하세요.'); return; }
      const presets = getPresets();
      if (presets[name]) { delete presets[name]; savePresetsObj(presets); loadPresetList(); showSuccess(`프리셋 '${name}' 을(를) 삭제했습니다.`); }
    }

    // 편집 사이드바 폭 조절 (오른쪽 패널이라 왼쪽 핸들 드래그 → 폭 = 화면폭 - clientX)
    const EDIT_MIN = 300, EDIT_MAX = 820;
    function applyEditWidth(w) {
      const width = Math.min(EDIT_MAX, Math.max(EDIT_MIN, Math.round(w)));
      document.documentElement.style.setProperty('--edit-width', width + 'px');
      try { localStorage.setItem('editWidth', width); } catch (e) {}
    }
    (function initEditResizer() {
      applyEditWidth(parseInt(localStorage.getItem('editWidth')) || 330);
      const handle = document.getElementById('editResizer');
      if (!handle) return;
      let resizing = false;
      handle.addEventListener('mousedown', e => {
        e.preventDefault(); resizing = true;
        handle.classList.add('es-resizing');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      });
      document.addEventListener('mousemove', e => { if (resizing) applyEditWidth(window.innerWidth - e.clientX); });
      document.addEventListener('mouseup', () => {
        if (!resizing) return;
        resizing = false;
        handle.classList.remove('es-resizing');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      });
    })();

    // 전체화면 작업공간: 좌(편집 사이드바)/우(미리보기) 경계 드래그로 폭 조절
    const WS_MIN = 320, WS_MAX_MARGIN = 360;   // 오른쪽 미리보기 최소폭 확보
    function applyWsWidth(w) {
      const max = Math.max(WS_MIN, window.innerWidth - WS_MAX_MARGIN);
      const width = Math.min(max, Math.max(WS_MIN, Math.round(w)));
      document.documentElement.style.setProperty('--edit-ws-width', width + 'px');
      try { localStorage.setItem('editWsWidth', width); } catch (e) {}
    }
    (function initWsResizer() {
      const saved = parseInt(localStorage.getItem('editWsWidth'));
      if (saved) document.documentElement.style.setProperty('--edit-ws-width', saved + 'px');
      const handle = document.getElementById('editWsResizer');
      if (!handle) return;
      let resizing = false;
      handle.addEventListener('mousedown', e => {
        e.preventDefault(); resizing = true;
        handle.classList.add('es-resizing');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      });
      document.addEventListener('mousemove', e => { if (resizing) applyWsWidth(e.clientX); });  // 사이드바가 왼쪽 → 폭 = clientX
      document.addEventListener('mouseup', () => {
        if (!resizing) return;
        resizing = false;
        handle.classList.remove('es-resizing');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      });
    })();

    // 사이드바 위에서 스크롤 시 메인 페이지가 함께 움직이지 않도록 격리
    // (내용이 다 보여 스크롤할 게 없으면 본문 스크롤도 차단, 끝에 닿으면 전파 차단)
    (function isolateSidebarScroll() {
      ['editSidebar', 'thumbSidebar'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('wheel', e => {
          const canScroll = el.scrollHeight > el.clientHeight + 1;
          if (!canScroll) { e.preventDefault(); return; }
          const atTop = el.scrollTop <= 0;
          const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
          if ((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom)) e.preventDefault();
        }, { passive: false });
      });
    })();

    // ── 적용 범위(전체/선택/범위/챕터) ──────────────────────────────────────
    // 'chapter'로 전환하거나 챕터를 바꾸면 syncEditUI()가 그 챕터만의 설정(activeLayoutSettings())으로
    // 아래 크기·조판·테두리·머리글바닥글·워터마크 입력을 전부 다시 채운다.
    function setEditScope(mode) {
      if (!editSettings) return;
      editSettings.scope.mode = mode;
      syncEditUI();
      scheduleLivePreview();
    }
    function populateChapterSel() {
      const sel = document.getElementById('esChapterSel');
      if (!sel) return;
      const tab = tabs.get(activeTabId);
      const chs = (tab && tab.chapters) ? tab.chapters.map(c => c.name)
        : [...new Set(pageResults.filter(Boolean).map(r => r.chapter).filter(Boolean))];
      sel.innerHTML = chs.length
        ? chs.map(n => `<option value="${n}">${n}</option>`).join('')
        : '<option value="">(이 문서엔 챕터가 없습니다)</option>';
      if (editSettings) {
        if (chs.includes(editSettings.scope.chapter)) sel.value = editSettings.scope.chapter;
        else editSettings.scope.chapter = sel.value;
      }
    }
    // valid(빈칸 제외) 순서 기준 boolean 마스크
    function computeScopeMask() {
      const valid = pageResults.filter(Boolean);
      const n = valid.length;
      const es = editSettings || newEditSettings();
      const sc = es.scope;
      if (sc.mode === 'selected') return valid.map(r => selectedPages.has(r.pageNum));
      if (sc.mode === 'range') {
        const a = Math.max(1, Math.min(sc.from || 1, n));
        const b = Math.max(1, Math.min(sc.to   || n, n));
        const lo = Math.min(a, b), hi = Math.max(a, b);
        return valid.map((_, i) => (i + 1) >= lo && (i + 1) <= hi);
      }
      if (sc.mode === 'chapter') return valid.map(r => r.chapter === sc.chapter);
      return valid.map(() => true);
    }
    // 전역(공통) 설정이 실제로 적용될 범위. computeScopeMask()와 달리 'chapter' 포커스는
    // (편집 대상 선택일 뿐 적용 범위를 좁히는 게 아니므로) 'all'과 동일하게 취급한다 —
    // 그래야 챕터 하나를 편집 중이어도 전역 설정이 나머지 챕터들에 그대로 적용된다.
    function computeGlobalFallbackMask() {
      const valid = pageResults.filter(Boolean);
      const n = valid.length;
      const sc = (editSettings || newEditSettings()).scope;
      if (sc.mode === 'selected') return valid.map(r => selectedPages.has(r.pageNum));
      if (sc.mode === 'range') {
        const a = Math.max(1, Math.min(sc.from || 1, n));
        const b = Math.max(1, Math.min(sc.to   || n, n));
        const lo = Math.min(a, b), hi = Math.max(a, b);
        return valid.map((_, i) => (i + 1) >= lo && (i + 1) <= hi);
      }
      return valid.map(() => true);
    }
    function updateScopeInfo() {
      const el = document.getElementById('esScopeInfo');
      if (!el) return;
      if (!pageResults.filter(Boolean).length) { el.textContent = ''; return; }
      const cnt = computeScopeMask().filter(Boolean).length;
      let txt = `▸ 적용 대상: ${cnt}개 페이지`;
      if (editSettings.scope.mode === 'chapter' && editSettings.scope.chapter) {
        txt += ` — '${editSettings.scope.chapter}' 챕터만의 설정을 편집 중`;
      }
      const byChapter = editSettings.byChapter || {};
      const overridden = Object.keys(byChapter).filter(n => hasActiveLayout(byChapter[n]));
      if (overridden.length) txt += `\n▸ 챕터별 개별 설정 적용됨: ${overridden.join(', ')}`;
      el.textContent = txt;
    }

    // ── 크기/배율 (activeLayoutSettings(): 전체 포커스면 전역 설정, 챕터 포커스면 그 챕터만의 설정) ──
    function setScaleMode(mode) {
      if (!editSettings) return;
      activeLayoutSettings().scaling.mode = mode;
      activateChip('scale', mode);
      document.getElementById('esScaleStandard').classList.toggle('show', mode === 'standard');
      document.getElementById('esScaleCustom').classList.toggle('show', mode === 'custom');
      document.getElementById('esFitRow').style.display = (mode === 'none') ? 'none' : 'flex';
      const hint = document.getElementById('esScaleHint');
      if (hint) hint.textContent = mode === 'none'
        ? '원본 크기를 유지합니다. 규격 용지·사용자 정의를 선택하면 콘텐츠를 그 크기에 맞춰 확대·축소합니다.'
        : (mode === 'standard'
            ? '선택한 규격 용지 크기에 맞춰 콘텐츠를 확대·축소합니다.'
            : '입력한 mm 크기에 맞춰 콘텐츠를 확대·축소합니다.');
      scheduleLivePreview();
    }
    function setOrient(o) { if (editSettings) { activeLayoutSettings().scaling.orient = o; activateChip('orient', o); scheduleLivePreview(); } }
    function setNup(n)    { if (editSettings) { activeLayoutSettings().nUp = n; activateChip('nup', n); scheduleLivePreview(); } }
    function setBorder(b) { if (editSettings) { activeLayoutSettings().border = b; activateChip('border', b); scheduleLivePreview(); } }
    function setWmMode(m) { if (editSettings) { activeLayoutSettings().wm.mode = m; activateChip('wmmode', m); scheduleLivePreview(); } }

    // ── 전체(범위) 동시 회전 — 기존 per-page rotation 모델 재사용 ────────────
    function rotateScope(deg) {
      if (!editSettings) return;
      const valid = pageResults.filter(Boolean);
      if (!valid.length) return;
      const mask = computeScopeMask();
      if (!mask.some(Boolean)) { showError('회전할 페이지가 적용 범위에 없습니다.'); return; }
      if (typeof pushHistory === 'function') pushHistory();
      let cnt = 0;
      valid.forEach((r, i) => {
        if (mask[i]) { r.rotation = ((((r.rotation || 0) + deg) % 360) + 360) % 360; cnt++; }
      });
      if (typeof renderAllPages === 'function') renderAllPages(pageResults);
      if (typeof renderSidebar  === 'function') renderSidebar(pageResults);
      pageEdited = true;
      const t = tabs.get(activeTabId); if (t) t.pageEdited = true;
      // 회전 후 결과를 다시 적용해야 하므로 이전 적용본 무효화
      processedPdfBytes = null; processedFileName = '';
      if (typeof updateDownloadBtn === 'function') updateDownloadBtn();
      const dir = deg > 0 ? '오른쪽' : deg < 0 ? '왼쪽' : '';
      showSuccess(`${cnt}개 페이지를 ${dir} ${Math.abs(deg)}° 회전했습니다.`);
      scheduleLivePreview();
    }

    // ── 설정 초기화 / UI 동기화 ─────────────────────────────────────────────
    // 현재 포커스(전체 또는 특정 챕터)의 설정만 초기화 — 다른 챕터의 개별 설정은 유지된다.
    function resetEditSettings() {
      if (!editSettings) return;
      const def = newEditSettings();
      Object.assign(activeLayoutSettings(), {
        scaling: def.scaling, margins: def.margins, nUp: def.nUp,
        gutter: def.gutter, border: def.border, hf: def.hf, wm: def.wm,
      });
      syncEditUI();
      closePreview();
      showSuccess('편집 설정을 초기화했습니다. (회전은 Ctrl+Z 실행취소로 되돌리세요)');
    }
    function syncEditUI() {
      if (!editSettings) return;
      const es = editSettings;
      activateChip('scope', es.scope.mode);
      document.getElementById('esScopeRange').classList.toggle('show', es.scope.mode === 'range');
      document.getElementById('esScopeChapter').classList.toggle('show', es.scope.mode === 'chapter');
      document.getElementById('esRangeFrom').value = es.scope.from || '';
      document.getElementById('esRangeTo').value   = es.scope.to   || '';
      if (es.scope.mode === 'chapter') populateChapterSel();
      // 여기까지 적용 범위(포커스)를 확정 → 이제부터는 그 포커스의 설정(전역 또는 챕터별
      // activeLayoutSettings())으로 아래 입력들을 채운다.
      const ls = activeLayoutSettings();
      setScaleMode(ls.scaling.mode);
      document.getElementById('esPaperSel').value = ls.scaling.paper;
      activateChip('orient', ls.scaling.orient);
      document.getElementById('esCustomW').value = ls.scaling.customW;
      document.getElementById('esCustomH').value = ls.scaling.customH;
      document.getElementById('esFitMargins').checked = ls.scaling.fitMargins;
      const mgOn = !!ls.margins.enabled;
      document.getElementById('esMgEnabled').checked = mgOn;
      document.getElementById('esMgTop').value    = ls.margins.top;
      document.getElementById('esMgBottom').value = ls.margins.bottom;
      document.getElementById('esMgLeft').value   = ls.margins.left;
      document.getElementById('esMgRight').value  = ls.margins.right;
      document.getElementById('esMgBody').style.opacity = mgOn ? '1' : '0.45';
      ['esMgTop','esMgBottom','esMgLeft','esMgRight'].forEach(id => document.getElementById(id).disabled = !mgOn);
      activateChip('nup', ls.nUp);
      document.getElementById('esGutter').value = ls.gutter;
      activateChip('border', ls.border);
      // 머리글/바닥글
      document.getElementById('esHfEnabled').checked = ls.hf.enabled;
      document.getElementById('esHfBody').classList.toggle('show', ls.hf.enabled);
      document.getElementById('esHfHL').value = ls.hf.hL;
      document.getElementById('esHfHC').value = ls.hf.hC;
      document.getElementById('esHfHR').value = ls.hf.hR;
      document.getElementById('esHfFL').value = ls.hf.fL;
      document.getElementById('esHfFC').value = ls.hf.fC;
      document.getElementById('esHfFR').value = ls.hf.fR;
      document.getElementById('esHfSize').value = ls.hf.size;
      document.getElementById('esHfColor').value = ls.hf.color;
      document.getElementById('esHfMargin').value = ls.hf.margin;
      setFontSelectValue(ls.hf.font || DEFAULT_HF_FONT);
      document.getElementById('esHfPnumStyle').value = ls.hf.pnumStyle != null ? ls.hf.pnumStyle : 1;
      // 워터마크
      document.getElementById('esWmEnabled').checked = ls.wm.enabled;
      document.getElementById('esWmBody').classList.toggle('show', ls.wm.enabled);
      document.getElementById('esWmText').value = ls.wm.text;
      document.getElementById('esWmSize').value = ls.wm.size;
      document.getElementById('esWmColor').value = ls.wm.color;
      document.getElementById('esWmOpacity').value = ls.wm.opacity;
      document.getElementById('esWmOpacityVal').textContent = ls.wm.opacity + '%';
      document.getElementById('esWmAngle').value = ls.wm.angle;
      activateChip('wmmode', ls.wm.mode);
      updateScopeInfo();
    }

    // 입력 위젯 → editSettings(또는 챕터별 개별 설정) 바인딩 (1회)
    (function bindEditInputs() {
      const onIn = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('input', () => { fn(el); scheduleLivePreview(); }); };
      onIn('esRangeFrom', el => { if (editSettings) { editSettings.scope.from = parseInt(el.value) || 1; updateScopeInfo(); } });
      onIn('esRangeTo',   el => { if (editSettings) { editSettings.scope.to   = parseInt(el.value) || 1; updateScopeInfo(); } });
      onIn('esCustomW',   el => { if (editSettings) activeLayoutSettings().scaling.customW = parseFloat(el.value) || 0; });
      onIn('esCustomH',   el => { if (editSettings) activeLayoutSettings().scaling.customH = parseFloat(el.value) || 0; });
      const mg = { esMgTop:'top', esMgBottom:'bottom', esMgLeft:'left', esMgRight:'right' };
      Object.entries(mg).forEach(([id, k]) => onIn(id, el => { if (editSettings) activeLayoutSettings().margins[k] = parseFloat(el.value) || 0; }));
      const autoPv = document.getElementById('esAutoPreview');
      if (autoPv) {
        autoPv.checked = liveAutoPreview;
        autoPv.addEventListener('change', () => {
          liveAutoPreview = autoPv.checked;
          localStorage.setItem('liveAutoPreview', liveAutoPreview ? '1' : '0');
          if (liveAutoPreview) scheduleLivePreview(); // 다시 켜면 밀린 변경을 즉시 반영
        });
      }
      const mgEn = document.getElementById('esMgEnabled');
      if (mgEn) mgEn.addEventListener('change', () => {
        if (editSettings) activeLayoutSettings().margins.enabled = mgEn.checked;
        document.getElementById('esMgBody').style.opacity = mgEn.checked ? '1' : '0.45';
        ['esMgTop','esMgBottom','esMgLeft','esMgRight'].forEach(id => document.getElementById(id).disabled = !mgEn.checked);
        scheduleLivePreview();
      });
      const ch = document.getElementById('esChapterSel');
      // 챕터를 바꾸면 그 챕터만의 설정으로 전환해야 하므로 syncEditUI()로 전체 입력을 다시 채운다.
      if (ch) ch.addEventListener('change', () => { if (editSettings) { editSettings.scope.chapter = ch.value; syncEditUI(); scheduleLivePreview(); } });
      const pp = document.getElementById('esPaperSel');
      if (pp) pp.addEventListener('change', () => { if (editSettings) activeLayoutSettings().scaling.paper = pp.value; scheduleLivePreview(); });
      const fm = document.getElementById('esFitMargins');
      if (fm) fm.addEventListener('change', () => { if (editSettings) activeLayoutSettings().scaling.fitMargins = fm.checked; scheduleLivePreview(); });
      onIn('esGutter', el => { if (editSettings) activeLayoutSettings().gutter = Math.max(0, parseFloat(el.value) || 0); });

      // 머리글/바닥글
      const hfToggle = document.getElementById('esHfEnabled');
      if (hfToggle) hfToggle.addEventListener('change', () => {
        if (editSettings) activeLayoutSettings().hf.enabled = hfToggle.checked;
        document.getElementById('esHfBody').classList.toggle('show', hfToggle.checked);
        scheduleLivePreview();
      });
      const hfMap = { esHfHL:'hL', esHfHC:'hC', esHfHR:'hR', esHfFL:'fL', esHfFC:'fC', esHfFR:'fR' };
      Object.entries(hfMap).forEach(([id, k]) => onIn(id, el => { if (editSettings) activeLayoutSettings().hf[k] = el.value; }));
      onIn('esHfSize',   el => { if (editSettings) activeLayoutSettings().hf.size = Math.max(5, parseFloat(el.value) || 9); });
      onIn('esHfMargin', el => { if (editSettings) activeLayoutSettings().hf.margin = Math.max(0, parseFloat(el.value) || 0); });
      const hfColor = document.getElementById('esHfColor');
      if (hfColor) hfColor.addEventListener('input', () => { if (editSettings) activeLayoutSettings().hf.color = hfColor.value; scheduleLivePreview(); });
      const pnSel = document.getElementById('esHfPnumStyle');
      if (pnSel) pnSel.addEventListener('change', () => { if (editSettings) activeLayoutSettings().hf.pnumStyle = parseInt(pnSel.value) || 0; scheduleLivePreview(); });
      const fontSel = document.getElementById('esHfFont');
      if (fontSel) fontSel.addEventListener('change', () => { if (editSettings) activeLayoutSettings().hf.font = fontSel.value; scheduleLivePreview(); });

      // 워터마크
      const wmToggle = document.getElementById('esWmEnabled');
      if (wmToggle) wmToggle.addEventListener('change', () => {
        if (editSettings) activeLayoutSettings().wm.enabled = wmToggle.checked;
        document.getElementById('esWmBody').classList.toggle('show', wmToggle.checked);
        scheduleLivePreview();
      });
      onIn('esWmText',  el => { if (editSettings) activeLayoutSettings().wm.text = el.value; });
      onIn('esWmSize',  el => { if (editSettings) activeLayoutSettings().wm.size = Math.max(8, parseFloat(el.value) || 48); });
      onIn('esWmAngle', el => { if (editSettings) activeLayoutSettings().wm.angle = parseFloat(el.value) || 0; });
      const wmColor = document.getElementById('esWmColor');
      if (wmColor) wmColor.addEventListener('input', () => { if (editSettings) activeLayoutSettings().wm.color = wmColor.value; scheduleLivePreview(); });
      const wmOp = document.getElementById('esWmOpacity'), wmOpVal = document.getElementById('esWmOpacityVal');
      if (wmOp) wmOp.addEventListener('input', () => {
        if (editSettings) activeLayoutSettings().wm.opacity = parseInt(wmOp.value) || 30;
        if (wmOpVal) wmOpVal.textContent = wmOp.value + '%';
        scheduleLivePreview();
      });

      // 머리글/바닥글 입력에 포커스 → 페이지번호 삽입 대상 기억
      ['esHfHL','esHfHC','esHfHR','esHfFL','esHfFC','esHfFR'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('focus', () => { _lastHfField = id; });
      });
    })();
    // 페이지번호 토큰 {n}을 마지막 포커스된 머리글/바닥글 칸에 삽입
    let _lastHfField = 'esHfFC';
    function insertPageNumberToken() {
      const id = _lastHfField || 'esHfFC';
      const el = document.getElementById(id);
      if (!el || !editSettings) return;
      const key = { esHfHL:'hL', esHfHC:'hC', esHfHR:'hR', esHfFL:'fL', esHfFC:'fC', esHfFR:'fR' }[id];
      const pos = (el.selectionStart != null) ? el.selectionStart : el.value.length;
      el.value = el.value.slice(0, pos) + '{n}' + el.value.slice(pos);
      const ls = activeLayoutSettings();
      ls.hf[key] = el.value;
      if (!ls.hf.enabled) { ls.hf.enabled = true; document.getElementById('esHfEnabled').checked = true; document.getElementById('esHfBody').classList.add('show'); }
      el.focus();
      scheduleLivePreview();
    }

    // 레이아웃 변환이 필요한 설정이 하나라도 있는지
    function hasActiveLayout(es) {
      return !!es && (
        es.scaling.mode !== 'none' || (es.nUp | 0) > 1 || es.border !== 'none' ||
        (es.hf && es.hf.enabled) ||
        (es.wm && es.wm.enabled && es.wm.text.trim())
      );
    }
    // 전역 설정이든, 챕터별 개별 설정이든 하나라도 활성 레이아웃이 있는지
    function hasAnyActiveLayout() {
      if (!editSettings) return false;
      if (hasActiveLayout(editSettings)) return true;
      const byChapter = editSettings.byChapter || {};
      return Object.values(byChapter).some(o => hasActiveLayout(o));
    }
    // 현재 탭에 페이지 내부편집(내부 텍스트·요소 수정)이 하나라도 있는지
    function hasContentEdits() {
      return !!contentEdits && contentEdits.size > 0;
    }
    // 현재 스코프 포커스(전체/선택/범위/챕터)에서 편집 중인 설정 객체.
    // '챕터' 포커스면 그 챕터 전용 설정(byChapter[챕터명])을 반환(없으면 새로 생성) — 전역 설정과 별개로
    // 저장되어, 나중에 다른 챕터로 포커스를 옮겨도 이 챕터의 설정은 그대로 남아있다.
    function activeLayoutSettings() {
      if (!editSettings) return null;
      if (editSettings.scope.mode === 'chapter' && editSettings.scope.chapter) {
        const ch = editSettings.scope.chapter;
        if (!editSettings.byChapter) editSettings.byChapter = {};
        if (!editSettings.byChapter[ch]) {
          const def = newEditSettings();
          editSettings.byChapter[ch] = { scaling: def.scaling, margins: def.margins, nUp: def.nUp, gutter: def.gutter, border: def.border, hf: def.hf, wm: def.wm };
        }
        return editSettings.byChapter[ch];
      }
      return editSettings;
    }
    // 실제 적용 시 사용할 (마스크, 설정) 그룹 목록. 챕터별 개별 설정이 있는 챕터는 그 설정으로
    // 독립된 그룹이 되고, 나머지 페이지는 전역 설정 기준(적용 범위)으로 한 그룹이 된다.
    function computeLayoutGroups() {
      if (!editSettings) return [];
      const valid = pageResults.filter(Boolean);
      if (!valid.length) return [];
      const byChapter = editSettings.byChapter || {};
      const overriddenChapters = Object.keys(byChapter).filter(name => hasActiveLayout(byChapter[name]));
      const groups = [];
      overriddenChapters.forEach(name => {
        const mask = valid.map(r => r.chapter === name);
        if (mask.some(Boolean)) groups.push({ mask, es: byChapter[name] });
      });
      if (hasActiveLayout(editSettings)) {
        const overriddenSet = new Set(overriddenChapters);
        const baseMask = computeGlobalFallbackMask();
        const mask = valid.map((r, i) => baseMask[i] && !(r.chapter && overriddenSet.has(r.chapter)));
        if (mask.some(Boolean)) groups.push({ mask, es: editSettings });
      }
      return groups;
    }

    // ── 레이아웃 변환 패스: 크기 규격화 + N-up + 테두리 (worker-assemble.js에서 실행) ──
    // srcBytes: 순서·회전·흑백이 이미 반영된 base PDF. groups: [{mask, es}] — 마스크는 base 페이지
    // 순서 기준이며 그룹끼리 겹치지 않는다(챕터별 개별 설정 + 전역 설정 나머지).
    // 폰트 파일 읽기(electronAPI.readFile)는 워커에서 접근 불가한 API라 여기서 미리 읽어 전달한다.
    async function applyLayoutTransform(srcBytes, groups, baseSig) {
      const sig = (baseSig || '') + '::' + JSON.stringify(groups);
      if (_layoutCache.sig === sig) return _layoutCache.bytes;
      const fileName = (typeof originalFileName === 'string' ? originalFileName : '') || '';
      // 머리글/바닥글이 ASCII(숫자·영문)만이면 워커가 내장 표준폰트로 그리므로 13MB 시스템 폰트를 읽지도 넘기지도 않는다.
      // 한글 등이 들어가는 경우(템플릿 자체·한글 파일명의 {filename}·'1 페이지' 스타일의 {n})에만 폰트를 로드한다.
      const asciiRe = /^[\x20-\x7E]*$/;
      const hfNeedsEmbed = hf => [hf.hL, hf.hC, hf.hR, hf.fL, hf.fC, hf.fR].some(t =>
        t && t.trim() && (!asciiRe.test(t)
          || (/\{filename\}/.test(t) && !asciiRe.test(fileName))
          || (/\{n\}/.test(t) && (hf.pnumStyle | 0) === 4)));
      const fontBytesMap = {}; // 폰트 경로 → Uint8Array (그룹 간 동일 폰트는 1회만 로드)
      const workerGroups = groups.map(g => {
        const hf = g.es.hf;
        const hfOn = hf && hf.enabled && [hf.hL, hf.hC, hf.hR, hf.fL, hf.fC, hf.fR].some(s => s && s.trim());
        if (!hfOn || !hfNeedsEmbed(hf)) return g;
        const fontSel = (hf.font && hf.font.trim()) ? hf.font : DEFAULT_HF_FONT;
        if (fontBytesMap[fontSel] === undefined) {
          try { fontBytesMap[fontSel] = loadFontBytes(fontSel).slice(0); }
          catch (e) { console.warn('머리글/바닥글 글꼴 로드 실패 → 이미지로 대체:', e); fontBytesMap[fontSel] = null; }
        }
        // 워커는 이미 해석된(빈값이면 기본값 대입된) 폰트 경로만 안다 — fontBytesMap의 키와 맞춰준다.
        return { mask: g.mask, es: Object.assign({}, g.es, { hf: Object.assign({}, hf, { font: fontSel }) }) };
      });
      const srcCopy = srcBytes.slice(0);
      const transfer = [srcCopy.buffer];
      Object.values(fontBytesMap).forEach(b => { if (b) transfer.push(b.buffer); });
      const resultBytes = await assembleWorkerPool.run(
        'layout-transform', { srcBytes: srcCopy, groups: workerGroups, fontBytesMap, fileName, baseSig: baseSig || null }, transfer
      );
      const out = new Uint8Array(resultBytes);
      _layoutCache = { sig, bytes: out };
      return out;
    }

    // 렌더된 캔버스가 컬러를 포함하는지 샘플링 (출력 결과의 컬러/흑백 재집계용)
    function canvasIsColor(canvas) {
      try {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const { width: w, height: h } = canvas;
        const data = ctx.getImageData(0, 0, w, h).data;
        const totalPx = data.length >> 2;
        const step = Math.max(1, (totalPx / 9000) | 0);
        for (let i = 0; i < data.length; i += step * 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
          if (a < 8) continue;
          if (Math.abs(r - g) > 6 || Math.abs(g - b) > 6 || Math.abs(r - b) > 6) return true;
        }
        return false;
      } catch (e) { return false; }
    }

    // 출력(미리보기) 페이지 → 원본 pageNum 배열 매핑 (조판 시 N:1). 흑백 선택·컨텍스트메뉴에 사용.
    // computeLayoutGroups()/워커의 그룹별 버킷 분할과 동일한 로직으로 계산해야 출력 페이지 수가 일치한다
    // (챕터마다 N-up 등 설정이 다를 수 있으므로 전역 nUp 하나로는 계산할 수 없음).
    function computeOutputSourceMap() {
      const valid = pageResults.filter(Boolean);
      const groups = computeLayoutGroups();
      if (!groups.length) return valid.map(r => [r.pageNum]);
      const groupIds = new Array(valid.length).fill(-1);
      groups.forEach((g, gi) => { g.mask.forEach((v, i) => { if (v) groupIds[i] = gi; }); });
      const map = [];
      let bucket = [], bucketGid = -1;
      const flush = () => {
        if (!bucket.length) return;
        const nUp = Math.max(1, groups[bucketGid].es.nUp | 0);
        for (let g = 0; g < bucket.length; g += nUp) {
          map.push(bucket.slice(g, g + nUp).map(idx => valid[idx].pageNum));
        }
        bucket = [];
      };
      for (let i = 0; i < valid.length; i++) {
        const gid = groupIds[i];
        if (gid !== -1 && gid === bucketGid) { bucket.push(i); }
        else {
          flush();
          if (gid === -1) map.push([valid[i].pageNum]);
          else bucket.push(i);
          bucketGid = gid;
        }
      }
      flush();
      return map;
    }

    // 흑백변환 옵션 자동 ON (미리보기에서 페이지 선택 시)
    function ensureBwOn() {
      if (processingOptions.bw) return;
      processingOptions.bw = true;
      const b = document.getElementById('opt-bw'); if (b) b.classList.add('active');
    }

    // 미리보기 셀들의 선택 표시(파랑 테두리+흑백)를 selectedPages 기준으로 갱신
    let _pvCells = []; // [{cell, sbItem, src:[pageNum,...]}]
    function refreshPreviewMarks() {
      _pvCells.forEach(({ cell, sbItem, src }) => {
        const on = src && src.length && src.every(pn => selectedPages.has(pn));
        if (cell) cell.classList.toggle('pv-selected', on);
        if (sbItem) sbItem.classList.toggle('sb-selected', on);
      });
    }
    // 미리보기 셀 클릭 → 해당(원본) 페이지 흑백 선택 토글
    function togglePreviewSelect(src) {
      if (!src || !src.length) return;
      const allSel = src.every(pn => selectedPages.has(pn));
      src.forEach(pn => {
        const el = document.querySelector(`.page-item[data-page="${pn}"]`);
        if (el) { allSel ? deselectPageEl(pn, el) : selectPageEl(pn, el); }
        else { allSel ? selectedPages.delete(pn) : selectedPages.add(pn); }
      });
      if (!allSel) ensureBwOn();          // 선택하면 흑백변환 자동 ON
      updateSelectedCount();              // invalidateProcessed 포함
      refreshPreviewMarks();
    }

    // ── 적용 결과 미리보기 (적용 PDF를 pdf.js로 렌더해 메인·사이드바에 표시) ────
    let previewRenderToken = 0;
    let _origStats = null; // 미리보기 진입 전 분석 통계 스냅샷
    // 출력 페이지 단위 캔버스 캐시 — 1페이지만 회전/편집해도 나머지 전체를 다시
    // 렌더링하던 것을 방지(그 페이지만 다시 그림). N-up(원본 여러 장→1출력)은 대응이
    // 모호해 캐시 대상에서 제외.
    let _pvPageCache = new Map();
    // 미리보기 pdf.js 문서 캐시 — 동일 출력 바이트면 재파싱을 건너뛴다. 메모리 누적을 막기 위해
    // 딱 1개만 상주시키고, 새 문서로 교체할 때 이전 문서를 반드시 destroy() 한다.
    let _pvDoc = { key: null, pdf: null };
    // 바이트 지문(길이+표본) — 전체 비교 없이 동일 여부만 빠르게 판단
    function bytesFingerprint(b) {
      const n = b.length; let h = n >>> 0;
      const step = Math.max(1, (n / 96) | 0);
      for (let i = 0; i < n; i += step) h = (Math.imul(h, 31) + b[i]) >>> 0;
      return n + ':' + h;
    }
    async function releasePreviewDoc() {
      if (_pvDoc.pdf) { try { await _pvDoc.pdf.destroy(); } catch (e) {} }
      _pvDoc = { key: null, pdf: null };
    }
    function setStatCounts(total, color) {
      const gray = Math.max(0, total - color);
      totalPagesEl.textContent     = total;
      colorPagesEl.textContent     = color;
      grayscalePagesEl.textContent = gray;
      colorPercentEl.textContent   = total ? Math.round(color / total * 100) + '%' : '0%';
      syncSidebarPanel();
    }
    // opts.live=true → 빠른 렌더(작은 해상도)
    async function renderProcessedPreview(bytes, opts) {
      opts = opts || {};
      const section = document.getElementById('previewSection');
      const grid = document.getElementById('previewGrid');
      const note = document.getElementById('previewNote');
      if (!section || !grid || !bytes) return;
      const myToken = ++previewRenderToken;
      const pxW = opts.live ? 170 : 240;   // 캔버스 폭(작을수록 빠름)
      // 진입 시 원본 통계 스냅샷(최초 1회)
      if (!_origStats) _origStats = {
        t: totalPagesEl.textContent, c: colorPagesEl.textContent,
        g: grayscalePagesEl.textContent, p: colorPercentEl.textContent,
      };
      let pdf = null;
      const fp = bytesFingerprint(bytes);
      const reused = _pvDoc.pdf && _pvDoc.key === fp;
      let keepPdf = reused; // 재사용 문서는 여기서 해제하지 않음(캐시로 계속 상주)
      try {
        if (reused) {
          pdf = _pvDoc.pdf; // 동일 출력 → 파싱 생략, 메모리에 상주한 문서 재사용
        } else {
          pdf = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
          if (myToken !== previewRenderToken) { try { await pdf.destroy(); } catch (e) {} return; }
        }
        const total = pdf.numPages;
        // 깜빡임 방지: 새 내용을 오프스크린(DocumentFragment)에 모두 그린 뒤 한 번에 교체.
        // 렌더 도중에는 기존 화면이 그대로 보이고, 더 새 갱신이 오면 교체 없이 중단(기존 유지).
        const mainFrag = document.createDocumentFragment();
        const sbFrag = document.createDocumentFragment();
        // 출력→원본 페이지 매핑 (흑백 선택 클릭용). 길이 불일치 시 클릭 비활성.
        const srcMap = computeOutputSourceMap();
        // computeOutputSourceMap은 임포징을 모른다(원본 페이지 1:1 기준). 복제 2부·반복처럼
        // 시트 수가 원본 페이지 수와 우연히 같아지면 매핑이 맞는 것처럼 통과해 엉뚱한 페이지가
        // 흑백 선택된다 → 임포징 포함 상태에서는 1:1 매핑 자체를 쓰지 않는다.
        const canSelect = srcMap.length === total && !impIncluded();
        const pvCells = [];
        let colorCount = 0;
        // 1:1(비N-up) 페이지는 (해상도·레이아웃설정·원본페이지·회전·흑백선택)이 그대로면
        // 이전 렌더의 캔버스를 재사용 — 한 페이지만 회전해도 나머지 전체를 다시 그리지 않는다.
        // 캔버스 캐시 키에 임포징 상태(impSignature)를 포함 — editSettings에는 임포징 옵션이
        // 없어서, 이게 빠지면 임포징을 바꿔도 이전 캔버스를 재사용해 옛 모양이 남는다.
        const layoutSig = JSON.stringify(editSettings) + impSignature();
        const pnMap = new Map(pageResults.filter(Boolean).map(r => [r.pageNum, r]));
        const pvPageCacheNext = new Map();
        for (let i = 1; i <= total; i++) {
          if (myToken !== previewRenderToken) return;
          const src = canSelect ? srcMap[i - 1] : null;
          let sig = null;
          if (src && src.length === 1) {
            const r = pnMap.get(src[0]);
            if (r) sig = [pxW, layoutSig, total, r.originalIdx, r.rotation || 0, r.isBlank ? 1 : 0, selectedPages.has(src[0]) ? 1 : 0].join('|');
          }
          const cached = sig ? _pvPageCache.get(i) : null;
          let canvas, isColor;
          if (cached && cached.sig === sig) {
            canvas = document.createElement('canvas');
            canvas.width = cached.w; canvas.height = cached.h;
            canvas.getContext('2d').drawImage(cached.canvas, 0, 0);
            isColor = cached.isColor;
          } else {
            const page = await pdf.getPage(i);
            const vp1 = page.getViewport({ scale: 1 });
            const vp = page.getViewport({ scale: pxW / vp1.width });
            canvas = document.createElement('canvas');
            canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
            await page.render({ canvasContext: canvas.getContext('2d', { willReadFrequently: true }), viewport: vp }).promise;
            if (myToken !== previewRenderToken) return;
            isColor = canvasIsColor(canvas);
          }
          if (sig) pvPageCacheNext.set(i, { sig, canvas, w: canvas.width, h: canvas.height, isColor });
          if (isColor) colorCount++;
          const selected = !!(src && src.length && src.every(pn => selectedPages.has(pn)));
          // 메인 셀
          canvas.className = 'pv-canvas';
          const cell = document.createElement('div'); cell.className = 'pv-cell' + (selected ? ' pv-selected' : '');
          const num = document.createElement('div'); num.className = 'pv-num'; num.textContent = i;
          cell.append(canvas, num); mainFrag.appendChild(cell);
          // 사이드바 미니 썸네일 (메인과 동일 모양으로 다운스케일)
          const sc = document.createElement('canvas');
          const sbw = 104, sbh = Math.max(1, Math.round(canvas.height * sbw / canvas.width));
          sc.width = sbw; sc.height = sbh;
          sc.getContext('2d').drawImage(canvas, 0, 0, sbw, sbh);
          sc.style.cssText = 'width:100%;height:auto;display:block;border-radius:3px;';
          const sbItem = document.createElement('div');
          sbItem.className = 'sb-item' + (isColor ? ' sb-color-page' : ' sb-mono-page') + (selected ? ' sb-selected' : '');
          sbItem.appendChild(sc);
          const sn = document.createElement('div'); sn.className = 'sb-num'; sn.textContent = i;
          sbItem.appendChild(sn);
          sbFrag.appendChild(sbItem);
          // 클릭 → 해당 페이지 흑백 선택 토글 (조판 시 시트의 원본 페이지 전부)
          if (src) {
            const handler = () => togglePreviewSelect(src);
            cell.addEventListener('click', handler);
            sbItem.style.cursor = 'pointer';
            sbItem.addEventListener('click', handler);
            pvCells.push({ cell, sbItem, src });
          }
          // 우클릭 → 원본 페이지 1:1 매칭(N-up 미적용)일 때만 기존 컨텍스트 메뉴 재사용
          // (회전·삭제·빈 페이지 삽입 — 조판 미리보기 중에도 편집 가능하도록)
          if (src && src.length === 1) {
            const pageNum = src[0];
            const ctxHandler = e => {
              e.preventDefault(); e.stopPropagation();
              const idx = pageResults.findIndex(p => p && p.pageNum === pageNum);
              if (idx >= 0) { ctxTargetIdx = idx; showCtxMenu(e, idx); }
            };
            cell.addEventListener('contextmenu', ctxHandler);
            sbItem.addEventListener('contextmenu', ctxHandler);
          }
          // 큰 문서에서도 UI가 멈추지 않게 가끔 양보
          if (opts.live && i % 8 === 0) await new Promise(r => setTimeout(r));
        }
        if (myToken !== previewRenderToken) return;
        _pvPageCache = pvPageCacheNext;
        // 이 렌더가 최종 승자 — 파싱한 문서를 1개만 메모리에 상주시킨다(이전 캐시는 해제).
        if (!reused) {
          if (_pvDoc.pdf && _pvDoc.pdf !== pdf) { try { await _pvDoc.pdf.destroy(); } catch (e) {} }
          _pvDoc = { key: fp, pdf };
        }
        keepPdf = true;
        // ── 한 번에 교체 (깜빡임 없음) ──
        grid.replaceChildren(mainFrag);
        sidebar.querySelectorAll('.sb-item, .sb-chapter').forEach(el => el.remove());
        sidebar.appendChild(sbFrag);
        _pvCells = pvCells;
        document.getElementById('previewCount').textContent = `(전체 ${total}페이지)` + (canSelect ? ' · 페이지를 클릭해 흑백 선택' : '');
        note.textContent = '';
        setAnalysisGridVisible(false);
        section.style.display = 'block';
        // 출력 결과 기준으로 컬러/흑백 통계 갱신
        setStatCounts(total, colorCount);
      } catch (e) {
        console.error('미리보기 렌더 실패:', e);
      } finally {
        // 상주 캐시로 남긴 문서(keepPdf)만 유지하고, 그 외(중도 취소·교체된 새 문서)는 즉시 해제한다.
        // 캐시는 항상 최대 1개만 남으므로 편집 반복 시 pdf.js 메모리가 누적되지 않는다.
        if (pdf && !keepPdf) { try { await pdf.destroy(); } catch (e) {} }
      }
    }
    function closePreview() {
      previewRenderToken++; // 진행 중 렌더 취소
      releasePreviewDoc();  // 상주 pdf.js 문서 해제(메모리 회수)
      _pvCells = [];
      const s = document.getElementById('previewSection');
      if (s) s.style.display = 'none';
      const g = document.getElementById('previewGrid'); if (g) g.innerHTML = '';
      setAnalysisGridVisible(true);
      // 원본 통계·사이드바 복원
      if (_origStats) {
        totalPagesEl.textContent     = _origStats.t;
        colorPagesEl.textContent     = _origStats.c;
        grayscalePagesEl.textContent = _origStats.g;
        colorPercentEl.textContent   = _origStats.p;
        _origStats = null;
        syncSidebarPanel();
      }
      if (pageResults && pageResults.filter(Boolean).length) renderSidebar(pageResults);
    }
    // 분석 썸네일 그리드(헤딩·힌트 포함) 표시/숨김 — 편집 결과를 같은 자리에 보여주기 위함
    function setAnalysisGridVisible(visible) {
      ['pagesGrid', 'pagesDetailHead', 'pagesDetailHint'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = visible ? '' : 'none';
      });
    }

    function renderSidebar(results) {
      // 상단 패널(#sbPanel)은 보존하고 썸네일 항목·챕터 구분만 교체
      sidebar.querySelectorAll('.sb-item, .sb-chapter').forEach(el => el.remove());
      const sbChTotal = chapterRuns().length;   // 챕터 총수 — 이동 버튼 끝단 비활성화용
      let sbPrevChapter = null, sbChapterNo = 0;
      results.filter(Boolean).forEach((r, orderedIdx) => {
        if (r.chapter && r.chapter !== sbPrevChapter) {
          sbChapterNo++;
          const startIdx = pageResults.indexOf(r);   // 이 챕터 첫 페이지의 pageResults 인덱스
          const no = sbChapterNo;
          const ch = document.createElement('div');
          ch.className = 'sb-chapter';
          const b = document.createElement('span'); b.className = 'sb-chapter-badge'; b.textContent = sbChapterNo;
          const nm = document.createElement('span'); nm.className = 'sb-chapter-name'; nm.textContent = r.chapter;
          const acts = document.createElement('span'); acts.className = 'sb-chapter-actions';
          const mkSbBtn = (cls, html, title, disabled, fn) => {
            const btn = document.createElement('button');
            btn.className = 'sb-ch-btn' + (cls ? ' ' + cls : '');
            btn.innerHTML = html; btn.title = title; btn.disabled = !!disabled;
            btn.onclick = (e) => { e.stopPropagation(); fn(); };
            return btn;
          };
          acts.append(
            mkSbBtn('', '▲', '이 챕터를 위로 이동', no <= 1,        () => moveChapterRun(startIdx, -1)),
            mkSbBtn('', '▼', '이 챕터를 아래로 이동', no >= sbChTotal, () => moveChapterRun(startIdx, +1)),
            mkSbBtn('sb-ch-del', '🗑', '이 챕터 전체 삭제', sbChTotal <= 1, () => deleteChapterAt(startIdx)),
          );
          ch.append(b, nm, acts);
          ch.title = r.chapter;
          sidebar.appendChild(ch);
          sbPrevChapter = r.chapter;
        }
        const item = document.createElement('div');
        item.className = 'sb-item' + (r.isBlank ? '' : (r.isColor ? ' sb-color-page' : ' sb-mono-page'));
        item.dataset.sbPage = r.pageNum;
        item.innerHTML = r.thumbnail
          ? `<img src="${r.thumbnail}" alt="${r.pageNum}">`
          : `<div class="sb-blank" style="height:44px;background:#2c2c2e;border-radius:3px;"></div>`;
        item.innerHTML += `<div class="sb-num">${r.pageNum}</div>`;

        // 클릭 → 메인 그리드 해당 페이지로 이동
        // Ctrl/Shift+클릭 → 메인 그리드와 동일한 페이지 선택 (개별 토글/범위 선택)
        item.addEventListener('click', e => {
          if (e._fromDrag) return;
          if (e.ctrlKey || e.shiftKey) {
            const el = document.querySelector(`[data-page="${r.pageNum}"]`);
            if (el) togglePageSelection(r.pageNum, el, e);
            return;
          }
          scrollToPage(r.pageNum);
        });

        // peer-hover 동기는 컨테이너 이벤트 위임으로 처리

        // 우클릭 → 메인 그리드와 동일한 컨텍스트 메뉴
        item.addEventListener('contextmenu', e => {
          e.preventDefault(); e.stopPropagation();
          const idx = pageResults.findIndex(p => p && p.pageNum === r.pageNum);
          if (idx >= 0) { ctxTargetIdx = idx; showCtxMenu(e, idx); }
        });

        // 사이드바 드래그 (메인 그리드와 dragSrcPageNum 공유)
        item.draggable = true;
        item.addEventListener('dragstart', e => {
          dragSrcPageNum = r.pageNum;
          e.dataTransfer.effectAllowed = 'move';
          requestAnimationFrame(() => item.classList.add('sb-dragging'));
        });
        item.addEventListener('dragend', () => {
          item.classList.remove('sb-dragging');
          sidebar.querySelectorAll('.sb-drag-before,.sb-drag-after')
            .forEach(el => el.classList.remove('sb-drag-before','sb-drag-after'));
        });
        item.addEventListener('dragover', e => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          sidebar.querySelectorAll('.sb-drag-before,.sb-drag-after')
            .forEach(el => el.classList.remove('sb-drag-before','sb-drag-after'));
          const rect = item.getBoundingClientRect();
          item.classList.add(e.clientX < rect.left + rect.width / 2 ? 'sb-drag-before' : 'sb-drag-after');
        });
        item.addEventListener('dragleave', e => {
          if (!item.contains(e.relatedTarget))
            item.classList.remove('sb-drag-before','sb-drag-after');
        });
        item.addEventListener('drop', e => {
          e.preventDefault(); e._fromDrag = true;
          const insertAfter = item.classList.contains('sb-drag-after');
          item.classList.remove('sb-drag-before','sb-drag-after');
          if (!dragSrcPageNum || dragSrcPageNum === r.pageNum) return;
          const srcIdx = pageResults.findIndex(p => p && p.pageNum === dragSrcPageNum);
          const dstIdx = pageResults.findIndex(p => p && p.pageNum === r.pageNum);
          if (srcIdx < 0 || dstIdx < 0) return;
          movePage(srcIdx, dstIdx, insertAfter);
        });

        sidebar.appendChild(item);
      });
      // 사이드바 재렌더링 후 선택 상태·흑백 이미지 복원
      results.filter(Boolean).forEach(r => {
        if (!selectedPages.has(r.pageNum)) return;
        const sbEl = sidebar.querySelector(`[data-sb-page="${r.pageNum}"]`);
        if (!sbEl) return;
        sbEl.classList.add('sb-selected');
        const sbImg = sbEl.querySelector('img');
        if (sbImg) sbImg.style.filter = 'grayscale(1)';
      });
      syncSidebarPanel();
    }

    // 스티키 패널의 분석결과 요약(본문 stat-card 값을 그대로 미러링)
    function updateStickyStats() {
      const g = id => document.getElementById(id);
      if (!g('stkTotal')) return;
      g('stkTotal').textContent = totalPagesEl.textContent;
      g('stkColor').textContent = colorPagesEl.textContent;
      g('stkGray').textContent  = grayscalePagesEl.textContent;
      g('stkPct').textContent   = colorPercentEl.textContent;
    }

    // 사이드바 상단 패널(분석결과·처리옵션)을 본문 상태와 동기화
    function syncSidebarPanel() {
      const g = id => document.getElementById(id);
      updateStickyStats();
      if (!g('sbPanel')) return;
      g('sbTotal').textContent = totalPagesEl.textContent;
      g('sbColor').textContent = colorPagesEl.textContent;
      g('sbGray').textContent  = grayscalePagesEl.textContent;
      g('sbPct').textContent   = colorPercentEl.textContent;
      g('sbSel').textContent   = `${selectedPages.size}개 선택됨`;
      g('sb-opt-bw').classList.toggle('active', !!processingOptions.bw);
      const sbInk = g('sb-opt-inkNorm');
      if (sbInk) sbInk.classList.toggle('active', !!processingOptions.inkNorm);
      // 좌측 패널 적용/다운로드 버튼 상태는 직접 계산 (상단 툴바 버튼은 제거됨 — 여기와 오른쪽 편집 패널로 통합)
      const anyActive = Object.values(processingOptions).some(v => v);
      const hasMod = !!originalPdfBytes && (anyActive || pageEdited || selectedPages.size > 0
                     || (typeof hasAnyActiveLayout === 'function' && hasAnyActiveLayout())
                     || (typeof hasContentEdits === 'function' && hasContentEdits()));
      const upToDate = !!processedPdfBytes;
      g('sb-applyBtn').disabled    = applying || !hasMod || upToDate;
      g('sb-downloadBtn').disabled = applying || !originalPdfBytes;
      g('sb-downloadBtn').classList.toggle('btn-dim', !processedPdfBytes);
      g('sb-clearOptsBtn').style.display = anyActive ? '' : 'none';
      g('sb-refreshBtn').style.display = '';
    }

    function scrollToPage(pageNum) {
      const el = document.querySelector(`[data-page="${pageNum}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.remove('page-apple-nav');
      void el.offsetWidth;
      el.classList.add('page-apple-nav');
      setTimeout(() => el.classList.remove('page-apple-nav'), 800);
    }

    // IntersectionObserver로 현재 뷰에 가장 많이 보이는 썸네일을 사이드바에서 하이라이트
    let sbObserver = null;
    function initSidebarObserver() {
      if (sbObserver) sbObserver.disconnect();
      sbObserver = new IntersectionObserver(entries => {
        let best = null, bestRatio = 0;
        entries.forEach(e => { if (e.intersectionRatio > bestRatio) { bestRatio = e.intersectionRatio; best = e; } });
        if (best) {
          const pageNum = parseInt(best.target.dataset.page);
          updateSidebarActive(pageNum);
        }
      }, { threshold: Array.from({ length: 11 }, (_, i) => i / 10) });
      document.querySelectorAll('.page-item[data-page]').forEach(el => sbObserver.observe(el));
    }

    function updateSidebarActive(pageNum) {
      sidebar.querySelectorAll('.sb-item').forEach(item => {
        const active = parseInt(item.dataset.sbPage) === pageNum;
        item.classList.toggle('sb-active', active);
        if (active) item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    }

    function renderPageItem(r, idx) {
      const { pageNum, isColor, isBlank, thumbnail, rotation = 0 } = r;
      const el = document.createElement('div');
      el.className = `page-item ${isBlank ? 'blank grayscale' : (isColor ? 'color' : 'grayscale')}`;
      el.dataset.page = pageNum;
      const typeLabel = isBlank ? '빈 페이지' : (isColor ? '🎨 컬러' : '흑백');
      el.innerHTML = `
        <div class="page-select-indicator">✓</div>
        <button class="page-btn-del" title="페이지 삭제">✕</button>
        <button class="page-btn-dup" title="페이지 복제 (D)">⧉</button>
        <div class="page-thumb-wrap">
          ${thumbnail ? `<img class="page-thumbnail" src="${thumbnail}" alt="페이지 ${pageNum}">` : ''}
          <div class="page-rotate-group">
            <button class="page-btn-ccw" title="반시계 90° 회전">↺</button>
            <button class="page-btn-cw"  title="시계 90° 회전">↻</button>
          </div>
        </div>
        <div class="page-info">${pageNum} <span class="page-type-inline">${typeLabel}</span></div>
        <button class="page-insert-btn">＋ 빈 페이지 삽입</button>
      `;
      if (rotation) {
        const img = el.querySelector('.page-thumbnail');
        if (img) applyRotationStyle(img, rotation, r.thumbW, r.thumbH);
      }
      if (selectedPages.has(pageNum)) {
        el.classList.add('selected');
        const img = el.querySelector('.page-thumbnail');
        if (img && !isBlank) img.style.filter = 'grayscale(1)';
      }
      el.addEventListener('click', e => {
        if (e.target.closest('button')) return;
        togglePageSelection(pageNum, el, e);
      });
      el.querySelector('.page-btn-del').addEventListener('click', e => {
        e.stopPropagation(); deletePage(idx);
      });
      el.querySelector('.page-btn-dup').addEventListener('click', e => {
        e.stopPropagation(); duplicatePage(idx);
      });
      el.querySelector('.page-btn-ccw').addEventListener('click', e => {
        e.stopPropagation(); rotatePage(idx, -90);
      });
      el.querySelector('.page-btn-cw').addEventListener('click', e => {
        e.stopPropagation(); rotatePage(idx, 90);
      });
      el.querySelector('.page-insert-btn').addEventListener('click', e => {
        e.stopPropagation(); insertBlankPage(idx);
      });
      // 마우스오버 → ctxTargetIdx 추적 (peer-hover 동기는 컨테이너 이벤트 위임으로 처리)
      el.addEventListener('mouseenter', () => { ctxTargetIdx = idx; });
      // 우클릭 → 컨텍스트 메뉴
      el.addEventListener('contextmenu', e => {
        e.preventDefault(); e.stopPropagation();
        ctxTargetIdx = idx;
        showCtxMenu(e, idx);
      });

      // ── 드래그 앤 드롭 (페이지 순서 이동) ──────────────────────────────────
      el.draggable = true;
      el.addEventListener('dragstart', e => {
        dragSrcPageNum = pageNum;
        e.dataTransfer.effectAllowed = 'move';
        // 약간 지연 후 반투명 처리 (dragImage가 먼저 캡처된 뒤 적용)
        requestAnimationFrame(() => el.classList.add('dragging'));
      });
      el.addEventListener('dragend', () => {
        el.classList.remove('dragging');
        document.querySelectorAll('.drag-before, .drag-after').forEach(e => {
          e.classList.remove('drag-before', 'drag-after');
        });
      });
      el.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        document.querySelectorAll('.drag-before, .drag-after').forEach(e => {
          e.classList.remove('drag-before', 'drag-after');
        });
        const rect = el.getBoundingClientRect();
        el.classList.add(e.clientX < rect.left + rect.width / 2 ? 'drag-before' : 'drag-after');
      });
      el.addEventListener('dragleave', e => {
        if (!el.contains(e.relatedTarget)) el.classList.remove('drag-before', 'drag-after');
      });
      el.addEventListener('drop', e => {
        e.preventDefault(); e.stopPropagation();
        const insertAfter = el.classList.contains('drag-after');
        el.classList.remove('drag-before', 'drag-after');
        if (!dragSrcPageNum || dragSrcPageNum === pageNum) return;
        const srcIdx = pageResults.findIndex(r => r && r.pageNum === dragSrcPageNum);
        const dstIdx = pageResults.findIndex(r => r && r.pageNum === pageNum);
        if (srcIdx < 0 || dstIdx < 0) return;
        movePage(srcIdx, dstIdx, insertAfter);
      });

      return el;
    }

    // ── 페이지 순서 이동 ─────────────────────────────────────────────────────
    let dragSrcPageNum = null;

    function movePage(srcIdx, dstIdx, insertAfter) {
      pushHistory();
      const [page] = pageResults.splice(srcIdx, 1);
      // splice 후 dstIdx 보정 (srcIdx가 앞에 있으면 한 칸 당겨짐)
      let insertIdx = srcIdx < dstIdx ? dstIdx - 1 : dstIdx;
      if (insertAfter) insertIdx++;
      pageResults.splice(insertIdx, 0, page);
      rebuildPageNums();
      syncTabPageResults();
      rerenderPages();
      setPageEdited();
      updateUndoBtn();
      // 이동된 페이지로 스크롤
      setTimeout(() => {
        const moved = pageResults[insertIdx];
        if (moved) scrollToPage(moved.pageNum);
      }, 60);
    }

    // 90/270도 회전 시 이미지가 wrapper 안에 완전히 들어오도록 scale 보정
    function applyRotationStyle(img, rotation, thumbW, thumbH) {
      if (!rotation) { img.style.transform = ''; return; }
      const isSide = rotation === 90 || rotation === 270;
      if (isSide && thumbW && thumbH) {
        // 90도 회전 후 이미지 너비(= 원래 높이)가 wrapper 너비를 넘지 않도록 축소
        const scale = thumbW / thumbH;
        img.style.transform = `rotate(${rotation}deg) scale(${scale})`;
      } else {
        img.style.transform = `rotate(${rotation}deg)`;
      }
    }

    function rotatePage(idx, deg) {
      const r = pageResults[idx];
      if (!r) return;
      pushHistory();
      r.rotation = ((r.rotation || 0) + deg + 360) % 360;
      // 메인 그리드 업데이트
      const el = document.querySelector(`[data-page="${r.pageNum}"]`);
      if (el) {
        const img = el.querySelector('.page-thumbnail');
        if (img) applyRotationStyle(img, r.rotation, r.thumbW, r.thumbH);
      }
      // 사이드바 업데이트
      const sbEl = sidebar.querySelector(`[data-sb-page="${r.pageNum}"]`);
      if (sbEl) {
        const sbImg = sbEl.querySelector('img');
        if (sbImg) applyRotationStyle(sbImg, r.rotation, r.thumbW, r.thumbH);
      }
      setPageEdited();
      updateUndoBtn();
    }

    // ── 드래그&드롭 ──────────────────────────────────────────────────────────
    // Electron에서 파일을 드래그하면 기본 동작으로 창이 해당 파일로 이동(navigate)됨.
    // 문서 레벨에서 막아야 업로드 영역의 drop 이벤트가 정상 작동함.
    document.addEventListener('dragover', e => e.preventDefault());
    document.addEventListener('drop',     e => e.preventDefault());

    const uploadSection = document.getElementById('uploadSection');
    uploadSection.addEventListener('dragover', e => { e.preventDefault(); uploadSection.classList.add('drag-over'); });
    uploadSection.addEventListener('dragleave', e => { if (!uploadSection.contains(e.relatedTarget)) uploadSection.classList.remove('drag-over'); });
    uploadSection.addEventListener('drop', async e => {
      e.preventDefault();
      uploadSection.classList.remove('drag-over');
      const dropped = [...e.dataTransfer.files].filter(f =>
        f.type.includes('pdf') || /\.pdf$/i.test(f.name) || CONVERT_RE.test(f.name)
      );
      if (!dropped.length) { showError('PDF · 한글(HWP·HWPX) · MS Office(Word·Excel·PowerPoint) · Adobe(AI·PSD·INDD) 파일만 업로드 가능합니다.'); return; }
      hideError(); hideSuccess();
      try {
        const needConvert = dropped.some(f => CONVERT_RE.test(f.name));
        if (needConvert) showLoading('문서를 PDF로 변환하고 있습니다…');
        // 드롭된 File → 실제 경로 취득 후 prepareFiles로 일괄 처리(HWP·Office는 PDF 변환)
        const items = dropped.map(f => ({ name: f.name, path: window.electronAPI.getPathForFile(f) }));
        const files = await prepareFiles(items);
        if (needConvert) hideLoading();
        if (files.length) startLoad(files);
      } catch(err) {
        hideLoading();
        showError('파일 처리 오류: ' + (err && err.message ? err.message : String(err)));
      }
    });
    uploadSection.addEventListener('click', e => {
      if (!e.target.closest('button')) openFilesDialog();
    });
    // 시작 시 최근 파일 칩 렌더 (함수는 app-core.js에 정의 — 로드 순서상 사용 가능)
    renderRecentFiles();

    // ── 공통 UI ──────────────────────────────────────────────────────────────
    function showLoading(msg) {
      loadingMsg.textContent = msg || 'PDF를 분석하고 있습니다...';
      // 새 작업 시작 시 진행바는 숨김 — updateProgress가 호출되면 그때 노출된다.
      loading.classList.remove('has-progress');
      loading.style.display = 'flex';
    }
    function hideLoading() { loading.style.display = 'none'; loading.classList.remove('has-progress'); }
    function showError(msg)   { errorEl.textContent = msg; errorEl.style.display = 'block'; successEl.style.display = 'none'; }
    function hideError()      { errorEl.style.display = 'none'; }
    function showSuccess(msg) { successEl.textContent = msg; successEl.style.display = 'block'; errorEl.style.display = 'none'; }
    function hideSuccess()    { successEl.style.display = 'none'; }

    window.addEventListener('scroll', () => {
      document.getElementById('scrollTopBtn').style.display = window.scrollY > 300 ? 'block' : 'none';
    });

    // ── 메인↔사이드바 peer-hover 동기 (이벤트 위임) ─────────────────────────
    // 개별 mouseenter/mouseleave 대신 컨테이너 단위로 처리 → 빠른 이동 시 잔류 없음
    function clearAllPeerHover() {
      document.querySelectorAll('.peer-hover').forEach(el => el.classList.remove('peer-hover'));
    }

    // 메인 그리드 → 사이드바
    pagesGrid.addEventListener('mouseover', e => {
      const item = e.target.closest('.page-item[data-page]');
      clearAllPeerHover();
      if (!item) return;
      const pageNum = item.dataset.page;
      const sbEl = sidebar.querySelector(`[data-sb-page="${pageNum}"]`);
      if (sbEl) sbEl.classList.add('peer-hover');
    });
    pagesGrid.addEventListener('mouseleave', clearAllPeerHover);

    // 사이드바 → 메인 그리드
    sidebar.addEventListener('mouseover', e => {
      const item = e.target.closest('.sb-item[data-sb-page]');
      clearAllPeerHover();
      if (!item) return;
      const pageNum = item.dataset.sbPage;
      // 사이드바 호버도 단축키(D 복제·Ctrl+V 붙여넣기 등) 대상 페이지로 추적
      const tIdx = pageResults.findIndex(p => p && p.pageNum === +pageNum);
      if (tIdx >= 0) ctxTargetIdx = tIdx;
      const mainEl = document.querySelector(`[data-page="${pageNum}"]`);
      if (mainEl) mainEl.classList.add('peer-hover');
    });
    sidebar.addEventListener('mouseleave', clearAllPeerHover);
