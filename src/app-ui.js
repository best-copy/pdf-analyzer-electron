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
      else { if (typeof exitEditWorkspace === 'function') exitEditWorkspace(false); document.body.classList.remove('edit-open'); }
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

    // ── 편집 패널 아코디언 그룹 ──────────────────────────────────────────────
    // 섹션 17개 세로 나열이 어지러워 4개 그룹으로 재편. 각 그룹은 접이식이며 마지막
    // 펼침 상태를 localStorage(esGroupOpen)에 기억. 접힌 그룹은 제목 옆에 활성 기능
    // 요약 배지(●)를 보여 준다. 고정 상단(자동반영·프리셋·적용범위)은 그룹 밖에 남는다.
    // ids 항목이 객체({wrap, title, ids})면 그 섹션들을 하나의 카테고리(es-section)로 병합해
    // 담는다 — 안의 섹션들은 es-subsec(점선 구분)으로 강등. 마크업 이동 없이 부트 시 조립.
    const ES_GROUPS = [
      { key: 'imp',  title: '📖 임포징 · 제본', ids: ['secImp'] },
      { key: 'page', title: '📄 페이지 보정', ids: [
        { wrap: 'secScaleAll', title: '<span class="ic">📐</span> 크기 · 여백 · 제본여백 · 블리드', ids: ['secScale', 'secMargins', 'secBind', 'secBleed'] },
        { wrap: 'secAdjust', title: '<span class="ic">🎯</span> 기울기 · 정렬 · 개별 보정', ids: ['secDeskew', 'secCenter', 'secPageAdjust'] },
        'secBorder'] },
      { key: 'cover', title: '📕 표지 만들기', ids: ['secCover'] },
      { key: 'mark', title: '🔖 머릿말 · 꼬릿말 · 워터마크', ids: ['secHf', 'secWm'] },
      { key: 'tool', title: '🛠 도구', ids: ['secContentEdit'] },
    ];
    function esGroupOpenState() { try { return JSON.parse(localStorage.getItem('esGroupOpen') || '{}') || {}; } catch (e) { return {}; } }
    function toggleEsGroup(key, force) {
      const body = document.getElementById('esgBody-' + key);
      const head = document.getElementById('esgHead-' + key);
      if (!body || !head) return;
      const open = force !== undefined ? !!force : !body.classList.contains('open');
      body.classList.toggle('open', open);
      head.classList.toggle('open', open);
      const st = esGroupOpenState(); st[key] = open;
      try { localStorage.setItem('esGroupOpen', JSON.stringify(st)); } catch (e) {}
      updateEsGroupBadges();
    }
    // 그룹별 활성 기능 요약 배지 — 접혀 있어도 무엇이 켜져 있는지 보이게
    function updateEsGroupBadges() {
      const ls = editSettings ? ensureAdjustFields(activeLayoutSettings()) : null;
      const parts = { page: [], imp: [], cover: [], mark: [], tool: [] };
      if (ls) {
        if (ls.scaling.mode === 'percent') parts.page.push(`배율 ${ls.scaling.percent || 100}%`);
        else if (ls.scaling.mode !== 'none') parts.page.push('크기');
        if (ls.deskew.enabled) parts.page.push('기울기');
        if (ls.center.enabled) parts.page.push('정렬');
        if (ls.margins && ls.margins.enabled) parts.page.push('여백');
        if (ls.bind.enabled) parts.page.push('제본여백');
        if (ls.border !== 'none') parts.page.push('테두리');
        if (ls.hf && ls.hf.enabled) parts.mark.push('머리글/바닥글');
        if (ls.wm && ls.wm.enabled && ls.wm.text.trim()) parts.mark.push('워터마크');
      }
      const paN = editSettings && editSettings.pageAdjust ? Object.keys(editSettings.pageAdjust).length : 0;
      if (paN) parts.page.push(`개별 ${paN}쪽`);
      if (typeof _bleedEnabled !== 'undefined' && _bleedEnabled) parts.page.push('블리드');
      if (typeof _impEnabled !== 'undefined' && _impEnabled) parts.imp.push('임포징 포함');
      // ✒ 폰트 출력 안전화는 메인 '처리 옵션'으로 이동 — 편집 그룹 배지에서는 제외
      Object.entries(parts).forEach(([k, arr]) => {
        const el = document.getElementById('esgBadge-' + k);
        if (el) el.textContent = arr.length ? '● ' + arr.join(' · ') : '';
      });
    }
    (function buildEsGroups() {
      const sidebar = document.getElementById('editSidebar');
      if (!sidebar) return;
      const anchor = sidebar.querySelector('.es-actions');   // 그룹들은 적용/다운로드 버튼 위에
      const st = esGroupOpenState();
      ES_GROUPS.forEach(g => {
        const wrap = document.createElement('div');
        wrap.className = 'es-group';
        const head = document.createElement('div');
        head.className = 'es-group-head';
        head.id = 'esgHead-' + g.key;
        head.innerHTML = `<span class="esg-arrow">▸</span><span class="esg-title">${g.title}</span><span class="esg-badge" id="esgBadge-${g.key}"></span>`;
        head.addEventListener('click', () => toggleEsGroup(g.key));
        const body = document.createElement('div');
        body.className = 'es-group-body';
        body.id = 'esgBody-' + g.key;
        g.ids.forEach(id => {
          if (typeof id === 'string') {
            const el = document.getElementById(id);
            if (el) body.appendChild(el);
            return;
          }
          // 병합 카테고리: 새 es-section을 만들어 하위 섹션들을 es-subsec으로 담는다
          const wrap = document.createElement('div');
          wrap.className = 'es-section';
          wrap.id = id.wrap;
          const t = document.createElement('div');
          t.className = 'es-section-title';
          t.innerHTML = id.title;
          wrap.appendChild(t);
          id.ids.forEach(sid => {
            const el = document.getElementById(sid);
            if (el) { el.classList.remove('es-section'); el.classList.add('es-subsec'); wrap.appendChild(el); }
          });
          body.appendChild(wrap);
        });
        wrap.append(head, body);
        sidebar.insertBefore(wrap, anchor || null);
        if (st[g.key]) { body.classList.add('open'); head.classList.add('open'); }
      });
      updateEsGroupBadges();
    })();
    // 임포징 프로파일 관리(저장·수정·목록·동기화) 접이식 토글
    function toggleImpProfMgmt(force) {
      const box = document.getElementById('impProfMgmt');
      const btn = document.getElementById('impProfMgmtBtn');
      if (!box) return;
      const open = force !== undefined ? !!force : box.style.display === 'none';
      box.style.display = open ? '' : 'none';
      if (btn) btn.textContent = open ? '▾ 관리' : '▸ 관리';
    }

    // 편집 UI는 전용 '편집 모드'(전체화면 작업공간)에서만 쓴다 — 오른쪽 사이드바 단독 모드는
    // 폐지. 열기 = 편집 모드 진입, 닫기 = 편집 모드 종료. (E 키·✏ 버튼 공용)
    function toggleEditSidebar(force) {
      const open = (force === undefined)
        ? !document.body.classList.contains('edit-fullscreen') : !!force;
      if (open) enterEditWorkspace();
      else exitEditWorkspace(false);
    }

    // ── 전용 편집 모드 (전체화면 작업공간) ─────────────────────────────────
    // 왼쪽=편집 컨트롤 전체, 오른쪽=큰 미리보기. '💾 저장하고 닫기'로 편집을 메인에 적용하고
    // 닫는다. 별도 OS 창이 아니라 같은 렌더러 안이므로 메모리 캐시(_baseCache·_pvDoc 등)·워커가
    // 그대로 유지된다. 메인 화면에는 분석·흑백·잉크정규화·프린터판정·프리플라이트·적용·다운로드만 남는다.
    let _wsEnteredWithPreview = false;   // 편집 모드 진입 전에 이미 '적용 결과'를 보고 있었는지
    // 편집 모드 진입 직전의 '적용 결과' 보관본. 편집 모드의 라이브/표본 미리보기는
    // processedPdfBytes를 무효화하므로(runLivePreview → invalidateProcessed), 저장 없이 나오면
    // 이미 적용해 둔 흑백·잉크정규화 결과가 화면에서 사라져 "적용이 풀렸다"로 보였다.
    // 나올 때 이 보관본을 되돌려 결과 화면·다운로드 상태를 그대로 유지한다.
    let _wsSavedResult = null;
    function enterEditWorkspace() {
      if (!originalPdfBytes || !pageResults.filter(Boolean).length) { showError('먼저 PDF를 열어 주세요.'); return; }
      _wsEnteredWithPreview = previewVisible() && !!processedPdfBytes;
      _wsSavedResult = processedPdfBytes
        ? { bytes: processedPdfBytes, name: processedFileName, direct: directOutputBytes }
        : null;
      if (!document.body.classList.contains('edit-open')) {
        document.body.classList.add('edit-open');
        populateFontDropdown(); ensureFontList(); loadPresetList(); syncEditUI();
      }
      document.body.classList.add('edit-fullscreen');
      // 줌 위젯(－/＋, Ctrl+[ ]) — 작업공간 미리보기 썸네일 확대·축소에도 사용
      if (typeof setThumbZoomWidgetVisible === 'function') setThumbZoomWidgetVisible(true);
      // 오른쪽 미리보기 채우기: 편집이 있으면 강제로 1회 렌더(자동반영 토글과 무관), 없으면 원본 페이지 표시.
      if (shouldPreview()) runLivePreview();
      else showWorkspaceBasePreview();
    }
    function exitEditWorkspace(applied) {
      if (!document.body.classList.contains('edit-fullscreen')) return;
      document.body.classList.remove('edit-fullscreen');
      document.body.classList.remove('edit-open');   // 사이드바 단독 모드 없음 — 함께 닫는다
      if (typeof wsResetSampleGrid === 'function') wsResetSampleGrid();
      if (typeof updateGeometryOverlays === 'function') updateGeometryOverlays();
      // 적용하지 않고 닫으면 메인은 원본 페이지 그리드(썸네일)로 복귀한다.
      // 편집 모드의 라이브 미리보기가 processedPdfBytes를 채워 두기 때문에, 이 조건에 그 값을
      // 넣으면 미리보기가 메인에 남아 썸네일 그리드가 숨겨진 채로 끝난다 → 우클릭 회전 등
      // 썸네일 기반 편집이 "먹지 않는" 것처럼 보였다(실제 원인). 진입 전부터 결과를 보고 있던
      // 경우에만 그 화면을 유지한다.
      if (!applied) {
        // 진입 전 적용 결과 되살리기 — 편집 모드 미리보기가 지워 놓은 상태를 원복한다.
        if (_wsSavedResult && !processedPdfBytes) {
          processedPdfBytes = _wsSavedResult.bytes;
          processedFileName = _wsSavedResult.name;
          directOutputBytes = _wsSavedResult.direct;
          setDirty(true);
          updateDownloadBtn();
        }
        // 결과를 보고 있던 상태로 들어왔다면 결과 화면을 그대로(원본 결과 기준으로) 다시 그린다.
        // 편집 모드의 표본 미리보기 그리드가 남아 있으면 흐린 원본 썸네일이 섞여 보여
        // 흑백 적용이 풀린 것처럼 보이기 때문. 렌더는 오프스크린 → 한 번에 교체라 깜빡임 없음.
        if (_wsEnteredWithPreview && processedPdfBytes) {
          if (typeof wsResetSampleGrid === 'function') wsResetSampleGrid();
          renderProcessedPreview(processedPdfBytes, { live: false });
        } else {
          closePreview();
        }
      }
      _wsSavedResult = null;
      _wsEnteredWithPreview = false;
    }
    // '💾 저장하고 닫기' — 창을 먼저 닫고 적용을 진행한다.
    // (예전엔 applyChanges를 await한 뒤 닫아서, 폰트 출력 안전화·평탄화처럼 오래 걸리는
    //  옵션이 켜져 있으면 "닫기가 안 먹는다"로 보였다. 진행 상황은 메인 화면 토스트로 표시)
    async function saveAndCloseWorkspace() {
      // 임포징·블리드도 단독 수정사항 — 빠져 있으면 "임포징만 켜고 저장하고 닫기"가 거절돼
      // 창이 닫히지 않거나 임포징 전 결과가 그대로 남았다.
      const otherMod = hasAnyActiveLayout() || hasContentEdits()
                     || (typeof _impEnabled !== 'undefined' && _impEnabled)
                     || (typeof _bleedEnabled !== 'undefined' && _bleedEnabled);
      if (processingOptions.bw && !selectedPages.size && !otherMod) {
        showError('흑백변환할 페이지를 선택하거나 편집 옵션을 설정하세요.'); return;
      }
      const needApply = shouldPreview();
      // 편집 모드의 실시간 미리보기가 이미 지금 설정 그대로의 전체 결과를 만들어 두었다면
      // (표본 미리보기가 아니고, 그 뒤로 설정이 바뀌지도 않았다면) 그것이 곧 '적용 결과'다.
      // 예전에는 여기서 무조건 applyChanges를 다시 돌려, 임포징 200시트를 방금 조립해 놓고도
      // 메인으로 나오자마자 같은 조립을 처음부터 한 번 더 했다 — 그동안 적용·다운로드 버튼이
      // 모두 잠긴 채 수십 초가 흐르는 것이 "나오면 버튼이 죽는다"의 실제 원인이었다.
      const reusable = needApply && !!processedPdfBytes && !applying
        && !_liveRunning && !_livePvPending && !_liveQueued
        && typeof optSignature === 'function' && _processedSig === optSignature();
      exitEditWorkspace(needApply);
      if (!needApply) return;
      if (reusable) { adoptLivePreviewResult(); return; }
      try {
        await applyChanges();    // 편집을 메인에 적용(processedPdfBytes 생성 + 결과 표시)
      } catch (e) {
        console.error('작업공간 저장 오류:', e);
        showError('편집 적용 중 오류: ' + (e && e.message ? e.message : String(e)));
      }
    }
    // 편집 모드에서 만들어 둔 결과를 '적용 결과'로 그대로 승격한다 — 재조립 없음.
    // 바이트는 applyChanges가 만드는 것과 동일한 파이프라인 산출물이라 결과물 차이가 없다.
    function adoptLivePreviewResult() {
      processedFileName = defaultProcessedName();
      setDirty(true);
      // 흑백변환 확정(commit) — applyChanges와 동일 규약(선택은 해제, 변환은 유지)
      let committed = 0;
      if (processingOptions.bw && selectedPages.size) {
        pageResults.forEach(r => { if (r && !r.isBlank && selectedPages.has(r.pageNum) && !r.appliedBw) { r.appliedBw = true; committed++; } });
        commitClearSelection();
      }
      updateDownloadBtn();
      renderProcessedPreview(processedPdfBytes, { live: false });   // 화면만 정식 해상도로 다시
      const layoutNote = layoutNoteOf()
        + (typeof _bleedEnabled !== 'undefined' && _bleedEnabled ? ` · ◲ 블리드 ${_bleedOpts().mm}mm${_bleedOpts().crop ? '+재단선' : ''}` : '')
        + (typeof impositionNoteOf === 'function' ? impositionNoteOf() : '');
      showSuccess(`적용 완료! 편집 모드에서 만든 결과를 그대로 가져왔습니다${layoutNote} — '⇩ 다운로드'를 눌러 저장하세요.`
        + (committed ? `\n✅ 흑백변환 확정 — 선택은 자동 해제되었고 변환은 유지됩니다.` : ''));
      if (typeof recordWorkHistory === 'function') { try { recordWorkHistory(); } catch (e) {} }
      setTimeout(prewarmOptimizedOutput, 400);
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
      return { scaling: es.scaling, margins: es.margins, nUp: es.nUp, gutter: es.gutter, border: es.border, deskew: es.deskew, center: es.center, bind: es.bind, hf: es.hf, wm: es.wm };
    }
    // 프리셋에 담는 임포징 입력 컨트롤 전체 — 'v'=value, 'c'=checked.
    // 새 임포징 옵션을 UI에 추가하면 여기에도 등록해야 프리셋에 저장·복원된다
    // (예전엔 목록이 일부라 사용자 지정 용지 W×H·그리드·배치·재단선 세부가 통째로 누락됐다).
    const IMP_PRESET_FIELDS = {
      bkPaper: 'v', impCustomW: 'v', impCustomH: 'v', impCustomName: 'v',
      bkGutter: 'v', bkCreep: 'v', impMargin: 'v', impBleed: 'v',
      impAcross: 'v', impDown: 'v', repCols: 'v', repRows: 'v',
      impFixed: 'v', impAlign: 'v', impOffX: 'v', impOffY: 'v',
      impCropGap: 'v', impCropLen: 'v', impCropTh: 'v',
      impCrop: 'c', impFrame: 'c', impSlug: 'c', impStackNum: 'c', impCropCenter: 'c', bkCoverSplit: 'c',
    };
    // 자주 쓰는 작업 세팅 재사용 — 처리 옵션(흑백·잉크정규화) + 임포징 설정까지 스냅샷
    function captureExtraPreset() {
      const g = id => document.getElementById(id);
      const fields = {};
      Object.entries(IMP_PRESET_FIELDS).forEach(([id, kind]) => {
        const el = g(id);
        if (el) fields[id] = kind === 'c' ? !!el.checked : el.value;
      });
      return {
        proc: { bw: !!processingOptions.bw, inkNorm: !!processingOptions.inkNorm,
                outline: (typeof _outlineEnabled !== 'undefined') && _outlineEnabled,
                outlineMode: (typeof _outlineMode !== 'undefined') ? _outlineMode : 'outline',
                outlineFlatten: !!g('outlineFlatten')?.checked },
        // ◲ 블리드(매직미러) 옵션 — 예전엔 빠져 있어 최근 작업을 불러와도 블리드가 꺼진 채였다
        bleed: {
          enabled: (typeof _bleedEnabled !== 'undefined') && _bleedEnabled,
          mm: g('bleedGenMm')?.value, crop: !!g('bleedCrop')?.checked,
        },
        // 📕 표지 만들기 값 전체 (표지 프리셋과 같은 스냅샷)
        cover: (typeof captureCoverState === 'function') ? captureCoverState() : null,
        imp: {
          enabled: !!_impEnabled,     // '임포징 포함' 체크 상태까지 재현
          mode: _impMode, bind: _bkBind, cutN: _cutN, cutSides: _cutSides, scale: _impScale,
          fields,
          // 📖 임포징 프리셋 — 프리셋을 불러온 상태(_impProfile)는 UI 값만으로 재현되지 않는다.
          // 이게 빠져 있어서 '최근 작업 설정'을 눌러도 제본(임포징) 항목이 통째로 풀렸다.
          profSel: g('impProfile')?.value || '',
          profName: (_impProfile && _impProfile._profName) || '',
          profOpts: _impProfile ? JSON.parse(JSON.stringify(Object.assign({}, _impProfile, { slug: undefined }))) : null,
          // 구버전 앱이 이 프리셋을 읽어도 최소한 동작하도록 예전 키도 함께 기록
          paper: fields.bkPaper || 'auto', gutter: fields.bkGutter || '0', creep: fields.bkCreep || '0',
          margin: fields.impMargin || '0', bleed: fields.impBleed || '0', crop: !!fields.impCrop,
          repCols: fields.repCols || '', repRows: fields.repRows || '',
        },
      };
    }
    function applyExtraPreset(c) {
      const g = id => document.getElementById(id);
      if (c.proc) {
        ['bw', 'inkNorm'].forEach(k => {
          if (typeof c.proc[k] === 'boolean' && !!processingOptions[k] !== c.proc[k]) toggleOption(k);
        });
        // ✒ 폰트 아웃라인화 옵션 복원 (방식 → 체크박스 순서 — 방식이 먼저여야 안내가 맞다)
        if (c.proc.outlineMode && typeof setOutlineMode === 'function') setOutlineMode(c.proc.outlineMode);
        if (typeof c.proc.outline === 'boolean' && typeof setOutlineEnabled === 'function') setOutlineEnabled(c.proc.outline);
        if (typeof c.proc.outlineFlatten === 'boolean' && g('outlineFlatten')) g('outlineFlatten').checked = c.proc.outlineFlatten;
      }
      // ◲ 블리드 복원 (값 먼저, 켜기는 마지막 — setBleedEnabled가 안내 메시지를 띄우므로)
      if (c.bleed) {
        if (g('bleedGenMm') && c.bleed.mm !== undefined) g('bleedGenMm').value = c.bleed.mm;
        if (g('bleedCrop') && typeof c.bleed.crop === 'boolean') g('bleedCrop').checked = c.bleed.crop;
        if (typeof c.bleed.enabled === 'boolean' && typeof setBleedEnabled === 'function'
            && !!_bleedEnabled !== c.bleed.enabled) setBleedEnabled(c.bleed.enabled);
      }
      // 📕 표지 설정 복원
      if (c.cover && typeof applyCoverState === 'function') { try { applyCoverState(c.cover); } catch (e) { console.warn('표지 설정 복원 실패:', e); } }
      if (c.imp) {
        const im = c.imp;
        // 값 세팅 도중 impSettingsChanged가 매번 재조립을 예약하지 않도록 가드 (프로파일 적용과 동일 규약)
        const hadGuard = typeof _loadingProfile !== 'undefined';
        if (hadGuard) _loadingProfile = true;
        try {
          if (im.mode !== undefined) setImpMode(im.mode);   // ''(방식 미선택)도 그대로 재현
          if (im.bind)     setBookletBind(im.bind);
          if (im.cutN)     setCutN(im.cutN);
          if (im.cutSides) setCutSides(im.cutSides);
          if (im.scale && typeof setImpScale === 'function') setImpScale(im.scale);
          // 신형(fields): 임포징 입력 전체 복원. 구형 프리셋은 예전 키만 있으므로 그대로 매핑.
          const f = im.fields || {
            bkPaper: im.paper, bkGutter: im.gutter, bkCreep: im.creep,
            impMargin: im.margin, impBleed: im.bleed, impCrop: !!im.crop,
            repCols: im.repCols, repRows: im.repRows,
          };
          // 용지 드롭다운은 옵션을 다시 만든 뒤 값을 넣어야 한다(없는 커스텀 용지는 auto 폴백)
          if (f.bkPaper !== undefined) populatePaperSelect(f.bkPaper);
          Object.entries(IMP_PRESET_FIELDS).forEach(([id, kind]) => {
            if (id === 'bkPaper' || f[id] === undefined) return;
            const el = g(id);
            if (!el) return;
            if (kind === 'c') el.checked = !!f[id];
            else el.value = f[id];
          });
          // 종속 UI 동기: 사용자 지정 W×H 행·재단선 세부 행은 값만 넣으면 숨겨진 채로 남는다
          if (typeof onImpPaperChange === 'function') onImpPaperChange();
          const cropOptRow = g('impCropOptRow');
          if (cropOptRow) cropOptRow.style.display = (g('impCrop') && g('impCrop').checked) ? '' : 'none';
          // 📖 임포징 프리셋 재현 — 저장 당시 프리셋을 불러온 상태였다면 그 정규화 옵션을
          // 그대로 되살린다(UI 값만으로는 재현되지 않는 항목이 있어 제본 설정이 통째로 빠졌었다).
          _impProfile = null;
          if (im.profOpts) {
            _impProfile = im.profOpts;
            if (im.profSel !== undefined && g('impProfile')) {
              const sel = g('impProfile');
              // 이름이 같은 프리셋을 우선 찾고(순서가 바뀌었을 수 있음), 없으면 저장된 인덱스
              const byName = im.profName
                ? [...sel.options].find(o => o.textContent === im.profName) : null;
              sel.value = byName ? byName.value
                : ([...sel.options].some(o => o.value === im.profSel) ? im.profSel : '');
            }
          } else if (g('impProfile')) { g('impProfile').value = ''; }
          if (typeof updateImpSheetReadout === 'function') updateImpSheetReadout();
        } finally { if (hadGuard) _loadingProfile = false; }
        // '임포징 포함' 상태 재현 — 방식이 있어야 켤 수 있다(toggleImpEnabled가 자체 검증)
        if (typeof im.enabled === 'boolean' && typeof toggleImpEnabled === 'function'
            && !!_impEnabled !== im.enabled) toggleImpEnabled(im.enabled);
      }
    }
    function loadPresetList() {
      const sel = document.getElementById('esPresetSel'); if (!sel) return;
      const names = Object.keys(getPresets()).sort();
      const cur = sel.value;
      sel.innerHTML = '<option value="">프리셋 선택…</option>' +
        names.map(n => `<option value="${n.replace(/"/g, '&quot;')}">${n}</option>`).join('');
      if (names.includes(cur)) sel.value = cur;
      updatePresetSaveBtn();
    }
    // 프리셋 이름 입력·선택 변경 → 저장 버튼 라벨(신규/덮어쓰기) 동기 (1회 바인딩)
    (function bindPresetSaveBtn() {
      const nm = document.getElementById('esPresetName');
      if (nm) nm.addEventListener('input', updatePresetSaveBtn);
      const sel = document.getElementById('esPresetSel');
      if (sel) sel.addEventListener('change', updatePresetSaveBtn);
    })();
    // 저장 대상 = 이름칸에 적은 이름(신규/지정 저장). 비어 있으면 목록에서 선택 중인 프리셋
    // (= 불러와서 옵션을 고친 그 프리셋)에 덮어쓴다.
    function presetSaveTarget() {
      const typed = (document.getElementById('esPresetName')?.value || '').trim();
      if (typed) return typed;
      return document.getElementById('esPresetSel')?.value || '';
    }
    // 저장 버튼 라벨을 대상에 맞춰 갱신 — 신규인지 덮어쓰기인지 누르기 전에 보이게
    function updatePresetSaveBtn() {
      const btn = document.getElementById('esPresetSaveBtn');
      if (!btn) return;
      const target = presetSaveTarget();
      const exists = target && !!getPresets()[target];
      btn.textContent = exists ? '💾 덮어쓰기' : '＋ 저장';
      btn.title = exists
        ? `'${target}' 프로파일을 현재 설정으로 덮어씁니다 (새 이름을 적으면 새 프로파일으로 저장)`
        : '이름을 적으면 새 프로파일으로, 비우면 위에서 선택한 프로파일에 현재 설정을 덮어씁니다';
    }
    function savePreset() {
      if (!editSettings) return;
      const inp = document.getElementById('esPresetName');
      const name = presetSaveTarget();
      if (!name) {
        showError('프로파일 이름을 입력하거나, 덮어쓸 프로파일을 목록에서 선택하세요.');
        inp.focus(); return;
      }
      const presets = getPresets();
      const overwrite = !!presets[name];
      if (overwrite && !confirm(`프로파일 '${name}'을(를) 현재 설정으로 덮어쓸까요?`)) return;
      presets[name] = JSON.parse(JSON.stringify(
        Object.assign(presetFromSettings(activeLayoutSettings()), captureExtraPreset())));
      savePresetsObj(presets);
      inp.value = '';
      loadPresetList();
      document.getElementById('esPresetSel').value = name;
      updatePresetSaveBtn();
      showSuccess(overwrite
        ? `프로파일 '${name}' 을(를) 현재 설정으로 덮어썼습니다.`
        : `프로파일 '${name}' 을(를) 저장했습니다.`);
    }
    // 프로파일 데이터 적용 공용부 — 프로파일 불러오기와 '이전 세션 복원'이 공유
    function applyPresetData(c) {
      const def = newEditSettings();
      // 현재 포커스(전체 또는 특정 챕터)의 설정에 적용 — 적용 범위(scope) 자체는 유지
      const t = activeLayoutSettings();
      t.scaling = Object.assign(def.scaling, c.scaling || {});
      t.margins = Object.assign(def.margins, c.margins || {});
      t.nUp = c.nUp != null ? c.nUp : def.nUp;
      t.gutter = c.gutter != null ? c.gutter : def.gutter;
      t.border = c.border || def.border;
      t.deskew = Object.assign(def.deskew, c.deskew || {});
      t.center = Object.assign(def.center, c.center || {});
      t.bind   = Object.assign(def.bind,   c.bind   || {});
      t.hf = Object.assign(def.hf, c.hf || {});
      t.wm = Object.assign(def.wm, c.wm || {});
      applyExtraPreset(c);   // 처리 옵션·임포징 설정 복원 (구버전 프로파일엔 없으면 무시)
      syncEditUI();
      updatePresetSaveBtn();
      scheduleLivePreview();
    }
    function loadPreset(name) {
      if (!name || !editSettings) return;
      const p = getPresets()[name]; if (!p) return;
      applyPresetData(JSON.parse(JSON.stringify(p)));
      showSuccess(`프로파일 '${name}' 을(를) 적용했습니다. (편집·처리옵션·임포징 설정 포함)`
        + `\n옵션을 고친 뒤 '💾 덮어쓰기'를 누르면 이 프로파일이 갱신됩니다.`);
    }
    // ── 🕓 이전 세션 설정 자동 보관 — 프로파일 저장을 잊고 껐을 때의 안전망 ──
    // 문서가 열려 있는 동안 1분마다 + 종료 직전에 현재 설정(편집·처리·임포징)을 스냅샷.
    // 재시작하면 지난 세션 스냅샷을 '🕓 이전 설정' 버튼으로 불러와 재사용하거나,
    // 불러온 뒤 기존 '＋ 저장'으로 프로파일로 남길 수 있다.
    const SESSION_SNAP_KEY = 'lastSessionSettings';
    let _bootPrevSession = null;   // 부트 시점의 지난 세션 스냅샷 (이번 세션 자동저장이 덮기 전 확보)
    function saveSessionSnapshot() {
      if (!editSettings) return;
      try {
        const data = Object.assign(presetFromSettings(activeLayoutSettings()), captureExtraPreset());
        localStorage.setItem(SESSION_SNAP_KEY, JSON.stringify({ ts: Date.now(), data: JSON.parse(JSON.stringify(data)) }));
      } catch (e) {}
      recordWorkHistory();   // 🕓 문서별 작업내역에도 기록
    }
    // ── 🕓 최근 작업 설정 — 문서(파일명+크기)별 자동 기록 목록.
    // 같은 문서로 판정되면 설정 + 문서 편집 상태(순서·회전·빈페이지·흑백확정·선택·개별보정)까지
    // 이어받고, 다른 문서면 설정(프로파일 범위)만 적용한다.
    const WORK_HISTORY_KEY = 'workHistory';
    const WH_MAX = 12;
    const whEsc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const whFmt = ts => { const d = new Date(ts || 0), p2 = v => String(v).padStart(2, '0'); return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
    function workHistory() { try { return JSON.parse(localStorage.getItem(WORK_HISTORY_KEY) || '[]') || []; } catch (e) { return []; } }
    function saveWorkHistoryList(list) { try { localStorage.setItem(WORK_HISTORY_KEY, JSON.stringify(list.slice(0, WH_MAX))); } catch (e) {} }
    function whIsSameDoc(h) {
      return !!(h && h.ident && originalPdfBytes
        && h.ident.name === (originalFileName || '문서')
        && h.ident.size === originalPdfBytes.byteLength);
    }
    function whSummary() {
      const parts = describeLayoutParts(activeLayoutSettings()).slice(0, 4);
      if (typeof _impEnabled !== 'undefined' && _impEnabled) {
        const pn = (typeof _impProfile !== 'undefined' && _impProfile && _impProfile._profName)
                || (typeof _impMode !== 'undefined' ? _impMode : '');
        parts.push(pn ? '임포징 (' + pn + ')' : '임포징');
      }
      if (processingOptions.bw) parts.push('흑백');
      if (processingOptions.inkNorm) parts.push('잉크정규화');
      if (typeof _bleedEnabled !== 'undefined' && _bleedEnabled) parts.push('블리드');
      if (typeof _outlineEnabled !== 'undefined' && _outlineEnabled) parts.push('폰트안전화');
      return parts.join(' · ') || '기본 설정';
    }
    function captureDocState() {
      return {
        order: pageResults.filter(Boolean).map(r => ({
          oi: r.isBlank ? null : r.originalIdx, blank: !!r.isBlank, rot: r.rotation || 0,
          chapter: r.chapter || '', bw: !!r.appliedBw, roman: !!r.isRoman,
          ps: r.isBlank ? (r.pageSize || null) : undefined,
          // 📑 목차: 생성된 목차 페이지 표식과 북마크 제목도 함께 — 빠지면 다시 열었을 때
          // 목차 페이지가 평범한 본문으로 돌아가 로마자 번호·PDF 북마크가 사라진다.
          toc: r.isTocPage ? 1 : undefined,
          tt: r.tocTitle || undefined,
        })),
        selected: [...selectedPages],
        pageAdjust: (editSettings && editSettings.pageAdjust) ? JSON.parse(JSON.stringify(editSettings.pageAdjust)) : {},
      };
    }
    function recordWorkHistory() {
      if (!editSettings || !originalPdfBytes) return;
      try {
        const entry = {
          ident: { name: originalFileName || '문서', size: originalPdfBytes.byteLength },
          ts: Date.now(),
          summary: whSummary(),
          data: JSON.parse(JSON.stringify(Object.assign(presetFromSettings(activeLayoutSettings()), captureExtraPreset()))),
          docState: captureDocState(),
        };
        const list = workHistory().filter(h => !(h.ident && h.ident.name === entry.ident.name));
        list.unshift(entry);
        saveWorkHistoryList(list);
        renderWorkHistory();
      } catch (e) {}
    }
    function toggleWorkHistory(force) {
      const el = document.getElementById('workHistoryList');
      const arrow = document.getElementById('whArrow');
      if (!el) return;
      const open = force !== undefined ? !!force : el.style.display === 'none';
      el.style.display = open ? '' : 'none';
      if (arrow) arrow.textContent = open ? '▾' : '▸';
    }
    function renderWorkHistory() {
      const sec = document.getElementById('secWorkHistory');
      const listEl = document.getElementById('workHistoryList');
      if (!sec || !listEl) return;
      const list = workHistory();
      sec.style.display = list.length ? '' : 'none';
      const cnt = document.getElementById('whCount');
      if (cnt) cnt.textContent = list.length ? `(${list.length})` : '';
      listEl.innerHTML = list.map((h, i) => {
        const same = whIsSameDoc(h);
        return `<div class="es-row" style="margin-bottom:4px;">
          <button class="es-chip" style="flex:1; min-width:0; text-align:left; white-space:normal; line-height:1.5;" onclick="applyWorkHistory(${i})"
            title="${same ? '같은 문서 — 설정 + 회전·순서·흑백선택·개별보정까지 이어받습니다 (Ctrl+Z로 되돌리기 가능)' : '설정(편집 옵션·처리·임포징)만 적용합니다'}">
            ${same ? '<span style="color:#ffd60a;">●</span> ' : ''}${whEsc(h.ident && h.ident.name)} <span style="color:#6e6e73; font-size:11px;">${whFmt(h.ts)}</span><br>
            <span style="color:#aeaeb2; font-size:11px;">${whEsc(h.summary)}</span>
          </button>
          <button class="es-chip" style="flex:0 0 auto;" onclick="deleteWorkHistory(${i})" title="이 기록 삭제">✕</button>
        </div>`;
      }).join('');
    }
    function applyWorkHistory(i) {
      const h = workHistory()[i];
      if (!h) return;
      if (!editSettings) { showError('먼저 PDF를 열어 주세요 — 문서가 있어야 설정을 적용할 수 있습니다.'); return; }
      const same = whIsSameDoc(h);
      applyPresetData(JSON.parse(JSON.stringify(h.data || {})));
      let full = false;
      if (same && h.docState) full = restoreDocState(h.docState);
      scheduleLivePreview();
      showSuccess(full
        ? `🕓 '${h.ident.name}' 작업을 이어받았습니다 — 설정 + 회전·순서·빈페이지·흑백확정·선택·개별보정 복원. (문서 되돌리기 Ctrl+Z)`
        : `🕓 '${h.ident.name}'의 설정을 적용했습니다${same ? '' : ' (다른 문서라 설정만)'} — ＋ 저장으로 프로파일로 남길 수 있습니다.`);
    }
    function deleteWorkHistory(i) {
      const list = workHistory();
      list.splice(i, 1);
      saveWorkHistoryList(list);
      renderWorkHistory();
    }
    // 같은 문서의 편집 상태 복원 — 스냅샷의 순서/회전/빈페이지/흑백확정/선택/개별보정을 재현.
    // originalIdx 매칭이 어긋나면(문서가 실제로는 다름) 조용히 포기하고 설정만 남긴다.
    function restoreDocState(ds) {
      try {
        if (!ds || !Array.isArray(ds.order) || !ds.order.length) return false;
        const byOi = new Map();
        pageResults.forEach(r => { if (r && !r.isBlank && r.originalIdx != null && !byOi.has(r.originalIdx)) byOi.set(r.originalIdx, r); });
        const next = [];
        for (const o of ds.order) {
          if (o.blank) {
            next.push({ pageNum: 0, originalIdx: null, isColor: false, isBlank: true, rotation: 0,
              thumbnail: (typeof blankThumbnail === 'function') ? blankThumbnail() : null,
              pageSize: o.ps || [595.28, 841.89], chapter: o.chapter || '' });
          } else {
            const r = byOi.get(o.oi);
            if (!r) return false;
            next.push(Object.assign({}, r, { rotation: o.rot || 0, chapter: o.chapter || '', appliedBw: !!o.bw, isRoman: !!o.roman,
              isTocPage: !!o.toc, tocTitle: o.tt || undefined }));
          }
        }
        if (typeof pushHistory === 'function') pushHistory();   // Ctrl+Z 복귀 지점
        pageResults.length = 0;
        next.forEach(r => pageResults.push(r));
        pageResults.forEach((r, i2) => { r.pageNum = i2 + 1; });
        selectedPages.clear();
        (ds.selected || []).forEach(n => selectedPages.add(n));
        if (editSettings) editSettings.pageAdjust = JSON.parse(JSON.stringify(ds.pageAdjust || {}));
        if (typeof clearProcessCaches === 'function') clearProcessCaches();
        if (typeof syncTabPageResults === 'function') syncTabPageResults();
        if (typeof rerenderPages === 'function') rerenderPages();
        if (typeof updateSelectedCount === 'function') updateSelectedCount();
        if (typeof updateUndoBtn === 'function') updateUndoBtn();
        return true;
      } catch (e) { console.warn('작업내역 문서상태 복원 실패:', e); return false; }
    }
    // 문서 분석 완료 시 호출 — 같은 문서의 지난 작업이 있으면 안내 + 편집 버튼 강조
    function notifyWorkHistory() {
      renderWorkHistory();
      // 💼 작업 파일로 연 직후에는 알리지 않는다 — 이미 그 상태로 복원했는데
      // "지난 작업이 기록되어 있습니다"가 복원 안내를 덮어써 혼란만 준다.
      if (typeof _openingWorkFile !== 'undefined' && _openingWorkFile) return;
      const h = workHistory().find(whIsSameDoc);
      if (!h) return;
      showSuccess(`🕓 이 문서의 지난 작업(${whFmt(h.ts)} · ${h.summary})이 기록되어 있습니다.`
        + `\n✏ 편집(E)을 열고 '🕓 최근 작업 설정'에서 ● 항목을 누르면 회전·순서·흑백선택까지 그대로 이어받습니다.`);
      const et = document.getElementById('editToggle');
      if (et) { et.classList.add('wh-pulse'); setTimeout(() => et.classList.remove('wh-pulse'), 6000); }
    }
    function restoreLastSession() {
      if (!_bootPrevSession || !_bootPrevSession.data) { showError('보관된 이전 세션 설정이 없습니다.'); return; }
      if (!editSettings) { showError('먼저 PDF를 열어 주세요 — 문서가 있어야 설정을 적용할 수 있습니다.'); return; }
      applyPresetData(JSON.parse(JSON.stringify(_bootPrevSession.data)));
      showSuccess('🕓 이전 세션 설정을 불러왔습니다 (편집·처리옵션·임포징 포함).'
        + '\n계속 쓰려면 프로파일 이름을 적고 ＋ 저장으로 남겨두세요.');
    }
    (function initSessionSnapshot() {
      try { _bootPrevSession = JSON.parse(localStorage.getItem(SESSION_SNAP_KEY) || 'null'); } catch (e) {}
      window.addEventListener('beforeunload', saveSessionSnapshot);
      setInterval(saveSessionSnapshot, 60000);
      renderWorkHistory();   // 🕓 최근 작업 목록 표시 (기록이 있으면 섹션 노출)
    })();
    function deletePreset() {
      const sel = document.getElementById('esPresetSel');
      const name = sel && sel.value;
      if (!name) { showError('삭제할 프로파일을 선택하세요.'); return; }
      const presets = getPresets();
      if (presets[name]) {
        if (!confirm(`프로파일 '${name}' 을(를) 삭제할까요?`)) return;
        delete presets[name]; savePresetsObj(presets);
        sel.value = '';
        loadPresetList();     // updatePresetSaveBtn 포함
        showSuccess(`프로파일 '${name}' 을(를) 삭제했습니다.`);
      }
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
      const pctSub = document.getElementById('esScalePercentSub');
      if (pctSub) pctSub.classList.toggle('show', mode === 'percent');
      // 배율 모드는 페이지 자체가 커지는 것이라 '여백 안에 맞추기'가 의미 없음 — 숨김
      document.getElementById('esFitRow').style.display = (mode === 'none' || mode === 'percent') ? 'none' : 'flex';
      const hint = document.getElementById('esScaleHint');
      if (hint) hint.textContent = mode === 'none'
        ? '원본 크기를 유지합니다. 규격 용지·사용자 정의·배율을 선택하면 콘텐츠를 그 크기에 맞춰 확대·축소합니다.'
        : (mode === 'standard'
            ? '선택한 규격 용지 크기에 맞춰 콘텐츠를 확대·축소합니다.'
            : mode === 'percent'
            ? '페이지 크기와 내용을 입력한 배율(%)로 함께 확대·축소합니다.'
            : '입력한 mm 크기에 맞춰 콘텐츠를 확대·축소합니다.');
      scheduleLivePreview();
    }
    function setOrient(o) { if (editSettings) { activeLayoutSettings().scaling.orient = o; activateChip('orient', o); scheduleLivePreview(); } }
    function setNup(n)    { if (editSettings) { activeLayoutSettings().nUp = n; activateChip('nup', n); scheduleLivePreview(); } }
    // 테두리: 누르면 적용, 같은 걸 한 번 더 누르면 해제('없음' 버튼 없이 토글)
    function setBorder(b) {
      if (!editSettings) return;
      const ls = activeLayoutSettings();
      const next = (b !== 'none' && ls.border === b) ? 'none' : b;
      ls.border = next;
      activateChip('border', next);   // 'none'은 어떤 칩과도 안 맞아 전부 비활성 표시
      scheduleLivePreview();
    }
    // 📏 여백 사방 동일(링크) — 켜면 한 칸 입력이 상·하·좌·우 전체에 복사된다
    let _mgLinked = localStorage.getItem('mgLinked') === '1';
    function toggleMgLink(force) {
      _mgLinked = force !== undefined ? !!force : !_mgLinked;
      try { localStorage.setItem('mgLinked', _mgLinked ? '1' : '0'); } catch (e) {}
      const btn = document.getElementById('esMgLink');
      if (btn) btn.classList.toggle('active', _mgLinked);
      if (_mgLinked && force === undefined) mgSetAll(document.getElementById('esMgTop')?.value);   // 켜는 순간 '상' 값으로 통일
    }
    function mgSetAll(v) {
      const val = Math.max(0, parseFloat(v) || 0);
      ['esMgTop', 'esMgBottom', 'esMgLeft', 'esMgRight'].forEach(id => {
        const el = document.getElementById(id);
        if (el && el.value !== String(val)) el.value = val;
      });
      if (editSettings) {
        const m = activeLayoutSettings().margins;
        m.top = m.bottom = m.left = m.right = val;
      }
      scheduleLivePreview();
    }
    function setWmMode(m) { if (editSettings) { activeLayoutSettings().wm.mode = m; activateChip('wmmode', m); scheduleLivePreview(); } }

    // ── 기울기 보정 / 가운데 정렬 / 제본여백 ──────────────────────────────────
    // 구버전 프리셋·챕터 설정에는 새 필드가 없을 수 있어 접근 시 기본값을 채워 준다.
    function ensureAdjustFields(ls) {
      const def = newEditSettings();
      if (!ls.deskew) ls.deskew = def.deskew;
      if (!ls.center) ls.center = def.center;
      if (!ls.bind)   ls.bind   = def.bind;
      return ls;
    }
    function setDeskewMode(m) {
      if (!editSettings) return;
      ensureAdjustFields(activeLayoutSettings()).deskew.mode = m;
      activateChip('dkmode', m);
      document.getElementById('esDkManualRow').style.display = (m === 'manual') ? 'flex' : 'none';
      scheduleLivePreview();
    }
    function setCenterMode(m) { if (editSettings) { ensureAdjustFields(activeLayoutSettings()).center.mode = m; activateChip('ctmode', m); scheduleLivePreview(); } }
    function setCenterAxis(a) { if (editSettings) { ensureAdjustFields(activeLayoutSettings()).center.axis = a; activateChip('ctaxis', a); scheduleLivePreview(); } }
    function setBindSide(s)   { if (editSettings) { ensureAdjustFields(activeLayoutSettings()).bind.side = s; activateChip('bindside', s); scheduleLivePreview(); } }
    function setBindMethod(m) { if (editSettings) { ensureAdjustFields(activeLayoutSettings()).bind.method = m; activateChip('bindmethod', m); scheduleLivePreview(); } }
    // ── 페이지별 개별 보정 (자동 기울기·정렬 위에 페이지 단위 가감) ──────────
    // 저장소는 전역 editSettings.pageAdjust — { 페이지키: {skip, rot(°,+시계), dx(mm,+오른쪽), dy(mm,+아래)} }.
    // 키는 원본 페이지 기준(adjKeyOf)이라 순서 변경에도 따라간다. 프리셋에는 저장하지 않는다(문서 종속).
    function adjKeyOf(r) { return r.isBlank ? 'b' + r.pageNum : 'o' + r.originalIdx; }
    function pageAdjustMap() {
      if (!editSettings) return null;
      if (!editSettings.pageAdjust) editSettings.pageAdjust = {};
      return editSettings.pageAdjust;
    }
    function paTarget() {
      const valid = pageResults.filter(Boolean);
      const el = document.getElementById('paPage');
      let n = parseInt(el && el.value, 10) || 1;
      n = Math.max(1, Math.min(valid.length || 1, n));
      if (el && el.value !== String(n) && document.activeElement !== el) el.value = n;
      return { r: valid[n - 1] || null, n, valid };
    }
    function updatePaList() {
      const el = document.getElementById('paList');
      if (!el) return;
      const map = (editSettings && editSettings.pageAdjust) || {};
      const valid = pageResults.filter(Boolean);
      const nums = [];
      valid.forEach((r, i) => { if (map[adjKeyOf(r)]) nums.push(i + 1); });
      el.textContent = nums.length ? `개별 보정 지정: ${nums.join(', ')}쪽` : '';
    }
    function syncPaUI() {
      const st = document.getElementById('paState');
      if (!editSettings || !pageResults.filter(Boolean).length) {
        if (st) st.textContent = '';
        updatePaList();
        return;
      }
      const { r } = paTarget();
      const o = (r && editSettings.pageAdjust && editSettings.pageAdjust[adjKeyOf(r)]) || null;
      document.getElementById('paSkip').checked = !!(o && o.skip);
      document.getElementById('paRot').value = o ? (o.rot || 0) : 0;
      document.getElementById('paDx').value  = o ? (o.dx  || 0) : 0;
      document.getElementById('paDy').value  = o ? (o.dy  || 0) : 0;
      if (st) st.textContent = o ? '● 지정됨' : '기본';
      updatePaList();
    }
    function paApplyInput() {
      if (!editSettings) return;
      const { r } = paTarget();
      if (!r) return;
      const map = pageAdjustMap();
      const key = adjKeyOf(r);
      const rec = {
        skip: !!document.getElementById('paSkip').checked,
        rot: Math.max(-45, Math.min(45, parseFloat(document.getElementById('paRot').value) || 0)),
        dx:  Math.max(-200, Math.min(200, parseFloat(document.getElementById('paDx').value) || 0)),
        dy:  Math.max(-200, Math.min(200, parseFloat(document.getElementById('paDy').value) || 0)),
      };
      if (!rec.skip && !rec.rot && !rec.dx && !rec.dy) delete map[key];
      else map[key] = rec;
      const st = document.getElementById('paState');
      if (st) st.textContent = map[key] ? '● 지정됨' : '기본';
      updatePaList();
      updateEsGroupBadges();
      scheduleLivePreview();
    }
    function paGoto(d) {
      const { n, valid } = paTarget();
      const el = document.getElementById('paPage');
      if (el) el.value = Math.max(1, Math.min(valid.length || 1, n + d));
      syncPaUI();
    }
    function paResetPage() {
      if (!editSettings || !editSettings.pageAdjust) return;
      const { r } = paTarget();
      if (r) delete editSettings.pageAdjust[adjKeyOf(r)];
      syncPaUI(); updateEsGroupBadges(); scheduleLivePreview();
    }
    function paResetAll() {
      if (!editSettings) return;
      editSettings.pageAdjust = {};
      syncPaUI(); updateEsGroupBadges(); scheduleLivePreview();
    }
    // 우클릭 메뉴 → 이 페이지를 개별 보정 대상으로 열기.
    // 편집 모드 밖(분석 썸네일 우클릭)이면 먼저 편집 작업공간으로 진입한다.
    function ctxPageAdjust() {
      hideCtxMenu();
      if (ctxTargetIdx < 0 || !pageResults[ctxTargetIdx]) return;
      const r = pageResults[ctxTargetIdx];
      const n = pageResults.filter(Boolean).indexOf(r) + 1;
      if (n <= 0) return;
      if (!document.body.classList.contains('edit-fullscreen')) enterEditWorkspace();
      toggleEsGroup('page', true);   // 📄 페이지 보정 그룹 펼침
      const el = document.getElementById('paPage');
      if (el) el.value = n;
      syncPaUI();
      const sec = document.getElementById('secPageAdjust');
      if (sec) {
        sec.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // 어디로 갔는지 눈에 띄게 잠깐 강조
        sec.style.transition = 'background 0.4s';
        sec.style.background = 'rgba(255,214,10,0.12)';
        setTimeout(() => { sec.style.background = ''; }, 1200);
      }
      const rot = document.getElementById('paRot');
      if (rot) rot.focus();
    }

    // 📖 펼침 보기 — 실제 책 펼침 모양 (1쪽 오른쪽 단독, 이후 짝|홀 맞붙임).
    // 적용 전(분석 썸네일)·적용 후(결과 미리보기) 양쪽에 적용. 펼침은 페이지가 크게
    // 보이므로 결과 미리보기는 고해상도로 다시 렌더한다(화질).
    function toggleSpreadView(force) {
      const pg = document.getElementById('previewGrid');
      const ag = document.getElementById('pagesGrid');
      const on = force !== undefined ? !!force : !(pg && pg.classList.contains('pv-spread'));
      [pg, ag].forEach(g => { if (g) g.classList.toggle('pv-spread', on); });
      markSpreadFirst();
      ['spreadViewBtn', 'spreadViewBtn2'].forEach(id => {
        const b = document.getElementById(id);
        if (b) b.classList.toggle('active', on);
      });
      _syncSpreadZoomWidget(on);
      // 결과 미리보기가 떠 있으면 펼침 해상도로 재렌더 (표본 모드는 라이브 경로가 재렌더)
      if (typeof previewVisible === 'function' && previewVisible()) {
        if (pg && pg.dataset.wsSample === '1') { if (typeof scheduleLivePreview === 'function') scheduleLivePreview(); }
        else if (typeof processedPdfBytes !== 'undefined' && processedPdfBytes) renderProcessedPreview(processedPdfBytes);
      }
    }
    // 📖 펼침 크기 조절 — 줌 위젯(−/%/+ · Ctrl+[ ])이 펼침 모드에서는 이 값을 조절한다.
    // 50~200%, 10% 단계. 확대 시 흐려지지 않게 결과 미리보기를 새 해상도로 재렌더(디바운스).
    let _spreadZoomPct = 100;
    let _spreadRerenderTimer = null;
    function changeSpreadZoom(dir) {
      _spreadZoomPct = Math.max(50, Math.min(200, _spreadZoomPct + dir * 10));
      applySpreadZoom();
    }
    function applySpreadZoom() {
      const k = _spreadZoomPct / 100;
      const pg = document.getElementById('previewGrid');
      const ag = document.getElementById('pagesGrid');
      if (pg) pg.style.setProperty('--spread-w', Math.round(560 * k) + 'px');
      if (ag) ag.style.setProperty('--spread-w', Math.round(480 * k) + 'px');
      const pctEl = document.getElementById('zoomPct');
      if (pctEl) pctEl.textContent = _spreadZoomPct + '%';
      const zo = document.getElementById('zoomOutBtn'), zi = document.getElementById('zoomInBtn');
      if (zo) zo.disabled = _spreadZoomPct <= 50;
      if (zi) zi.disabled = _spreadZoomPct >= 200;
      clearTimeout(_spreadRerenderTimer);
      _spreadRerenderTimer = setTimeout(() => {
        if (typeof previewVisible === 'function' && previewVisible()) {
          if (pg && pg.dataset.wsSample === '1') { if (typeof scheduleLivePreview === 'function') scheduleLivePreview(); }
          else if (typeof processedPdfBytes !== 'undefined' && processedPdfBytes) renderProcessedPreview(processedPdfBytes);
        }
      }, 300);
    }
    // 펼침 토글 ↔ 줌 위젯 연동: 켜면 위젯을 띄워 펼침 %를 표시, 끄면 썸네일 % 표시로 복원
    function _syncSpreadZoomWidget(on) {
      if (on) {
        if (typeof setThumbZoomWidgetVisible === 'function') setThumbZoomWidgetVisible(true);
        applySpreadZoom();
        return;
      }
      const pctEl = document.getElementById('zoomPct');
      if (pctEl && typeof thumbStepIdx !== 'undefined') pctEl.textContent = (50 + thumbStepIdx * 10) + '%';
      const zo = document.getElementById('zoomOutBtn'), zi = document.getElementById('zoomInBtn');
      if (zo && typeof thumbStepIdx !== 'undefined') zo.disabled = thumbStepIdx === 0;
      if (zi && typeof THUMB_STEPS !== 'undefined') zi.disabled = thumbStepIdx === THUMB_STEPS.length - 1;
      // 편집 모드가 아니면 위젯은 원래 숨김 상태로 복귀
      if (!document.body.classList.contains('edit-fullscreen') && typeof setThumbZoomWidgetVisible === 'function')
        setThumbZoomWidgetVisible(false);
    }
    // 분석 그리드 펼침 표식 — 첫 페이지(오른쪽 단독) + 각 카드의 좌/우 면(sp-left/sp-right).
    // 챕터 구분선이 전폭 행을 차지해 CSS 순서만으로는 열을 판정할 수 없어, 그리드
    // 자동 배치를 그대로 시뮬레이션하며 클래스를 붙인다(구분선을 만나면 다음은 왼쪽부터).
    function markSpreadFirst() {
      const ag = document.getElementById('pagesGrid');
      if (!ag) return;
      ag.querySelectorAll('.page-item.spread-first, .page-item.sp-left, .page-item.sp-right')
        .forEach(el => el.classList.remove('spread-first', 'sp-left', 'sp-right'));
      if (!ag.classList.contains('pv-spread')) return;
      let col = 1, first = true;
      for (const el of ag.children) {
        if (el.classList.contains('chapter-divider')) { col = 1; continue; }   // 전폭 행 → 다음은 왼쪽부터
        if (!el.classList.contains('page-item')) continue;
        if (first) { el.classList.add('spread-first', 'sp-right'); first = false; col = 1; continue; }
        if (col === 1) { el.classList.add('sp-left'); col = 2; }
        else { el.classList.add('sp-right'); col = 1; }
      }
    }
    // 펼침 보기는 항상 꺼진 상태로 시작 — 필요할 때만 켜는 확인용 보기(기본 꺼짐).
    try { localStorage.removeItem('spreadView'); } catch (e) {}   // 과거 저장값 정리

    // ✚ 십자 가이드선 — 미리보기 각 페이지 위에 수평·수직 중앙선 오버레이 (탭 공통 화면 옵션)
    function togglePreviewGuide(on) {
      const grid = document.getElementById('previewGrid');
      if (grid) grid.classList.toggle('pv-guides', !!on);
    }

    // ── 기하 옵션 오버레이 선반영 (편집 모드 전용) ──────────────────────────
    // 여백(노란 점선 박스)·제본여백(빗금 띠)을 PDF 재조립을 기다리지 않고 미리보기 위에
    // 즉시 그린다 — 슬라이더가 "붙어서" 움직이는 체감. 실제 재조립은 디바운스로 뒤따라온다.
    // 셀의 dataset.pw/ph(페이지 pt 크기)로 mm→% 환산. 표본 모드의 회색(pv-stale) 셀은 제외.
    function updateGeometryOverlays() {
      const grid = document.getElementById('previewGrid');
      if (!grid) return;
      const ws = document.body.classList.contains('edit-fullscreen');
      const cells = grid.querySelectorAll('.pv-cell');
      const ls = (ws && editSettings) ? ensureAdjustFields(activeLayoutSettings()) : null;
      const mg = ls && ls.margins && ls.margins.enabled ? ls.margins : null;
      const bind = ls && ls.bind && ls.bind.enabled && (ls.bind.size || 0) > 0 ? ls.bind : null;
      cells.forEach((cell, i) => {
        const old = cell.querySelector('.pv-geo');
        if (!mg && !bind) { if (old) old.remove(); return; }
        if (cell.classList.contains('pv-stale')) { if (old) old.remove(); return; }
        const pw = parseFloat(cell.dataset.pw), ph = parseFloat(cell.dataset.ph);
        if (!(pw > 0 && ph > 0)) { if (old) old.remove(); return; }
        const mmW = pw / PT_PER_MM_UI, mmH = ph / PT_PER_MM_UI;
        let html = '';
        if (mg) {
          const l = Math.min(45, (mg.left || 0) / mmW * 100), r = Math.min(45, (mg.right || 0) / mmW * 100);
          const t = Math.min(45, (mg.top || 0) / mmH * 100), b = Math.min(45, (mg.bottom || 0) / mmH * 100);
          html += `<div class="pv-geo-margin" style="left:${l}%;right:${r}%;top:${t}%;bottom:${b}%;"></div>`;
        }
        if (bind) {
          // 출력 페이지 번호(셀 순서+1) 홀짝으로 제본쪽 교대 — 워커 bindSideFor와 동일 규칙
          let side = bind.side || 'left';
          if (bind.alt !== false && (i + 1) % 2 === 0) {
            side = side === 'left' ? 'right' : side === 'right' ? 'left' : side === 'top' ? 'bottom' : 'top';
          }
          const pct = Math.min(48, (side === 'left' || side === 'right')
            ? (bind.size || 0) / mmW * 100 : (bind.size || 0) / mmH * 100);
          const pos = side === 'left' ? `left:0;top:0;bottom:0;width:${pct}%`
                   : side === 'right' ? `right:0;top:0;bottom:0;width:${pct}%`
                   : side === 'top' ? `top:0;left:0;right:0;height:${pct}%`
                   : `bottom:0;left:0;right:0;height:${pct}%`;
          html += `<div class="pv-geo-bind" style="${pos}"></div>`;
        }
        let geo = old;
        if (!geo) { geo = document.createElement('div'); geo.className = 'pv-geo'; cell.appendChild(geo); }
        if (geo.innerHTML !== html) geo.innerHTML = html;
      });
    }
    const PT_PER_MM_UI = 72 / 25.4;

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
        gutter: def.gutter, border: def.border, deskew: def.deskew, center: def.center, bind: def.bind,
        hf: def.hf, wm: def.wm,
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
      const pctEl = document.getElementById('esScalePercent'); if (pctEl) pctEl.value = ls.scaling.percent || 100;
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
      // 기울기 보정 / 가운데 정렬 / 제본여백
      ensureAdjustFields(ls);
      document.getElementById('esDkEnabled').checked = !!ls.deskew.enabled;
      document.getElementById('esDkBody').classList.toggle('show', !!ls.deskew.enabled);
      activateChip('dkmode', ls.deskew.mode);
      document.getElementById('esDkManualRow').style.display = (ls.deskew.mode === 'manual') ? 'flex' : 'none';
      document.getElementById('esDkAngle').value = ls.deskew.angle;
      document.getElementById('esDkAngleSlider').value = ls.deskew.angle;
      document.getElementById('esCtEnabled').checked = !!ls.center.enabled;
      document.getElementById('esCtBody').classList.toggle('show', !!ls.center.enabled);
      activateChip('ctmode', ls.center.mode);
      activateChip('ctaxis', ls.center.axis);
      document.getElementById('esCtIgnore').value = ls.center.ignore;
      document.getElementById('esBindEnabled').checked = !!ls.bind.enabled;
      document.getElementById('esBindBody').classList.toggle('show', !!ls.bind.enabled);
      document.getElementById('esBindSize').value = ls.bind.size;
      activateChip('bindside', ls.bind.side);
      activateChip('bindmethod', ls.bind.method);
      document.getElementById('esBindAlt').checked = ls.bind.alt !== false;
      syncPaUI();   // 페이지별 개별 보정 (전역 editSettings.pageAdjust — 포커스와 무관)
      // 폰트 출력 안전화 방식 칩 (localStorage 전역 — es와 무관, 부트 복원 겸용)
      if (typeof _outlineMode !== 'undefined') activateChip('olmode', _outlineMode);
      // 머리글/바닥글
      document.getElementById('esHfEnabled').checked = ls.hf.enabled;
      document.getElementById('esHfBody').classList.toggle('show', ls.hf.enabled);
      activateChip('hftarget', _hfTarget);
      syncHfGridInputs();      // 6칸 그리드 = 현재 입력 대상(공통/홀수쪽/짝수쪽)의 값
      updateHfTargetMarks();
      document.getElementById('esHfSize').value = ls.hf.size;
      document.getElementById('esHfColor').value = ls.hf.color;
      document.getElementById('esHfMargin').value = ls.hf.margin;
      setFontSelectValue(ls.hf.font || DEFAULT_HF_FONT);
      document.getElementById('esHfPnumStyle').value = ls.hf.pnumStyle != null ? ls.hf.pnumStyle : 1;
      const hfAltChk = document.getElementById('esHfAlt'); if (hfAltChk) hfAltChk.checked = !!ls.hf.alt;
      const hfStartEl = document.getElementById('esHfStart'); if (hfStartEl) hfStartEl.value = Math.max(1, (ls.hf.start | 0) || 1);
      const hfOffXEl = document.getElementById('esHfOffX'); if (hfOffXEl) hfOffXEl.value = ls.hf.offX || 0;
      const hfOffYEl = document.getElementById('esHfOffY'); if (hfOffYEl) hfOffYEl.value = ls.hf.offY || 0;
      if (typeof updateHfLayerInfo === 'function') updateHfLayerInfo();   // 💾 확정 문구 개수 표시
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
      updateEsGroupBadges();
    }

    // 입력 위젯 → editSettings(또는 챕터별 개별 설정) 바인딩 (1회)
    (function bindEditInputs() {
      const onIn = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('input', () => { fn(el); scheduleLivePreview(); }); };
      onIn('esRangeFrom', el => { if (editSettings) { editSettings.scope.from = parseInt(el.value) || 1; updateScopeInfo(); } });
      onIn('esRangeTo',   el => { if (editSettings) { editSettings.scope.to   = parseInt(el.value) || 1; updateScopeInfo(); } });
      onIn('esCustomW',   el => { if (editSettings) activeLayoutSettings().scaling.customW = parseFloat(el.value) || 0; });
      onIn('esCustomH',   el => { if (editSettings) activeLayoutSettings().scaling.customH = parseFloat(el.value) || 0; });
      onIn('esScalePercent', el => { if (editSettings) activeLayoutSettings().scaling.percent = Math.max(10, Math.min(400, parseFloat(el.value) || 100)); });
      const mg = { esMgTop:'top', esMgBottom:'bottom', esMgLeft:'left', esMgRight:'right' };
      Object.entries(mg).forEach(([id, k]) => onIn(id, el => {
        if (!editSettings) return;
        if (_mgLinked) { mgSetAll(el.value); return; }   // 🔗 사방 동일 — 한 칸 입력이 전체 복사
        activeLayoutSettings().margins[k] = parseFloat(el.value) || 0;
      }));
      toggleMgLink(_mgLinked);   // 부트 시 🔗 버튼 상태 복원
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

      // 기울기 보정 / 가운데 정렬 / 제본여백
      const bindToggleSub = (chkId, bodyId, apply) => {
        const chk = document.getElementById(chkId);
        if (chk) chk.addEventListener('change', () => {
          if (editSettings) apply(ensureAdjustFields(activeLayoutSettings()), chk.checked);
          document.getElementById(bodyId).classList.toggle('show', chk.checked);
          scheduleLivePreview();
        });
      };
      bindToggleSub('esDkEnabled',   'esDkBody',   (ls, on) => {
        ls.deskew.enabled = on;
        // 기울기 보정을 켜면 십자 가이드선도 자동으로 켠다 — 수평 확인이 목적이므로.
        // (끌 때는 그대로 둠 — 다른 보정 확인에 계속 쓸 수 있게 사용자가 직접 끈다)
        if (on) {
          const g = document.getElementById('esGuideChk');
          if (g && !g.checked) { g.checked = true; togglePreviewGuide(true); }
        }
      });
      bindToggleSub('esCtEnabled',   'esCtBody',   (ls, on) => { ls.center.enabled = on; });
      bindToggleSub('esBindEnabled', 'esBindBody', (ls, on) => { ls.bind.enabled = on; });
      // 수동 각도: 슬라이더 ↔ 숫자 입력 동기
      const dkNum = document.getElementById('esDkAngle'), dkSl = document.getElementById('esDkAngleSlider');
      const setDkAngle = v => {
        const a = Math.max(-15, Math.min(15, parseFloat(v) || 0));
        if (editSettings) ensureAdjustFields(activeLayoutSettings()).deskew.angle = a;
        if (dkNum && dkNum.value !== String(a)) dkNum.value = a;
        if (dkSl && dkSl.value !== String(a)) dkSl.value = a;
        scheduleLivePreview();
      };
      if (dkNum) dkNum.addEventListener('input', () => setDkAngle(dkNum.value));
      if (dkSl)  dkSl.addEventListener('input', () => setDkAngle(dkSl.value));
      onIn('esCtIgnore', el => { if (editSettings) ensureAdjustFields(activeLayoutSettings()).center.ignore = Math.max(0, Math.min(20, parseFloat(el.value) || 0)); });
      onIn('esBindSize', el => { if (editSettings) ensureAdjustFields(activeLayoutSettings()).bind.size = Math.max(0, parseFloat(el.value) || 0); });
      const bindAlt = document.getElementById('esBindAlt');
      if (bindAlt) bindAlt.addEventListener('change', () => { if (editSettings) ensureAdjustFields(activeLayoutSettings()).bind.alt = bindAlt.checked; scheduleLivePreview(); });

      // 머리글/바닥글
      const hfToggle = document.getElementById('esHfEnabled');
      if (hfToggle) hfToggle.addEventListener('change', () => {
        if (editSettings) activeLayoutSettings().hf.enabled = hfToggle.checked;
        document.getElementById('esHfBody').classList.toggle('show', hfToggle.checked);
        scheduleLivePreview();
      });
      // 6칸 그리드는 현재 입력 대상(_hfTarget: 공통/홀수쪽/짝수쪽)의 필드에 기록
      const hfMap = { esHfHL:'hL', esHfHC:'hC', esHfHR:'hR', esHfFL:'fL', esHfFC:'fC', esHfFR:'fR' };
      Object.entries(hfMap).forEach(([id, k]) => onIn(id, el => {
        if (editSettings) activeLayoutSettings().hf[hfKeyFor(k)] = el.value;
        updateHfTargetMarks();
      }));
      onIn('esHfSize',   el => { if (editSettings) activeLayoutSettings().hf.size = Math.max(5, parseFloat(el.value) || 9); });
      onIn('esHfMargin', el => { if (editSettings) activeLayoutSettings().hf.margin = Math.max(0, parseFloat(el.value) || 0); });
      const hfColor = document.getElementById('esHfColor');
      if (hfColor) hfColor.addEventListener('input', () => { if (editSettings) activeLayoutSettings().hf.color = hfColor.value; scheduleLivePreview(); });
      const pnSel = document.getElementById('esHfPnumStyle');
      if (pnSel) pnSel.addEventListener('change', () => { if (editSettings) activeLayoutSettings().hf.pnumStyle = parseInt(pnSel.value) || 0; scheduleLivePreview(); });
      const hfAlt = document.getElementById('esHfAlt');
      if (hfAlt) hfAlt.addEventListener('change', () => { if (editSettings) activeLayoutSettings().hf.alt = hfAlt.checked; scheduleLivePreview(); });
      onIn('esHfStart', el => { if (editSettings) activeLayoutSettings().hf.start = Math.max(1, parseInt(el.value) || 1); });
      onIn('esHfOffX', el => { if (editSettings) activeLayoutSettings().hf.offX = parseFloat(el.value) || 0; });
      onIn('esHfOffY', el => { if (editSettings) activeLayoutSettings().hf.offY = parseFloat(el.value) || 0; });
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
    // 페이지번호 토큰 {n}을 마지막 포커스된 머리글/바닥글 칸에 삽입.
    // 포커스한 칸이 없으면: 홀짝 좌우 교대가 켜져 있으면 바닥글 오른쪽(홀수쪽 기준 책 바깥쪽,
    // 짝수쪽은 교대로 왼쪽에 인쇄됨), 아니면 바닥글 중앙이 기본.
    let _lastHfField = null;
    function hfDefaultNumField() {
      const ls = editSettings && activeLayoutSettings();
      return (ls && ls.hf && ls.hf.alt) ? 'fR' : 'fC';
    }
    function insertPageNumberToken() {
      const id = _lastHfField || (hfDefaultNumField() === 'fR' ? 'esHfFR' : 'esHfFC');
      const el = document.getElementById(id);
      if (!el || !editSettings) return;
      const key = { esHfHL:'hL', esHfHC:'hC', esHfHR:'hR', esHfFL:'fL', esHfFC:'fC', esHfFR:'fR' }[id];
      const pos = (el.selectionStart != null) ? el.selectionStart : el.value.length;
      el.value = el.value.slice(0, pos) + '{n}' + el.value.slice(pos);
      const ls = activeLayoutSettings();
      ls.hf[hfKeyFor(key)] = el.value;   // 현재 입력 대상(공통/홀수쪽/짝수쪽)의 칸에 기록
      updateHfTargetMarks();
      if (!ls.hf.enabled) { ls.hf.enabled = true; document.getElementById('esHfEnabled').checked = true; document.getElementById('esHfBody').classList.add('show'); }
      el.focus();
      scheduleLivePreview();
    }

    // ── 머리글/바닥글 홀·짝 입력 대상 ────────────────────────────────────────
    // 한 그리드(esHfHL~esHfFR)를 [공통/홀수쪽/짝수쪽] 칩으로 전환하며 편집한다.
    // 전용 칸(o*/e*)에 값이 있으면 그쪽 페이지는 전용 칸으로, 없으면 공통으로 인쇄(워커 폴백).
    let _hfTarget = 'common';
    const HF_BASE_KEYS = ['hL', 'hC', 'hR', 'fL', 'fC', 'fR'];
    function hfKeyFor(k, target) {
      const t = target || _hfTarget;
      return t === 'common' ? k : (t === 'odd' ? 'o' : 'e') + k.charAt(0).toUpperCase() + k.slice(1);
    }
    // 공통·홀·짝 어느 세트든 내용이 있는지 (자동 켜기 판단용)
    function hfAnyContent(hf) {
      if (hf.layers && hf.layers.length) return true;   // 확정(누적) 문구가 있으면 활성
      return ['common', 'odd', 'even'].some(t => HF_BASE_KEYS.some(k => { const v = hf[hfKeyFor(k, t)]; return v && v.trim(); }));
    }
    // ── 💾 문구 확정(누적) — 현재 입력을 레이어로 굳히고 입력칸을 비워 다음 문구를 받는다.
    // 확정된 레이어들은 각자의 스타일(크기·색·글꼴·위치·교대·번호시작)대로 전부 겹쳐 인쇄된다.
    const HF_LAYER_FIELDS = ['hL', 'hC', 'hR', 'fL', 'fC', 'fR',
      'oHL', 'oHC', 'oHR', 'oFL', 'oFC', 'oFR', 'eHL', 'eHC', 'eHR', 'eFL', 'eFC', 'eFR'];
    const HF_LAYER_STYLE = ['size', 'color', 'margin', 'font', 'pnumStyle', 'alt', 'start', 'offX', 'offY'];
    function commitHfLayer() {
      if (!editSettings) return;
      const hf = activeLayoutSettings().hf;
      if (!HF_LAYER_FIELDS.some(k => hf[k] && String(hf[k]).trim())) {
        showError('확정할 문구가 없습니다 — 먼저 머리글/바닥글 칸에 내용을 입력하세요.');
        return;
      }
      if (!hf.layers) hf.layers = [];
      const snap = {};
      HF_LAYER_STYLE.forEach(k => { snap[k] = hf[k]; });
      HF_LAYER_FIELDS.forEach(k => { snap[k] = hf[k] || ''; hf[k] = ''; });   // 스냅샷 후 입력칸 비움
      hf.layers.push(snap);
      hf.enabled = true;
      syncEditUI();
      updateHfLayerInfo();
      scheduleLivePreview();
      showSuccess(`💾 문구 ${hf.layers.length}차 확정 — 입력칸을 비웠습니다. 다음 문구를 입력해 겹쳐 넣으세요.\n확정된 문구는 전부 함께 인쇄되며, '✔ 적용'/'⇩ 다운로드'에 포함됩니다.`);
    }
    function undoHfLayer() {
      if (!editSettings) return;
      const hf = activeLayoutSettings().hf;
      if (!hf.layers || !hf.layers.length) { showError('되돌릴 확정 문구가 없습니다.'); return; }
      if (HF_LAYER_FIELDS.some(k => hf[k] && String(hf[k]).trim())
        && !confirm('현재 입력 중인 문구를 버리고 마지막 확정 문구를 입력칸으로 되돌릴까요?')) return;
      const snap = hf.layers.pop();
      Object.keys(snap).forEach(k => { hf[k] = snap[k]; });
      syncEditUI();
      updateHfLayerInfo();
      scheduleLivePreview();
      showSuccess(`↩ ${hf.layers.length + 1}차 확정 문구를 입력칸으로 되돌렸습니다 — 수정 후 다시 확정하세요.`);
    }
    function updateHfLayerInfo() {
      const el = document.getElementById('hfLayerInfo');
      if (!el) return;
      const ls = editSettings && activeLayoutSettings();
      const n = (ls && ls.hf && ls.hf.layers) ? ls.hf.layers.length : 0;
      el.style.display = n ? '' : 'none';
      el.textContent = n ? `💾 확정된 문구 ${n}개가 함께 인쇄됩니다 — 마지막 확정을 고치려면 '↩ 확정 취소'` : '';
    }
    function syncHfGridInputs() {
      if (!editSettings) return;
      const ls = activeLayoutSettings();
      const ids = { esHfHL: 'hL', esHfHC: 'hC', esHfHR: 'hR', esHfFL: 'fL', esHfFC: 'fC', esHfFR: 'fR' };
      Object.entries(ids).forEach(([id, k]) => { const el = document.getElementById(id); if (el) el.value = ls.hf[hfKeyFor(k)] || ''; });
    }
    // 칩에 ● 표시 — 그 대상에 내용이 입력되어 있음을 한눈에
    function updateHfTargetMarks() {
      if (!editSettings) return;
      const hf = activeLayoutSettings().hf;
      const hasSet = t => HF_BASE_KEYS.some(k => { const v = hf[hfKeyFor(k, t)]; return v && v.trim(); });
      document.querySelectorAll('[data-hftarget]').forEach(b => {
        const t = b.dataset.hftarget;
        const label = t === 'common' ? '공통' : t === 'odd' ? '홀수쪽' : '짝수쪽';
        b.textContent = (hasSet(t) ? '● ' : '') + label;
      });
    }
    function setHfTarget(t) {
      _hfTarget = t;
      activateChip('hftarget', t);
      syncHfGridInputs();
      updateHfTargetMarks();
    }

    // ☑ 선택 페이지=1 — 썸네일에서 선택한 첫 페이지를 쪽 번호 1페이지로 지정.
    // 머리글/바닥글이 꺼져 있거나 비어 있으면 바닥글 중앙 {n}으로 켜서 실제로 번호가 인쇄되게 한다.
    function setHfStartFromSelection() {
      if (!editSettings) return;
      const sel = [...selectedPages].sort((a, b) => a - b);
      if (!sel.length) { showError('먼저 썸네일에서 1페이지가 될 페이지를 선택하세요.'); return; }
      const ls = activeLayoutSettings();
      ls.hf.start = sel[0];
      if (!ls.hf.enabled || !hfAnyContent(ls.hf)) {
        ls.hf.enabled = true;
        { const nk = ls.hf.alt ? 'fR' : 'fC'; if (!ls.hf[nk] || !ls.hf[nk].trim()) ls.hf[nk] = '{n}'; }   // 교대 시 책 바깥쪽
      }
      syncEditUI();
      showSuccess(`${sel[0]}페이지가 1페이지로 지정되었습니다 — 앞 ${sel[0] - 1}쪽은 번호 생략.\n'💾 저장하고 닫기' 또는 '✔ 적용'으로 반영됩니다.`);
      scheduleLivePreview();
    }

    // 레이아웃 변환이 필요한 설정이 하나라도 있는지
    function hasActiveLayout(es) {
      return !!es && (
        es.scaling.mode !== 'none' || (es.nUp | 0) > 1 || es.border !== 'none' ||
        (es.deskew && es.deskew.enabled) ||
        (es.center && es.center.enabled) ||
        (es.pageAdjust && Object.keys(es.pageAdjust).length > 0) ||
        (es.bind && es.bind.enabled) ||
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
          editSettings.byChapter[ch] = { scaling: def.scaling, margins: def.margins, nUp: def.nUp, gutter: def.gutter, border: def.border, deskew: def.deskew, center: def.center, bind: def.bind, hf: def.hf, wm: def.wm };
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

    // ── 페이지 보정 측정: 기울기(투영 프로파일) + 콘텐츠 바운딩박스 (base PDF 저해상 렌더) ──
    // 반환: base 페이지 순서 배열 [{skew, cx, cy, pw, ph, hasContent} | null]
    //   skew: 감지된 기울기 보정각(도, pdf-lib 반시계+) — 이 값만큼 돌리면 수평이 된다
    //   cx/cy: 콘텐츠 bbox 중심(pt, PDF 좌표 y-위쪽+), pw/ph: 페이지 크기(pt, 뷰어 방향)
    // 같은 base(sig)면 캐시 재사용, 이미 잰 페이지는 다시 재지 않는다.
    let _measureCache = { key: null, data: [] };
    function _analyzeRenderedPage(img, W, H, scale, ignorePct) {
      const d = img.data;
      const igX = Math.round(W * (ignorePct || 0) / 100), igY = Math.round(H * (ignorePct || 0) / 100);
      // 1) 콘텐츠 bbox — 비백색(luma<247) 픽셀 범위 (가장자리 ignorePct% 무시: 스캔 테두리·페이지번호 잡음 배제)
      let minX = W, maxX = -1, minY = H, maxY = -1;
      // 2) 기울기 감지용 어두운 픽셀 표본 (텍스트·괘선 위주 luma<160)
      const xs = [], ys = [];
      for (let y = igY; y < H - igY; y++) {
        const row = y * W * 4;
        for (let x = igX; x < W - igX; x++) {
          const i = row + x * 4;
          const a = d[i + 3];
          if (a < 8) continue; // 투명 = 배경
          const lum = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
          if (lum < 247) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (lum < 160 && ((x + y) & 1) === 0) { xs.push(x); ys.push(y); }
          }
        }
      }
      const hasContent = maxX >= 0;
      // 기울기: 각도 θ로 사영(y − x·tanθ)한 행 히스토그램의 제곱합이 최대가 되는 θ
      // (텍스트 줄이 수평으로 정렬될수록 히스토그램이 뾰족해짐). 표본이 적으면 0.
      let skew = 0;
      if (xs.length > 300) {
        const n = Math.min(xs.length, 24000);
        const step = Math.max(1, (xs.length / n) | 0);
        const score = deg => {
          const t = Math.tan(deg * Math.PI / 180);
          const off = W; // y − x·tanθ 가 음수가 되지 않게 여유
          const bins = new Float64Array(H + 2 * W);
          for (let k = 0; k < xs.length; k += step) {
            const b = (ys[k] - xs[k] * t + off) | 0;
            if (b >= 0 && b < bins.length) bins[b]++;
          }
          let s = 0;
          for (let k = 0; k < bins.length; k++) s += bins[k] * bins[k];
          return s;
        };
        let best = 0, bestS = -1;
        for (let a = -5; a <= 5.001; a += 0.25) { const s = score(a); if (s > bestS) { bestS = s; best = a; } }
        for (let a = best - 0.2; a <= best + 0.201; a += 0.05) { const s = score(a); if (s > bestS) { bestS = s; best = a; } }
        // 캔버스는 y가 아래로 증가: 감지각 +θ = 줄이 오른쪽으로 내려감(PDF 기준 시계방향 기움)
        // → PDF 반시계(+)로 +θ 돌리면 수평. 0에 가까운 잡음(<0.05°)은 무시.
        skew = Math.abs(best) < 0.05 ? 0 : Math.round(best * 100) / 100;
      }
      return {
        skew,
        hasContent,
        cx: hasContent ? (minX + maxX + 1) / 2 / scale : W / 2 / scale,
        cy: hasContent ? (H - (minY + maxY + 1) / 2) / scale : H / 2 / scale,
        pw: W / scale, ph: H / scale,
      };
    }
    async function measurePageAdjust(srcBytes, needMask, baseSig, ignorePct) {
      const key = (baseSig || bytesFingerprint(srcBytes)) + '::' + (ignorePct || 0);
      if (_measureCache.key !== key) _measureCache = { key, data: [] };
      const data = _measureCache.data;
      const missing = [];
      for (let i = 0; i < needMask.length; i++) if (needMask[i] && !data[i]) missing.push(i);
      if (!missing.length) return data;
      const pdf = await pdfjsLib.getDocument({ data: srcBytes.slice(0) }).promise;
      try {
        for (const i of missing) {
          if (i >= pdf.numPages) continue;
          const page = await pdf.getPage(i + 1);
          const vp1 = page.getViewport({ scale: 1 });
          const scale = Math.min(1.5, 640 / Math.max(vp1.width, vp1.height));
          const vp = page.getViewport({ scale });
          const c = document.createElement('canvas');
          c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); // 배경 없는 페이지 대비
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          data[i] = _analyzeRenderedPage(ctx.getImageData(0, 0, c.width, c.height), c.width, c.height, scale, ignorePct);
          page.cleanup();
        }
      } finally { try { await pdf.destroy(); } catch (e) {} }
      return data;
    }
    // groups의 기울기·정렬 설정 → 워커에 넘길 페이지별 최종 보정 배열 [{rot,dx,dy}|null]
    // winFrom: 표본 창(문서 일부 조립)이면 창 시작의 문서 절대 인덱스 — 개별 보정 키 매칭용
    async function computeAdjustArray(srcBytes, groups, baseSig, winFrom) {
      const needsAdj = g => (g.es.deskew && g.es.deskew.enabled) || (g.es.center && g.es.center.enabled);
      const needsMeasure = g => (g.es.deskew && g.es.deskew.enabled && g.es.deskew.mode !== 'manual')
                             || (g.es.center && g.es.center.enabled);
      const N = groups[0].mask.length;
      // 페이지별 개별 보정 — 문서 순서 기준 전역(editSettings.pageAdjust), 그룹과 무관하게 적용
      const off = winFrom | 0;
      const pa = (editSettings && editSettings.pageAdjust) || {};
      const validAll = pageResults.filter(Boolean);
      const ovOf = i => {
        const r = validAll[off + i];
        if (!r) return null;
        const o = pa[adjKeyOf(r)];
        return (o && (o.skip || o.rot || o.dx || o.dy)) ? o : null;
      };
      let anyOv = false;
      for (let i = 0; i < N && !anyOv; i++) if (ovOf(i)) anyOv = true;
      if (!groups.some(needsAdj) && !anyOv) return null;
      const adjust = new Array(N).fill(null);
      let meas = null;
      if (groups.some(needsMeasure)) {
        const needMask = new Array(N).fill(false);
        groups.forEach(g => { if (needsMeasure(g)) g.mask.forEach((v, i) => { if (v) needMask[i] = true; }); });
        const ignorePct = Math.max(2, ...groups.filter(g => g.es.center && g.es.center.enabled)
          .map(g => parseFloat(g.es.center.ignore) || 0));
        meas = await measurePageAdjust(srcBytes, needMask, baseSig, ignorePct);
      }
      groups.forEach(g => {
        if (!needsAdj(g)) return;
        const dk = g.es.deskew, ce = g.es.center;
        // 일괄(uniform) 정렬: 그룹 내 평균 쏠림으로 모든 페이지를 동일 이동 (조판 문서용)
        let uDx = 0, uDy = 0, uN = 0;
        if (ce && ce.enabled && ce.mode === 'uniform' && meas) {
          g.mask.forEach((v, i) => {
            const m = v && meas[i];
            if (m && m.hasContent) { uDx += m.pw / 2 - m.cx; uDy += m.ph / 2 - m.cy; uN++; }
          });
          if (uN) { uDx /= uN; uDy /= uN; }
        }
        g.mask.forEach((v, i) => {
          if (!v) return;
          const m = meas ? meas[i] : null;
          let rot = 0, dx = 0, dy = 0;
          if (dk && dk.enabled) {
            // 수동 입력은 사용자 기준 '+ = 시계방향' → pdf-lib 반시계(+)로 부호 반전
            rot = dk.mode === 'manual' ? -(parseFloat(dk.angle) || 0) : (m ? m.skew : 0);
          }
          if (ce && ce.enabled) {
            if (ce.mode === 'uniform') { dx = uDx; dy = uDy; }
            else if (m && m.hasContent) { dx = m.pw / 2 - m.cx; dy = m.ph / 2 - m.cy; }
            if (ce.axis === 'h') dy = 0; else if (ce.axis === 'v') dx = 0;
          }
          if (rot || dx || dy) adjust[i] = { rot, dx, dy };
        });
      });
      // 개별 보정 패스 — 자동 보정값 위에 가감. skip이면 그 페이지의 자동값은 버리고 수동값만.
      for (let i = 0; i < N; i++) {
        const o = ovOf(i);
        if (!o) continue;
        const a = (!o.skip && adjust[i]) ? adjust[i] : { rot: 0, dx: 0, dy: 0 };
        a.rot += -(parseFloat(o.rot) || 0);                       // UI '+=시계방향' → pdf-lib 반시계(+)
        a.dx  += (parseFloat(o.dx) || 0) * PT_PER_MM_UI;          // +=오른쪽
        a.dy  += -(parseFloat(o.dy) || 0) * PT_PER_MM_UI;         // UI '+=아래' → PDF y는 위가 +
        adjust[i] = (a.rot || a.dx || a.dy) ? a : null;
      }
      return adjust.some(Boolean) ? adjust : null;
    }

    // ── 로마자 번호 (앞붙이 페이지 — 목차·표지·서문) ─────────────────────────
    function toRoman(n) {
      const map = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
      let s = '';
      for (const [v, r] of map) while (n >= v) { s += r; n -= v; }
      return s;
    }
    // 문서(base) 순서 기준 로마자 배정 — 목차 페이지(isTocPage)와 사용자 지정(isRoman) 페이지에
    // 순서대로 i, ii, iii…를 부여. 해당 페이지는 머리글/바닥글 {n}·{page}가 로마자로 인쇄된다.
    function computeRomanNums() {
      const valid = pageResults.filter(Boolean);
      let k = 0;
      const arr = valid.map(r => (r.isTocPage || r.isRoman) ? toRoman(++k) : null);
      return arr.some(Boolean) ? arr : null;
    }
    // ⅰ 선택 페이지 로마자 — 썸네일 선택 페이지의 로마자 표기를 토글.
    // 번호가 하나도 설정돼 있지 않으면 바닥글 중앙 {n}으로 켜서 실제로 인쇄되게 한다.
    function toggleRomanForSelection() {
      if (!editSettings) return;
      const sel = [...selectedPages];
      if (!sel.length) { showError('먼저 썸네일에서 로마자 번호를 붙일 페이지를 선택하세요.'); return; }
      const targets = pageResults.filter(r => r && sel.includes(r.pageNum) && !r.isTocPage);
      if (!targets.length) { showError('선택 페이지가 모두 목차 페이지입니다 — 목차는 자동으로 로마자가 붙습니다.'); return; }
      const allOn = targets.every(r => r.isRoman);
      targets.forEach(r => { r.isRoman = !allOn; });
      const ls = activeLayoutSettings();
      if (!allOn && (!ls.hf.enabled || !hfAnyContent(ls.hf))) {
        ls.hf.enabled = true;
        { const nk = ls.hf.alt ? 'fR' : 'fC'; if (!ls.hf[nk] || !ls.hf[nk].trim()) ls.hf[nk] = '{n}'; }   // 교대 시 책 바깥쪽
        syncEditUI();
      }
      invalidateProcessed();
      showSuccess(allOn
        ? `${targets.length}개 페이지의 로마자 표기를 해제했습니다.`
        : `${targets.length}개 페이지에 로마자 번호(i, ii…)를 지정했습니다 — 목차·지정 페이지 순서대로 배정됩니다.\n'✔ 적용' 또는 '💾 저장하고 닫기'로 반영됩니다.`);
      scheduleLivePreview();
    }

    // ── 레이아웃 변환 패스: 크기 규격화 + N-up + 테두리 (worker-assemble.js에서 실행) ──
    // srcBytes: 순서·회전·흑백이 이미 반영된 base PDF. groups: [{mask, es}] — 마스크는 base 페이지
    // 순서 기준이며 그룹끼리 겹치지 않는다(챕터별 개별 설정 + 전역 설정 나머지).
    // 폰트 파일 읽기(electronAPI.readFile)는 워커에서 접근 불가한 API라 여기서 미리 읽어 전달한다.
    async function applyLayoutTransform(srcBytes, groups, baseSig, opts) {
      // 로마자 번호(목차·지정 페이지) — 문서 전체 기준으로 배정 후, 표본 미리보기면 창만큼 슬라이스
      const win = opts && opts.window;
      let roman = computeRomanNums();
      if (roman && win) roman = roman.slice(win.from, win.to + 1);
      if (roman && !roman.some(Boolean)) roman = null;
      // 개별 보정(pageAdjust)은 전역 저장이라 그룹 JSON에 안 잡힐 수 있어(챕터 그룹만 있을 때) 명시 포함
      const sig = (baseSig || '') + '::' + JSON.stringify(groups)
        + '::A' + JSON.stringify((editSettings && editSettings.pageAdjust) || {})
        + '::R' + (roman ? roman.join(',') : '');
      if (_layoutCache.sig === sig) return _layoutCache.bytes;
      const fileName = (typeof originalFileName === 'string' ? originalFileName : '') || '';
      // 머리글/바닥글이 ASCII(숫자·영문)만이면 워커가 내장 표준폰트로 그리므로 13MB 시스템 폰트를 읽지도 넘기지도 않는다.
      // 한글 등이 들어가는 경우(템플릿 자체·한글 파일명의 {filename}·'1 페이지' 스타일의 {n})에만 폰트를 로드한다.
      const asciiRe = /^[\x20-\x7E]*$/;
      const hfAllFields = hf => [hf.hL, hf.hC, hf.hR, hf.fL, hf.fC, hf.fR,
        hf.oHL, hf.oHC, hf.oHR, hf.oFL, hf.oFC, hf.oFR,
        hf.eHL, hf.eHC, hf.eHR, hf.eFL, hf.eFC, hf.eFR];
      const hfNeedsEmbed = hf => hfAllFields(hf).some(t =>
        t && t.trim() && (!asciiRe.test(t)
          || (/\{filename\}/.test(t) && !asciiRe.test(fileName))
          || (/\{n\}/.test(t) && (hf.pnumStyle | 0) === 4)));
      const fontBytesMap = {}; // 폰트 경로 → Uint8Array (그룹 간 동일 폰트는 1회만 로드)
      const loadHfFont = sel => {
        if (fontBytesMap[sel] === undefined) {
          try { fontBytesMap[sel] = loadFontBytes(sel).slice(0); }
          catch (e) { console.warn('머리글/바닥글 글꼴 로드 실패 → 이미지로 대체:', e); fontBytesMap[sel] = null; }
        }
        return sel;
      };
      const workerGroups = groups.map(g => {
        const hf = g.es.hf;
        if (!hf || !hf.enabled) return g;
        // 확정 레이어 + 현재 입력 — 내용 있는 구성마다 폰트를 준비하고 경로를 해석해 전달
        const cfgs = [hf, ...(hf.layers || [])].filter(c => hfAllFields(c).some(s => s && s.trim()));
        if (!cfgs.length || !cfgs.some(c => hfNeedsEmbed(c))) return g;
        const resolve = c => {
          const sel = (c.font && c.font.trim()) ? c.font : DEFAULT_HF_FONT;
          if (hfNeedsEmbed(c)) loadHfFont(sel);
          return sel;
        };
        const hf2 = Object.assign({}, hf, {
          font: resolve(hf),
          layers: (hf.layers || []).map(L => Object.assign({}, L, { font: resolve(L) })),
        });
        return { mask: g.mask, es: Object.assign({}, g.es, { hf: hf2 }) };
      });
      // 기울기 보정·가운데 정렬: base PDF를 저해상 렌더로 측정해 페이지별 보정값 계산
      // (측정은 baseSig 캐시 — 같은 base면 재측정 없이 즉시. 실패해도 나머지 레이아웃은 진행)
      let adjust = null;
      try { adjust = await computeAdjustArray(srcBytes, groups, baseSig, win ? win.from : 0); }
      catch (e) { console.warn('기울기·정렬 측정 실패 — 보정 없이 진행:', e); }
      const srcCopy = srcBytes.slice(0);
      const transfer = [srcCopy.buffer];
      Object.values(fontBytesMap).forEach(b => { if (b) transfer.push(b.buffer); });
      const resultBytes = await assembleWorkerPool.run(
        'layout-transform', {
          srcBytes: srcCopy, groups: workerGroups, fontBytesMap, fileName, baseSig: baseSig || null, adjust, roman,
          // 표본 창(문서 일부 조립)이면 절대 페이지 번호 계산용 오프셋·전체 쪽수 전달
          pageOffset: win ? win.from : 0,
          totalPages: win ? pageResults.filter(Boolean).length : null,
        }, transfer
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

    // (구) ensureBwOn — 미리보기 선택 시 흑백변환을 몰래 켜던 코드는 제거됨.
    // 정책: 선택은 순수 선택(회전·복제·목차 등)이며, 흑백 지정은 '⬛ 흑백변환' 버튼을 명시적으로 켰을 때만.

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
      // (흑백변환 자동 ON 제거 — 선택은 흑백 지정이 아님. 옵션 버튼을 명시적으로 켜야 흑백 대상이 된다)
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
      stopLazyPreviewRender();   // 이전 렌더가 배경에서 채우는 중이면 먼저 멈춘다
      // 캔버스 폭(작을수록 빠름). 펼침 모드는 표시 폭(560px × 펼침%)에 맞춘 고해상도로.
      const spreadK = (typeof _spreadZoomPct !== 'undefined' ? _spreadZoomPct : 100) / 100;
      const pxW = grid.classList.contains('pv-spread')
        ? Math.max(400, Math.round(560 * spreadK * 1.15))
        : (opts.live ? 170 : 240);
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
        // ── 보이는 것부터 그린다(지연 렌더) ────────────────────────────────
        // 예전에는 전 페이지를 다 그린 뒤에야 화면을 교체해서, 임포징 150시트면 조작 한 번에
        // 12초씩 걸렸다(실측: 시트당 79ms, 그 대부분이 이미지 디코드라 해상도를 낮춰도 안 줄었다).
        // 이제는 셀 자리만 먼저 깔아 즉시 교체하고, 화면에 보이는 셀부터 그린 뒤 나머지를
        // 배경에서 채운다. 그리는 총량과 화질은 그대로다 — 기다리는 순서만 바꾼 것.
        let colorCount = 0;
        const colorKnown = new Set();          // 실제로 그려서 컬러 여부를 확인한 페이지
        // 1:1 페이지의 캔버스 캐시 키에 쓰는 레이아웃 지문 — 임포징 상태(impSignature)를 포함해야
        // 임포징만 바꿨을 때 옛 캔버스가 남지 않는다.
        const layoutSig = JSON.stringify(editSettings) + impSignature();
        const pnMap = new Map(pageResults.filter(Boolean).map(r => [r.pageNum, r]));
        const pvPageCacheNext = new Map();
        const sigOf = (i) => {
          const src = canSelect ? srcMap[i - 1] : null;
          if (src && src.length === 1) {
            const r = pnMap.get(src[0]);
            if (r) return [pxW, layoutSig, total, r.originalIdx, r.rotation || 0, r.isBlank ? 1 : 0,
                           (r.isRoman || r.isTocPage) ? 1 : 0,
                           (selectedPages.has(src[0]) ? 1 : 0) + (r.appliedBw ? 2 : 0)].join('|');
            return null;
          }
          // 임포징 시트처럼 원본 1:1 매핑이 없는 페이지 — 결과 바이트 지문(fp)이 같으면 내용도 같다
          return ['imp', pxW, fp, i, total].join('|');
        };
        // 자리 크기용 기준 치수(1페이지) — 시트는 크기가 같으므로 이걸로 자리를 잡고,
        // 실제로 그릴 때 그 페이지의 진짜 치수로 바로잡는다.
        let refW = 0, refH = 0;
        try {
          const p1 = await pdf.getPage(1);
          const v1 = p1.getViewport({ scale: 1 });
          refW = v1.width; refH = v1.height;
        } catch (e) {}
        if (myToken !== previewRenderToken) return;

        const cellsByIdx = new Map();          // i → { cell, canvas, sbCanvas, sbItem }
        for (let i = 1; i <= total; i++) {
          const src = canSelect ? srcMap[i - 1] : null;
          const sig = sigOf(i);
          const cached = sig ? _pvPageCache.get(i) : null;
          const hit = !!(cached && cached.sig === sig);
          const selected = !!(src && src.length && src.every(pn => selectedPages.has(pn)));

          const canvas = document.createElement('canvas');
          canvas.className = 'pv-canvas';
          let pagePtW = 0, pagePtH = 0, isColor = null;
          if (hit) {
            canvas.width = cached.w; canvas.height = cached.h;
            canvas.getContext('2d').drawImage(cached.canvas, 0, 0);
            isColor = cached.isColor;
            pagePtW = cached.pw || 0; pagePtH = cached.ph || 0;
            pvPageCacheNext.set(i, cached);
            if (isColor) colorCount++;
            colorKnown.add(i);
          } else {
            // 아직 안 그린 자리 — 이전 그림이 있으면 흐리게 보여주고(pv-stale), 없으면 빈 자리
            const prev = _pvPageCache.get(i);
            if (prev && prev.canvas) {
              canvas.width = prev.w; canvas.height = prev.h;
              canvas.getContext('2d').drawImage(prev.canvas, 0, 0);
              pagePtW = prev.pw || 0; pagePtH = prev.ph || 0;
            } else if (refW > 0) {
              canvas.width = Math.max(1, Math.round(pxW));
              canvas.height = Math.max(1, Math.round(pxW * refH / refW));
              const c2 = canvas.getContext('2d');
              c2.fillStyle = '#fff'; c2.fillRect(0, 0, canvas.width, canvas.height);
              pagePtW = refW; pagePtH = refH;
            }
          }

          const cell = document.createElement('div');
          cell.className = 'pv-cell' + (selected ? ' pv-selected' : '') + (hit ? '' : ' pv-pending');
          if (pagePtW > 0) { cell.dataset.pw = pagePtW; cell.dataset.ph = pagePtH; }
          const num = document.createElement('div'); num.className = 'pv-num'; num.textContent = i;
          cell.append(canvas, num); mainFrag.appendChild(cell);

          // 사이드바 미니 썸네일 (메인과 동일 모양으로 다운스케일)
          const sc = document.createElement('canvas');
          const sbw = 104, sbh = Math.max(1, Math.round(canvas.height * sbw / Math.max(1, canvas.width)));
          sc.width = sbw; sc.height = sbh;
          if (canvas.width) sc.getContext('2d').drawImage(canvas, 0, 0, sbw, sbh);
          sc.style.cssText = 'width:100%;height:auto;display:block;border-radius:3px;';
          const sbItem = document.createElement('div');
          sbItem.className = 'sb-item' + (isColor === true ? ' sb-color-page' : isColor === false ? ' sb-mono-page' : '')
                           + (selected ? ' sb-selected' : '');
          sbItem.appendChild(sc);
          const sn = document.createElement('div'); sn.className = 'sb-num'; sn.textContent = i;
          sbItem.appendChild(sn);
          sbFrag.appendChild(sbItem);

          if (src) {
            const handler = () => togglePreviewSelect(src);
            cell.addEventListener('click', handler);
            sbItem.style.cursor = 'pointer';
            sbItem.addEventListener('click', handler);
            pvCells.push({ cell, sbItem, src });
          }
          // 우클릭 → 원본 페이지 1:1 매칭(N-up 미적용)일 때만 기존 컨텍스트 메뉴 재사용
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
          if (!hit) cellsByIdx.set(i, { cell, canvas, sbCanvas: sc, sbItem, sig });
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
        // 작업공간 표본 모드 흔적 제거 — 전체 렌더로 전환되면 표본 그리드 캐시는 무효
        delete grid.dataset.wsSample;
        if (typeof wsResetSampleGrid === 'function') wsResetSampleGrid();
        sidebar.querySelectorAll('.sb-item, .sb-chapter').forEach(el => el.remove());
        sidebar.appendChild(sbFrag);
        _pvCells = pvCells;
        updateGeometryOverlays();   // 편집 모드면 여백·제본여백 가이드 오버레이 재부착
        document.getElementById('previewCount').textContent = `(전체 ${total}페이지)` + (canSelect ? ' · 페이지를 클릭해 흑백 선택' : '');
        note.textContent = '';
        setAnalysisGridVisible(false);
        section.style.display = 'block';
        // 출력 결과 기준 컬러/흑백 통계 — 아직 안 그린 셀이 있으면 그려지는 대로 채워진다
        setStatCounts(total, colorCount);
        // 화면에 보이는 셀부터 그리고, 나머지는 배경에서 이어서 채운다(총 작업량·화질은 동일)
        if (cellsByIdx.size) {
          keepPdf = true;
          runLazyPreviewRender({
            pdf, bytes, byteLen: bytes.length, myToken, pxW, cellsByIdx, cache: pvPageCacheNext, grid, note, total,
            onColor: (i, isColor) => {
              if (colorKnown.has(i)) return;
              colorKnown.add(i);
              if (isColor) colorCount++;
              setStatCounts(total, colorCount);
            },
          });
        }
      } catch (e) {
        console.error('미리보기 렌더 실패:', e);
      } finally {
        // 상주 캐시로 남긴 문서(keepPdf)만 유지하고, 그 외(중도 취소·교체된 새 문서)는 즉시 해제한다.
        // 캐시는 항상 최대 1개만 남으므로 편집 반복 시 pdf.js 메모리가 누적되지 않는다.
        if (pdf && !keepPdf) { try { await pdf.destroy(); } catch (e) {} }
      }
    }

    // ── 미리보기 지연 렌더 엔진 ────────────────────────────────────────────────
    // 화면에 보이는 셀 → 가까운 셀 → 나머지 순으로 그린다. 중간에 새 렌더가 시작되면
    // (previewRenderToken 변경) 즉시 멈춘다. 그리는 내용·해상도는 예전과 완전히 동일하다.
    // 그리는 순서만 바꾼 것이므로 결과물·화질에는 영향이 없다.
    let _lazyStop = null;                       // 진행 중인 지연 렌더 중단 함수
    const LAZY_MARGIN = 600;                    // 화면 밖 이만큼(px)까지는 미리 그려 둔다

    // ── 병렬 렌더 ──────────────────────────────────────────────────────────────
    // 실측: pdf.js는 이미지 디코드를 자기 워커에서 하므로, 같은 바이트로 문서를 K개 띄우면
    // 거의 선형으로 빨라진다(32시트 2,508ms → 2개 1,339 / 3개 1,009 / 4개 847ms).
    // 대신 문서마다 PDF 바이트 사본을 가지므로 큰 출력에서는 개수를 줄여 메모리를 지킨다.
    function previewPoolSize(byteLen, jobs) {
      if (jobs < 8) return 1;                   // 몇 장 안 되면 문서 띄우는 값이 더 든다
      const cores = navigator.hardwareConcurrency || 4;
      const mb = (byteLen || 0) / 1048576;
      let k = mb <= 30 ? 4 : mb <= 80 ? 3 : mb <= 200 ? 2 : 1;
      k = Math.min(k, Math.max(1, Math.floor(cores / 4)), Math.ceil(jobs / 4));
      return Math.max(1, k);
    }

    function stopLazyPreviewRender() { if (_lazyStop) { _lazyStop(); _lazyStop = null; } }

    function runLazyPreviewRender(ctx) {
      stopLazyPreviewRender();
      const { pdf, bytes, byteLen, myToken, pxW, cellsByIdx, cache, grid, note, total, onColor } = ctx;
      let cancelled = false;
      let observer = null;
      const pending = new Set(cellsByIdx.keys());
      const priority = [];                      // 화면에 들어온 셀 (먼저 그린다)
      _lazyStop = () => {
        cancelled = true;
        if (observer) { try { observer.disconnect(); } catch (e) {} }
      };

      // 보이는 셀을 우선순위 큐에 넣는다 — 스크롤하면 그 위치가 즉시 앞줄로 온다
      try {
        observer = new IntersectionObserver((entries) => {
          for (const en of entries) {
            if (!en.isIntersecting) continue;
            const i = +en.target.dataset.pvIdx;
            if (pending.has(i) && !priority.includes(i)) priority.unshift(i);
          }
        }, { root: null, rootMargin: LAZY_MARGIN + 'px 0px' });
        cellsByIdx.forEach((c, i) => { c.cell.dataset.pvIdx = i; observer.observe(c.cell); });
      } catch (e) { observer = null; }

      const nextIndex = () => {
        while (priority.length) {
          const i = priority.shift();
          if (pending.has(i)) return i;
        }
        return pending.size ? pending.values().next().value : null;
      };

      let doneCount = 0;
      const totalToDraw = pending.size;
      const extraDocs = [];
      const releaseExtras = async () => {
        while (extraDocs.length) { const d = extraDocs.pop(); try { await d.destroy(); } catch (e) {} }
      };

      const drawLoop = async (doc) => {
        while (!cancelled && pending.size) {
          if (myToken !== previewRenderToken) break;
          const i = nextIndex();
          if (i == null) break;
          pending.delete(i);
          const c = cellsByIdx.get(i);
          if (!c || !c.cell.isConnected) continue;
          try {
            const page = await doc.getPage(i);
            if (cancelled || myToken !== previewRenderToken) break;
            const vp1 = page.getViewport({ scale: 1 });
            const vp = page.getViewport({ scale: pxW / vp1.width });
            const off = document.createElement('canvas');
            off.width = Math.ceil(vp.width); off.height = Math.ceil(vp.height);
            await page.render({ canvasContext: off.getContext('2d', { willReadFrequently: true }), viewport: vp }).promise;
            if (cancelled || myToken !== previewRenderToken) break;
            const isColor = canvasIsColor(off);
            // 자리 잡아둔 캔버스에 실제 그림을 옮겨 담는다(요소 교체 없이 → 스크롤 위치 유지)
            const cv = c.canvas;
            cv.width = off.width; cv.height = off.height;
            cv.getContext('2d').drawImage(off, 0, 0);
            c.cell.classList.remove('pv-pending');
            c.cell.dataset.pw = vp1.width; c.cell.dataset.ph = vp1.height;
            // 사이드바 미니 썸네일도 같이 갱신
            const sbw = 104, sbh = Math.max(1, Math.round(off.height * sbw / off.width));
            c.sbCanvas.width = sbw; c.sbCanvas.height = sbh;
            c.sbCanvas.getContext('2d').drawImage(off, 0, 0, sbw, sbh);
            c.sbItem.classList.toggle('sb-color-page', isColor);
            c.sbItem.classList.toggle('sb-mono-page', !isColor);
            cache.set(i, { sig: c.sig, canvas: off, w: off.width, h: off.height, isColor, pw: vp1.width, ph: vp1.height });
            if (onColor) onColor(i, isColor);
            page.cleanup();
          } catch (e) {
            if (!cancelled) console.warn('미리보기 페이지 렌더 실패:', i, e);
          }
          doneCount++;
          if (note && pending.size) note.textContent = `미리보기 채우는 중… ${doneCount}/${totalToDraw}`;
          else if (note) note.textContent = '';
          // 화면 조작이 끊기지 않게 매 페이지마다 양보 (배경 채우기는 낮은 우선순위)
          await new Promise(r => setTimeout(r));
        }
      };

      (async () => {
        const loops = [drawLoop(pdf)];
        // 병렬 문서는 보이는 셀을 먼저 띄운 뒤에 만든다 — 첫 화면이 늦어지지 않게.
        const k = previewPoolSize(byteLen, totalToDraw);
        if (k > 1) {
          (async () => {
            for (let n = 1; n < k; n++) {
              if (cancelled || myToken !== previewRenderToken || !pending.size) break;
              try {
                const doc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
                if (cancelled || myToken !== previewRenderToken) { try { await doc.destroy(); } catch (e) {} break; }
                extraDocs.push(doc);
                loops.push(drawLoop(doc));
              } catch (e) { break; }
            }
          })();
        }
        // 새로 합류하는 루프까지 모두 끝날 때까지 기다린다
        while (loops.length) { const cur = loops.splice(0); await Promise.all(cur); }
        await releaseExtras();
        if (observer) { try { observer.disconnect(); } catch (e) {} }
        if (!cancelled && note && myToken === previewRenderToken) note.textContent = '';
        if (typeof updateGeometryOverlays === 'function' && !cancelled) updateGeometryOverlays();
      })();
    }
    function closePreview() {
      previewRenderToken++; // 진행 중 렌더 취소
      stopLazyPreviewRender();
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
        // 적용 확정 흑백(appliedBw)은 사이드바에서도 흑백으로 표시
        item.className = 'sb-item' + (r.isBlank ? '' : ((r.isColor && !r.appliedBw) ? ' sb-color-page' : ' sb-mono-page'));
        item.dataset.sbPage = r.pageNum;
        item.innerHTML = r.thumbnail
          ? `<img src="${r.thumbnail}"${r.appliedBw ? ' style="filter:grayscale(1);"' : ''} alt="${r.pageNum}">`
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
        if (sbImg && processingOptions.bw) sbImg.style.filter = 'grayscale(1)';   // 흑백 미리보기는 옵션 ON일 때만
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
      if (typeof updateEbNote === 'function') updateEbNote();   // 📖 시안 예상 용량
      const wsb = g('workSaveBtn');
      if (wsb) wsb.disabled = !originalPdfBytes;                // 💼 문서가 있어야 작업 저장
      const ebb = g('ebGenBtn');
      if (ebb) ebb.disabled = !originalPdfBytes;                // 📖 문서가 있어야 시안 생성
      g('sb-opt-bw').classList.toggle('active', !!processingOptions.bw);
      const sbInk = g('sb-opt-inkNorm');
      if (sbInk) sbInk.classList.toggle('active', !!processingOptions.inkNorm);
      // 좌측 패널 적용/다운로드 버튼 상태는 직접 계산 (상단 툴바 버튼은 제거됨 — 여기와 오른쪽 편집 패널로 통합)
      // 판정은 메인 버튼(updateDownloadBtn)과 **같은 조건**이어야 한다 — 임포징·블리드·
      // 폰트 안전화가 빠져 있어서, 임포징만 켠 상태에서 좌측 '✔ 적용'만 회색으로 남았다.
      const anyActive = Object.values(processingOptions).some(v => v);
      const hasMod = !!originalPdfBytes && (anyActive || pageEdited || selectedPages.size > 0
                     || (typeof hasAnyActiveLayout === 'function' && hasAnyActiveLayout())
                     || (typeof hasContentEdits === 'function' && hasContentEdits())
                     || (typeof impIncluded === 'function' && impIncluded())
                     || (typeof _bleedEnabled !== 'undefined' && _bleedEnabled)
                     || (typeof _outlineEnabled !== 'undefined' && _outlineEnabled));
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


    // ── 🔍 페이지 크게 보기 — 컬러/흑백 판별용 ──────────────────────────────
    // 썸네일만으로는 옅은 색(도장·로고·라인)이 컬러인지 눈으로 알기 어렵다.
    // 원본 페이지를 크게 렌더하고, '컬러 픽셀 표시'로 중성(회색)이 아닌 픽셀만 자홍색으로
    // 칠해 준다. 감도 1 = 분석기와 같은 기준(|R-G|,|G-B|,|R-B| ≤ 1 이면 회색).
    let _pvvIdx = -1;              // pageResults 인덱스
    let _pvvZoomPct = 0;           // 0 = 화면 맞춤, 그 외 = 배율 %
    let _pvvBase = null;           // 렌더 원본 픽셀 (오버레이 재계산용)
    let _pvvToken = 0;
    function pvvOpen(idx) {
      if (!pageResults.length) return;
      if (idx == null || idx < 0 || !pageResults[idx]) {
        // 선택이 있으면 첫 선택 페이지, 없으면 첫 페이지
        const sel = [...selectedPages].sort((a, b) => a - b);
        const pn = sel.length ? sel[0] : (pageResults.find(Boolean) || {}).pageNum;
        idx = pageResults.findIndex(r => r && r.pageNum === pn);
      }
      if (idx < 0) return;
      _pvvIdx = idx;
      _pvvZoomPct = 0;
      const modal = document.getElementById('pageViewModal');
      if (!modal) return;
      modal.style.display = 'flex';
      const wrap = document.getElementById('pvvOnlySelWrap');
      if (wrap) wrap.style.display = selectedPages.size > 1 ? '' : 'none';
      pvvRender();
    }
    function closePageView() {
      const modal = document.getElementById('pageViewModal');
      if (modal) modal.style.display = 'none';
      _pvvBase = null; _pvvIdx = -1;
      _pvvToken++;   // 진행 중 렌더 취소
    }
    function pvvVisible() {
      const m = document.getElementById('pageViewModal');
      return !!m && m.style.display !== 'none';
    }
    // ◀ ▶ 이동 대상 목록 — '선택한 페이지만'이 켜져 있으면 선택 페이지 안에서만 돈다
    function pvvNavList() {
      const valid = pageResults.map((r, i) => ({ r, i })).filter(x => x.r);
      const onlySel = document.getElementById('pvvOnlySel')?.checked && selectedPages.size > 1;
      const list = onlySel ? valid.filter(x => selectedPages.has(x.r.pageNum)) : valid;
      return list.length ? list : valid;
    }
    function pvvNav(d) {
      const list = pvvNavList();
      let at = list.findIndex(x => x.i === _pvvIdx);
      if (at < 0) at = 0;
      const next = list[(at + d + list.length) % list.length];
      if (!next) return;
      _pvvIdx = next.i;
      pvvRender();
    }
    function pvvZoom(d) {
      if (d === 0) _pvvZoomPct = 0;
      else {
        const cur = _pvvZoomPct || 100;
        _pvvZoomPct = Math.max(25, Math.min(600, cur + d * 25));
      }
      pvvRender();
    }
    function pvvTolChanged() {
      const v = document.getElementById('pvvTol')?.value || '1';
      const el = document.getElementById('pvvTolVal');
      if (el) el.textContent = v;
      pvvRedraw();
    }
    function pvvSyncTitle() {
      const r = pageResults[_pvvIdx];
      const t = document.getElementById('pvvTitle');
      if (!r || !t) return;
      const list = pvvNavList();
      const at = list.findIndex(x => x.i === _pvvIdx);
      const onlySel = document.getElementById('pvvOnlySel')?.checked && selectedPages.size > 1;
      t.textContent = `${r.pageNum}쪽 / 전체 ${pageResults.filter(Boolean).length}쪽`
        + (onlySel ? ` · 선택 ${at + 1}/${list.length}` : '');
      const bw = document.getElementById('pvvBwBtn');
      if (bw) {
        const on = selectedPages.has(r.pageNum);
        bw.classList.toggle('active', on || !!r.appliedBw);
        bw.textContent = r.appliedBw ? '⬛ 흑백 확정됨' : (on ? '⬛ 흑백변환 선택됨' : '⬛ 흑백변환 선택');
      }
      const z = document.getElementById('pvvZoomPct');
      if (z) z.textContent = _pvvZoomPct ? _pvvZoomPct + '%' : '맞춤';
    }
    async function pvvRender() {
      const r = pageResults[_pvvIdx];
      const cv = document.getElementById('pvvCanvas');
      const box = document.getElementById('pvvBody');
      if (!r || !cv || !box) return;
      const my = ++_pvvToken;
      pvvSyncTitle();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      try {
        if (r.isBlank || r.originalIdx == null || !globalPdfDoc) {
          const ps = r.pageSize || [595.28, 841.89];
          const fit = Math.min((box.clientWidth - 40) / ps[0], (box.clientHeight - 40) / ps[1]);
          const s = Math.max(0.05, fit * (_pvvZoomPct ? _pvvZoomPct / 100 : 1));
          cv.width = Math.ceil(ps[0] * s * dpr); cv.height = Math.ceil(ps[1] * s * dpr);
          cv.style.width = Math.round(ps[0] * s) + 'px';
          cv.style.height = Math.round(ps[1] * s) + 'px';
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
          _pvvBase = null;
          pvvSetStat(null);
          return;
        }
        const page = await globalPdfDoc.getPage(r.originalIdx + 1);
        if (my !== _pvvToken) return;
        const rot = ((((page.rotate || 0) + (r.rotation || 0)) % 360) + 360) % 360;
        const vp1 = page.getViewport({ scale: 1, rotation: rot });
        const fit = Math.min((box.clientWidth - 40) / vp1.width, (box.clientHeight - 40) / vp1.height);
        const cssScale = Math.max(0.05, fit * (_pvvZoomPct ? _pvvZoomPct / 100 : 1));
        // 렌더 픽셀 상한 — 초대형 페이지에서 캔버스가 폭주하지 않게
        let renderScale = cssScale * dpr;
        const maxSide = 4000;
        const longSide = Math.max(vp1.width, vp1.height) * renderScale;
        if (longSide > maxSide) renderScale *= maxSide / longSide;
        const vp = page.getViewport({ scale: renderScale, rotation: rot });
        cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
        cv.style.width = Math.round(vp1.width * cssScale) + 'px';
        cv.style.height = Math.round(vp1.height * cssScale) + 'px';
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        try { page.cleanup(); } catch (e) {}
        if (my !== _pvvToken) return;
        _pvvBase = ctx.getImageData(0, 0, cv.width, cv.height);
        pvvRedraw();
      } catch (e) {
        console.error('페이지 크게 보기 렌더 실패:', e);
        pvvSetStat(null);
      }
    }
    // 컬러 픽셀 비율 계산 + (옵션) 자홍색 오버레이
    function pvvRedraw() {
      const cv = document.getElementById('pvvCanvas');
      if (!cv || !_pvvBase) return;
      const tol = parseInt(document.getElementById('pvvTol')?.value) || 0;
      const mark = !!document.getElementById('pvvMark')?.checked;
      const src = _pvvBase.data;
      const out = new ImageData(new Uint8ClampedArray(src), _pvvBase.width, _pvvBase.height);
      const d = out.data;
      let colored = 0, opaque = 0;
      for (let i = 0; i < src.length; i += 4) {
        if (src[i + 3] < 8) continue;
        opaque++;
        const rr = src[i], gg = src[i + 1], bb = src[i + 2];
        const isColor = Math.abs(rr - gg) > tol || Math.abs(gg - bb) > tol || Math.abs(rr - bb) > tol;
        if (!isColor) continue;
        colored++;
        if (mark) { d[i] = 255; d[i + 1] = 0; d[i + 2] = 200; }
      }
      cv.getContext('2d').putImageData(out, 0, 0);
      pvvSetStat({ colored, opaque });
    }
    function pvvSetStat(s) {
      const st = document.getElementById('pvvStat');
      const vd = document.getElementById('pvvVerdict');
      const r = pageResults[_pvvIdx];
      if (vd && r) {
        const isColor = r.isColor && !r.appliedBw;
        vd.className = 'pvv-verdict ' + (isColor ? 'is-color' : 'is-gray');
        vd.textContent = r.isBlank ? '빈 페이지' : (r.appliedBw ? '흑백 확정' : (r.isColor ? '🎨 컬러 판정' : '흑백 판정'));
      }
      if (!st) return;
      if (!s || !s.opaque) { st.textContent = ''; return; }
      const pct = s.colored / s.opaque * 100;
      st.textContent = s.colored
        ? `컬러 픽셀 ${s.colored.toLocaleString()}개 (${pct < 0.01 ? '<0.01' : pct.toFixed(2)}%)`
        : '컬러 픽셀 없음 — 완전한 회색 페이지';
    }
    // 창 크기가 바뀌면 '맞춤' 배율을 다시 계산 (뷰어가 열려 있을 때만)
    let _pvvResizeTimer = null;
    window.addEventListener('resize', () => {
      if (!pvvVisible()) return;
      clearTimeout(_pvvResizeTimer);
      _pvvResizeTimer = setTimeout(pvvRender, 150);
    });
    // 이 페이지를 흑백변환 대상으로 선택/해제 (메인 썸네일 선택과 같은 상태)
    function pvvToggleBw() {
      const r = pageResults[_pvvIdx];
      if (!r || r.isBlank) return;
      if (r.appliedBw) { showError('이미 흑백으로 확정된 페이지입니다 — 되돌리려면 ⬛ 흑백변환 옵션을 끄세요.'); return; }
      const el = document.querySelector(`[data-page="${r.pageNum}"]`);
      if (selectedPages.has(r.pageNum)) { if (el) deselectPageEl(r.pageNum, el); else selectedPages.delete(r.pageNum); }
      else { if (el) selectPageEl(r.pageNum, el); else selectedPages.add(r.pageNum); }
      updateSelectedCount();
      pvvSyncTitle();
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
        if (img && !isBlank && processingOptions.bw) img.style.filter = 'grayscale(1)';   // 흑백 미리보기는 옵션 ON일 때만
      }
      // 적용 확정된 흑백 페이지 — 선택과 무관하게 회색 + '흑백' 라벨 유지
      if (r.appliedBw && !isBlank) {
        const img = el.querySelector('.page-thumbnail');
        if (img) img.style.filter = 'grayscale(1)';
        const span = el.querySelector('.page-type-inline');
        if (span) { if (!span.dataset.orig) span.dataset.orig = span.textContent; span.textContent = '흑백'; }
      }
      el.addEventListener('click', e => {
        if (e.target.closest('button')) return;
        togglePageSelection(pageNum, el, e);
      });
      // 더블클릭 → 🔍 크게 보기 (컬러/흑백 판별). 클릭 2회로 생긴 선택 토글은 서로 상쇄된다.
      el.addEventListener('dblclick', e => {
        if (e.target.closest('button')) return;
        e.preventDefault();
        pvvOpen(pageResults.findIndex(p => p && p.pageNum === pageNum));
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
      const isSide = rotation === 90 || rotation === 270;
      // 대지(판형) 스왑: 90/270°면 썸네일 칸의 가로세로를 실제 출력 판형대로 바꾼다
      // (기존엔 세로 칸 안에서 그림만 돌아가 레터박스로 보였음)
      const wrap = img.closest ? img.closest('.page-thumb-wrap') : null;
      if (wrap) {
        if (isSide && thumbW && thumbH) {
          wrap.style.aspectRatio = `${thumbH} / ${thumbW}`;
          wrap.style.display = 'flex'; wrap.style.alignItems = 'center'; wrap.style.justifyContent = 'center';
        } else {
          wrap.style.aspectRatio = ''; wrap.style.display = ''; wrap.style.alignItems = ''; wrap.style.justifyContent = '';
        }
      }
      if (!rotation) { img.style.transform = ''; return; }
      if (isSide && thumbW && thumbH) {
        // 스왑된 칸을 꽉 채우는 배율 (칸 있음) / 칸 폭을 넘지 않는 축소 (사이드바 등 칸 없음)
        img.style.transform = `rotate(${rotation}deg) scale(${thumbW / thumbH})`;
      } else {
        img.style.transform = `rotate(${rotation}deg)`;
      }
    }

    function rotatePage(idx, deg) {
      const r = pageResults[idx];
      if (!r) return;
      pushHistory();
      // 복제(D)와 같은 규칙: 클릭한 페이지가 선택(Shift/Ctrl 다중선택)에 포함되고
      // 2개 이상 선택이면 선택 전체를 함께 회전 — 아니면 그 페이지만.
      const targets = (selectedPages.size > 1 && selectedPages.has(r.pageNum))
        ? pageResults.filter(x => x && selectedPages.has(x.pageNum))
        : [r];
      for (const t of targets) {
        t.rotation = ((t.rotation || 0) + deg + 360) % 360;
        // 썸네일 즉시 반영 (메인 그리드 + 사이드바)
        const el = document.querySelector(`[data-page="${t.pageNum}"]`);
        if (el) {
          const img = el.querySelector('.page-thumbnail');
          if (img) applyRotationStyle(img, t.rotation, t.thumbW, t.thumbH);
        }
        const sbEl = sidebar.querySelector(`[data-sb-page="${t.pageNum}"]`);
        if (sbEl) {
          const sbImg = sbEl.querySelector('img');
          if (sbImg) applyRotationStyle(sbImg, t.rotation, t.thumbW, t.thumbH);
        }
      }
      setPageEdited();
      updateUndoBtn();
      if (targets.length > 1)
        showSuccess(`선택한 ${targets.length}쪽을 ${deg > 0 ? '시계 ↻' : '반시계 ↺'} 90° 회전했습니다. (되돌리기 Ctrl+Z)`);
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
      // 💼 작업 파일을 떨어뜨리면 저장된 상태 그대로 복원한다 (분석 파이프라인을 타지 않음)
      const works = [...e.dataTransfer.files].filter(f => /\.pdfw$/i.test(f.name));
      if (works.length) {
        hideError(); hideSuccess();
        for (const w of works) await openWorkFilePath(window.electronAPI.getPathForFile(w));
        return;
      }
      const dropped = [...e.dataTransfer.files].filter(f =>
        f.type.includes('pdf') || /\.pdf$/i.test(f.name) || CONVERT_RE.test(f.name)
      );
      if (!dropped.length) { showError('PDF · 한글(HWP·HWPX) · MS Office(Word·Excel·PowerPoint) · Adobe(AI·PSD·INDD) · 이미지(PNG·JPG·GIF·BMP·WEBP·TIFF) 파일만 업로드 가능합니다.'); return; }
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

    // 빈 곳 클릭 → 선택 해제 기능은 제거됨 — 선택은 흑백변환·회전·복제·적용범위 등
    // 여러 파이프라인의 입력이라, 사이드바·본문 여백을 무심코 클릭만 해도 풀리는 사고가
    // 반복됐다(흑백 모드만 막아도 체크 전에 선택하는 흐름에서 여전히 풀림).
    // 해제는 명시적 동작으로만: '선택 해제' 버튼 또는 C 키.

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

    // ── 📱 모바일 연동 서버 (remote-server.js) — 좌측 사이드바 설정 섹션 ──────
    // 폰이 같은 WiFi에서 이 PC로 HWP/Office/Adobe 변환·잉크판정을 위임한다.
    // QR = 접속 URL(토큰·MAC 포함) — 폰 카메라 스캔으로 테스트 페이지 접속.
    async function toggleRemoteServer(on) {
      const chk = document.getElementById('remoteSrvChk');
      try {
        const st = await window.electronAPI.remoteSetEnabled(on);
        renderRemoteServerUI(st);
        if (on && st.running) {
          const addr = st.lan.length ? `${st.lan[0].ip}:${st.port}` : `포트 ${st.port}`;
          showSuccess(`📱 모바일 연동 서버 켜짐 — ${addr}\n폰 카메라로 QR을 스캔해 접속하세요 (같은 WiFi 필요). 변환은 PC의 한글·Office·Adobe로 처리됩니다.`);
        } else if (on && !st.running) {
          showError('서버 시작 실패: ' + (st.lastError || '알 수 없는 오류'));
          if (chk) chk.checked = false;
        }
      } catch (e) {
        showError('모바일 연동 서버 오류: ' + (e && e.message ? e.message : String(e)));
        if (chk) chk.checked = false;
      }
    }
    function renderRemoteServerUI(st) {
      const body = document.getElementById('remoteSrvBody');
      const err  = document.getElementById('remoteSrvErr');
      const chk  = document.getElementById('remoteSrvChk');
      if (!body) return;
      if (chk) chk.checked = !!st.running;
      body.style.display = st.running ? '' : 'none';
      err.style.display = st.lastError ? '' : 'none';
      err.textContent = st.lastError || '';
      if (!st.running) return;
      // QR: 첫 번째 LAN 주소 (보통 유선/무선 1개). 나머지는 텍스트로 병기.
      const qrBox = document.getElementById('remoteSrvQr');
      const addrBox = document.getElementById('remoteSrvAddr');
      if (st.urls.length && typeof qrcode === 'function') {
        try {
          const qr = qrcode(0, 'M');
          qr.addData(st.urls[0]);
          qr.make();
          qrBox.innerHTML = qr.createSvgTag({ cellSize: 3, margin: 2 });
          qrBox.style.display = 'flex';
        } catch (e) { qrBox.style.display = 'none'; }
      } else qrBox.style.display = 'none';
      addrBox.innerHTML = st.lan.map(l =>
        `${l.ip}:${st.port} <span style="color:#636366;">(${l.iface} · MAC ${l.mac})</span>`).join('<br>')
        + `<br>토큰: <b style="color:#ffd60a;">${st.token}</b>`;
    }
    // 시작 시 저장된 상태 복원 (켜짐 설정이면 main이 이미 서버를 구동해 둠)
    (function initRemoteServerUI() {
      if (!window.electronAPI || !window.electronAPI.remoteStatus) return;
      window.electronAPI.remoteStatus().then(renderRemoteServerUI).catch(() => {});
    })();

    // 가상 프린터 설치 버튼 — 미설치일 때만 표시 (설치돼 있으면 숨김 유지)
    (function initPrinterSetupBtn() {
      if (!window.electronAPI || !window.electronAPI.printerStatus) return;
      window.electronAPI.printerStatus().then(st => {
        const b = document.getElementById('printerSetupBtn');
        if (b && !(st && st.installed)) b.style.display = '';
      }).catch(() => {});
    })();

    // ── 체험판 라이선스 배지 ────────────────────────────────────────────────
    // 화면 표시 전용이다. 실제 저장·출력 차단은 메인 프로세스의 길목에서 하므로,
    // 이 코드를 고쳐 배지를 숨겨도 만료된 라이선스로는 파일이 저장되지 않는다.
    function renderLicenseBadge(st) {
      const el = document.getElementById('licBadge');
      if (!el || !st) return;
      if (st.mode === 'admin') { el.style.display = 'none'; return; }   // 정품(발급자) PC
      el.style.display = '';
      el.textContent = (st.canSave ? '체험판 · ' : '⚠ ') + (st.label || '');
      el.classList.toggle('expired', !st.canSave);
    }
    (function initLicenseBadge() {
      if (!window.electronAPI || !window.electronAPI.licenseStatus) return;
      window.electronAPI.licenseStatus().then(renderLicenseBadge).catch(() => {});
      if (window.electronAPI.onLicenseStatus) window.electronAPI.onLicenseStatus(renderLicenseBadge);
    })();

    // 💼 작업 파일 더블클릭 연결 상태를 버튼 라벨에 반영 (등록/해제 토글)
    (function initWorkAssocBtn() {
    })();
