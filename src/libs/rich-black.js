// ⚫ 혼합 검정(리치 블랙) → K100(먹 1도) — 점검·개체별 선택·바꾸기 (2026-10-20)
// 인쇄물의 검은 면·선·글자가 CMYK 혼합색(C75 M68 Y67 K90 등)이나 RGB 검정(0,0,0)이면 출력기에서 4색으로 겹쳐
// 찍혀 가는 선·작은 글자가 번지거나 판이 어긋나 보인다.
//   · '개체' = 혼합 검정으로 칠하는 동작 하나(면 f/B…, 선 S/s, 글자 Tj/TJ/'/"). 이름표(key)로 하나씩 고르고 뺀다.
//       쪽 내용의 개체: `${쪽 열쇠}:c${순번}` · 폼·타일 패턴·주석 모양 안의 개체: `x${내용 지문}:${순번}`
//       (여러 쪽이 함께 쓰는 폼은 어느 쪽에서 보든 같은 이름표 — 하나를 빼면 함께 빠진다)
//   · 바꾸기는 '색 지정'이 아니라 '칠하기' 앞뒤에 넣는다 — 고른 개체만 K100이 되고 같은 색의 다른 개체는 그대로.
//       도형: 경로가 시작되는 자리에 `q 0 0 0 1 k`, 칠한 뒤 `Q` (경로 중간에는 색 연산자를 넣을 수 없다 — 규격)
//             클립(W)이 함께 걸린 경로는 Q가 클립을 지우므로 q/Q 대신 원래 색을 다시 지정한다.
//       글자: BT 안에서는 q/Q를 못 쓴다 — `0 0 0 1 k (…) Tj <원래 색 지정>`
//   · 그림(사진)·그러데이션(sh·셰이딩 패턴)·별색(Separation/DeviceN)·Indexed·Lab은 건드리지 않는다. DeviceGray는 원래 먹 1도.
//   · 미리보기(richBlackIdDoc): 개체마다 다른 RGB로 칠한 쪽을 그려 원래 쪽과 비교하면 개체마다 자리(상자)가 나온다.
//   · 바이트는 넣는 글자 말고는 그대로 둔다(인라인 그림 바이너리 등).
// 전역: richBlackIsCmyk · richBlackIsRgb · richBlackScanDoc · richBlackFixDoc · richBlackIdDoc · richBlackIdColor
(function (root) {
  'use strict';
  const PL = () => root.PDFLib;

  // CMYK가 '혼합 검정'인가 — 0~1
  //  · K 95% 이상 + C·M·Y가 조금이라도 섞임(C60 M40 Y40 K100, C100 K100 같은 '진한 검정')
  //  · K 60% 이상 + C·M·Y가 고르게(차 35% 이하) 섞여 거의 검게 나옴(잉크 투과 근사 ≤ 6%)
  //    — RGB→CMYK 변환 검정(C75 M68 Y67 K90 · C93 M88 Y89 K80)이 여기 든다. 남색(C100 M80 Y0 K60)은 차가 커서 제외.
  function richBlackIsCmyk(c, m, y, k) {
    const s = c + m + y;
    if (!(s > 0.004)) return false;                 // 이미 K만
    if (k >= 0.95) return true;
    if (k < 0.6) return false;
    const mx = Math.max(c, m, y), mn = Math.min(c, m, y);
    if (mx - mn > 0.35) return false;
    return (1 - c) * (1 - m) * (1 - y) * (1 - k) <= 0.06;
  }
  // RGB 검정 — 세 값이 모두 10% 이하이고 거의 무채색
  function richBlackIsRgb(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return mx <= 0.1 && mx - mn <= 0.05;
  }
  // 미리보기용 개체 색 — id(1~262143)를 RGB 세 값(4 간격)에 담는다. 반환 [r,g,b] 0~255
  function richBlackIdColor(id) { return [((id >> 12) & 63) * 4 + 2, ((id >> 6) & 63) * 4 + 2, (id & 63) * 4 + 2]; }

  // ── 색공간 이름 → 종류 ───────────────────────────────────────────────────
  function csKind(nameStr, resources) {
    if (nameStr === '/DeviceCMYK' || nameStr === '/CMYK') return 'cmyk';
    if (nameStr === '/DeviceRGB' || nameStr === '/RGB') return 'rgb';
    if (nameStr === '/DeviceGray' || nameStr === '/G') return 'gray';
    if (nameStr === '/Pattern') return 'pattern';
    const P = PL();
    try {
      const csDict = resources && resources.lookup(P.PDFName.of('ColorSpace'));
      if (!(csDict instanceof P.PDFDict)) return 'other';
      return csObjKind(csDict.lookup(P.PDFName.of(nameStr.slice(1))));
    } catch (e) { return 'other'; }
  }
  function csObjKind(v) {
    const P = PL();
    if (v instanceof P.PDFName) {
      const n = v.asString();
      return n === '/DeviceCMYK' ? 'cmyk' : n === '/DeviceRGB' ? 'rgb' : n === '/DeviceGray' ? 'gray' : n === '/Pattern' ? 'pattern' : 'other';
    }
    if (v instanceof P.PDFArray && v.size()) {
      const fam = v.lookup(0);
      const f = fam instanceof P.PDFName ? fam.asString() : '';
      if (f === '/CalRGB') return 'rgb';
      if (f === '/CalCMYK') return 'cmyk';
      if (f === '/CalGray') return 'gray';
      if (f === '/Pattern') return 'pattern';
      if (f === '/ICCBased') {
        const st = v.lookup(1);
        const n = st && st.dict ? st.dict.lookup(P.PDFName.of('N')) : null;
        const N = n && n.asNumber ? n.asNumber() : 0;
        if (N === 4) return 'cmyk';
        if (N === 1) return 'gray';
        if (N === 3) {
          // Lab ICC(팬톤 대체 등)는 RGB가 아니다 — 헤더 16~19바이트 색공간 서명으로 가린다
          try {
            const dec = decodeStream(st);
            const sig = dec && dec.length > 20 ? String.fromCharCode(dec[16], dec[17], dec[18], dec[19]) : 'RGB ';
            if (sig !== 'RGB ') return 'other';
          } catch (e) {}
          return 'rgb';
        }
      }
    }
    return 'other';
  }

  // ── 콘텐츠 스트림 훑기 ────────────────────────────────────────────────────
  const WS = new Set([0, 9, 10, 12, 13, 32]);
  const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
  const FILL_OPS = new Set(['f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);
  const STROKE_OPS = new Set(['S', 's', 'B', 'B*', 'b', 'b*']);
  const PATH_OPS = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're']);
  const TEXT_OPS = new Set(['Tj', 'TJ', "'", '"']);
  const pct = v => Math.round(v * 100);
  const cmykName = v => `C${pct(v[0])} M${pct(v[1])} Y${pct(v[2])} K${pct(v[3])}`;
  const rgbName = v => `RGB ${Math.round(v[0] * 255)},${Math.round(v[1] * 255)},${Math.round(v[2] * 255)}`;

  // src: latin1 문자열. keyOf(순번) → 이름표. act(item) → null | { fill?: '넣을 색', stroke?: '넣을 색' }
  // 반환 { out(바뀐 문자열|null), items:[{key, kind, color}], forms:[{name, state}], patterns:[이름] }
  function scanStream(src, resources, opts, initState, keyOf, act) {
    const st0 = initState || {};
    const side = s => ({ kind: s && s.kind || 'gray', rich: !!(s && s.rich), color: s && s.color || '', restore: s && s.restore || '', cs: s && s.cs || '' });
    let gs = { fill: side(st0.fill), stroke: side(st0.stroke) };
    const stack = [];
    const ops = [];
    const edits = [];          // {at, text} 넣기 · {s, e, text} 바꾸기는 쓰지 않는다
    const res = { items: [], forms: [], patterns: [] };
    const n = src.length;
    let i = 0, ord = 0, pathStart = -1, pathClip = false, inText = false;
    const cloneGs = g => ({ fill: Object.assign({}, g.fill), stroke: Object.assign({}, g.stroke) });
    const nums = () => ops.every(o => o.t === 'n') ? ops.map(o => o.v) : null;

    function setColor(which, op, opStart, opEnd) {
      const S = gs[which];
      const start = ops.length ? ops[0].s : opStart;
      const text = src.slice(start, opEnd);
      const v = nums();
      if (op === 'k' || op === 'K') {
        S.kind = 'cmyk'; S.restore = text; S.cs = '';
        S.rich = !opts.rgbOnly && !!(v && v.length === 4 && richBlackIsCmyk(v[0], v[1], v[2], v[3]));
        S.color = S.rich ? cmykName(v) : '';
        return;
      }
      if (op === 'rg' || op === 'RG') {
        S.kind = 'rgb'; S.restore = text; S.cs = '';
        S.rich = !!(opts.rgb && v && v.length === 3 && richBlackIsRgb(v[0], v[1], v[2]));
        S.color = S.rich ? rgbName(v) : '';
        return;
      }
      if (op === 'g' || op === 'G') { S.kind = 'gray'; S.rich = false; S.color = ''; S.restore = text; S.cs = ''; return; }
      if (op === 'cs' || op === 'CS') {
        const nm = ops.length === 1 && ops[0].t === 'name' ? ops[0].v : null;
        S.kind = nm ? csKind(nm, resources) : 'other'; S.rich = false; S.color = ''; S.restore = text; S.cs = text;
        return;
      }
      // sc / scn / SC / SCN — 되돌릴 때는 색공간부터 다시(cs가 같은 스트림에 있었을 때)
      S.restore = (S.cs ? S.cs + ' ' : '') + text;
      const last = ops[ops.length - 1];
      if (!v || (last && last.t === 'name')) { S.rich = false; S.color = ''; if (last && last.t === 'name') res.patterns.push(last.v); return; }
      if (S.kind === 'cmyk' && v.length === 4) { S.rich = !opts.rgbOnly && richBlackIsCmyk(v[0], v[1], v[2], v[3]); S.color = S.rich ? cmykName(v) : ''; return; }
      if (S.kind === 'rgb' && v.length === 3) { S.rich = !!opts.rgb && richBlackIsRgb(v[0], v[1], v[2]); S.color = S.rich ? rgbName(v) : ''; return; }
      S.rich = false; S.color = '';
    }

    while (i < n) {
      const c = src.charCodeAt(i);
      if (WS.has(c)) { i++; continue; }
      if (c === 37) { while (i < n && src.charCodeAt(i) !== 10 && src.charCodeAt(i) !== 13) i++; continue; }   // % 주석
      const s = i;
      if (c === 40) {   // ( 문자열 )
        let depth = 0;
        while (i < n) {
          const d = src.charCodeAt(i);
          if (d === 92) { i += 2; continue; }
          if (d === 40) depth++;
          else if (d === 41) { depth--; if (depth === 0) { i++; break; } }
          i++;
        }
        ops.push({ t: 'x', s, e: i }); continue;
      }
      if (c === 60) {
        if (src.charCodeAt(i + 1) === 60) { i += 2; ops.push({ t: 'x', s, e: i }); continue; }   // <<
        const j = src.indexOf('>', i); i = j < 0 ? n : j + 1; ops.push({ t: 'x', s, e: i }); continue;  // <hex>
      }
      if (c === 62) { i += src.charCodeAt(i + 1) === 62 ? 2 : 1; ops.push({ t: 'x', s, e: i }); continue; }
      if (c === 91 || c === 93 || c === 123 || c === 125) { i++; ops.push({ t: 'x', s, e: i }); continue; }
      if (c === 47) {   // /이름
        i++;
        while (i < n && !WS.has(src.charCodeAt(i)) && !DELIM.has(src.charCodeAt(i))) i++;
        ops.push({ t: 'name', v: src.slice(s, i), s, e: i }); continue;
      }
      while (i < n && !WS.has(src.charCodeAt(i)) && !DELIM.has(src.charCodeAt(i))) i++;
      if (i === s) { i++; continue; }
      const tok = src.slice(s, i);
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) { ops.push({ t: 'n', v: parseFloat(tok), s, e: i }); continue; }
      // ── 연산자 ──
      const op = tok;
      const opStart = ops.length ? ops[0].s : s;
      if (op === 'BI') {   // 인라인 그림 — ID 뒤 바이너리를 EI까지 건너뛴다
        const id = src.indexOf('ID', i);
        let k = id < 0 ? n : id + 3;
        while (k < n) {
          const e = src.indexOf('EI', k);
          if (e < 0) { k = n; break; }
          const before = src.charCodeAt(e - 1), after = e + 2 < n ? src.charCodeAt(e + 2) : 32;
          if (WS.has(before) && (WS.has(after) || e + 2 >= n)) { k = e + 2; break; }
          k = e + 2;
        }
        i = k; ops.length = 0; continue;
      }
      if (op === 'q') stack.push(cloneGs(gs));
      else if (op === 'Q') { if (stack.length) gs = stack.pop(); }
      else if (op === 'BT') inText = true;
      else if (op === 'ET') inText = false;
      else if (op === 'k' || op === 'rg' || op === 'g' || op === 'cs' || op === 'sc' || op === 'scn') setColor('fill', op, s, i);
      else if (op === 'K' || op === 'RG' || op === 'G' || op === 'CS' || op === 'SC' || op === 'SCN') setColor('stroke', op, s, i);
      else if (PATH_OPS.has(op)) { if (pathStart < 0) { pathStart = opStart; pathClip = false; } }
      else if (op === 'W' || op === 'W*') pathClip = true;
      else if (op === 'n') { pathStart = -1; pathClip = false; }
      else if (op === 'Do') {
        const nm = ops.length && ops[ops.length - 1].t === 'name' ? ops[ops.length - 1].v : null;
        if (nm) res.forms.push({ name: nm, state: cloneGs(gs) });
      } else if (FILL_OPS.has(op) || STROKE_OPS.has(op)) {
        const f = FILL_OPS.has(op) && gs.fill.rich, st = STROKE_OPS.has(op) && gs.stroke.rich;
        if (f || st) {
          const key = keyOf(ord++);
          const kind = f && st ? 'both' : f ? 'fill' : 'stroke';
          res.items.push({ key, kind, color: f ? gs.fill.color : gs.stroke.color });
          const a = act && act({ key, kind });
          if (a && pathStart >= 0) {
            const pre = (f && a.fill ? a.fill + ' ' : '') + (st && a.stroke ? a.stroke + ' ' : '');
            if (!pathClip) { edits.push({ at: pathStart, text: 'q ' + pre }); edits.push({ at: i, text: ' Q' }); }
            else {
              // 클립이 남아야 하므로 q/Q 없이 — 칠한 뒤 원래 색을 다시(모르면 바꾸지 않는다)
              const back = (f && a.fill ? gs.fill.restore : '') + ' ' + (st && a.stroke ? gs.stroke.restore : '');
              if ((!f || !a.fill || gs.fill.restore) && (!st || !a.stroke || gs.stroke.restore)) {
                edits.push({ at: pathStart, text: pre }); edits.push({ at: i, text: ' ' + back.trim() });
              }
            }
          }
        }
        pathStart = -1; pathClip = false;
      } else if (TEXT_OPS.has(op)) {
        if (gs.fill.rich) {
          const key = keyOf(ord++);
          res.items.push({ key, kind: 'text', color: gs.fill.color });
          const a = act && act({ key, kind: 'text' });
          if (a && a.fill && gs.fill.restore) { edits.push({ at: opStart, text: a.fill + ' ' }); edits.push({ at: i, text: ' ' + gs.fill.restore }); }
          else if (a && a.fill && !inText) { edits.push({ at: opStart, text: 'q ' + a.fill + ' ' }); edits.push({ at: i, text: ' Q' }); }
        }
      }
      ops.length = 0;
    }
    if (edits.length) {
      edits.sort((a, b) => a.at - b.at);   // 같은 자리면 넣은 순서대로(안정 정렬)
      let out = '', at = 0;
      for (const ed of edits) { out += src.slice(at, ed.at) + ed.text; at = ed.at; }
      res.out = out + src.slice(at);
    } else res.out = null;
    return res;
  }

  // ── 문서 단위 ─────────────────────────────────────────────────────────────
  const toLatin1 = u8 => { let s = ''; const CH = 0x8000; for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return s; };
  const fromLatin1 = s => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff; return u; };
  // 내용 지문(FNV-1a 32비트) — 폼 안 개체의 이름표. 같은 폼은 어느 문서로 복사돼도 내용이 같다
  function fnv(u8) { let h = 0x811c9dc5; for (let i = 0; i < u8.length; i++) { h ^= u8[i]; h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36) + u8.length.toString(36); }

  function decodeStream(st) {
    const P = PL();
    if (st instanceof P.PDFRawStream) return P.decodePDFRawStream(st).decode();
    if (st && typeof st.getUnencodedContents === 'function') return st.getUnencodedContents();
    if (st && typeof st.getContents === 'function') return st.getContents();
    return null;
  }
  // 스트림 객체(ref)를 새 내용으로 — 사전의 다른 항목(BBox·Resources·Matrix…)은 그대로
  function replaceStream(ctx, ref, oldSt, bytes) {
    const ns = ctx.flateStream(bytes);
    for (const [k, v] of oldSt.dict.entries()) {
      const key = k.asString();
      if (key === '/Filter' || key === '/DecodeParms' || key === '/Length' || key === '/DL') continue;
      ns.dict.set(k, v);
    }
    ctx.assign(ref, ns);
  }

  // 내용 하나 + 그 안에서 부르는 폼·타일 패턴까지
  function walk(doc, contentU8, resources, opts, acc, state, keyOf, setOut) {
    const P = PL(), ctx = doc.context;
    let r;
    try { r = scanStream(toLatin1(contentU8), resources, opts, state, keyOf, opts.act); }
    catch (e) { acc.skipped++; return; }
    r.items.forEach(it => acc.items.push(it));
    if (r.out !== null && opts.write) setOut(fromLatin1(r.out));
    const sub = (dictName, nm, isForm, st2) => {
      const holder = resources && resources.lookup(P.PDFName.of(dictName));
      if (!(holder instanceof P.PDFDict)) return;
      const ref = holder.get(P.PDFName.of(nm.slice(1)));
      const obj = holder.lookup(P.PDFName.of(nm.slice(1)));
      if (!obj || !obj.dict) return;
      if (isForm) { const t = obj.dict.lookup(P.PDFName.of('Subtype')); if (!t || t.asString() !== '/Form') return; }
      else { const pt = obj.dict.lookup(P.PDFName.of('PatternType')); if (!pt || pt.asNumber() !== 1) return; }   // 셰이딩 패턴은 그대로
      const rk = ref instanceof P.PDFRef ? ref.toString() : null;
      if (rk && acc.seen.has(rk)) return;
      if (rk) acc.seen.add(rk);
      let data; try { data = decodeStream(obj); } catch (e) { acc.skipped++; return; }
      if (!data) { acc.skipped++; return; }
      const fp = 'x' + fnv(data);
      walk(doc, data, obj.dict.lookup(P.PDFName.of('Resources')) || resources, opts, acc, st2, o => `${fp}:${o}`,
        u8 => { if (ref instanceof P.PDFRef) replaceStream(ctx, ref, obj, u8); });
    };
    r.forms.forEach(f => sub('XObject', f.name, true, f.state));
    r.patterns.forEach(nm => sub('Pattern', nm, false, null));
  }

  // opts: { rgb(기본 true), pages?:[0부터], pageKey?(쪽 번호 0부터) → 쪽 열쇠, act?(item) → 넣을 색, write?:boolean }
  // 반환: { pages:[{ page(1부터), items:[{key,kind,color}], fill, stroke, text, colors }], total:{fill,stroke,text,items}, skipped, changed }
  function processDoc(doc, opts) {
    const P = PL(), ctx = doc.context;
    const o = Object.assign({ rgb: true, write: false }, opts || {});
    const pageKey = o.pageKey || (pi => 'p' + pi);
    const seenWrite = new Set();   // 바꾸기: 함께 쓰는 폼·패턴은 한 번만 고친다
    const out = { pages: [], total: { fill: 0, stroke: 0, text: 0, items: 0 }, skipped: 0, changed: 0 };
    const uniq = new Set();
    const want = o.pages ? new Set(o.pages) : null;
    doc.getPages().forEach((page, pi) => {
      if (want && !want.has(pi)) return;
      const acc = { items: [], seen: o.write ? seenWrite : new Set(), skipped: 0 };   // 점검은 쪽마다(함께 쓰는 폼도 각 쪽에)
      const po = o.act ? Object.assign({}, o, { act: it => o.act(Object.assign(it, { page: pi })) }) : o;
      const node = page.node;
      const resources = node.Resources ? node.Resources() : node.lookup(P.PDFName.of('Resources'));
      const cRaw = node.get(P.PDFName.of('Contents'));
      const cObj = cRaw ? ctx.lookup(cRaw) : null;
      const parts = [];
      try {
        if (cObj instanceof P.PDFArray) { for (let k = 0; k < cObj.size(); k++) parts.push(decodeStream(cObj.lookup(k))); }
        else if (cObj) parts.push(decodeStream(cObj));
      } catch (e) { acc.skipped++; parts.length = 0; }
      const pk = pageKey(pi);
      if (parts.length && parts.every(Boolean)) {
        const len = parts.reduce((s, p) => s + p.length + 1, 0);
        const all = new Uint8Array(len); let at = 0;
        parts.forEach(p => { all.set(p, at); at += p.length; all[at++] = 10; });
        walk(doc, all, resources, po, acc, null, k => `${pk}:c${k}`,
          u8 => { node.set(P.PDFName.of('Contents'), ctx.register(ctx.flateStream(u8))); out.changed++; });
      }
      // 인쇄되는 주석의 모양(AP /N)도 — 저장·인쇄 때 함께 찍힌다
      try {
        const annots = node.lookup(P.PDFName.of('Annots'));
        if (annots instanceof P.PDFArray) {
          for (let k = 0; k < annots.size(); k++) {
            const a = annots.lookup(k);
            const ap = a && a.lookup && a.lookup(P.PDFName.of('AP'));
            if (!(ap instanceof P.PDFDict)) continue;
            const nref = ap.get(P.PDFName.of('N'));
            const ns = ap.lookup(P.PDFName.of('N'));
            if (!ns || !ns.dict || !(nref instanceof P.PDFRef) || acc.seen.has(nref.toString())) continue;
            acc.seen.add(nref.toString());
            const data = decodeStream(ns);
            if (!data) continue;
            const fp = 'x' + fnv(data);
            walk(doc, data, ns.dict.lookup(P.PDFName.of('Resources')) || resources, po, acc, null, q => `${fp}:${q}`,
              u8 => { replaceStream(ctx, nref, ns, u8); out.changed++; });
          }
        }
      } catch (e) { acc.skipped++; }
      out.skipped += acc.skipped;
      if (acc.items.length) {
        const pg = { page: pi + 1, items: acc.items, fill: 0, stroke: 0, text: 0, colors: [] };
        const cs = new Set();
        acc.items.forEach(it => {
          if (it.kind === 'fill' || it.kind === 'both') pg.fill++;
          if (it.kind === 'stroke' || it.kind === 'both') pg.stroke++;
          if (it.kind === 'text') pg.text++;
          cs.add(it.color);
          if (!uniq.has(it.key)) {
            uniq.add(it.key); out.total.items++;
            if (it.kind === 'fill' || it.kind === 'both') out.total.fill++;
            if (it.kind === 'stroke' || it.kind === 'both') out.total.stroke++;
            if (it.kind === 'text') out.total.text++;
          }
        });
        pg.colors = [...cs].slice(0, 6);
        out.pages.push(pg);
      }
    });
    return out;
  }

  // 바꾸기 — opts.isSelected(key) (없으면 전부)가 참인 개체만 K100
  function fixDoc(doc, opts) {
    const sel = opts && opts.isSelected;
    let edits = 0;
    const editPages = new Set();
    const r = processDoc(doc, Object.assign({}, opts, {
      write: true,
      act: it => { if (sel && !sel(it.key)) return null; edits++; editPages.add(it.page); return { fill: '0 0 0 1 k', stroke: '0 0 0 1 K' }; },
    }));
    r.total.edits = edits;
    r.total.editPages = editPages.size;
    return r;
  }
  // RGB 검정 → 리치블랙 처리 — RGB로 칠한 검정만(opts.rgbOnly) 면은 opts.rich(기본 C40 M30 Y30 K100), 글자·선은 K100.
  // RGB 검정은 출력기가 C75 M68 Y67 K90 같은 제멋대로의 4색으로 바꿔 찍는다 — 정한 값으로 미리 바꾼다(사용자 결정 2026-10-20:
  // 값 C40 M30 Y30 K100, 작은 글자·가는 선은 판 어긋남에 번져 보이므로 K100).
  const RGB_RICH_DEFAULT = '0.4 0.3 0.3 1';
  function rgbRichDoc(doc, opts) {
    const rich = (opts && opts.rich) || RGB_RICH_DEFAULT;
    let edits = 0, fills = 0;
    const editPages = new Set();
    const r = processDoc(doc, Object.assign({}, opts, {
      rgb: true, rgbOnly: true, write: true,
      act: it => {
        edits++; editPages.add(it.page);
        if (it.kind === 'text') return { fill: '0 0 0 1 k' };
        if (it.kind === 'stroke') return { stroke: '0 0 0 1 K' };
        fills++;
        return { fill: rich + ' k', stroke: '0 0 0 1 K' };
      },
    }));
    r.total.edits = edits; r.total.richFills = fills; r.total.editPages = editPages.size;
    return r;
  }
  // 미리보기용 — 개체마다 다른 RGB로 칠한다. 반환에 ids: [key, …] (id = 순번+1)
  function idDoc(doc, opts) {
    const ids = [], idOf = new Map();
    const r = processDoc(doc, Object.assign({}, opts, {
      write: true,
      act: it => {
        let id = idOf.get(it.key);
        if (!id) { ids.push(it.key); id = ids.length; idOf.set(it.key, id); }
        const c = richBlackIdColor(id).map(v => (v / 255).toFixed(4)).join(' ');
        return { fill: `${c} rg`, stroke: `${c} RG` };
      },
    }));
    r.ids = ids;
    return r;
  }

  root.richBlackIsCmyk = richBlackIsCmyk;
  root.richBlackIsRgb = richBlackIsRgb;
  root.richBlackIdColor = richBlackIdColor;
  root.richBlackScanStream = scanStream;
  root.richBlackScanDoc = (doc, opts) => processDoc(doc, Object.assign({}, opts, { write: false, act: null }));
  root.richBlackFixDoc = fixDoc;
  root.richBlackIdDoc = idDoc;
  root.rgbRichBlackDoc = rgbRichDoc;
})(typeof self !== 'undefined' ? self : this);
