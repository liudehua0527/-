const categories = {
  twitter: { label: '推特', folder: '推特' },
  zhihu: { label: '知乎', folder: '知乎' },
  in: { label: '其他入库', folder: '入库' },
  out: { label: '其他不入库', folder: '不入库' },
};

const state = {
  sourceHandle: null,
  targetHandle: null,
  files: [],
  index: 0,
  mode: 'immediate',
  op: 'copy',
  queue: [],
  history: [],
  hotkeys: { '1': 'twitter', '2': 'zhihu', '3': 'in', '4': 'out' },
  renameEnabled: false,
  renamePrefix: 'shot',
  renameIndex: 1,
  currentGroup: 1,
};

const el = {
  pickSource: document.querySelector('#pickSource'),
  pickTarget: document.querySelector('#pickTarget'),
  fileName: document.querySelector('#fileName'),
  fileMeta: document.querySelector('#fileMeta'),
  counter: document.querySelector('#counter'),
  preview: document.querySelector('#preview'),
  emptyHint: document.querySelector('#emptyHint'),
  queueList: document.querySelector('#queueList'),
  statusPill: document.querySelector('#statusPill'),
  hotkeyMap: document.querySelector('#hotkeyMap'),
  applyQueue: document.querySelector('#applyQueue'),
  undo: document.querySelector('#undo'),
  nextGroup: document.querySelector('#nextGroup'),
  renameToggle: document.querySelector('#renameToggle'),
  prefix: document.querySelector('#prefix'),
  startIndex: document.querySelector('#startIndex'),
};

function updateStatus(msg) {
  el.statusPill.textContent = msg;
}

function parseMeta(name) {
  const match = name.match(/(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d+).*_(com\.[^\.]+\.[^\.]+)\./);
  if (!match) return { time: '未解析', source: '未知来源' };
  return { time: match[1], source: match[2] };
}

async function readFilesRecursively(dirHandle, path = '') {
  const items = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === 'directory') {
      items.push(...(await readFilesRecursively(handle, `${path}${name}/`)));
      continue;
    }
    if (!/\.(png|jpe?g|webp|bmp)$/i.test(name)) continue;
    items.push({ handle, name, path, parent: dirHandle });
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

function renderHotkeyMap() {
  el.hotkeyMap.innerHTML = '';
  Object.entries(categories).forEach(([key, value]) => {
    const row = document.createElement('div');
    row.className = 'hotkey-row';
    const title = document.createElement('span');
    title.textContent = value.label;
    const input = document.createElement('input');
    input.value = Object.keys(state.hotkeys).find((k) => state.hotkeys[k] === key) || '';
    input.maxLength = 1;
    input.onchange = () => {
      const newKey = input.value.trim();
      if (!newKey) return;
      Object.keys(state.hotkeys).forEach((k) => { if (state.hotkeys[k] === key) delete state.hotkeys[k]; });
      state.hotkeys[newKey] = key;
      renderHotkeyMap();
    };
    const tip = document.createElement('span');
    tip.textContent = `按键：${input.value || '未设置'}`;
    row.append(title, input, tip);
    el.hotkeyMap.appendChild(row);
  });
}

function showCurrent() {
  if (!state.files.length) {
    el.fileName.textContent = '请先选择源图片文件夹';
    el.fileMeta.textContent = '文件名解析信息会显示在这里';
    el.counter.textContent = '0 / 0';
    el.preview.style.display = 'none';
    el.emptyHint.style.display = 'block';
    return;
  }
  const current = state.files[state.index];
  if (!current) {
    el.fileName.textContent = '全部处理完成';
    el.fileMeta.textContent = `队列剩余 ${state.queue.length} 条，可按 A 批量执行`; 
    el.preview.style.display = 'none';
    el.emptyHint.style.display = 'block';
    return;
  }
  current.handle.getFile().then((f) => {
    el.preview.src = URL.createObjectURL(f);
    el.preview.style.display = 'block';
    el.emptyHint.style.display = 'none';
  });
  const meta = parseMeta(current.name);
  el.fileName.textContent = current.name;
  el.fileMeta.textContent = `时间：${meta.time}｜来源：${meta.source}｜分段组：G${current.group ?? state.currentGroup}`;
  el.counter.textContent = `${state.index + 1} / ${state.files.length}`;
}

function renderQueue() {
  el.queueList.innerHTML = state.queue.length
    ? state.queue.map((q, i) => `${i + 1}. ${q.file.name} → ${categories[q.category].label}`).join('<br/>')
    : '暂无待执行项';
}

function next() {
  state.index += 1;
  showCurrent();
}

