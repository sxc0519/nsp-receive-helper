// ==UserScript==
// @name         NSP 高速稳定批量入库
// @namespace    local.nsp.receive
// @version      1.0.0
// @description  逐票入库，核对列表结果，断线保留进度；超时不盲目重试。
// @match        https://nsp-jp.ytoglobal.com/*
// @updateURL    https://raw.githubusercontent.com/sxc0519/nsp-receive-helper/main/nsp-receive-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/sxc0519/nsp-receive-helper/main/nsp-receive-helper.user.js
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const ROUTE = '/port-out/receive';
  const KEY = 'nsp-receive-batch-v1';
  const LOCK = 'nsp-receive-batch-lock-v1';
  const OWNER = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const TIMEOUT_MS = 25000;
  const LOCK_MS = 12000;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let task = readTask();
  let working = false;
  let pauseRequested = false;
  let idleNote = '';
  let host, root, ui;

  function readTask() {
    try {
      const value = JSON.parse(localStorage.getItem(KEY) || 'null');
      return value && Array.isArray(value.ids) ? value : null;
    } catch { return null; }
  }

  function saveTask() {
    if (task) localStorage.setItem(KEY, JSON.stringify(task));
    else localStorage.removeItem(KEY);
    render();
  }

  function writeLock() {
    localStorage.setItem(LOCK, JSON.stringify({ owner: OWNER, time: Date.now() }));
  }

  function lockOwner() {
    try {
      const lock = JSON.parse(localStorage.getItem(LOCK) || 'null');
      return lock && Date.now() - lock.time < LOCK_MS ? lock.owner : null;
    } catch { return null; }
  }

  function claimLock() {
    const owner = lockOwner();
    if (owner && owner !== OWNER) return false;
    writeLock();
    return lockOwner() === OWNER;
  }

  function releaseLock() {
    if (lockOwner() === OWNER) localStorage.removeItem(LOCK);
  }

  // 原生 setter + input 事件可以让 React/Ant Design 接收批量填写的值。
  function setField(id, value) {
    const input = document.getElementById(id);
    if (!input) throw Error(`找不到 ${id} 输入框`);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus();
    setter.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function controls() {
    const waybill = document.getElementById('waybillNo');
    const form = waybill?.closest('form.scan-form');
    const button = form?.querySelector('button.scan-btn');
    return { waybill, form, button };
  }

  function rowFor(id) {
    return [...document.querySelectorAll('.ant-table-tbody tr.ant-table-row')]
      .find(row => row.querySelectorAll('td')[1]?.textContent.trim() === id) || null;
  }

  function rowResult(row) {
    const cells = row?.querySelectorAll('td');
    return cells && cells.length >= 5 ? {
      key: row.getAttribute('data-row-key'),
      weight: Number(cells[3].textContent.trim()),
      dimensions: cells[4].textContent.trim().split('*').map(Number)
    } : null;
  }

  function sameNumber(a, b) {
    return Number.isFinite(a) && Math.abs(a - Number(b)) < 0.00001;
  }

  function receiptCheck(id, beforeKey, settings) {
    const result = rowResult(rowFor(id));
    if (!result || !result.key || result.key === beforeKey) return null;
    const expected = [settings.length, settings.width, settings.height];
    if (!sameNumber(result.weight, settings.weight) ||
        expected.some((value, i) => !sameNumber(result.dimensions[i], value))) {
      return { ok: false, detail: `列表已出现 ${id}，但重量或尺寸与设置不一致，请人工核对` };
    }
    return { ok: true };
  }

  function errorMessage() {
    const messages = document.querySelectorAll(
      '.ant-message-error, .ant-notification-notice-error, .ant-form-item-explain-error'
    );
    return [...messages].map(node => node.textContent.trim()).find(Boolean) || '';
  }

  async function waitFor(predicate, timeout, interval = 80) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = predicate();
      if (value) return value;
      await sleep(interval);
    }
    return null;
  }

  function parsedInput() {
    const tokens = ui.ids.value.toUpperCase().split(/[\s,，;；、]+/).filter(Boolean);
    if (!tokens.length) throw Error('请先粘贴运单号');
    const invalid = tokens.filter(id => !/^G\d{11}$/.test(id));
    if (invalid.length) throw Error(`单号格式不正确：${invalid.slice(0, 3).join('、')}`);
    const seen = new Set();
    const duplicates = tokens.filter(id => seen.has(id) || !seen.add(id));
    if (duplicates.length) throw Error(`列表有重复单号：${[...new Set(duplicates)].slice(0, 3).join('、')}`);
    return tokens;
  }

  function settingsInput() {
    const values = Object.fromEntries(
      ['weight', 'length', 'width', 'height']
        .map(key => [key, Number(ui[key].value.trim().replace(',', '.'))])
    );
    if (Object.values(values).some(value => !Number.isFinite(value) || value <= 0 || value > 9999)) {
      throw Error('重量和长宽高须为大于 0、且不超过 9999 的数字');
    }
    return values;
  }

  function note(message) {
    if (task) {
      task.note = message;
      saveTask();
    } else {
      idleNote = message;
      render();
    }
  }

  function confirmReceipt() {
    if (!task?.pending) return false;
    const check = receiptCheck(task.pending.id, task.pending.beforeKey, task.settings);
    if (!check?.ok) return false;
    task.cursor++;
    task.pending = null;
    task.mode = task.cursor === task.ids.length ? 'done' : 'paused';
    note(`已在列表核对，完成 ${task.cursor}/${task.ids.length}`);
    return true;
  }

  async function submitOne(id) {
    const { button } = controls();
    if (!button) throw Error('找不到入库按钮，已停止');
    const beforeKey = rowResult(rowFor(id))?.key || null;
    const settings = task.settings;

    // 重取元素，避免页面重新渲染后沿用失效的输入框。
    for (const field of ['weight', 'length', 'width', 'height']) {
      setField(field, settings[field]);
    }
    setField('waybillNo', id);

    const ready = await waitFor(() => {
      const current = controls();
      return current.waybill?.value === id &&
        ['weight', 'length', 'width', 'height'].every(field =>
          sameNumber(Number(document.getElementById(field)?.value), settings[field])) &&
        current.button && !current.button.disabled && current.button;
    }, 5000);
    if (!ready) throw Error(`${id}：表单未就绪，已停止`);
    if (pauseRequested || !working) return;

    // 点击前写入待核对状态。网络或页面中断后绝不自动重发这一票。
    task.pending = { id, beforeKey, at: Date.now() };
    note(`正在入库 ${id}（${task.cursor + 1}/${task.ids.length}）`);
    ready.click();

    const result = await waitFor(() => {
      if (location.pathname !== ROUTE) return { error: '页面已离开入库扫描' };
      const check = receiptCheck(id, beforeKey, settings);
      if (check?.ok) return { ok: true };
      if (check && !check.ok) return { error: check.detail };
      const error = errorMessage();
      if (error) return { error: `${id}：${error}` };
      return null;
    }, TIMEOUT_MS, 100);

    if (result?.ok) {
      task.cursor++;
      task.pending = null;
      note(`已完成 ${task.cursor}/${task.ids.length}，最后一票：${id}`);
      return;
    }

    // 超时后通过页面自带按钮再刷新一次列表；仍不重发单号。
    if (!result && location.pathname === ROUTE) {
      const refresh = [...document.querySelectorAll('button')]
        .find(node => node.textContent.trim() === '刷新列表');
      refresh?.click();
      const late = await waitFor(() => receiptCheck(id, beforeKey, settings)?.ok, 5000, 150);
      if (late) {
        task.cursor++;
        task.pending = null;
        note(`已刷新列表确认，完成 ${task.cursor}/${task.ids.length}`);
        return;
      }
    }
    throw Error(result?.error || `${id}：等待入库结果超时，已停止。请先核对这一票`);
  }

  async function run() {
    if (working) return;
    if (location.pathname !== ROUTE) return note('请打开「入库扫描」页面');
    if (!claimLock()) return note('另一个标签页正在运行批量入库');
    task = readTask();
    working = true;
    pauseRequested = false;
    const heartbeat = setInterval(() => {
      if (working && lockOwner() === OWNER) writeLock();
    }, 3000);
    try {
      if (task?.mode === 'done') throw Error('上一批已完成。请先点击「清空任务」，再粘贴新批次');
      if (!task) {
        task = {
          ids: parsedInput(), settings: settingsInput(), cursor: 0,
          pending: null, mode: 'paused', note: ''
        };
        saveTask();
      }
      if (task.pending && !confirmReceipt()) {
        throw Error(`${task.pending.id} 的结果尚未确认，请先点击「核对待处理单号」`);
      }
      task.mode = 'running';
      saveTask();
      while (task.cursor < task.ids.length && !pauseRequested) {
        if (lockOwner() !== OWNER) throw Error('另一个标签页接管了任务，已停止');
        await submitOne(task.ids[task.cursor]);
      }
      task.mode = task.cursor === task.ids.length ? 'done' : 'paused';
      note(task.mode === 'done' ? `全部完成：${task.ids.length}/${task.ids.length}` :
        `已暂停：${task.cursor}/${task.ids.length}`);
    } catch (error) {
      if (task) task.mode = 'paused';
      note(error.message || String(error));
    } finally {
      working = false;
      clearInterval(heartbeat);
      releaseLock();
      render();
    }
  }

  function render() {
    if (!ui) return;
    const active = !!task && task.mode !== 'done';
    const count = task ? `${task.cursor}/${task.ids.length}` : '0/0';
    ui.progress.textContent = `进度 ${count}${task?.pending ? ` · 待核对 ${task.pending.id}` : ''}`;
    ui.status.textContent = task?.note || idleNote || '粘贴单号并设置重量、尺寸，然后点击开始';
    ui.start.textContent = task?.mode === 'done' ? '已完成' : active ? '继续' : '开始新批次';
    ui.start.disabled = working || task?.mode === 'done';
    ui.pause.disabled = !working;
    ui.review.disabled = working || !task?.pending;
    ui.retry.disabled = working || !task?.pending;
    ui.skip.disabled = working || !task?.pending;
    ui.newBatch.disabled = working;
    for (const key of ['ids', 'weight', 'length', 'width', 'height']) {
      ui[key].disabled = working || active;
    }
  }

  function attach() {
    if (host || location.pathname !== ROUTE) return;
    host = document.createElement('div');
    host.id = 'nsp-batch-panel';
    document.body.append(host);
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
          font: 13px/1.4 Arial, sans-serif; color: #17202a; }
        * { box-sizing: border-box; }
        .panel { width: 320px; max-height: calc(100vh - 32px); overflow: auto;
          padding: 14px; border: 1px solid #cbd5e1; border-radius: 10px;
          background: #fff; box-shadow: 0 8px 30px #0003; }
        h3 { margin: 0 0 9px; font-size: 16px; }
        label { display: block; margin: 6px 0 3px; font-weight: 600; }
        textarea, input { width: 100%; padding: 6px; border: 1px solid #94a3b8;
          border-radius: 4px; font: inherit; }
        textarea { height: 95px; resize: vertical; }
        .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
        button { padding: 6px 8px; border: 0; border-radius: 5px; background: #2563eb;
          color: #fff; cursor: pointer; font: inherit; }
        button:disabled { opacity: .45; cursor: default; }
        .muted { background: #64748b; }
        .warn { background: #b45309; }
        .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
        #progress { margin-top: 10px; font-weight: 700; }
        #status { margin-top: 5px; white-space: pre-wrap; overflow-wrap: anywhere; }
        .hint { margin-top: 6px; color: #475569; font-size: 12px; }
      </style>
      <div class="panel">
        <h3>NSP 批量入库</h3>
        <label for="ids">运单号（空格、逗号或换行分隔）</label>
        <textarea id="ids" placeholder="G10433010381&#10;G10433012177"></textarea>
        <div class="grid">
          <div><label for="weight">重量 kg</label><input id="weight" value="0.1" inputmode="decimal"></div>
          <div><label for="length">长 cm</label><input id="length" value="14" inputmode="decimal"></div>
          <div><label for="width">宽 cm</label><input id="width" value="9" inputmode="decimal"></div>
          <div><label for="height">高 cm</label><input id="height" value="4" inputmode="decimal"></div>
        </div>
        <div class="actions">
          <button id="start">开始新批次</button><button id="pause" class="muted">暂停</button>
          <button id="newBatch" class="muted">清空任务</button>
        </div>
        <div id="progress"></div><div id="status"></div>
        <div class="actions">
          <button id="review" class="muted">核对待处理单号</button>
          <button id="retry" class="warn">确认未入库，重试</button>
          <button id="skip" class="muted">确认已入库，跳过</button>
        </div>
        <div class="hint">超时会停在当前单号。先查页面记录，再选择重试或跳过。勿同时在其他标签页手动入库。</div>
      </div>`;
    ui = Object.fromEntries(
      ['ids', 'weight', 'length', 'width', 'height', 'start', 'pause', 'newBatch',
        'progress', 'status', 'review', 'retry', 'skip']
        .map(id => [id, root.getElementById(id)])
    );
    if (task) {
      ui.ids.value = task.ids.join('\n');
      for (const key of ['weight', 'length', 'width', 'height']) ui[key].value = task.settings[key];
      if (task.mode === 'running') {
        task.mode = 'paused';
        task.note = task.pending ? `${task.pending.id} 的结果待核对` : '页面刷新后已暂停，可继续';
        saveTask();
      }
    }
    ui.start.addEventListener('click', run);
    ui.pause.addEventListener('click', () => {
      pauseRequested = true;
      note('正在完成当前这一票，然后暂停');
    });
    ui.review.addEventListener('click', () => {
      if (!task?.pending) return;
      const id = task.pending.id;
      if (!confirmReceipt()) note(`列表尚未确认 ${id}。请人工检查后选择重试或跳过`);
    });
    ui.retry.addEventListener('click', () => {
      if (!task?.pending) return;
      const id = task.pending.id;
      task.pending = null;
      note(`${id} 已标记为未入库，点击「继续」重新提交`);
    });
    ui.skip.addEventListener('click', () => {
      if (!task?.pending) return;
      const id = task.pending.id;
      task.cursor++;
      task.pending = null;
      task.mode = task.cursor === task.ids.length ? 'done' : 'paused';
      note(`${id} 已人工确认入库，进度 ${task.cursor}/${task.ids.length}`);
    });
    ui.newBatch.addEventListener('click', () => {
      task = null;
      idleNote = '';
      ui.ids.value = '';
      saveTask();
    });
    render();
  }

  function routeCheck() {
    if (location.pathname === ROUTE) attach();
    else if (host) {
      if (working) pauseRequested = true;
      host.remove();
      host = root = ui = null;
    }
  }

  routeCheck();
  setInterval(routeCheck, 1000);
  window.addEventListener('storage', event => {
    if (event.key === LOCK && working && lockOwner() !== OWNER) pauseRequested = true;
  });
})();
