/* 正文配音（IndexTTS2 音色克隆）——
 * 正文 → 千问27B 拆出「谁说的什么」→ 按角色音色逐句 TTS → 可合并成一条
 * 依赖本机 H3 工作台（默认 http://127.0.0.1:8899）：
 *   GET  /api/tts/voices       已有音色参考
 *   POST /api/tts/upload       上传音色参考（wav/mp3/ogg/flac/m4a）
 *   POST /api/tts/run          {text, ref, emoText} → 一句音频
 *   POST /api/tts/merge        {names:[...]} → 合并成一条
 *   POST /v1/chat/completions  千问拆台词
 */
(function () {
  'use strict';

  const LS = 'h3tts.settings.v1';
  const DEFA = {
    host: 'http://127.0.0.1:8899', key: '', conc: 2, emo: true,
    roles: [{ name: '旁白', ref: '' }, { name: '角色1', ref: '' }],
  };
  let S = Object.assign({}, DEFA);
  try { S = Object.assign(S, JSON.parse(localStorage.getItem(LS) || '{}')); } catch (_) {}
  if (!Array.isArray(S.roles) || !S.roles.length) S.roles = JSON.parse(JSON.stringify(DEFA.roles));
  function saveS() { try { localStorage.setItem(LS, JSON.stringify(S)); } catch (_) {} }

  const $ = (s) => document.querySelector(s);
  const api = (p) => String(S.host || '').replace(/\/+$/, '') + p;
  const abs = (u) => (/^https?:/i.test(u) ? u : api(u));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let VOICES = [];
  let LINES = [];       // {speaker, text, emo, state, url, err}
  let STOP = false;

  /* ---------- 正文抽取（同 H3 插件口径）---------- */
  function lastMesText() {
    const list = Array.from(document.querySelectorAll('#chat .mes .mes_text'));
    const el = list[list.length - 1];
    return el ? el.innerText || '' : '';
  }
  function stripJunk(s) {
    let t = String(s || '');
    t = t.replace(/<!--[\s\S]*?-->/g, '');
    t = t.replace(/<(logic_check|thinking|meow_FM|status|wlog|parallel_world|branches|UpdateVariable|htm1fenge|StatusPlaceHolderImpl|bbs_start|bbs_end)[^>]*>[\s\S]*?<\/\1>/gi, '');
    t = t.replace(/<[^>]+>/g, '');
    const cut = t.search(/Date\s*Summary|世界运行报告|玩家状态栏|变量更新|^\s*⊹/im);
    if (cut > t.length * 0.3) t = t.slice(0, cut);
    return t.split(/\n{2,}/).map((p) => p.trim())
      .filter((p) => ((p.match(/[\u4e00-\u9fa5]/g) || []).length >= 12 || /[「『].{2,}[」』]/.test(p)))
      .join('\n\n').trim();
  }
  function storyText() {
    const sel = $('#h3tts-floor');
    if (sel && sel.value) {
      const el = Array.from(document.querySelectorAll('#chat .mes')).find((m) => (m.getAttribute('mesid') || '') === sel.value);
      if (el) return stripJunk((el.querySelector('.mes_text') || el).innerText || '');
    }
    return stripJunk(lastMesText());
  }

  /* ---------- 音色 ---------- */
  async function loadVoices() {
    try {
      const j = await (await fetch(api('/api/tts/voices'))).json();
      VOICES = j.voices || [];
    } catch (_) { VOICES = []; }
    renderRoles();
  }
  function roleOptions(cur) {
    return '<option value="">（选音色）</option>' + VOICES.map((v) =>
      '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(v) + '</option>').join('');
  }
  function renderRoles() {
    const box = $('#h3tts-roles');
    if (!box) return;
    box.innerHTML = S.roles.map((r, i) =>
      '<div class="row" data-i="' + i + '">'
      + '<input class="rname" value="' + esc(r.name || '') + '" placeholder="角色名（旁白/白井/妈妈…）" style="max-width:130px;flex:none">'
      + '<select class="rref" style="flex:1;min-width:0">' + roleOptions(r.ref) + '</select>'
      + '<button class="rup" style="flex:none" title="上传这段音色（10–20 秒干净人声最好）">传</button>'
      + '<button class="rdel" style="flex:none" title="删掉这个槽">✕</button>'
      + '</div>').join('');
    box.querySelectorAll('.row').forEach((row) => {
      const i = Number(row.dataset.i);
      row.querySelector('.rname').onchange = (e) => { S.roles[i].name = e.target.value.trim(); saveS(); };
      row.querySelector('.rref').onchange = (e) => { S.roles[i].ref = e.target.value; saveS(); };
      row.querySelector('.rdel').onclick = () => { S.roles.splice(i, 1); saveS(); renderRoles(); };
      row.querySelector('.rup').onclick = () => uploadVoice(i);
    });
  }
  function uploadVoice(i) {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'audio/*';
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      status('run', '上传音色 ' + f.name + ' …');
      try {
        const r = await fetch(api('/api/tts/upload?name=' + encodeURIComponent(f.name)), {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f,
        });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || '上传失败');
        S.roles[i].ref = j.name;
        saveS();
        await loadVoices();
        status('ok', '音色已上传：' + j.name);
      } catch (e) { status('err', '上传失败：' + (e.message || e)); }
    };
    inp.click();
  }

  /* ---------- 千问拆台词 ---------- */
  async function buildDialogue() {
    const text = storyText();
    if (!text) { status('err', '这条楼层没抽到正文'); return; }
    const names = S.roles.map((r) => r.name).filter(Boolean);
    const sys = [
      '你是广播剧编剧。把用户给的中文正文拆成可以配音的台词序列。',
      '只输出 JSON 数组，不要解释、不要代码块、不要多余文字。',
      '每项格式：{"speaker":"角色名或旁白","text":"要念出来的原话","emo":"情绪(两个汉字)"}',
      '规则：',
      '1) 旁白用 speaker="旁白"，念正文里的叙述部分，不要照抄对话。',
      '2) 引号里的台词归说话人；同一角色全程用同一个名字。',
      '3) 可用角色名：' + names.join('、') + '；正文里出现的其他称呼请归一到这些名字。',
      '4) 每句 8–40 字，太长就拆成多句；一句只表达一个动作或一句话。',
      '5) 顺序严格按正文时间线；总句数控制在 40 句以内。',
      '6) emo 从这些里选：平静、开心、疑惑、害羞、生气、难过、紧张、惊讶。',
    ].join('\n');
    const user = '正文：\n"""\n' + text + '\n"""';
    const key = S.key || '';
    status('run', '千问正在拆台词…（20–60 秒）');
    const r = await fetch(api('/v1/chat/completions'), {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, key ? { Authorization: 'Bearer ' + key } : {}),
      body: JSON.stringify({ model: 'qwen27b-q4', stream: false, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }),
    });
    const j = await r.json().catch(() => ({}));
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    let out = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : '';
    if (!out) throw new Error('模型没返回内容');
    const s = out.indexOf('['), e = out.lastIndexOf(']');
    if (s < 0 || e < 0) throw new Error('模型没给 JSON 数组：' + out.slice(0, 120));
    const arr = JSON.parse(out.slice(s, e + 1));
    if (!Array.isArray(arr) || !arr.length) throw new Error('台词为空');
    LINES = arr.map((x) => ({
      speaker: String(x.speaker || '旁白').trim(),
      text: String(x.text || '').trim(),
      emo: String(x.emo || '').trim(),
      state: 'idle', url: '', err: '',
    })).filter((x) => x.text);
    renderLines();
    status('ok', '拆出 ' + LINES.length + ' 句，可手改再配音');
  }

  function renderLines() {
    const box = $('#h3tts-lines');
    if (!box) return;
    if (!LINES.length) { box.innerHTML = '<div class="hint">还没有台词。点「① 拆台词」。</div>'; return; }
    box.innerHTML = LINES.map((l, i) => {
      const st = l.state === 'done' ? '✅' : l.state === 'error' ? '❌' : l.state === 'run' ? '⏳' : '·';
      return '<div class="line" data-i="' + i + '">'
        + '<div class="lhead"><span class="spk">' + esc(l.speaker) + '</span>'
        + '<span class="emo">' + esc(l.emo || '') + '</span>'
        + '<span class="st">' + st + '</span>'
        + (l.url ? '<audio controls preload="none" src="' + esc(abs(l.url)) + '"></audio>' : '')
        + '</div>'
        + '<textarea class="ltext" rows="2">' + esc(l.text) + '</textarea>'
        + (l.err ? '<div class="lerr">' + esc(l.err) + '</div>' : '')
        + '</div>';
    }).join('');
    box.querySelectorAll('.line').forEach((el) => {
      const i = Number(el.dataset.i);
      el.querySelector('.ltext').onchange = (e) => { LINES[i].text = e.target.value.trim(); };
    });
  }

  /* ---------- 逐句配音 ---------- */
  function refOf(speaker) {
    const nm = String(speaker || '').trim();
    let hit = S.roles.find((r) => (r.name || '').trim() === nm);
    if (!hit) hit = S.roles.find((r) => nm && (nm.includes((r.name || '').trim()) || (r.name || '').trim().includes(nm)));
    if (!hit) hit = S.roles.find((r) => (r.name || '').trim() === '旁白') || S.roles[0];
    return hit ? hit.ref : '';
  }

  async function doVoice() {
    if (!LINES.length) { status('err', '先点「① 拆台词」'); return; }
    const conc = Math.max(1, Math.min(4, Number($('#h3tts-conc').value) || 2));
    STOP = false;
    LINES.forEach((l) => { l.state = 'idle'; l.url = ''; l.err = ''; });
    renderLines();
    $('#h3tts-run').disabled = true;
    let cur = 0, done = 0, ok = 0;
    const t0 = Date.now();
    async function worker() {
      while (!STOP) {
        const i = cur++;
        if (i >= LINES.length) return;
        const l = LINES[i];
        const ref = refOf(l.speaker);
        if (!ref) { l.state = 'error'; l.err = '没配这个角色的音色：' + l.speaker; done++; renderLines(); continue; }
        l.state = 'run'; renderLines();
        try {
          const r = await fetch(api('/api/tts/run'), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: l.text, ref: ref, emoText: S.emo ? l.emo : '', tag: l.speaker }),
          });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || '配音失败');
          l.url = j.url; l.state = 'done'; ok++;
        } catch (e) {
          l.state = 'error'; l.err = e.message || String(e);
        }
        done++;
        renderLines();
        status(done === LINES.length ? 'ok' : 'run', '配音 ' + done + '/' + LINES.length + '（成功 ' + ok + '）· ' + Math.round((Date.now() - t0) / 1000) + 's');
      }
    }
    const ws = [];
    for (let k = 0; k < conc; k++) ws.push(worker());
    await Promise.all(ws);
    $('#h3tts-run').disabled = false;
    status(ok ? 'ok' : 'err', '配音完成：' + ok + '/' + LINES.length + ' 句');
  }

  async function doMerge() {
    const names = LINES.filter((l) => l.url).map((l) => String(l.url).split('filename=')[1]).filter(Boolean).map(decodeURIComponent);
    if (names.length < 2) { status('err', '至少要两段已生成的音频'); return; }
    status('run', '合并 ' + names.length + ' 段…');
    try {
      const r = await fetch(api('/api/tts/merge'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names: names }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || '合并失败');
      const box = $('#h3tts-all');
      box.innerHTML = '<div class="hint">合并结果</div><audio controls src="' + esc(abs(j.url)) + '"></audio>'
        + '<a class="dl" href="' + esc(abs(j.url)) + '" download>下载</a>';
      status('ok', '合并完成：' + j.name);
    } catch (e) { status('err', '合并失败：' + (e.message || e)); }
  }

  /* ---------- UI ---------- */
  function status(kind, msg) {
    const el = $('#h3tts-status');
    if (!el) return;
    el.className = 'h3tts-status ' + (kind || '');
    el.textContent = msg || '';
  }
  function fillFloors() {
    const sel = $('#h3tts-floor');
    if (!sel) return;
    const prev = sel.value;
    const mes = Array.from(document.querySelectorAll('#chat .mes'));
    sel.innerHTML = '<option value="">最新一条</option>' + mes.map((m) => {
      const id = m.getAttribute('mesid') || '';
      const t = ((m.querySelector('.mes_text') || m).innerText || '').replace(/\s+/g, ' ').slice(0, 24);
      return '<option value="' + esc(id) + '">#' + esc(id) + ' ' + esc(t) + '</option>';
    }).join('');
    if (prev) sel.value = prev;
  }
  function openPanel() {
    const d = $('#h3tts-dlg');
    if (!d) return;
    fillFloors();
    try { if (!d.open) d.showModal(); } catch (_) { d.setAttribute('open', ''); }
  }

  function build() {
    if ($('#h3tts-dlg')) return;
    const d = document.createElement('dialog');
    d.id = 'h3tts-dlg';
    d.innerHTML = `
      <header><b>正文配音</b><span class="sub">正文 → 千问拆台词 → IndexTTS2 按角色音色逐句克隆</span><button id="h3tts-x">✕</button></header>
      <div class="body">
        <div class="row"><label>H3 地址</label><input id="h3tts-host" placeholder="http://127.0.0.1:8899">
          <label class="w">Key</label><input id="h3tts-key" type="password" placeholder="留空 = 用服务端账号池"></div>
        <div class="row"><label>楼层</label><select id="h3tts-floor"></select><button id="h3tts-refl">↻</button>
          <label class="w">并发</label><input id="h3tts-conc" type="number" min="1" max="4" value="2">
          <label class="w"><input type="checkbox" id="h3tts-emo" checked> 用情绪</label></div>

        <div class="row"><label>音色</label><button id="h3tts-addrole">+ 加角色</button>
          <span class="hint" style="margin:0">旁白 + 每个角色各一段参考音频（10–20 秒干净人声最好）</span></div>
        <div id="h3tts-roles"></div>

        <div class="row">
          <button id="h3tts-peek">看正文</button>
          <button id="h3tts-dlgbtn" class="primary">① 拆台词</button>
          <button id="h3tts-run">② 配音</button>
          <button id="h3tts-merge">③ 合并</button>
          <button id="h3tts-stop">停止</button>
        </div>
        <div id="h3tts-lines"></div>
        <div id="h3tts-all"></div>
        <div id="h3tts-status" class="h3tts-status"></div>
      </div>`;
    document.body.appendChild(d);

    $('#h3tts-host').value = S.host;
    $('#h3tts-key').value = S.key;
    $('#h3tts-conc').value = S.conc;
    $('#h3tts-emo').checked = !!S.emo;

    $('#h3tts-x').onclick = () => (d.close ? d.close() : d.removeAttribute('open'));
    $('#h3tts-host').onchange = (e) => { S.host = e.target.value.trim() || DEFA.host; saveS(); };
    $('#h3tts-key').onchange = (e) => { S.key = e.target.value.trim(); saveS(); };
    $('#h3tts-conc').onchange = (e) => { S.conc = Number(e.target.value) || 2; saveS(); };
    $('#h3tts-emo').onchange = (e) => { S.emo = e.target.checked; saveS(); };
    $('#h3tts-refl').onclick = fillFloors;
    $('#h3tts-addrole').onclick = () => { S.roles.push({ name: '角色' + S.roles.length, ref: '' }); saveS(); renderRoles(); };
    $('#h3tts-peek').onclick = () => {
      const t = storyText();
      alert('将发给千问的正文（' + t.length + ' 字）：\n\n' + (t || '（没抽到）'));
    };
    $('#h3tts-dlgbtn').onclick = () => buildDialogue().catch((e) => status('err', '拆台词失败：' + (e.message || e)));
    $('#h3tts-run').onclick = doVoice;
    $('#h3tts-merge').onclick = doMerge;
    $('#h3tts-stop').onclick = () => { STOP = true; status('err', '已停止（已提交的仍会跑完）'); };

    // 顶栏图标
    try {
      const bar = document.querySelector('#top-settings-holder');
      if (bar && !document.querySelector('#h3tts-topbtn')) {
        const tb = document.createElement('div');
        tb.id = 'h3tts-topbtn';
        tb.className = 'drawer-icon fa-solid fa-microphone interactable';
        tb.title = '正文配音（IndexTTS2 音色克隆）';
        tb.tabIndex = 0;
        tb.style.cssText = 'cursor:pointer';
        tb.onclick = openPanel;
        bar.appendChild(tb);
      }
    } catch (e) { console.warn('[h3tts] top btn fail', e); }

    // 扩展设置入口
    try {
      const host = document.querySelector('#extensions_settings') || document.querySelector('#extensions_settings2');
      if (host && !document.querySelector('#h3tts-drawer')) {
        const wrap = document.createElement('div');
        wrap.id = 'h3tts-drawer';
        wrap.innerHTML = '<div class="inline-drawer" style="margin-bottom:6px">'
          + '<div class="inline-drawer-toggle inline-drawer-header" style="cursor:pointer"><b>正文配音</b>'
          + '<span class="hint" style="margin-left:8px;color:#8b98ab;font-size:12px">千问拆台词 → IndexTTS2 音色克隆</span></div>'
          + '<div class="inline-drawer-content" style="display:none"><button class="menu_button" id="h3tts-open" style="margin:6px 0">打开正文配音</button></div></div>';
        host.appendChild(wrap);
        const head = wrap.querySelector('.inline-drawer-header');
        const content = wrap.querySelector('.inline-drawer-content');
        head.onclick = () => { content.style.display = content.style.display === 'none' ? 'block' : 'none'; };
        wrap.querySelector('#h3tts-open').onclick = openPanel;
      }
    } catch (e) { console.warn('[h3tts] drawer fail', e); }

    renderRoles();
    renderLines();
    loadVoices();
  }

  function boot() {
    try { build(); window.__h3tts = true; console.log('[h3tts] booted v1.0.0'); }
    catch (e) {
      console.error('[h3tts] boot fail', e);
      try {
        const d = document.createElement('div');
        d.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:10000;background:#7f1d1d;color:#fff;padding:8px 10px;border-radius:8px;font-size:12px';
        d.textContent = '[正文配音] 加载失败：' + (e && e.message ? e.message : e);
        document.body.appendChild(d);
        setTimeout(() => d.remove(), 15000);
      } catch (_) {}
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 1200));
  else setTimeout(boot, 1200);
})();
