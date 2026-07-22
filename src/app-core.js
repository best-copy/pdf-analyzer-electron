    // ── PDF.js 워커 설정 (asar 패키지 내부에서도 동작하는 blob URL 방식) ──────
    // Web Worker는 asar 경로를 직접 로드할 수 없으므로
    // preload의 fs.readFileSync로 읽어 Blob URL로 변환해 사용
    try {
      const workerContent = window.electronAPI.getWorkerContent();
      const blob = new Blob([workerContent], { type: 'application/javascript' });
      pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
    } catch(e) {
      console.error('PDF.js 워커 로드 실패:', e);
    }

    // ── 공유 DOM ─────────────────────────────────────────────────────────────
    const fileInfo         = document.getElementById('fileInfo');
    const progressBar      = document.getElementById('progressBar');
    const progressFill     = document.getElementById('progressFill');
    const loading          = document.getElementById('loading');
    const loadingMsg       = document.getElementById('loadingMsg');
    const errorEl          = document.getElementById('error');
    const successEl        = document.getElementById('success');
    const tabBar           = document.getElementById('tabBar');
    const mainTabBar       = document.getElementById('mainTabBar');
    const tabBars          = [tabBar, mainTabBar];
    const resultsSection   = document.getElementById('resultsSection');
    const pagesGrid        = document.getElementById('pagesGrid');
    const rangeSummary     = document.getElementById('rangeSummary');
    const selectedCountEl  = document.getElementById('selectedCount');
    const totalPagesEl     = document.getElementById('totalPages');
    const colorPagesEl     = document.getElementById('colorPages');
    const grayscalePagesEl = document.getElementById('grayscalePages');
    const colorPercentEl   = document.getElementById('colorPercentage');

    // ── 현재 탭의 상태를 가리키는 전역 앨리어스 ─────────────────────────────
    let originalPdfBytes   = null;
    let originalFileName   = '';
    let globalPdfDoc       = null;
    let pageResults        = [];
    let selectedPages      = new Set();
    let originalThumbnails = new Map();
    let quoteItems         = [];
    let pageEdited         = false;
    let liveAutoPreview    = localStorage.getItem('liveAutoPreview') === '1'; // 편집 중 자동 반영 (기본 OFF)
    let undoStack          = []; // 실행취소 히스토리 (페이지 상태 스냅샷)
    let redoStack          = []; // 다시실행 히스토리
    const HISTORY_LIMIT    = 1000; // 보관 스냅샷 최대 개수 (사실상 무제한)
    let processedPdfBytes  = null; // '적용'으로 생성된 결과 PDF (다운로드 대기)
    let processedFileName  = '';
    let applying           = false; // 적용(수정) 진행 중 여부
    // inkNorm(잉크 정규화): 분석기가 '흑백'으로 판정한 페이지도 DeviceGray 색공간으로 강제
    // 변환한다. 화면은 흑백처럼 보여도 내부가 RGB/CMYK 회색(리치블랙)이면 프린터 과금기가
    // 컬러로 카운트하는 문제의 해결책 — 시각적 변화 없이 색공간만 그레이로 통일.
    const processingOptions = { bw: false, inkNorm: true };   // 잉크 정규화는 기본 켬
    let editSettings       = null; // 현재 탭의 편집 설정(크기·회전·조판·테두리) 앨리어스
    let contentEdits       = new Map(); // 현재 탭의 페이지 내부편집: originalIdx → { model, bytes, rev }

    // 저장 안 한 작업 여부를 main에 보고 (종료 전 확인용)
    let _isDirty = false;
    function setDirty(v) {
      v = !!v;
      if (v === _isDirty) return;
      _isDirty = v;
      try { window.electronAPI.setUnsaved && window.electronAPI.setUnsaved(v); } catch (e) {}
    }

    // 편집 설정 기본값 팩토리 — 탭마다 독립 보관
    function newEditSettings() {
      return {
        scope:   { mode: 'all', from: 1, to: 1, chapter: '' },
        scaling: { mode: 'none', paper: 'A4', orient: 'auto', customW: 210, customH: 297, fitMargins: true },
        margins: { enabled: false, top: 10, bottom: 10, left: 10, right: 10 }, // mm — enabled일 때만 적용
        nUp: 1,
        gutter: 0,        // 조판 칸 사이 간격 (mm)
        border: 'none',
        // 머리글/바닥글 — 좌/중/우 6칸, 자리표시자 {page}{total}{date}{filename}{n}
        hf: { enabled: false, hL: '', hC: '', hR: '', fL: '', fC: '', fR: '',
              size: 9, color: '#333333', margin: 10, pnumStyle: 1, font: 'C:\\Windows\\Fonts\\malgun.ttf' },
        // 워터마크
        wm: { enabled: false, text: '', size: 48, color: '#cccccc',
              opacity: 30, angle: 45, mode: 'center' },
        // 합본 문서의 챕터별 개별 설정 — 적용 범위를 '챕터'로 두고 편집하면 여기에 저장되어
        // 전역(위) 설정과 별개로 그 챕터에만 적용된다. { [챕터명]: {scaling,margins,nUp,gutter,border,hf,wm} }
        byChapter: {},
      };
    }

    // ── 멀티코어 Worker Pool ──────────────────────────────────────────────────
    class WorkerPool {
      constructor(scriptPath, numWorkers) {
        this.pending = new Map();
        this.nextId = 0;
        this.freeWorkers = [];
        this.jobQueue = [];
        const workerUrl = new URL(scriptPath, window.location.href).href;
        this.workers = Array.from({ length: numWorkers }, () => {
          const w = new Worker(workerUrl);
          w.onmessage = (e) => this._onResult(w, e.data);
          w.onerror   = (e) => {
            const job = w.__currentJob;
            if (job) { this.pending.get(job.id)?.reject(new Error(e.message)); this.pending.delete(job.id); }
            w.__currentJob = null;
            this.freeWorkers.push(w);
            this._flush();
          };
          this.freeWorkers.push(w);
          return w;
        });
      }
      run(type, payload, transferable = [], onProgress = null) {
        return new Promise((resolve, reject) => {
          const id = this.nextId++;
          this.jobQueue.push({ id, type, payload, transferable, resolve, reject, onProgress });
          this._flush();
        });
      }
      _flush() {
        while (this.freeWorkers.length > 0 && this.jobQueue.length > 0) {
          const worker = this.freeWorkers.pop();
          const job    = this.jobQueue.shift();
          this._dispatch(worker, job);
        }
      }
      _dispatch(worker, job) {
        this.pending.set(job.id, { resolve: job.resolve, reject: job.reject, onProgress: job.onProgress });
        worker.__currentJob = job;
        worker.postMessage({ id: job.id, type: job.type, payload: job.payload }, job.transferable);
      }
      _onResult(worker, data) {
        const p = this.pending.get(data.id);
        if (!p) return;
        if (data.progress !== undefined) { p.onProgress?.(data.progress); return; }
        if (data.error) p.reject(new Error(data.error));
        else p.resolve(data.result);
        this.pending.delete(data.id);
        worker.__currentJob = null;
        this.freeWorkers.push(worker);
        this._flush();
      }
    }
    const CORES = Math.max(navigator.hardwareConcurrency || 4, 2);
    const grayWorkerPool = new WorkerPool('./worker-gray.js', CORES);
    const assembleWorkerPool = new WorkerPool('./worker-assemble.js', CORES);

    // ── 탭 관리 ──────────────────────────────────────────────────────────────
    const tabs = new Map(); // id → tabState
    let activeTabId = null;

    function newTabState(file) {
      return {
        id: 'tab_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
        fileName: file.name,
        originalFileName: file.name.replace(/\.(pdf|hwpx?|docx?|xlsx?|pptx?|psd|indd|ai)$/i, ''),
        originalPdfBytes: null,
        pdfDoc: null,
        pageResults: [],
        selectedPages: new Set(),
        originalThumbnails: new Map(),
        quoteItems: [],
        processingOptions: { bw: false, inkNorm: true },
        status: 'loading',
        errorMsg: '',
        colorCount: 0,
        bwCount: 0,
        progress: 0,
        defaultPageSize: null,
        pageEdited: false,
        undoStack: [],
        redoStack: [],
        fileSize: file.size || 0,
        editSettings: newEditSettings(),
        contentEdits: new Map(), // 페이지 내부편집(내부 텍스트·요소): originalIdx → { model, bytes, rev }
      };
    }

    // PDF 페이지 크기(pt) → 표준 용지명 판별 (mm 기준, 오차 허용)
    function detectPaperName(wmm, hmm) {
      const std = [
        ['A3', 297, 420], ['A4', 210, 297], ['A5', 148, 210], ['A6', 105, 148],
        ['B4', 250, 353], ['B5', 176, 250], ['B6', 125, 176],
        ['Letter', 216, 279], ['Legal', 216, 356], ['Tabloid', 279, 432],
      ];
      const tol = 3; // ±3mm
      for (const [name, a, b] of std) {
        if ((Math.abs(wmm - a) <= tol && Math.abs(hmm - b) <= tol) ||
            (Math.abs(wmm - b) <= tol && Math.abs(hmm - a) <= tol)) return name;
      }
      return null;
    }

    // 페이지의 실제 크기(pt) 추출 — 빈 페이지는 pageSize, 분석된 페이지는 pageWpt/pageHpt
    function pagePtSize(r) {
      if (!r) return null;
      if (r.isBlank && r.pageSize) return [r.pageSize[0], r.pageSize[1]];
      if (r.pageWpt) return [r.pageWpt, r.pageHpt];
      return null;
    }

    // pt 크기 → { key, text } (표준 용지명·방향 포함)
    function sizeLabel(wpt, hpt) {
      const wmm = wpt * 25.4 / 72, hmm = hpt * 25.4 / 72;
      const w = Math.round(wmm), h = Math.round(hmm);
      const name = detectPaperName(wmm, hmm);
      const orient = wmm > hmm ? '가로' : '세로';
      return {
        key: `${w}x${h}`,
        text: `${w} × ${h} mm` + (name ? ` (${name}·${orient})` : ` (${orient})`),
      };
    }

    // 업로드 문서 정보(파일명·페이지 크기·페이지수)를 상단에 표시
    // 페이지 크기가 다르면 "혼합 — 크기별 페이지 범위" 로 표기
    function updateFileInfo(tab) {
      if (!tab) return;
      const results = tab.pageResults ? tab.pageResults.filter(Boolean) : [];
      const pages = results.length;

      // 크기별 그룹화 (key → { text, nums[] })
      const groups = new Map();
      results.forEach(r => {
        const sz = pagePtSize(r);
        if (!sz) return;
        const lbl = sizeLabel(sz[0], sz[1]);
        if (!groups.has(lbl.key)) groups.set(lbl.key, { text: lbl.text, nums: [] });
        groups.get(lbl.key).nums.push(r.pageNum);
      });

      let sizeStr = '';
      if (groups.size === 0 && tab.defaultPageSize) {
        // 분석 전: 1페이지 크기로 임시 표시
        sizeStr = `📐 ${sizeLabel(tab.defaultPageSize[0], tab.defaultPageSize[1]).text}`;
      } else if (groups.size === 1) {
        sizeStr = `📐 ${[...groups.values()][0].text}`;
      } else if (groups.size > 1) {
        const parts = [...groups.values()]
          .sort((a, b) => b.nums.length - a.nums.length)
          .map(g => `${g.text} ${formatRanges(g.nums)}p`);
        sizeStr = `📐 혼합 — ${parts.join(' · ')}`;
      }

      const html = `<strong>${tab.fileName}</strong>`
        + (sizeStr ? ` — ${sizeStr}` : '')
        + (pages ? ` · 📄 ${pages}페이지` : '');
      fileInfo.innerHTML = html;
      // 크기·내용이 바뀔 때만 3초간 표시 후 자동 숨김 (페이지 편집 영역을 가리지 않도록)
      showFileInfoTransient(html);
    }

    // 문서 크기 배너: 내용 변동 시에만 3초 노출 후 자동 숨김
    let _fileInfoTimer = null, _fileInfoLast = '';
    function showFileInfoTransient(html) {
      if (html === _fileInfoLast && fileInfo.style.display === 'none') return; // 동일 내용 재노출 안 함
      _fileInfoLast = html;
      fileInfo.style.display = 'block';
      fileInfo.style.transition = 'opacity 0.4s';
      fileInfo.style.opacity = '1';
      clearTimeout(_fileInfoTimer);
      _fileInfoTimer = setTimeout(() => {
        fileInfo.style.opacity = '0';
        setTimeout(() => { if (fileInfo.style.opacity === '0') fileInfo.style.display = 'none'; }, 450);
      }, 3000);
    }

    function createTab(file) {
      const state = newTabState(file);
      tabs.set(state.id, state);
      if (tabs.size >= 2) tabBars.forEach(b => b.style.display = 'flex');
      renderTabBar();
      syncMainTabBarOffset();
      return state;
    }

    function activateTab(id) {
      if (!tabs.has(id)) return;
      // 현재 탭의 processingOptions 저장
      if (activeTabId && tabs.has(activeTabId)) {
        Object.assign(tabs.get(activeTabId).processingOptions, processingOptions);
      }
      activeTabId = id;
      const tab = tabs.get(id);

      // 전역 앨리어스를 새 탭의 상태 객체로 교체
      originalPdfBytes   = tab.originalPdfBytes;
      originalFileName   = tab.originalFileName;
      globalPdfDoc       = tab.pdfDoc;
      pageResults        = tab.pageResults;
      selectedPages      = tab.selectedPages;
      originalThumbnails = tab.originalThumbnails;
      quoteItems         = tab.quoteItems;
      Object.assign(processingOptions, tab.processingOptions);
      pageEdited         = tab.pageEdited;
      undoStack          = tab.undoStack;
      redoStack          = tab.redoStack;
      if (!tab.editSettings) tab.editSettings = newEditSettings();
      editSettings       = tab.editSettings;
      if (!tab.contentEdits) tab.contentEdits = new Map();
      contentEdits       = tab.contentEdits;
      // 탭 전환 시 이전 탭의 '적용' 결과는 무효화 (다운로드 비활성)
      processedPdfBytes  = null;
      processedFileName  = '';
      if (typeof closePreview === 'function') closePreview();
      if (typeof clearProcessCaches === 'function') clearProcessCaches();

      hideError(); hideSuccess();

      if (tab.status === 'ready') {
        hideLoading(); progressBar.style.display = 'none';
        resultsSection.style.display = 'block';
        renderTabUI(tab);
      } else if (tab.status === 'loading') {
        resultsSection.style.display = 'none';
        showLoading('PDF를 분석하고 있습니다...');
        progressBar.style.display = 'block';
        updateProgress(tab.progress);
      } else if (tab.status === 'error') {
        resultsSection.style.display = 'none';
        hideLoading(); progressBar.style.display = 'none';
        showError(tab.errorMsg);
      } else {
        resultsSection.style.display = 'none';
        hideLoading(); progressBar.style.display = 'none';
      }
      renderTabBar();
    }

    // 닫는 탭의 썸네일 objectURL 해제 (메모리 누수 방지; blob: URL만 대상, data:는 무시)
    function revokeThumbnails(results) {
      if (!results) return;
      results.forEach(r => {
        if (r && typeof r.thumbnail === 'string' && r.thumbnail.startsWith('blob:')) {
          try { URL.revokeObjectURL(r.thumbnail); } catch {}
        }
      });
    }

    function closeTab(id) {
      const closing = tabs.get(id);
      if (closing) revokeThumbnails(closing.pageResults);
      tabs.delete(id);
      if (activeTabId === id) {
        const remaining = [...tabs.keys()];
        if (remaining.length > 0) {
          activateTab(remaining[remaining.length - 1]);
        } else {
          activeTabId = null;
          resultsSection.style.display = 'none';
          setThumbZoomWidgetVisible(false);
          showSidebar(false);
          hideLoading(); progressBar.style.display = 'none';
          hideError(); hideSuccess();
          originalPdfBytes = null; originalFileName = '';
          pageResults = []; selectedPages = new Set();
          originalThumbnails = new Map(); quoteItems = [];
        }
      }
      if (tabs.size < 2) tabBars.forEach(b => b.style.display = 'none');
      renderTabBar();
      syncMainTabBarOffset();
    }

    let dragTabId = null;
    // 탭 순서 변경: srcId 탭을 targetId 탭 앞으로 이동시켜 Map을 재구성
    function moveTabBefore(srcId, targetId) {
      if (srcId === targetId) return;
      const ids = [...tabs.keys()].filter(id => id !== srcId);
      const idx = ids.indexOf(targetId);
      if (idx < 0) return;
      ids.splice(idx, 0, srcId);
      const entries = ids.map(id => [id, tabs.get(id)]);
      tabs.clear();
      entries.forEach(([id, st]) => tabs.set(id, st));
      renderTabBar();
    }

    // #mainTabBar(상단 고정)가 표시될 때 그 높이만큼 .sticky-panel을 밀어내려
    // 두 sticky 요소가 스크롤 시 서로 겹치지 않게 한다.
    function syncMainTabBarOffset() {
      requestAnimationFrame(() => {
        const h = mainTabBar.style.display === 'flex' ? mainTabBar.getBoundingClientRect().height : 0;
        document.documentElement.style.setProperty('--maintabbar-h', h + 'px');
      });
    }

    // 사이드바(#tabBar)·메인(#mainTabBar) 두 곳에 동일한 탭 목록을 렌더링한다.
    // 사이드바를 닫아도 메인 쪽 탭 바는 항상 보이도록 동시에 표시한다.
    function renderTabBar() {
      tabBars.forEach(container => {
        container.innerHTML = '';
        tabs.forEach((state, id) => {
          const tab = document.createElement('div');
          tab.className = 'tab-item' + (id === activeTabId ? ' active' : '');
          const icon = state.status === 'loading' ? '⏳ ' : state.status === 'error' ? '❌ ' : '📄 ';
          const short = state.fileName.length > 22 ? state.fileName.slice(0, 20) + '…' : state.fileName;
          tab.title = state.fileName;
          tab.draggable = true;
          tab.innerHTML = `<span class="tab-name">${icon}${short}</span><button class="tab-close" onclick="event.stopPropagation();closeTab('${id}')">✕</button>`;
          tab.onclick = () => activateTab(id);
          // 마우스 드래그로 탭 순서 변경
          tab.ondragstart = (e) => { dragTabId = id; e.dataTransfer.effectAllowed = 'move'; tab.classList.add('dragging'); };
          tab.ondragend = () => { dragTabId = null; container.querySelectorAll('.tab-item').forEach(t => t.classList.remove('dragging','drag-over')); };
          tab.ondragover = (e) => { if (dragTabId && dragTabId !== id) { e.preventDefault(); tab.classList.add('drag-over'); } };
          tab.ondragleave = () => tab.classList.remove('drag-over');
          tab.ondrop = (e) => { e.preventDefault(); tab.classList.remove('drag-over'); if (dragTabId) moveTabBefore(dragTabId, id); };
          container.appendChild(tab);
        });
        // 2개 이상 열려 있으면 '파일 합치기' 버튼 표시
        if (tabs.size >= 2) {
          const mb = document.createElement('button');
          mb.className = 'tab-merge-btn';
          mb.innerHTML = '<span class="ic">🔗</span> 파일 합치기';
          mb.title = '열려 있는 모든 파일을 하나의 PDF로 합쳐 저장합니다';
          mb.onclick = mergeAllTabs;
          container.appendChild(mb);
        }
      });
    }

    function renderTabUI(tab) {
      setThumbZoomWidgetVisible(true);
      showSidebar(true);
      const total = tab.pageResults.length;
      totalPagesEl.textContent     = total;
      colorPagesEl.textContent     = tab.colorCount;
      grayscalePagesEl.textContent = tab.bwCount;
      colorPercentEl.textContent   = Math.round(tab.colorCount / Math.max(1, total) * 100) + '%';

      const colorList = tab.pageResults.filter(p => p && p.isColor).map(p => p.pageNum);
      const grayList  = tab.pageResults.filter(p => p && !p.isColor).map(p => p.pageNum);
      rangeSummary.innerHTML = `<strong>컬러 페이지:</strong> ${formatRanges(colorList)}<br><strong>흑백 페이지:</strong> ${formatRanges(grayList)}`;

      renderAllPages(tab.pageResults);

      // 처리 옵션 버튼 상태 복원
      Object.keys(processingOptions).forEach(k => {
        const btn = document.getElementById('opt-' + k);
        if (btn) btn.classList.toggle('active', processingOptions[k]);
      });
      updateDownloadBtn();
      updateFileInfo(tab);

      updateSelectedCount();

      if (tab.quoteItems.length > 0) {
        document.getElementById('q-customer').value = tab._customer || '';
        document.getElementById('q-date').value = tab._date || new Date().toISOString().split('T')[0];
        renderQuoteTable();
        document.getElementById('quoteSection').style.display = 'block';
      } else {
        document.getElementById('quoteSection').style.display = 'none';
      }
    }

    // ── 파일 핸들링 ──────────────────────────────────────────────────────────
    const HWP_RE    = /\.hwpx?$/i;                  // 한글 (한컴오피스 COM)
    const OFFICE_RE = /\.(docx?|xlsx?|pptx?)$/i;    // MS Office (Word·Excel·PowerPoint COM)
    const ADOBE_RE  = /\.(psd|indd)$/i;            // Photoshop·InDesign (Adobe COM)
    const AI_RE     = /\.ai$/i;                    // Illustrator (PDF 호환본은 직접, 아니면 COM)
    const CONVERT_RE = /\.(hwpx?|docx?|xlsx?|pptx?|psd|indd|ai)$/i; // PDF 변환이 필요한 모든 확장자

    // ── 최근 파일 (localStorage, 최대 8개) ──────────────────────────────────
    function loadRecentFiles() {
      try { return JSON.parse(localStorage.getItem('recentFiles')) || []; } catch (e) { return []; }
    }
    function addRecentFile(it) {
      if (!it || !it.path) return;
      try {
        let list = loadRecentFiles().filter(r => r.path !== it.path);
        list.unshift({ name: it.name, path: it.path, ts: Date.now() });
        localStorage.setItem('recentFiles', JSON.stringify(list.slice(0, 8)));
        renderRecentFiles();
      } catch (e) {}
    }
    function removeRecentFile(p) {
      try {
        localStorage.setItem('recentFiles', JSON.stringify(loadRecentFiles().filter(r => r.path !== p)));
        renderRecentFiles();
      } catch (e) {}
    }
    function clearRecentFiles() {
      if (!loadRecentFiles().length) return;
      if (!confirm('최근 파일 기록을 모두 삭제할까요?')) return;
      try { localStorage.removeItem('recentFiles'); } catch (e) {}
      renderRecentFiles();
    }
    function renderRecentFiles() {
      const box = document.getElementById('recentFiles');
      if (!box) return;
      const list = loadRecentFiles();
      box.innerHTML = '';
      if (!list.length) { box.style.display = 'none'; return; }
      box.style.display = 'flex';
      const lbl = document.createElement('span'); lbl.className = 'recent-label'; lbl.textContent = '🕘 최근 파일:';
      box.appendChild(lbl);
      list.forEach(r => {
        // 칩(파일명 클릭=열기) + × 삭제 버튼
        const item = document.createElement('span');
        item.className = 'recent-item'; item.title = r.path;
        const chip = document.createElement('button');
        chip.className = 'recent-chip'; chip.textContent = r.name;
        chip.onclick = (e) => { e.stopPropagation(); openRecentFile(r); };
        const del = document.createElement('button');
        del.className = 'recent-del'; del.textContent = '×'; del.title = '이 항목을 최근 목록에서 삭제';
        del.onclick = (e) => { e.stopPropagation(); removeRecentFile(r.path); };
        item.appendChild(chip); item.appendChild(del);
        box.appendChild(item);
      });
      // 전체 삭제
      const clear = document.createElement('button');
      clear.className = 'recent-clear'; clear.textContent = '🗑 기록 전체삭제'; clear.title = '최근 파일 기록을 모두 삭제';
      clear.onclick = (e) => { e.stopPropagation(); clearRecentFiles(); };
      box.appendChild(clear);
    }
    async function openRecentFile(r) {
      hideError(); hideSuccess();
      try {
        if (CONVERT_RE.test(r.name)) showLoading('문서를 PDF로 변환하고 있습니다…');
        const files = await prepareFiles([{ name: r.name, path: r.path }]);
        hideLoading();
        if (files.length) startLoad(files);
        else removeRecentFile(r.path);   // 변환/읽기 실패(파일 삭제·이동 등) → 목록에서 제거
      } catch (e) {
        hideLoading(); removeRecentFile(r.path);
        showError('최근 파일 열기 실패: ' + (e && e.message ? e.message : String(e)));
      }
    }

    // ── 가져오기 실패 재시도 ─────────────────────────────────────────────────
    // prepareFiles가 항목별 실패를 여기에 모으고, 에러 배너에 '다시 시도' 버튼을 붙인다.
    let _failedImports = [];
    function showImportFailures() {
      if (!_failedImports.length) return;
      const names = _failedImports.map(f => f.name).join(', ');
      const reason = _failedImports[0].reason || '';
      errorEl.innerHTML = '';
      const txt = document.createElement('span');
      txt.textContent = `${_failedImports.length}개 파일 변환/읽기 실패: ${names}` + (reason ? `\n${reason}` : '');
      const btn = document.createElement('button');
      btn.className = 'retry-import-btn';
      btn.textContent = '↻ 다시 시도';
      btn.onclick = retryFailedImports;
      errorEl.append(txt, btn);
      errorEl.style.display = 'block';
      successEl.style.display = 'none';
    }
    async function retryFailedImports() {
      if (!_failedImports.length) return;
      const items = _failedImports.map(f => ({ name: f.name, path: f.path }));
      _failedImports = [];
      hideError();
      try {
        showLoading('실패한 파일을 다시 변환하는 중…');
        const files = await prepareFiles(items);
        hideLoading();
        if (files.length) startLoad(files);
      } catch (e) {
        hideLoading();
        showError('다시 시도 실패: ' + (e && e.message ? e.message : String(e)));
      }
    }

    // 경로 기반 입력({name, path})을 File-like 객체로 변환.
    // HWP/HWPX=한글 COM, MS Office=Office COM, Photoshop/InDesign=Adobe COM으로 PDF 변환.
    // Illustrator .ai는 PDF 호환 저장본이면 그 자체가 PDF라 앱 실행 없이 직접 사용한다.
    // (변환 계열은 모두 단일 인스턴스라 순차 변환)
    // 한 파일이 실패해도 전체가 중단되지 않는다 — 실패 항목은 _failedImports에 모아
    // '다시 시도' 버튼을 노출하고, 성공한 파일들만 반환한다.
    async function prepareFiles(items) {
      const out = [];
      const failed = [];
      for (const it of items) {
        try {
          let pdfPath = null;
          let directBytes = null;   // 이미 읽어둔 PDF 바이트 재사용(.ai PDF 호환본)
          if (HWP_RE.test(it.name)) {
            showLoading(`${it.name} → PDF로 변환 중…`);
            pdfPath = await window.electronAPI.convertHwpToPdf(it.path);
          } else if (OFFICE_RE.test(it.name)) {
            showLoading(`${it.name} → PDF로 변환 중…`);
            pdfPath = await window.electronAPI.convertOfficeToPdf(it.path);
          } else if (ADOBE_RE.test(it.name)) {
            showLoading(`${it.name} → PDF로 변환 중… (Adobe 앱 실행, 수십 초 걸릴 수 있어요)`);
            pdfPath = await window.electronAPI.convertAdobeToPdf(it.path);
          } else if (AI_RE.test(it.name)) {
            // Illustrator .ai: PDF 호환 저장본(%PDF로 시작)이면 그대로 PDF로 사용
            const ab = window.electronAPI.readFile(it.path);
            const h = new Uint8Array(ab.slice(0, 5));
            const isPdf = h[0]===0x25 && h[1]===0x50 && h[2]===0x44 && h[3]===0x46; // "%PDF"
            if (isPdf) {
              directBytes = ab;
            } else {
              showLoading(`${it.name} → PDF로 변환 중… (Illustrator 실행)`);
              pdfPath = await window.electronAPI.convertAdobeToPdf(it.path);
            }
          }
          const readPath = pdfPath || it.path;
          const tmpToClean = pdfPath; // 변환으로 생성된 임시 PDF만 정리 대상
          out.push({
            name: it.name,                       // 원본 이름(확장자 포함) 유지 — 표시·저장명에 사용
            size: 0,
            type: 'application/pdf',
            arrayBuffer: () => Promise.resolve(directBytes || window.electronAPI.readFile(readPath))
              .then(buf => {
                // 메모리로 읽어들였으니 변환 임시 PDF는 즉시 삭제 (디스크 누적 방지)
                if (tmpToClean && window.electronAPI.cleanupTempFile) {
                  try { window.electronAPI.cleanupTempFile(tmpToClean); } catch (e) {}
                }
                return buf;
              }),
          });
          if (it.path) addRecentFile(it);   // 성공한 파일만 최근 목록에 기록
        } catch (e) {
          console.error('파일 준비 실패:', it.name, e);
          failed.push({ name: it.name, path: it.path, reason: (e && e.message) || String(e) });
        }
      }
      if (failed.length) { _failedImports = failed; showImportFailures(); }
      return out;
    }

    async function openFilesDialog() {
      try {
        const result = await window.electronAPI.openFile();
        if (!result || !result.length) return;
        hideError(); hideSuccess();
        const needConvert = result.some(r => CONVERT_RE.test(r.name));
        if (needConvert) showLoading('문서를 PDF로 변환하고 있습니다…');
        // preload의 readFile()로 파일을 직접 읽어 File-like 객체 생성
        // (IPC로 대용량 바이너리를 전달하지 않아 빠르고 안정적)
        const fakeFiles = await prepareFiles(result);
        if (needConvert) hideLoading();
        if (fakeFiles.length) startLoad(fakeFiles);
      } catch(e) {
        hideLoading();
        showError('파일 열기 오류: ' + (e && e.message ? e.message : String(e)));
        console.error('openFilesDialog 오류:', e);
      }
    }

    // 분석이 끝나 챕터로 합칠 수 있는 상태인지
    function isTabReady(t) {
      return t && t.status === 'ready' && t.originalPdfBytes && t.pageResults.filter(Boolean).length;
    }

    function startLoad(files) {
      // 이미 분석이 끝난 문서가 있으면, 새 파일을 별도 탭이 아니라 그 문서에 챕터로 추가
      // (활성 탭 우선, 없으면 분석이 끝난 첫 탭을 기준으로 합본)
      const baseTab = isTabReady(tabs.get(activeTabId))
        ? tabs.get(activeTabId)
        : [...tabs.values()].find(isTabReady);
      if (baseTab) {
        appendImportedFiles(files, baseTab);
        return;
      }

      clearTimeout(_fileInfoTimer);
      fileInfo.style.display = 'block';
      fileInfo.style.opacity = '1';
      fileInfo.innerHTML = files.length > 1
        ? `<strong>${files.length}개 파일</strong> 동시 분석 중`
        : `<strong>${files[0].name}</strong> — 분석 중…`;

      const firstTab = createTab(files[0]);
      activateTab(firstTab.id);
      analyzePDF(files[0], firstTab);

      for (let i = 1; i < files.length; i++) {
        const tab = createTab(files[i]);
        analyzePDF(files[i], tab);
      }
    }

    // ── 기존 분석본에 새 파일을 챕터로 이어붙이기 ────────────────────────────
    // 활성 분석본(baseTab)의 페이지(기존 챕터 보존)에 새로 가져온 파일들을 차례로
    // 챕터로 추가해 하나의 PDF로 합치고, 그 합본을 다시 분석한다.
    // 결과는 단일 탭이므로 다운로드 버튼으로 하나의 파일로 저장할 수 있다.
    async function appendImportedFiles(newFiles, baseTab) {
      try {
        hideError(); hideSuccess();
        showLoading(`기존 분석본에 ${newFiles.length}개 파일을 챕터로 추가하는 중…`);

        const mergedDoc = await PDFLib.PDFDocument.create();
        const chapters  = [];          // 파일별 챕터 경계 {name, start(1-based), count}

        // 1) 기준 문서(베이스) 페이지 복사 — 기존 챕터는 보존, 없으면 전체를 한 챕터로
        const baseSrc    = await PDFLib.PDFDocument.load(baseTab.originalPdfBytes.slice(0));
        const baseIdx    = baseSrc.getPageIndices();
        const baseCopied = await mergedDoc.copyPages(baseSrc, baseIdx);
        baseCopied.forEach(p => mergedDoc.addPage(p));
        if (baseTab.chapters && baseTab.chapters.length) {
          baseTab.chapters.forEach(ch => chapters.push({ ...ch }));
        } else {
          chapters.push({ name: baseTab.fileName, start: 1, count: baseIdx.length });
        }
        let startPage = baseIdx.length + 1;

        // 2) 새로 가져온 파일들을 차례로 챕터로 추가
        for (const f of newFiles) {
          const ab     = await f.arrayBuffer();
          const src    = await PDFLib.PDFDocument.load(ab.slice(0));
          const idx    = src.getPageIndices();
          const copied = await mergedDoc.copyPages(src, idx);
          copied.forEach(p => mergedDoc.addPage(p));
          chapters.push({ name: f.name, start: startPage, count: idx.length });
          startPage += idx.length;
        }

        const bytes = await mergedDoc.save();
        hideLoading();

        // 합본 파일명: 이미 합본이면 그 이름 유지, 아니면 베이스명 기준 "_합본.pdf"
        const mergedName = /_합본\.pdf$/i.test(baseTab.fileName)
          ? baseTab.fileName
          : `${baseTab.fileName.replace(/\.[^.]+$/, '')}_합본.pdf`;

        const buf  = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const file = {
          name: mergedName, size: bytes.byteLength, type: 'application/pdf',
          arrayBuffer: () => Promise.resolve(buf.slice(0)),
        };

        // 합본을 새 탭으로 열어 분석하고, 흡수된 베이스 탭은 닫는다
        const tab = createTab(file);
        tab.chapters = chapters;       // 분석 완료 후 페이지별 챕터 태깅에 사용
        activateTab(tab.id);
        closeTab(baseTab.id);
        await analyzePDF(file, tab);

        showSuccess(`${newFiles.length}개 파일을 챕터로 추가했습니다. 다운로드 버튼으로 하나의 PDF로 저장할 수 있습니다.`);
      } catch (e) {
        hideLoading();
        showError('파일 추가 중 오류: ' + (e && e.message ? e.message : String(e)));
        console.error('appendImportedFiles 오류:', e);
      }
    }

    // ── PDF 분석 (병렬, 탭별 독립 실행) ──────────────────────────────────────
    async function analyzePDF(file, tabState) {
      const isActive = () => activeTabId === tabState.id;

      try {
        const arrayBuffer = await file.arrayBuffer();
        tabState.originalPdfBytes = new Uint8Array(arrayBuffer.slice(0));
        tabState.fileSize = arrayBuffer.byteLength;
        const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
        tabState.pdfDoc = pdf;
        if (isActive()) { originalPdfBytes = tabState.originalPdfBytes; globalPdfDoc = pdf; }

        // 빈 페이지 삽입·문서 크기 표시에 사용할 1페이지 크기 저장 (pt 단위)
        try {
          const fp = await pdf.getPage(1);
          const vp = fp.getViewport({ scale: 1 });
          tabState.defaultPageSize = [vp.width, vp.height];
        } catch(e) {}
        if (isActive()) updateFileInfo(tabState); // 실제 페이지 크기 표시

        const totalPages = pdf.numPages;
        // 인덱스 순서 보장을 위해 배열 미리 확장
        while (tabState.pageResults.length < totalPages) tabState.pageResults.push(null);

        let colorCount = 0, bwCount = 0, done = 0;

        // 페이지당 분석 동시 처리 — pdf.js 워커는 '문서당 1개'라 한 문서로는 렌더가
        // 직렬화된다(동시성만 올려도 실병렬 X). 같은 바이트로 보조 문서를 2~3개 더
        // 열면 각자 워커를 가져 페이지 렌더가 실제로 병렬화된다(코어 활용 극대화).
        // 메모리 보호: 대용량 파일(>96MB)이나 짧은 문서(<8p)는 보조 문서 생략.
        const CONCURRENCY = Math.max(2, Math.min(navigator.hardwareConcurrency || 4, 8));
        const extraDocs = [];
        if (totalPages >= 8 && tabState.originalPdfBytes.byteLength < 96 * 1024 * 1024) {
          const want = Math.min(3, Math.max(0, Math.floor(CONCURRENCY / 2) - 1));
          for (let e = 0; e < want; e++) {
            try {
              extraDocs.push(await pdfjsLib.getDocument({ data: tabState.originalPdfBytes.slice(0) }).promise);
            } catch (err) { break; }
          }
        }
        const docs = [pdf, ...extraDocs];
        let qi = 0;
        const thumbJobs = [];   // 썸네일 JPEG 인코딩은 렌더와 병행 — 마지막에 일괄 대기
        const tasks = Array.from({ length: totalPages }, (_, i) => async (doc) => {
          const pn   = i + 1;
          const page = await doc.getPage(pn);
          const res  = await analyzePageColor(page);
          const entry = { pageNum: pn, originalIdx: pn - 1, isColor: res.isColor, thumbnail: null,
                          thumbW: res.thumbW, thumbH: res.thumbH, pageWpt: res.pageWpt, pageHpt: res.pageHpt };
          tabState.pageResults[i] = entry;
          thumbJobs.push(res.thumbPromise.then(t => { entry.thumbnail = t; }));
          if (res.isColor) colorCount++; else bwCount++;
          tabState.progress = Math.round(++done / totalPages * 100);
          if (isActive()) updateProgress(tabState.progress);
        });
        // 워커 wi는 docs[wi % docs.length] 문서 담당 — 문서별 부하 균등 분산
        const runWorker = async (wi) => {
          const doc = docs[wi % docs.length];
          while (qi < tasks.length) await tasks[qi++](doc);
        };
        await Promise.all(Array.from({ length: CONCURRENCY }, (_, wi) => runWorker(wi)));
        await Promise.all(thumbJobs);   // 남은 썸네일 인코딩 완료 대기
        // 보조 문서 즉시 해제 (메인 pdf만 상주)
        for (const d of extraDocs) { try { await d.destroy(); } catch (e) {} }

        tabState.colorCount = colorCount;
        tabState.bwCount    = bwCount;
        tabState.status     = 'ready';

        // 합본 탭이면 각 페이지에 원본 파일명(챕터) 태깅 — 그리드·사이드바 구분에 사용
        if (tabState.chapters && tabState.chapters.length) {
          tabState.chapters.forEach(ch => {
            for (let i = ch.start - 1; i < ch.start - 1 + ch.count; i++) {
              if (tabState.pageResults[i]) tabState.pageResults[i].chapter = ch.name;
            }
          });
        }

        if (isActive()) {
          pageResults = tabState.pageResults;
          displayResults(totalPages, colorCount, bwCount, tabState.pageResults);
          showSuccess('PDF 분석이 완료되었습니다!');
        } else {
          // 비활성(백그라운드) 탭: DOM은 그대로 두고 quoteItems만 채워, 나중에 이 탭으로
          // 전환했을 때 renderTabUI가 견적서를 바로 표시할 수 있게 한다.
          tabState.quoteItems.push(...buildQuoteItems(colorCount, bwCount));
        }

      } catch (err) {
        tabState.status   = 'error';
        tabState.errorMsg = err.message || String(err);
        if (isActive()) { hideLoading(); progressBar.style.display = 'none'; showError('PDF 분석 중 오류: ' + tabState.errorMsg); }
      } finally {
        if (isActive()) { hideLoading(); progressBar.style.display = 'none'; }
        renderTabBar();
      }
    }

    async function analyzePageColor(page) {
      try {
        // 페이지 실제 크기(pt) — 표시 스케일 산출 + 혼합문서 크기 판별에 사용
        const vp1 = page.getViewport({ scale: 1 });
        // 썸네일 화질: 화면 DPI(Windows 125~200% 배율 등)와 표시폭에 맞춰
        // '딱 필요한 만큼만' 렌더 → 화질↑·픽셀 낭비 없음. 색상 판정은 어느
        // 해상도든 15k 샘플이면 충분하므로 화질을 올려도 분석 정확도엔 무관.
        // 최대 줌(≈480px)에서도 선명하도록 페이지 폭·DPI 기준으로 타깃 산출.
        // 보통 페이지는 ≈0.8(A4→476px ≈ 최대 줌 폭)로 렌더, 0.5~0.8로 제한해
        // 큰 페이지의 과도 렌더만 방지. (DPI 영향은 1.5까지만 반영해 폭주 차단)
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        let rScale = (480 * dpr) / vp1.width;            // 최대 표시폭 × DPI ÷ 페이지폭
        rScale = Math.max(0.5, Math.min(rScale, 0.8));   // 0.5~0.8 제한
        const vp = page.getViewport({ scale: rScale });
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        canvas.width  = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;

        // 색상 분석
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        // pdf.js 워커 쪽 페이지 리소스 즉시 해제 — 대형 문서에서 워커 메모리 누적으로
        // 뒤 페이지 렌더가 점점 느려지는 것을 방지 (캔버스 픽셀은 이미 복사됨)
        try { page.cleanup(); } catch (e) {}
        const totalPixels = data.length >> 2;
        const sampleStep  = Math.max(1, totalPixels / 15000 | 0);
        let gray = 0;
        for (let i = 0; i < data.length; i += sampleStep * 4) {
          const r = data[i], g = data[i+1], b = data[i+2];
          if (Math.abs(r-g) <= 1 && Math.abs(g-b) <= 1 && Math.abs(r-b) <= 1) gray++;
        }
        const sampled = Math.ceil(totalPixels / sampleStep);
        const isColor = gray / sampled < 0.999999;

        // 썸네일: 같은 캔버스에서 비동기 인코딩(toBlob)→objectURL.
        // 완료를 여기서 기다리지 않고 promise로 반환 — 인코딩이 도는 동안 같은 워커
        // 레인이 다음 페이지 렌더를 시작할 수 있어 렌더·인코딩이 겹쳐 진행된다.
        const thumbPromise = new Promise(res => {
          canvas.toBlob(b => res(b ? URL.createObjectURL(b) : null), 'image/jpeg', 0.85);
        });
        // vp1(실제 페이지 크기 pt)은 위에서 산출함. thumbW/H는 캔버스 실제 픽셀.
        return { isColor, thumbPromise, thumbW: canvas.width, thumbH: canvas.height,
                 pageWpt: vp1.width, pageHpt: vp1.height };
      } catch {
        return { isColor: false, thumbPromise: Promise.resolve(null) };
      }
    }

    function displayResults(totalPages, colorCount, grayscaleCount, results) {
      totalPagesEl.textContent     = totalPages;
      colorPagesEl.textContent     = colorCount;
      grayscalePagesEl.textContent = grayscaleCount;
      colorPercentEl.textContent   = Math.round((colorCount / totalPages) * 100) + '%';

      renderAllPages(results);

      const colorList = results.filter(p => p && p.isColor).map(p => p.pageNum);
      const grayList  = results.filter(p => p && !p.isColor).map(p => p.pageNum);
      rangeSummary.innerHTML = `<strong>컬러 페이지:</strong> ${formatRanges(colorList)}<br><strong>흑백 페이지:</strong> ${formatRanges(grayList)}`;

      resultsSection.style.display = 'block';
      setThumbZoomWidgetVisible(true);
      showSidebar(true);
      applyThumbFontStep(thumbStepIdx);
      setTimeout(initSidebarObserver, 200);
      updateSelectedCount();
      initQuoteSection(colorCount, grayscaleCount);
      updateDownloadBtn();
      if (activeTabId && tabs.has(activeTabId)) updateFileInfo(tabs.get(activeTabId));
      // 분석 완료 → 유휴 시간에 잉크 정규화 변환을 미리 수행(적용 즉시화)
      setTimeout(() => { if (typeof prewarmInkNorm === 'function') prewarmInkNorm(); }, 1200);
    }

    // ── 썸네일 흑백 표시 — CSS filter (GPU 가속, 픽셀 연산 없음) ─────────────
    function convertImgToGrayscale(img) {
      if (img) img.style.filter = 'grayscale(1)';
    }

    function applyGrayscaleToEl(el, pageNum, sbEl) {
      const img = el.querySelector('.page-thumbnail');
      if (img) img.style.filter = 'grayscale(1)';
      const span = el.querySelector('.page-type-inline');
      if (span && !span.dataset.orig) span.dataset.orig = span.textContent;
      if (span) span.textContent = '흑백';
      // 사이드바 동기 (sbEl 미전달 시 DOM 탐색)
      const sb = sbEl ?? sidebar.querySelector(`[data-sb-page="${pageNum}"]`);
      if (sb) { const sbImg = sb.querySelector('img'); if (sbImg) sbImg.style.filter = 'grayscale(1)'; }
    }

    function restoreThumbnailEl(el, pageNum, sbEl) {
      const img = el.querySelector('.page-thumbnail');
      if (img) img.style.filter = '';
      const span = el.querySelector('.page-type-inline');
      if (span && span.dataset.orig) { span.textContent = span.dataset.orig; delete span.dataset.orig; }
      // 사이드바 동기
      const sb = sbEl ?? sidebar.querySelector(`[data-sb-page="${pageNum}"]`);
      if (sb) { const sbImg = sb.querySelector('img'); if (sbImg) sbImg.style.filter = ''; }
    }

    // ── 페이지 선택 ──────────────────────────────────────────────────────────
    let lastClickedIdx = null; // Shift+클릭 범위 기준점

    function selectPageEl(pageNum, element, sbEl) {
      selectedPages.add(pageNum);
      element.classList.add('selected');
      const sb = sbEl ?? sidebar.querySelector(`[data-sb-page="${pageNum}"]`);
      applyGrayscaleToEl(element, pageNum, sb);
      if (sb) sb.classList.add('sb-selected');
    }
    function deselectPageEl(pageNum, element, sbEl) {
      selectedPages.delete(pageNum);
      element.classList.remove('selected');
      const sb = sbEl ?? sidebar.querySelector(`[data-sb-page="${pageNum}"]`);
      restoreThumbnailEl(element, pageNum, sb);
      if (sb) sb.classList.remove('sb-selected');
    }

    function togglePageSelection(pageNum, element, event) {
      const visiblePages = pageResults.filter(Boolean);
      const idx = visiblePages.findIndex(r => r.pageNum === pageNum);

      if (event && event.shiftKey && lastClickedIdx !== null) {
        // Shift+클릭: lastClickedIdx ~ idx 범위 모두 선택
        const from = Math.min(lastClickedIdx, idx);
        const to   = Math.max(lastClickedIdx, idx);
        for (let i = from; i <= to; i++) {
          const r = visiblePages[i];
          if (!r) continue;
          const el = document.querySelector(`[data-page="${r.pageNum}"]`);
          if (el) selectPageEl(r.pageNum, el);
        }
      } else if (event && event.ctrlKey) {
        // Ctrl+클릭: 개별 토글
        if (selectedPages.has(pageNum)) deselectPageEl(pageNum, element);
        else selectPageEl(pageNum, element);
        lastClickedIdx = idx;
      } else {
        // 일반 클릭: 기존 토글
        if (selectedPages.has(pageNum)) deselectPageEl(pageNum, element);
        else selectPageEl(pageNum, element);
        lastClickedIdx = idx;
      }
      updateSelectedCount();
    }

    // 요소 Map 한 번에 수집 → 루프 내 querySelector 제거 (O(n²) → O(n))
    function buildElMaps() {
      const pageElMap = new Map(), sbElMap = new Map();
      document.querySelectorAll('.page-item[data-page]')
        .forEach(el => pageElMap.set(+el.dataset.page, el));
      sidebar.querySelectorAll('[data-sb-page]')
        .forEach(el => sbElMap.set(+el.dataset.sbPage, el));
      return { pageElMap, sbElMap };
    }

    function selectAllColor() {
      deselectAll();
      const { pageElMap, sbElMap } = buildElMaps();
      pageResults.forEach(r => {
        if (!r || !r.isColor) return;
        const el = pageElMap.get(r.pageNum);
        if (el) selectPageEl(r.pageNum, el, sbElMap.get(r.pageNum));
      });
      updateSelectedCount();
    }

    function selectAll() {
      const { pageElMap, sbElMap } = buildElMaps();
      pageResults.forEach(r => {
        if (!r || selectedPages.has(r.pageNum)) return;
        const el = pageElMap.get(r.pageNum);
        if (el) selectPageEl(r.pageNum, el, sbElMap.get(r.pageNum));
      });
      updateSelectedCount();
    }

    function deselectAll() {
      selectedPages.clear();
      document.querySelectorAll('.page-item.selected').forEach(el => {
        el.classList.remove('selected');
        const img = el.querySelector('.page-thumbnail');
        if (img) img.style.filter = '';
        const span = el.querySelector('.page-type-inline');
        if (span && span.dataset.orig) { span.textContent = span.dataset.orig; delete span.dataset.orig; }
      });
      sidebar.querySelectorAll('.sb-item.sb-selected').forEach(el => {
        el.classList.remove('sb-selected');
        const sbImg = el.querySelector('img');
        if (sbImg) sbImg.style.filter = '';
      });
      updateSelectedCount();
    }

    function updateSelectedCount() {
      const count = selectedPages.size;
      selectedCountEl.textContent = `${count}개 선택됨`;
      invalidateProcessed();
      syncSidebarPanel();
      if (typeof refreshPreviewMarks === 'function') refreshPreviewMarks();
      // 미리보기가 켜져 있으면 선택 변경을 실제 흑백변환으로 즉시 반영(캐시로 빠름)
      if (typeof previewVisible === 'function' && previewVisible()) scheduleLivePreview();
    }

    function refreshResults() {
      if (!pageResults.length) return;
      // 편집 적용 결과가 표시 중이면 결과 PDF를 다시 분석해 컬러/흑백 수 + 견적서 갱신
      const pv = document.getElementById('previewSection');
      if (pv && pv.style.display !== 'none' && processedPdfBytes) {
        renderProcessedPreview(processedPdfBytes, { live: false }).then(() => {
          const c = parseInt(colorPagesEl.textContent) || 0;
          const g = parseInt(grayscalePagesEl.textContent) || 0;
          updateQuoteCounts(c, g);
        });
        return;
      }
      let newColor = 0, newGray = 0;
      const colorPages = [], grayPages = [];
      pageResults.forEach(r => {
        if (!r) return;
        if (r.isColor && !selectedPages.has(r.pageNum)) { newColor++; colorPages.push(r.pageNum); }
        else { newGray++; grayPages.push(r.pageNum); }
      });
      colorPagesEl.textContent = newColor;
      grayscalePagesEl.textContent = newGray;
      colorPercentEl.textContent = Math.round(newColor / pageResults.filter(Boolean).length * 100) + '%';
      rangeSummary.innerHTML = `<strong>컬러 페이지:</strong> ${formatRanges(colorPages)}<br><strong>흑백 페이지:</strong> ${formatRanges(grayPages)}`;
      initQuoteSection(newColor, newGray);
      syncSidebarPanel();
    }

    // ── 썸네일 크기 조절 ─────────────────────────────────────────────────────
    // 50% ~ 300%, 10% 단위 (기준 100% = 160px)
    const THUMB_BASE  = 160;
    const THUMB_STEPS = Array.from({ length: 26 }, (_, i) => Math.round(THUMB_BASE * (50 + i * 10) / 100));
    // [80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 256, 272, 288, 304, 320, 336, 352, 368, 384, 400, 416, 432, 448, 464, 480]
    let thumbStepIdx = 5; // 100% (index 5: 50+5*10=100%)

    function thumbFontStep(idx) {
      if (idx <= 2)  return 1;
      if (idx <= 4)  return 2;
      if (idx <= 6)  return 3;
      if (idx <= 9)  return 4;
      if (idx <= 12) return 5;
      if (idx <= 16) return 6;
      if (idx <= 20) return 7;
      return 8;
    }
    function applyThumbFontStep(idx) {
      const grid = document.getElementById('pagesGrid');
      for (let i = 1; i <= 8; i++) grid.classList.remove('thumb-fs-' + i);
      grid.classList.add('thumb-fs-' + thumbFontStep(idx));
    }

    function changeThumbZoom(dir) {
      const next = thumbStepIdx + dir;
      if (next < 0 || next >= THUMB_STEPS.length) return;
      thumbStepIdx = next;
      const px  = THUMB_STEPS[thumbStepIdx];
      const pct = 50 + thumbStepIdx * 10;
      document.getElementById('pagesGrid').style.setProperty('--thumb-size', px + 'px');
      document.getElementById('zoomPct').textContent = pct + '%';
      document.getElementById('zoomOutBtn').disabled = thumbStepIdx === 0;
      document.getElementById('zoomInBtn').disabled  = thumbStepIdx === THUMB_STEPS.length - 1;
      applyThumbFontStep(thumbStepIdx);
    }

    function setThumbZoomWidgetVisible(visible) {
      document.getElementById('thumbZoomWidget').style.display = visible ? 'flex' : 'none';
    }

    // ── 단축키 ───────────────────────────────────────────────────────────────
    // Ctrl 조합: [ 축소 / ] 확대 / Z 실행취소 / Y·Shift+Z 다시실행
    document.addEventListener('keydown', e => {
      if (!e.ctrlKey) return;
      const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);
      const hasTextSel = (window.getSelection() + '').length > 0;
      if (e.key === '[' || e.key === 'BracketLeft')  { e.preventDefault(); changeThumbZoom(-1); }
      else if (e.key === ']' || e.key === 'BracketRight') { e.preventDefault(); changeThumbZoom(+1); }
      else if ((e.key === 'z' || e.key === 'Z') && e.shiftKey) { e.preventDefault(); redoEdit(); }
      else if (e.key === 'z' || e.key === 'Z')        { e.preventDefault(); undoEdit(); }
      else if (e.key === 'y' || e.key === 'Y')        { e.preventDefault(); redoEdit(); }
      // 페이지 클립보드 — 입력창 포커스·텍스트 선택 중엔 브라우저 기본 복사/붙여넣기 우선
      else if ((e.key === 'c' || e.key === 'C') && !inField && !hasTextSel && pageResults.length) { e.preventDefault(); copyPagesToClipboard(); }
      else if ((e.key === 'x' || e.key === 'X') && !inField && !hasTextSel && pageResults.length) { e.preventDefault(); cutPagesToClipboard(); }
      else if ((e.key === 'v' || e.key === 'V') && !inField && pageResults.length)                { e.preventDefault(); pastePagesFromClipboard(); }
    });

    // F5: 결과 새로고침 (입력창 포커스 여부와 무관하게 동작 — 브라우저 새로고침 차단)
    document.addEventListener('keydown', e => {
      if (e.key === 'F5' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        refreshResults();
      }
    });

    // 단일 키: W / R / L / B / C (입력창 포커스 시 무시)
    document.addEventListener('keydown', e => {
      // Esc: 전체화면 편집 작업공간 닫기 (입력창 포커스 중에도 동작)
      if (e.key === 'Escape' && document.body.classList.contains('edit-fullscreen')) {
        e.preventDefault(); exitEditWorkspace(false); return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;
      if (!pageResults.length) return;
      switch (e.key) {
        case 't': case 'T': e.preventDefault(); openContentEditor(ctxTargetIdx >= 0 ? ctxTargetIdx : null); break;
        case 'w': case 'W': e.preventDefault(); ctxInsertBlank();  break;
        case 'd': case 'D': e.preventDefault(); ctxDuplicatePage(); break;
        case 'r': case 'R': e.preventDefault(); ctxRotate(90);     break;
        case 'l': case 'L': e.preventDefault(); ctxRotate(-90);    break;
        case 'b': case 'B': e.preventDefault(); ctxApplyBW();      break;
        case 'c': case 'C':      e.preventDefault(); ctxClearBW();      break;
        case 's': case 'S':      e.preventDefault(); showSidebar(!sbVisible); break;
        case 'e': case 'E':      e.preventDefault(); toggleEditSidebar(); break;
        case 'Delete':           e.preventDefault(); ctxDeletePage();   break;
      }
    });

    // ── 컨텍스트 메뉴 ────────────────────────────────────────────────────────
    let ctxTargetIdx = -1;   // 우클릭·마우스오버된 썸네일의 pageResults 인덱스
    const ctxMenu = document.getElementById('pageCtxMenu');

    function showCtxMenu(e, idx) {
      ctxTargetIdx = idx;
      const menuW = 220, menuH = 340;
      let x = e.clientX, y = e.clientY;
      if (x + menuW > window.innerWidth)  x = window.innerWidth  - menuW - 6;
      if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 6;
      ctxMenu.style.left    = x + 'px';
      ctxMenu.style.top     = y + 'px';
      ctxMenu.style.display = 'block';
    }
    function hideCtxMenu() { ctxMenu.style.display = 'none'; }

    document.addEventListener('click',       hideCtxMenu);
    document.addEventListener('contextmenu', e => { if (!e.target.closest('.page-item')) hideCtxMenu(); });
    document.addEventListener('keydown',     e => { if (e.key === 'Escape') hideCtxMenu(); });

    // 컨텍스트 메뉴 액션 (ctxTargetIdx 또는 마우스오버 썸네일 기준)
    function ctxInsertBlank() {
      hideCtxMenu();
      if (ctxTargetIdx < 0) return;
      insertBlankPage(ctxTargetIdx);
    }
    function ctxRotate(deg) {
      hideCtxMenu();
      if (ctxTargetIdx < 0) return;
      rotatePage(ctxTargetIdx, deg);
    }
    function ctxApplyBW() {
      hideCtxMenu();
      if (ctxTargetIdx < 0) return;
      const r = pageResults[ctxTargetIdx];
      if (!r) return;
      const el = document.querySelector(`[data-page="${r.pageNum}"]`);
      if (el && !el.classList.contains('selected')) selectPageEl(r.pageNum, el);
      updateSelectedCount();
    }
    function ctxClearBW() {
      hideCtxMenu();
      if (ctxTargetIdx < 0) return;
      const r = pageResults[ctxTargetIdx];
      if (!r) return;
      const el = document.querySelector(`[data-page="${r.pageNum}"]`);
      if (el && el.classList.contains('selected')) deselectPageEl(r.pageNum, el);
      updateSelectedCount();
    }
    function ctxDeletePage() {
      hideCtxMenu();
      if (ctxTargetIdx < 0) return;
      deletePage(ctxTargetIdx);
    }
    function ctxDuplicatePage() {
      hideCtxMenu();
      if (ctxTargetIdx < 0) return;
      duplicatePage(ctxTargetIdx);
    }
    function ctxSplitChapter() {
      const idx = ctxTargetIdx;
      hideCtxMenu();
      if (idx < 0) return;
      splitChapterAt(idx);
    }
    function ctxCopyPages()  { hideCtxMenu(); copyPagesToClipboard(); }
    function ctxCutPages()   { hideCtxMenu(); cutPagesToClipboard(); }
    function ctxPastePages() { hideCtxMenu(); pastePagesFromClipboard(); }
    function ctxEditContent() {
      const idx = ctxTargetIdx;
      hideCtxMenu();
      openContentEditor(idx);
    }

    // ── 페이지 내부 편집기(별도 창) ──────────────────────────────────────────
    // 원본 PDF는 임시파일로 넘기고(대용량 IPC 손상 방지) 편집기는 fs로 직접 읽는다.
    async function openContentEditor(startDisplayIdx) {
      if (!originalPdfBytes || !pageResults.filter(Boolean).length) { showError('편집할 PDF가 없습니다.'); return; }
      try {
        const buf = originalPdfBytes.slice ? originalPdfBytes.slice(0) : originalPdfBytes;
        const pdfPath = window.electronAPI.writeTempFile(buf, 'pdf');
        // 표시순서(빈 페이지 제외) — 편집기 왼쪽 페이지목록·번호용
        const order = pageResults.filter(r => r && !r.isBlank).map(r => ({ originalIdx: r.originalIdx, num: r.pageNum }));
        if (!order.length) { showError('편집 가능한 원본 페이지가 없습니다.'); return; }
        // 기존 편집 모델 전달(재편집)
        const modelsObj = {};
        contentEdits.forEach((v, k) => { modelsObj[k] = v.model || []; });
        // 시작 페이지 originalIdx
        let startIdx = order[0].originalIdx;
        const sr = (startDisplayIdx != null) ? pageResults[startDisplayIdx] : null;
        if (sr && !sr.isBlank) startIdx = sr.originalIdx;
        await window.electronAPI.openEditor({ pdfPath, models: modelsObj, startIdx, order });
      } catch (e) {
        console.error('편집기 열기 실패:', e);
        showError('내부 편집기 열기 실패: ' + (e.message || e));
      }
    }

    // 편집기 저장 결과 반영: contentEdits 병합 → 캐시 무효 → 썸네일 재생성 → 화면 반영
    async function applyEditorResult(result) {
      if (!result) return;
      const { edits, removed } = result;
      const changed = [];
      try {
        showLoading('내부 편집 반영 중…');
        if (edits) {
          for (const k of Object.keys(edits)) {
            const idx = +k, e = edits[k] || {};
            let bytes = null;
            try { bytes = new Uint8Array(window.electronAPI.readFile(e.bytesPath)); }
            catch (err) { console.error('편집결과 읽기 실패:', err); }
            finally { try { window.electronAPI.removeTempFile(e.bytesPath); } catch (x) {} }
            if (!bytes) continue;
            const prev = contentEdits.get(idx);
            contentEdits.set(idx, { model: e.model || [], bytes, rev: (prev ? prev.rev : 0) + 1 });
            changed.push(idx);
          }
        }
        if (removed && removed.length) {
          removed.forEach(idx => { if (contentEdits.has(idx)) { contentEdits.delete(idx); changed.push(idx); } });
        }
        if (!changed.length) { hideLoading(); return; }
        clearProcessCaches();                 // base·bw·편집doc·미리보기 캐시 전부 무효화
        await regenEditedThumbs([...new Set(changed)]);
        setDirty(true);
        refreshResults();                     // 그리드·사이드바 썸네일 갱신
        updateDownloadBtn();
        if (previewVisible() || shouldPreview()) scheduleLivePreview(); else invalidateProcessed();
        showSuccess(`내부 편집을 반영했습니다 (${new Set(changed).size}개 페이지). '✔ 적용' 후 '⇩ 다운로드'로 저장하세요.`);
      } catch (e) {
        console.error('편집 반영 오류:', e);
        showError('내부 편집 반영 오류: ' + (e.message || e));
      } finally { hideLoading(); }
    }

    // 편집/삭제된 페이지의 썸네일을 편집본(또는 원본)으로 다시 렌더
    async function regenEditedThumbs(indices) {
      for (const idx of indices) {
        const r = pageResults.find(x => x && !x.isBlank && x.originalIdx === idx);
        if (!r) continue;
        const ed = contentEdits.get(idx);
        let pdf = null;
        try {
          const data = ed ? ed.bytes.slice(0) : originalPdfBytes.slice(0);
          pdf = await pdfjsLib.getDocument({ data }).promise;
          const page = await pdf.getPage(ed ? 1 : idx + 1);
          const res = await analyzePageColor(page);
          const thumb = res && res.thumbPromise ? await res.thumbPromise : null;
          if (thumb) {
            if (r.thumbnail && typeof r.thumbnail === 'string' && r.thumbnail.startsWith('blob:'))
              { try { URL.revokeObjectURL(r.thumbnail); } catch (x) {} }
            r.thumbnail = thumb; r.thumbW = res.thumbW; r.thumbH = res.thumbH; r.isColor = res.isColor;
          }
        } catch (e) { console.error('썸네일 재생성 실패:', e); }
        finally { if (pdf) { try { pdf.destroy(); } catch (x) {} } }
      }
    }

    // 편집기 → 메인: 저장 결과 수신 등록 (1회)
    try { window.electronAPI.onEditorResult && window.electronAPI.onEditorResult(applyEditorResult); } catch (e) {}

    function jumpToPage() {
      const input = document.getElementById('jumpPageInput');
      const num = parseInt(input.value);
      const total = pageResults.filter(Boolean).length;
      if (!num || num < 1 || num > total) {
        input.style.borderColor = '#dc3545';
        setTimeout(() => { input.style.borderColor = ''; }, 1000);
        return;
      }
      const el = document.querySelector(`[data-page="${num}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.remove('page-jump-highlight');
      void el.offsetWidth;
      el.classList.add('page-jump-highlight');
      setTimeout(() => el.classList.remove('page-jump-highlight'), 1300);
    }

    // ── 처리 옵션 / 버튼 상태 ────────────────────────────────────────────────
    // 임포징 포함 여부를 app-core에서 안전하게 읽는다. _impEnabled는 뒤에 로드되는
    // app-process.js의 최상위 let이라 이 파일 실행 시점엔 TDZ — typeof도 던지므로 try로 감싼다.
    function impIncluded() {
      try { return !!_impEnabled; } catch (e) { return false; }
    }
    // 적용 버튼: 수정사항(흑백옵션·페이지편집·페이지선택)이 있으면 활성화
    // 다운로드 버튼: '적용'으로 결과가 만들어진 뒤에만 활성화, 적용 진행 중엔 비활성화
    function updateDownloadBtn() {
      const anyActive = Object.values(processingOptions).some(v => v);
      // 편집 사이드바(크기·N-up·테두리·머리글바닥글·워터마크, 챕터별 개별 설정 포함)만
      // 설정한 경우도 '수정사항'으로 인정해야 메인/사이드바의 '적용' 버튼이 편집창의
      // '편집 적용'과 같은 조건으로 활성화된다.
      // 임포징 포함(_impEnabled)도 단독으로 '수정사항' — 빠져 있으면 임포징만 켠 상태에서
      // 메인/사이드바 '적용'이 비활성이라 전체화면으로 펼쳐야만 반영되는 비대칭이 생긴다.
      const hasMod    = !!originalPdfBytes && (anyActive || pageEdited || selectedPages.size > 0 || hasAnyActiveLayout() || hasContentEdits() || impIncluded());
      const applyBtn    = document.getElementById('applyBtn');
      const downloadBtn = document.getElementById('downloadBtn');
      // 적용 결과가 이미 최신이면(processedPdfBytes 존재 — 어떤 수정이든 생기면
      // invalidateProcessed()가 null로 비움) 다시 적용할 필요가 없으므로 비활성화.
      const upToDate  = !!processedPdfBytes;
      if (applyBtn)    applyBtn.disabled    = applying || !hasMod || upToDate;
      // 다운로드: PDF가 열려 있으면 클릭 가능(우클릭→원본 저장). 적용 전이면 흐리게 표시.
      if (downloadBtn) {
        downloadBtn.disabled = applying || !originalPdfBytes;
        downloadBtn.classList.toggle('btn-dim', !processedPdfBytes);
      }
      const clearBtn = document.getElementById('clearOptsBtn');
      if (clearBtn) clearBtn.style.display = anyActive ? '' : 'none';
      // 편집 패널 적용/다운로드 버튼
      const esApply = document.getElementById('esApplyBtn');
      const esDownload = document.getElementById('esDownloadBtn');
      if (esApply) esApply.disabled = applying || !originalPdfBytes || upToDate;
      if (esDownload) esDownload.disabled = applying || !processedPdfBytes;
      // '적용 필요' 강조 — 자동 반영(liveAutoPreview)이 꺼져 있으면 설정을 바꿔도 화면이
      // 그대로라 반영이 안 된 것으로 오해하기 쉽다. 미리보기가 떠 있지 않아도 보이도록
      // 적용 버튼 자체에 표시한다.
      // 단, 버튼 활성 조건(hasMod)을 그대로 쓰면 안 된다 — inkNorm이 기본 ON이라 PDF를
      // 열자마자 hasMod가 참이 되어, 사용자가 아무것도 건드리지 않았는데 계속 깜빡인다.
      // 강조는 '사용자가 실제로 바꾼 것'이 있을 때만: 기본값과 달라진 옵션 + 실제 편집.
      const optsChanged = processingOptions.bw || processingOptions.inkNorm !== true;
      const userMod = !!originalPdfBytes && (optsChanged || pageEdited || selectedPages.size > 0
                      || hasAnyActiveLayout() || hasContentEdits() || impIncluded());
      const needsApply = userMod && !upToDate && !applying;
      ['applyBtn', 'sb-applyBtn', 'esApplyBtn'].forEach(id => {
        const b = document.getElementById(id);
        if (b) b.classList.toggle('needs-apply', needsApply && !b.disabled);
      });
      syncSidebarPanel();
    }

    // 새 수정이 생기면 직전 '적용' 결과는 무효화 (다시 적용해야 다운로드 가능)
    function invalidateProcessed() {
      if (!applying) { processedPdfBytes = null; processedFileName = ''; }
      updateDownloadBtn();
    }

    function toggleOption(key) {
      processingOptions[key] = !processingOptions[key];
      document.getElementById(`opt-${key}`).classList.toggle('active', processingOptions[key]);
      invalidateProcessed();
      if (typeof previewVisible === 'function' && previewVisible()) scheduleLivePreview();
      // 잉크 정규화를 켜면 유휴 시간에 미리 변환 시작
      if (key === 'inkNorm' && processingOptions.inkNorm) setTimeout(prewarmInkNorm, 300);
    }

    function clearOptions() {
      Object.keys(processingOptions).forEach(k => {
        processingOptions[k] = false;
        const btn = document.getElementById('opt-' + k);
        if (btn) btn.classList.remove('active');
      });
      invalidateProcessed();
    }



    // ── base(순서·회전·흑백) 빌드 — 결과를 시그니처로 캐시 (실시간 미리보기 재사용) ──
    let _baseCache = { sig: null, bytes: null, stats: null };
    // 페이지 단위 흑백변환 캐시: originalIdx → 변환된 단일페이지 PDFDocument.
    // 선택이 바뀌어도 '새로 선택된 페이지'만 변환하므로 재적용이 매우 빠르다.
    let _bwCache = new Map();
    // 페이지 내부편집 소스 캐시: originalIdx → 편집이 구워진 단일페이지 PDFDocument.
    // contentEdits[idx].bytes(편집된 단일페이지 PDF)를 1회 load해 재사용한다.
    let _editDocCache = new Map();
    // 페이지 편집 버전(캐시 무효화·시그니처용) — 편집이 없으면 0.
    function editRev(idx) { const e = contentEdits && contentEdits.get(idx); return e ? (e.rev || 0) : 0; }
    // 편집된 단일페이지 PDFDocument를 load해 캐시에서 반환(편집 없으면 null).
    async function getEditedPageDoc(idx) {
      const e = contentEdits && contentEdits.get(idx);
      if (!e || !e.bytes) return null;
      const cached = _editDocCache.get(idx);
      if (cached && cached.rev === (e.rev || 0)) return cached.doc;
      const doc = await PDFLib.PDFDocument.load(e.bytes.slice ? e.bytes.slice(0) : e.bytes);
      _editDocCache.set(idx, { rev: e.rev || 0, doc });
      return doc;
    }
    // 레이아웃 변환(N-up·규격화·테두리·머리글바닥글·워터마크) 결과 캐시 — 실시간 미리보기가
    // 이미 계산한 결과를 '적용' 버튼이 그대로 재사용해 중복 워커 실행(딜레이)을 없앤다.
    let _layoutCache = { sig: null, bytes: null };
    // 조립된 base 문서 캐시(회전 제외한 순서+흑백 기준). 회전만 바뀌면 이 문서를 그대로
    // 재사용해 각 페이지 /Rotate만 다시 세팅→재저장한다(load·copyPages·흑백조립 생략).
    // pages[i] = { page(PDFPage), baseAngle(원본 /Rotate) } — baseAngle 기준이라 회전이
    // 누적되지 않고 항상 (원본각+요청각)으로 idempotent하게 반영된다.
    let _baseAssembled = null; // { key, outDoc, pages:[{page,baseAngle}], stats, validCount }
    // 다운로드용 최적화본 캐시 (buildOptimizedOutput 결과; 프리웜으로 미리 채움)
    let _optCache = { sig: null, bytes: null };
    function clearProcessCaches() {
      _baseCache = { sig: null, bytes: null, stats: null };
      _bwCache = new Map();
      _editDocCache = new Map();
      _layoutCache = { sig: null, bytes: null };
      _baseAssembled = null;
      _pvPageCache = new Map();
      _optCache = { sig: null, bytes: null };
      releasePreviewDoc();
    }
    // 회전을 뺀 base 키(페이지 순서 + 흑백선택). 회전만 바뀌면 이 키가 동일 → 조립본 재사용.
    function baseOrderBwKey() {
      const valid = pageResults.filter(Boolean);
      const order = valid.map(r => (r.isBlank ? 'b' + (r.pageSize || []).join('x') : r.originalIdx) + (r.isBlank ? '' : '@' + editRev(r.originalIdx))).join('|');
      const bw = (processingOptions.bw && selectedPages.size) ? [...selectedPages].sort((a, b) => a - b).join(',') : '';
      return order + '#' + bw + (processingOptions.inkNorm ? '#ink' : '');
    }
    function baseSignature() {
      const valid = pageResults.filter(Boolean);
      const order = valid.map(r => `${r.isBlank ? 'b' + (r.pageSize || []).join('x') : r.originalIdx + '@' + editRev(r.originalIdx)}:${r.rotation || 0}`).join('|');
      const bw = (processingOptions.bw && selectedPages.size) ? [...selectedPages].sort((a, b) => a - b).join(',') : '';
      return order + '#' + bw + (processingOptions.inkNorm ? '#ink' : '');
    }
    // ── 흑백(DeviceGray) 변환 대상 판정 — 적용(buildBaseProcessed)과 다운로드
    // (buildBaseOptimized) 두 파이프라인이 반드시 이 함수를 공유한다.
    // (한쪽에만 조건이 빠져 다운로드본에서 잉크 정규화가 누락됐던 버그의 재발 방지)
    function isBwTarget(r) {
      if (!r || r.isBlank) return false;
      if (processingOptions.bw && selectedPages.size > 0 && selectedPages.has(r.pageNum)) return true;
      return !!processingOptions.inkNorm && !r.isColor;
    }

    // 필요한 흑백 페이지들을 캐시에 채움(없는 것만 병렬 변환). srcDoc는 1회 로드.
    async function ensureBwConverted(indices, stats, onProgress) {
      const todo = indices.filter(i => !_bwCache.has(i));
      if (!todo.length) { if (onProgress) onProgress(92); return; }
      // 회색 판정 페이지는 Dot Gain 보정을 걸지 않는다(0 강제) — 이미 회색인 페이지의
      // 밝기가 변하는 부작용 방지. 컬러 페이지만 UI에서 선택한 Dot Gain을 적용.
      const colorOf = new Map(pageResults.filter(r => r && !r.isBlank).map(r => [r.originalIdx, !!r.isColor]));
      const src = await PDFLib.PDFDocument.load(originalPdfBytes.slice(0));
      // 1) 각 페이지를 개별 tmp 문서로 복사 (src 동시 접근 방지 위해 순차)
      //    내부편집이 있는 페이지는 원본 대신 '편집된 단일페이지'를 소스로 삼아 흑백 변환한다.
      const tmps = [];
      for (const idx of todo) {
        const tmp = await PDFLib.PDFDocument.create();
        const editedDoc = await getEditedPageDoc(idx);
        const [pg] = editedDoc ? await tmp.copyPages(editedDoc, [0])
                               : await tmp.copyPages(src, [idx]);
        tmp.addPage(pg);
        tmps.push({ idx, tmp });
      }
      // 2) 변환은 CPU 코어 수만큼 병렬
      const SEM = Math.max(navigator.hardwareConcurrency || 4, 4);
      let sem = SEM; const q = [];
      const wait = () => sem > 0 ? (sem--, Promise.resolve()) : new Promise(r => q.push(r));
      const rel = () => { if (q.length) q.shift()(); else sem++; };
      let done = 0;
      await Promise.all(tmps.map(({ idx, tmp }) => (async () => {
        await wait();
        try {
          try { await convertPageToGrayscaleVector(tmp, 0, stats, colorOf.get(idx) ? undefined : 0); }
          catch (e) { if (stats) { stats.errors++; stats.errPages.push(idx + 1); } console.error(`페이지 ${idx + 1} 변환 오류:`, e); }
          _bwCache.set(idx, tmp);
          // 캐시 상한(FIFO) — 페이지당 단일페이지 PDFDocument가 상주하므로 초대형 문서에서
          // 메모리가 무한히 늘지 않게 오래된 항목부터 해제(재요청 시 다시 변환됨)
          if (_bwCache.size > 800) { const k = _bwCache.keys().next().value; _bwCache.delete(k); }
        } finally { done++; if (onProgress) onProgress(10 + done / tmps.length * 80); rel(); }
      })()));
    }
    // ── 잉크 정규화 프리웜 ──────────────────────────────────────────────────
    // 분석이 끝나면 유휴 시간에 흑백 판정 페이지들을 미리 _bwCache로 변환해 두어
    // '적용'을 눌렀을 때 변환 없이 즉시 조립되게 한다. 탭이 바뀌면 결과는 폐기.
    let _inkPrewarmPromise = null;
    function prewarmInkNorm() {
      if (_inkPrewarmPromise || applying) return;
      if (!processingOptions.inkNorm || !originalPdfBytes) return;
      const idxs = pageResults.filter(r => r && !r.isBlank && !r.isColor)
                              .map(r => r.originalIdx)
                              .filter(i => i != null && !_bwCache.has(i));
      if (!idxs.length) return;
      const tabAtStart = activeTabId;
      _inkPrewarmPromise = (async () => {
        try { await ensureBwConverted(idxs, null, null); }
        catch (e) { console.warn('잉크 정규화 프리웜 실패:', e); }
        finally {
          _inkPrewarmPromise = null;
          // 프리웜 도중 탭이 바뀌었으면 엉뚱한 문서의 캐시가 섞였을 수 있음 → 전체 폐기
          if (activeTabId !== tabAtStart) clearProcessCaches();
          // 이어서 다운로드용 최적화본도 미리 생성 — '적용' 전에 다운로드해도 즉시 저장
          else setTimeout(() => { if (typeof prewarmOptimizedOutput === 'function') prewarmOptimizedOutput(); }, 500);
        }
      })();
    }

    async function buildBaseProcessed(onProgress) {
      const sig = baseSignature();
      if (_baseCache.sig === sig && _baseCache.bytes) return _baseCache;
      // 잉크 정규화 프리웜이 돌고 있으면 완료를 기다렸다가 캐시를 재사용(중복 변환 방지)
      if (_inkPrewarmPromise) { if (onProgress) onProgress(8); await _inkPrewarmPromise; }
      const valid = pageResults.filter(Boolean);
      // ── 회전 전용 빠른 경로 ──
      // 순서·흑백이 그대로고 회전만 바뀐 경우: 이미 조립된 outDoc을 재사용해 각 페이지
      // /Rotate만 다시 세팅하고 재저장한다(무거운 load·copyPages·흑백조립 전부 생략).
      const key = baseOrderBwKey();
      if (_baseAssembled && _baseAssembled.key === key && _baseAssembled.pages.length === valid.length) {
        const asm = _baseAssembled;
        if (onProgress) onProgress(20);
        for (let i = 0; i < valid.length; i++) {
          const r = valid[i], { page, baseAngle } = asm.pages[i];
          page.setRotation(PDFLib.degrees((((baseAngle + (r.rotation || 0)) % 360) + 360) % 360));
        }
        if (onProgress) onProgress(80);
        const bytes = await asm.outDoc.save({ useObjectStreams: false, updateFieldAppearances: false });
        _baseCache = { sig, bytes, stats: asm.stats, validCount: valid.length };
        if (onProgress) onProgress(94);
        return _baseCache;
      }
      const isBw = isBwTarget;   // 변환 대상 판정은 다운로드 파이프라인과 공유
      const stats = { errors: 0, errPages: [], converted: 0 };
      if (onProgress) onProgress(5);
      // 흑백 대상 페이지 미리 변환(캐시 미스만 변환)
      const bwIdx = valid.filter(isBw).map(r => r.originalIdx);
      stats.converted = bwIdx.length;
      if (bwIdx.length) await ensureBwConverted(bwIdx, stats, onProgress);

      const srcDoc = await PDFLib.PDFDocument.load(originalPdfBytes.slice(0));
      const outDoc = await PDFLib.PDFDocument.create();
      // 비변환·비편집 원본 페이지는 일괄 copyPages로 리소스 공유 (파일 크기 최소화)
      const isEdited = r => !r.isBlank && contentEdits.has(r.originalIdx);
      const origPages = valid.filter(r => !r.isBlank && !isBw(r) && !isEdited(r));
      const origCopied = origPages.length ? await outDoc.copyPages(srcDoc, origPages.map(r => r.originalIdx)) : [];
      const origMap = new Map(origPages.map((r, i) => [r.originalIdx, origCopied[i]]));
      // 내부편집 페이지(흑백 아님)는 편집된 단일페이지 doc에서 개별 복사
      const editMap = new Map();
      for (const r of valid) {
        if (r.isBlank || isBw(r) || !isEdited(r)) continue;
        const ed = await getEditedPageDoc(r.originalIdx);
        if (ed) { const [pg] = await outDoc.copyPages(ed, [0]); editMap.set(r.originalIdx, pg); }
      }
      // 변환 페이지는 캐시된 단일페이지 doc에서 복사 (흑백 소스는 편집본이 있으면 편집본)
      const bwMap = new Map();
      for (const r of valid) {
        if (!isBw(r)) continue;
        const conv = _bwCache.get(r.originalIdx);
        if (conv) { const [pg] = await outDoc.copyPages(conv, [0]); bwMap.set(r.originalIdx, pg); }
      }
      // 순서대로 조립 + 회전 (baseAngle=원본 /Rotate를 기록해 두면 이후 회전만 바뀔 때
      // outDoc을 재사용해 setRotation→재저장만으로 처리 가능)
      const asmPages = [];
      for (const r of valid) {
        let page;
        if (r.isBlank) page = outDoc.addPage(r.pageSize || [595.28, 841.89]);
        else if (isBw(r) && bwMap.has(r.originalIdx)) page = outDoc.addPage(bwMap.get(r.originalIdx));
        else if (isEdited(r) && editMap.has(r.originalIdx)) page = outDoc.addPage(editMap.get(r.originalIdx));
        else page = outDoc.addPage(origMap.get(r.originalIdx));
        const baseAngle = (page.getRotation && page.getRotation().angle) || 0;
        if (r.rotation) {
          page.setRotation(PDFLib.degrees((((baseAngle + r.rotation) % 360) + 360) % 360));
        }
        asmPages.push({ page, baseAngle });
      }
      if (onProgress) onProgress(94);
      const bytes = await outDoc.save({ useObjectStreams: false, updateFieldAppearances: false });
      _baseAssembled = { key, outDoc, pages: asmPages, stats, validCount: valid.length };
      _baseCache = { sig, bytes, stats, validCount: valid.length };
      return _baseCache;
    }

    function describeLayoutParts(es) {
      const parts = [];
      if (es.scaling.mode === 'standard') parts.push(`${es.scaling.paper} 규격화`);
      else if (es.scaling.mode === 'custom') parts.push(`${es.scaling.customW}×${es.scaling.customH}mm`);
      if ((es.nUp | 0) > 1) parts.push(`${es.nUp}-up 조판${es.gutter ? `(거터 ${es.gutter}mm)` : ''}`);
      if (es.border !== 'none') parts.push('테두리');
      if (es.hf && es.hf.enabled) parts.push('머리글/바닥글');
      if (es.wm && es.wm.enabled && es.wm.text.trim()) parts.push('워터마크');
      return parts;
    }
    // 전역 설정 + 챕터별 개별 설정을 모두 반영해 적용 결과 메시지에 쓸 설명을 만든다.
    function layoutNoteOf() {
      if (!editSettings) return '';
      const notes = [];
      if (hasActiveLayout(editSettings)) notes.push(describeLayoutParts(editSettings).join(', '));
      const byChapter = editSettings.byChapter || {};
      Object.keys(byChapter).forEach(name => {
        if (hasActiveLayout(byChapter[name])) notes.push(`[${name}] ${describeLayoutParts(byChapter[name]).join(', ')}`);
      });
      return notes.length ? ` · 레이아웃: ${notes.join(' / ')}` : '';
    }
    function defaultProcessedName() {
      const now = new Date();
      const ds = now.getFullYear() + String(now.getMonth()+1).padStart(2,'0') + String(now.getDate()).padStart(2,'0')
        + '_' + String(now.getHours()).padStart(2,'0') + String(now.getMinutes()).padStart(2,'0') + String(now.getSeconds()).padStart(2,'0');
      const includeAmt = document.getElementById('includeAmountChk')?.checked;
      const totalSum = includeAmt ? quoteItems.reduce((s, it) => s + itemTotal(it), 0) : 0;
      const amountStr = (includeAmt && totalSum > 0) ? `_${totalSum}원` : '';
      return `${originalFileName}_수정_${ds}${amountStr}.pdf`;
    }

    // ── 흑백 PDF / 편집 적용 (명시적 '적용' 버튼) ─────────────────────────────
    async function applyChanges() {
      if (!originalPdfBytes || !pageResults.filter(Boolean).length) return;
      if (processingOptions.bw && !selectedPages.size) { showError('흑백변환할 페이지를 선택해 주세요.'); return; }
      try {
        applying = true;
        processedPdfBytes = null; processedFileName = '';
        updateDownloadBtn();
        const bwMode = processingOptions.bw && selectedPages.size > 0;
        const inkCnt = processingOptions.inkNorm ? pageResults.filter(r => r && !r.isBlank && !r.isColor).length : 0;
        showLoading(bwMode ? `벡터 흑백변환 중 — 선택 ${selectedPages.size}페이지${inkCnt ? ` + 잉크 정규화 ${inkCnt}페이지` : ''}`
                  : inkCnt ? `잉크 정규화 중 — 흑백 판정 ${inkCnt}페이지를 DeviceGray로 변환`
                  : 'PDF 생성 중...');
        progressBar.style.display = 'block'; updateProgress(0);

        const base = await buildBaseProcessed(p => updateProgress(typeof _impEnabled !== 'undefined' && _impEnabled ? Math.round(p * 0.85) : p));
        let pdfBytes = base.bytes;
        const groups = computeLayoutGroups();
        if (groups.length) {
          updateProgress((typeof _impEnabled !== 'undefined' && _impEnabled) ? 82 : 96);
          pdfBytes = await applyLayoutTransform(pdfBytes, groups, base.sig);
        }
        // 임포징 포함 모드: 조립·레이아웃 결과를 시트로 임포징 (메인 다운로드와 동일 경로)
        if (typeof _impEnabled !== 'undefined' && _impEnabled) {
          updateProgress(88);
          pdfBytes = await buildImposedBytes(pdfBytes, p => updateProgress(88 + Math.round(p * 0.12)));
        }
        const layoutNote = layoutNoteOf() + (typeof impositionNoteOf === 'function' ? impositionNoteOf() : '');

        processedPdfBytes = pdfBytes;
        processedFileName = defaultProcessedName();
        setDirty(true);
        updateProgress(100);
        renderProcessedPreview(pdfBytes);

        const conv = base.stats || { converted: 0, errors: 0, errPages: [] };
        let msg = conv.converted > 0
          ? `적용 완료! ${conv.converted}페이지 흑백 변환됨${layoutNote} — '⇩ 다운로드'를 눌러 저장하세요.`
          : `적용 완료! 편집된 PDF(${base.validCount}페이지)${layoutNote} — '⇩ 다운로드'를 눌러 저장하세요.`;
        if (conv.errors > 0)
          msg += `\n⚠️ 주의: ${conv.errors}개 페이지(${conv.errPages.join(', ')})에서 일부 이미지 변환 실패 — 해당 페이지는 부분적으로 칼라가 남아있을 수 있습니다.`;
        showSuccess(msg);
        // 적용 완료 → 유휴 시간에 다운로드용 최적화본을 미리 생성(다운로드 즉시 저장)
        setTimeout(prewarmOptimizedOutput, 400);
      } catch (err) {
        console.error('편집 적용 오류:', err);
        processedPdfBytes = null; processedFileName = '';
        showError('처리 중 오류: ' + (err && err.message ? err.message : String(err)));
      } finally {
        applying = false;
        updateDownloadBtn();
        hideLoading();
        progressBar.style.display = 'none';
      }
    }