async function writeToCategory(fileObj, category) {
  if (!state.targetHandle) throw new Error('请先选择输出文件夹');
  const folder = await state.targetHandle.getDirectoryHandle(categories[category].folder, { create: true });
  const blob = await fileObj.handle.getFile();
  const meta = parseMeta(fileObj.name);
  const ext = fileObj.name.includes('.') ? `.${fileObj.name.split('.').pop()}` : '';
  const newName = state.renameEnabled
    ? `${state.renamePrefix}_${meta.time}_${meta.source}_G${fileObj.group ?? state.currentGroup}_${String(state.renameIndex).padStart(4, '0')}${ext}`
    : fileObj.name;

  const outHandle = await folder.getFileHandle(newName, { create: true });
  const writable = await outHandle.createWritable();
  await writable.write(blob);
  await writable.close();
  if (state.renameEnabled) state.renameIndex += 1;

  if (state.op === 'move') {
    await fileObj.parent.removeEntry(fileObj.name);
  }

  state.history.push({ fileObj, category, outputFolder: categories[category].folder, outName: newName, op: state.op });
}

async function classify(category) {
  const current = state.files[state.index];
  if (!current) return;

  if (state.mode === 'defer') {
    state.queue.push({ file: current, category });
    renderQueue();
    next();
    updateStatus(`已加入待执行：${categories[category].label}`);
    return;
  }

  try {
    await writeToCategory(current, category);
    updateStatus(`已${state.op === 'copy' ? '复制' : '剪切'}到 ${categories[category].label}`);
    next();
  } catch (error) {
    updateStatus(`失败：${error.message}`);
  }
}

async function applyQueue() {
  for (const item of state.queue) {
    await writeToCategory(item.file, item.category);
  }
  updateStatus(`批量执行完成，共 ${state.queue.length} 项`);
  state.queue = [];
  renderQueue();
}

async function undo() {
  const last = state.history.pop();
  if (!last || !state.targetHandle) {
    updateStatus('没有可撤回项');
    return;
  }
  const folder = await state.targetHandle.getDirectoryHandle(last.outputFolder);

  if (last.op === 'move') {
    const movedFile = await (await folder.getFileHandle(last.outName)).getFile();
    const restored = await last.fileObj.parent.getFileHandle(last.fileObj.name, { create: true });
    const writable = await restored.createWritable();
    await writable.write(movedFile);
    await writable.close();
  }

  await folder.removeEntry(last.outName);
  state.index = Math.max(0, state.index - 1);
  showCurrent();
  updateStatus('已撤回上一步');
}

function bindModeButtons() {
  document.querySelectorAll('.segmented button[data-mode]').forEach((btn) => {
    btn.onclick = () => {
      state.mode = btn.dataset.mode;
      document.querySelectorAll('.segmented button[data-mode]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      updateStatus(state.mode === 'immediate' ? '即时执行模式' : '延迟批量模式');
    };
  });
  document.querySelectorAll('#opModeSwitch button').forEach((btn) => {
    btn.onclick = () => {
      state.op = btn.dataset.op;
      document.querySelectorAll('#opModeSwitch button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      updateStatus(state.op === 'copy' ? '复制模式（推荐）' : '剪切模式（谨慎）');
    };
  });
}

el.pickSource.onclick = async () => {
  state.sourceHandle = await window.showDirectoryPicker();
  state.files = await readFilesRecursively(state.sourceHandle);
  state.index = 0;
  state.files = state.files.map((f) => ({ ...f, group: state.currentGroup }));
  updateStatus(`已载入 ${state.files.length} 张图片`);
  showCurrent();
};

el.pickTarget.onclick = async () => {
  state.targetHandle = await window.showDirectoryPicker();
  updateStatus('输出文件夹已就绪');
};

el.applyQueue.onclick = () => applyQueue().catch((e) => updateStatus(`失败：${e.message}`));
el.undo.onclick = () => undo().catch((e) => updateStatus(`失败：${e.message}`));
el.nextGroup.onclick = () => {
  state.currentGroup += 1;
  if (state.files[state.index]) state.files[state.index].group = state.currentGroup;
  showCurrent();
  updateStatus(`已切换到分段组 G${state.currentGroup}`);
};

el.renameToggle.onchange = (e) => { state.renameEnabled = e.target.checked; };
el.prefix.onchange = (e) => { state.renamePrefix = e.target.value || 'shot'; };
el.startIndex.onchange = (e) => { state.renameIndex = Number(e.target.value) || 1; };

window.addEventListener('keydown', (event) => {
  if (event.target.tagName === 'INPUT') return;
  if (event.key === 'ArrowRight') {
    state.index = Math.min(state.files.length - 1, state.index + 1);
    showCurrent();
    return;
  }
  if (event.key === 'ArrowLeft') {
    state.index = Math.max(0, state.index - 1);
    showCurrent();
    return;
  }
  if (event.key.toLowerCase() === 'z') return undo().catch(() => {});
  if (event.key.toLowerCase() === 'a') return applyQueue().catch(() => {});
  if (event.key.toLowerCase() === 'g') {
    el.nextGroup.click();
    return;
  }
  const category = state.hotkeys[event.key];
  if (category) classify(category);
});

bindModeButtons();
renderHotkeyMap();
showCurrent();
renderQueue();
