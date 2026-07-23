// Easel — frontend. Vanilla JS, single file, tight.

import { icon } from '/icons.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    if (el.dataset.hydrated === '1') return;
    el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
    el.dataset.hydrated = '1';
  });
}

// ---- State ----
const state = {
  view: 'media', // media | favorites | trash | folder | presets | detail
  folderId: null,
  detailId: null,
  tasks: [],
  presets: [],
  folders: [],
  search: '',
  selectMode: false,
  selectedTaskIds: new Set(),
  settings: {
    aspect: '2:3',
    variants: 2,
    quality: 'medium',
    characterIds: [],      // ordered list of character preset ids
    styleId: '',           // single style preset id
    referencePath: null,   // direct single-image attach from prompt bar
  },
};

const ASPECTS = ['1:1', '3:2', '2:3', '16:9', '9:16'];
const VARIANTS = [1, 2, 3, 4];
const QUALITIES = ['low', 'medium', 'high'];
const SETTINGS_KEY = 'easel:settings';
const BEST_VARIANTS_KEY = 'easel:best-variants';
const DRAFTS_KEY = 'easel:prompt-drafts';
const SKETCHPAD_KEY = 'easel:sketchpad';
const PRESET_FILTER_KEY = 'easel:preset-filter';
const PRESET_FILTER_VALUES = ['all', 'character', 'style'];

function loadPresetFilter() {
  const v = localStorage.getItem(PRESET_FILTER_KEY);
  return PRESET_FILTER_VALUES.includes(v) ? v : 'all';
}
function savePresetFilter(v) {
  if (PRESET_FILTER_VALUES.includes(v)) localStorage.setItem(PRESET_FILTER_KEY, v);
}

state.bestVariants = loadJson(BEST_VARIANTS_KEY, {});
state.presetSearch = '';
state.presetTypeFilter = loadPresetFilter();

// ---- API ----
async function api(path, opts = {}) {
  const resp = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return resp.json();
}

// ---- Toast ----
function toast(message, kind = 'ok', action = null) {
  if (typeof kind === 'object' && kind) {
    action = kind;
    kind = 'ok';
  }
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'err' ? ' err' : '');
  el.innerHTML = `<span>${escapeHtml(message)}</span>`;
  if (action?.label && typeof action.onClick === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = action.label;
    btn.addEventListener('click', async () => {
      try {
        await action.onClick();
      } finally {
        el.remove();
      }
    });
    el.appendChild(btn);
  }
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), action ? 7000 : 3600);
}

// ---- Popover ----
// Single-select: onPick(value) fires on click, popover closes.
// Multi-select (multi: true): each click calls onToggle(value), popover stays open until Done or backdrop.
function popover(anchor, title, options, onPick, opts = {}) {
  closePopover();
  const backdrop = document.createElement('div');
  backdrop.className = 'popover-backdrop';
  backdrop.id = 'active-popover';
  backdrop.addEventListener('click', closePopover);

  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.addEventListener('click', (e) => e.stopPropagation());

  const header = document.createElement('div');
  header.className = 'popover-title';
  header.textContent = title;
  pop.appendChild(header);

  const renderRows = () => {
    // Remove existing option rows before re-rendering
    pop.querySelectorAll('.popover-option').forEach((el) => el.remove());
    const footer = pop.querySelector('.popover-footer');
    for (const opt of options) {
      const row = document.createElement('div');
      row.className = 'popover-option' + (opt.active ? ' active' : '');
      row.innerHTML = `<span>${escapeHtml(opt.label)}</span>${opt.active ? '<span class="check">✓</span>' : ''}`;
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        if (opts.multi) {
          opt.active = !opt.active;
          onPick(opt.value, opt.active);
          renderRows();
        } else {
          onPick(opt.value);
          closePopover();
        }
      });
      if (footer) pop.insertBefore(row, footer);
      else pop.appendChild(row);
    }
  };

  if (opts.multi) {
    const footer = document.createElement('div');
    footer.className = 'popover-footer';
    const done = document.createElement('button');
    done.type = 'button';
    done.textContent = 'Done';
    done.addEventListener('click', (e) => {
      e.stopPropagation();
      closePopover();
    });
    footer.appendChild(done);
    pop.appendChild(footer);
  }

  renderRows();

  backdrop.appendChild(pop);
  document.body.appendChild(backdrop);

  // Position menu above the anchor, pinned to its right edge
  const rect = anchor.getBoundingClientRect();
  const menuWidth = pop.offsetWidth;
  const menuHeight = pop.offsetHeight;
  const left = Math.max(
    16,
    Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 16),
  );
  const top = Math.max(16, rect.top - menuHeight - 8);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}
function closePopover() {
  document.getElementById('active-popover')?.remove();
}

// ---- Data loaders ----
async function loadFolders() {
  state.folders = await api('/api/folders');
  renderFolders();
}
async function loadPresets() {
  state.presets = await api('/api/presets');
}
async function loadTasks() {
  const params = new URLSearchParams();
  if (state.view === 'favorites') params.set('view', 'favorites');
  else if (state.view === 'trash') params.set('view', 'trash');
  else if (state.view === 'folder') {
    params.set('view', 'folder');
    if (state.folderId) params.set('folder_id', state.folderId);
  } else params.set('view', 'media');
  state.tasks = await api('/api/tasks?' + params.toString());
}

// ---- Render: sidebar ----
function renderFolders() {
  const root = $('#folder-list');
  root.innerHTML = '';
  for (const f of state.folders) {
    const el = document.createElement('a');
    el.className = 'nav-item' + (state.view === 'folder' && state.folderId === f.id ? ' active' : '');
    el.href = `#folder/${f.id}`;
    el.dataset.folderId = f.id;
    el.innerHTML = `<span class="nav-icon">${icon('folder', { size: 16 })}</span><span>${escapeHtml(f.name)}</span>`;
    el.onclick = (ev) => {
      ev.preventDefault();
      goto('folder', { folderId: f.id });
    };
    root.appendChild(el);
  }
  if (state.folders.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'font-size: 0.72rem; color: var(--text-muted); padding: 4px 10px; font-style: italic;';
    empty.textContent = 'No folders yet';
    root.appendChild(empty);
  }
}

function updateActiveNav() {
  $$('.nav-item').forEach((el) => el.classList.remove('active'));
  if (state.view === 'folder' && state.folderId) {
    $(`.nav-item[data-folder-id="${state.folderId}"]`)?.classList.add('active');
  } else {
    $(`.nav-item[data-view="${state.view}"]`)?.classList.add('active');
  }
}

// ---- Render: gallery ----
function groupTasksByDate(tasks) {
  const groups = new Map();
  for (const t of tasks) {
    const d = new Date(t.created_at);
    const key = d.toDateString();
    const list = groups.get(key) ?? [];
    list.push(t);
    groups.set(key, list);
  }
  return groups;
}

function formatDateHeader(d) {
  const date = new Date(d);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatTime(d) {
  return new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
}

function searchableTaskText(task) {
  const presetText = (task.presets ?? [])
    .map((p) => `${p.name} v${p.version} ${p.type}`)
    .join(' ');
  const dateText = new Date(task.created_at).toLocaleString();
  return [
    task.prompt,
    task.kind,
    task.aspect_ratio,
    task.quality,
    task.status,
    presetText,
    dateText,
    task.reference_image_path ? 'reference ref' : '',
    task.favorite ? 'favorite starred' : '',
    task.trashed ? 'trash trashed' : '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function filteredTasks() {
  const q = state.search.trim().toLowerCase();
  if (!q) return state.tasks;
  const terms = q.split(/\s+/).filter(Boolean);
  return state.tasks.filter((task) => {
    const haystack = searchableTaskText(task);
    return terms.every((term) => haystack.includes(term));
  });
}

function isGalleryView() {
  return ['media', 'favorites', 'trash', 'folder'].includes(state.view);
}

function taskById(taskId) {
  return state.tasks.find((t) => t.id === taskId);
}

function selectedIds() {
  return [...state.selectedTaskIds].filter((id) => taskById(id));
}

function setSelectMode(enabled) {
  state.selectMode = enabled;
  if (!enabled) state.selectedTaskIds.clear();
  renderGallery();
  updateSelectionBar();
}

function toggleTaskSelection(taskId) {
  if (state.selectedTaskIds.has(taskId)) state.selectedTaskIds.delete(taskId);
  else state.selectedTaskIds.add(taskId);
  updateSelectionBar();
  const selected = state.selectedTaskIds.has(taskId);
  const card = document.querySelector(`.task-card[data-task-id="${taskId}"]`);
  card?.classList.toggle('selected', selected);
  const btn = card?.querySelector('.task-select');
  if (btn) {
    btn.classList.toggle('active', selected);
    btn.innerHTML = icon(selected ? 'check-square' : 'square', { size: 14 });
  }
}

function updateSelectionBar() {
  const bar = $('#selection-bar');
  if (!bar) return;
  const count = selectedIds().length;
  bar.hidden = !state.selectMode && count === 0;
  $('#selection-count').textContent = count === 1 ? '1 selected' : `${count} selected`;
  $('#select-mode-btn')?.classList.toggle('active', state.selectMode);
}

function selectedPresetStack() {
  const chars = state.settings.characterIds
    .map((id) => state.presets.find((p) => p.id === id))
    .filter(Boolean);
  const style = state.presets.find((p) => p.id === state.settings.styleId);
  return { chars, style };
}

function loadSettings() {
  const saved = loadJson(SETTINGS_KEY, null);
  if (!saved) return;
  state.settings.aspect = ASPECTS.includes(saved.aspect) ? saved.aspect : state.settings.aspect;
  state.settings.variants = VARIANTS.includes(saved.variants) ? saved.variants : state.settings.variants;
  state.settings.quality = QUALITIES.includes(saved.quality) ? saved.quality : state.settings.quality;
  const presetIds = new Set(state.presets.map((p) => p.id));
  state.settings.characterIds = Array.isArray(saved.characterIds)
    ? saved.characterIds.filter((id) => presetIds.has(id))
    : [];
  state.settings.styleId = presetIds.has(saved.styleId) ? saved.styleId : '';
}

function saveSettings() {
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({
      aspect: state.settings.aspect,
      variants: state.settings.variants,
      quality: state.settings.quality,
      characterIds: state.settings.characterIds,
      styleId: state.settings.styleId,
    }),
  );
}

function composedPrompt(promptText = $('#prompt-input')?.value?.trim() ?? '') {
  const { chars, style } = selectedPresetStack();
  return [
    ...chars.map((p) => p.body.trim()),
    ...(style ? [style.body.trim()] : []),
    promptText.trim(),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function taskRecipe(task) {
  return task.composed_prompt || task.prompt || '';
}

async function copyText(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch (e) {
    toast('Copy failed: ' + e.message, 'err');
  }
}

function applyTaskToComposer(task, { prompt = task.prompt, referencePath = task.reference_image_path } = {}) {
  $('#prompt-input').value = prompt ?? '';
  state.settings.aspect = task.aspect_ratio;
  state.settings.variants = task.variant_count;
  state.settings.quality = task.quality;
  state.settings.characterIds = (task.presets ?? []).filter((p) => p.type === 'character').map((p) => p.id);
  state.settings.styleId = (task.presets ?? []).find((p) => p.type === 'style')?.id ?? '';
  state.settings.referencePath = referencePath ?? null;
  syncChips();
  renderRefStrip();
  autoResizePrompt();
}

async function reuseTask(task) {
  applyTaskToComposer(task);
  await goto('media');
  $('#prompt-input').focus();
  toast('Prompt and settings loaded');
}

async function remixTask(task) {
  try {
    const first = task.variants?.[0];
    if (!first) throw new Error('No variant available to remix');
    const resp = await fetch(`/images/${first.image_path}`);
    if (!resp.ok) throw new Error('Could not load source image');
    const blob = await resp.blob();
    const file = new File([blob], 'remix.png', { type: blob.type || 'image/png' });
    const up = await uploadFile(file);
    applyTaskToComposer(task, { prompt: '', referencePath: up.path });
    await goto('media');
    $('#prompt-input').focus();
    toast('Remix reference attached');
  } catch (e) {
    toast(e.message, 'err');
  }
}

function downloadFirstVariant(task) {
  const first = task.variants?.[0];
  if (!first) return toast('No image to download', 'err');
  const a = document.createElement('a');
  a.href = `/images/${first.image_path}`;
  a.download = `${task.id}-0.png`;
  a.click();
}

async function exportTasks(taskIds) {
  const tasks = taskIds
    .map((id) => taskById(id))
    .filter(Boolean);
  if (tasks.length === 0) return toast('Select at least one generation', 'err');

  const resp = await fetch('/api/export', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task_ids: tasks.map((task) => task.id) }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error || 'Export failed');
  }
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `easel-ai-export-${new Date().toISOString().slice(0, 10)}.zip`;
  a.click();
  URL.revokeObjectURL(url);
  toast(tasks.length === 1 ? 'Exported archive' : `Exported ${tasks.length} generations`);
}

async function moveTasksToFolder(taskIds, folderId) {
  const previous = taskIds.map((id) => ({ id, folder_id: taskById(id)?.folder_id ?? null }));
  await Promise.all(
    taskIds.map((id) => api(`/api/tasks/${id}`, { method: 'PATCH', body: { folder_id: folderId } })),
  );
  const folderName = folderId
    ? state.folders.find((f) => f.id === folderId)?.name || 'folder'
    : 'No folder';
  toast(`${taskIds.length === 1 ? 'Moved' : `Moved ${taskIds.length}`} to ${folderName}`, {
    label: 'Undo',
    onClick: async () => {
      await Promise.all(
        previous.map((item) =>
          api(`/api/tasks/${item.id}`, { method: 'PATCH', body: { folder_id: item.folder_id } }),
        ),
      );
      await refreshView();
      setViewTitle();
      toast('Move undone');
    },
  });
  state.selectedTaskIds.clear();
  state.selectMode = false;
  await refreshView();
  setViewTitle();
}

async function setTasksTrashed(taskIds, trashed) {
  const previous = taskIds.map((id) => ({ id, trashed: !!taskById(id)?.trashed }));
  await Promise.all(
    taskIds.map((id) => api(`/api/tasks/${id}`, { method: 'PATCH', body: { trashed } })),
  );
  state.selectedTaskIds.clear();
  state.selectMode = false;
  toast(
    trashed
      ? taskIds.length === 1
        ? 'Moved to trash'
        : `Moved ${taskIds.length} to trash`
      : taskIds.length === 1
        ? 'Restored'
        : `Restored ${taskIds.length}`,
    trashed
      ? {
          label: 'Undo',
          onClick: async () => {
            await Promise.all(
              previous.map((item) =>
                api(`/api/tasks/${item.id}`, { method: 'PATCH', body: { trashed: item.trashed } }),
              ),
            );
            await refreshView();
            setViewTitle();
            toast('Trash undone');
          },
        }
      : null,
  );
  await refreshView();
  setViewTitle();
}

function openNewFolderDialog({ onCreated } = {}) {
  const panel = modal(
    'New folder',
    `
      <form id="new-folder-form" class="folder-form">
        <label>
          <span class="input-label">Folder name</span>
          <input class="text-input" id="new-folder-name" type="text" placeholder="e.g. Campaign references" autocomplete="off" />
        </label>
        <div class="folder-form-error" id="new-folder-error" hidden></div>
      </form>
    `,
    `
      <button type="button" class="btn-ghost btn" id="cancel-new-folder">Cancel</button>
      <button type="submit" form="new-folder-form" class="btn btn-with-icon">${icon('folder-plus', { size: 14 })} Create folder</button>
    `,
  );
  const form = panel.querySelector('#new-folder-form');
  const input = panel.querySelector('#new-folder-name');
  const error = panel.querySelector('#new-folder-error');
  const submit = panel.querySelector('button[type="submit"]');
  panel.querySelector('#cancel-new-folder')?.addEventListener('click', closeModal);
  setTimeout(() => input.focus(), 0);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const name = input.value.trim();
    if (!name) {
      error.textContent = 'Name the folder first.';
      error.hidden = false;
      input.focus();
      return;
    }
    submit.disabled = true;
    submit.innerHTML = `${icon('clock', { size: 14 })} Creating...`;
    try {
      const folder = await api('/api/folders', { method: 'POST', body: { name } });
      await loadFolders();
      closeModal();
      toast(`Created ${folder.name}`);
      if (onCreated) await onCreated(folder);
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
      submit.disabled = false;
      submit.innerHTML = `${icon('folder-plus', { size: 14 })} Create folder`;
    }
  });
}

function openMoveMenu(anchor, taskIds) {
  const firstTask = taskById(taskIds[0]);
  const options = [
    { value: '', label: 'No folder', active: taskIds.length === 1 && !firstTask?.folder_id },
    ...state.folders.map((f) => ({
      value: f.id,
      label: f.name,
      active: taskIds.length === 1 && firstTask?.folder_id === f.id,
    })),
    { value: '__new', label: '+ New folder', active: false },
  ];
  popover(anchor, 'Move to folder', options, async (value) => {
    let folderId = value || null;
    if (value === '__new') {
      return openNewFolderDialog({
        onCreated: async (folder) => moveTasksToFolder(taskIds, folder.id),
      });
    }
    await moveTasksToFolder(taskIds, folderId);
  });
}

function openTaskMenu(anchor, task) {
  const trashed = !!task.trashed;
  const options = [
    { value: 'reuse', label: 'Edit prompt', active: false },
    { value: 'remix', label: 'Remix from image', active: false },
    { value: 'move', label: 'Add to folder', active: false },
    { value: 'copy', label: 'Copy prompt', active: false },
    { value: 'download', label: 'Download first image', active: false },
    { value: 'favorite', label: task.favorite ? 'Unfavorite' : 'Favorite', active: !!task.favorite },
    { value: trashed ? 'restore' : 'trash', label: trashed ? 'Restore' : 'Move to trash', active: false },
  ];
  popover(anchor, 'Actions', options, async (action) => {
    if (action === 'reuse') return reuseTask(task);
    if (action === 'remix') return remixTask(task);
    if (action === 'move') return setTimeout(() => openMoveMenu(anchor, [task.id]), 0);
    if (action === 'copy') return copyText(task.prompt, 'Prompt copied');
    if (action === 'download') return downloadFirstVariant(task);
    if (action === 'favorite') {
      await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: { favorite: !task.favorite } });
      return refreshView();
    }
    if (action === 'trash' || action === 'restore') {
      return setTasksTrashed([task.id], action === 'trash');
    }
  });
}

function closeModal() {
  document.getElementById('active-modal')?.remove();
}

function modal(title, bodyHtml, footerHtml = '') {
  closeModal();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.id = 'active-modal';
  backdrop.addEventListener('click', closeModal);
  const panel = document.createElement('div');
  panel.className = 'modal-panel';
  panel.addEventListener('click', (e) => e.stopPropagation());
  panel.innerHTML = `
    <div class="modal-header">
      <div class="modal-title">${escapeHtml(title)}</div>
      <button class="modal-close" type="button" title="Close">${icon('x', { size: 15 })}</button>
    </div>
    <div class="modal-body">${bodyHtml}</div>
    ${footerHtml ? `<div class="modal-footer">${footerHtml}</div>` : ''}`;
  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);
  panel.querySelector('.modal-close').addEventListener('click', closeModal);
  return panel;
}

function openPromptReview() {
  const promptText = $('#prompt-input').value.trim();
  const { chars, style } = selectedPresetStack();
  const folderName = state.view === 'folder'
    ? state.folders.find((f) => f.id === state.folderId)?.name || 'Current folder'
    : 'My media';
  const composed = composedPrompt(promptText);
  const presetTags = [
    ...chars.map((p) => `<span class="task-preset-tag character">❈ ${escapeHtml(p.name)} v${p.version}</span>`),
    ...(style ? [`<span class="task-preset-tag style">✦ ${escapeHtml(style.name)} v${style.version}</span>`] : []),
  ].join('');
  const refHtml = state.settings.referencePath
    ? `<div class="review-ref"><img src="/refs/${state.settings.referencePath}" alt="reference" /><span>Direct reference attached</span></div>`
    : `<span class="review-muted">No direct reference</span>`;

  const panel = modal(
    'Generation review',
    `
      <div class="review-grid">
        <div><span class="input-label">Destination</span><strong>${escapeHtml(folderName)}</strong></div>
        <div><span class="input-label">Format</span><strong>${state.settings.aspect} · ${state.settings.variants}v · ${state.settings.quality}</strong></div>
      </div>
      <div class="review-section">
        <span class="input-label">Presets</span>
        <div class="task-preset-stack">${presetTags || '<span class="review-muted">No presets selected</span>'}</div>
      </div>
      <div class="review-section">
        <span class="input-label">Reference</span>
        ${refHtml}
      </div>
      <div class="review-section">
        <span class="input-label">Composed prompt</span>
        <pre class="review-prompt">${escapeHtml(composed || 'Write a prompt in the composer to preview the full request.')}</pre>
      </div>
    `,
    `
      <button class="btn-ghost btn btn-with-icon" id="copy-composed">${icon('copy', { size: 14 })} Copy composed</button>
      <button class="btn btn-with-icon" id="create-from-review">${icon('arrow-up', { size: 14 })} Create image</button>
    `,
  );
  panel.querySelector('#copy-composed')?.addEventListener('click', () => copyText(composed, 'Composed prompt copied'));
  panel.querySelector('#create-from-review')?.addEventListener('click', () => {
    closeModal();
    handleGenerate();
  });
}

async function openActivityDrawer() {
  closeModal();
  let recent = state.tasks;
  try {
    recent = await api('/api/tasks?view=all');
  } catch {
    recent = state.tasks;
  }
  recent = recent.slice(0, 18);
  const pending = recent.filter((t) => t.status === 'pending').length;
  const rows = recent.length
    ? recent
        .map((t) => {
          const statusIcon = t.status === 'pending' ? 'clock' : t.status === 'failed' ? 'x' : 'check';
          const statusLabel = t.status === 'pending' ? 'Preparing' : t.status === 'failed' ? 'Failed' : 'Ready';
          return `
            <button class="activity-row" type="button" data-task-id="${t.id}">
              <span class="activity-status ${t.status}">${icon(statusIcon, { size: 14 })}</span>
              <span class="activity-main">
                <span>${escapeHtml(t.prompt || 'Untitled generation')}</span>
                <small>${statusLabel} · ${formatTime(t.created_at)} · ${t.aspect_ratio} · ${t.variant_count || t.variants?.length || 1}v</small>
              </span>
            </button>`;
        })
        .join('')
    : `<div class="activity-empty">No generations loaded in this view yet.</div>`;
  const panel = modal(
    'Generation activity',
    `
      <div class="activity-summary">
        <span>${pending ? `${pending} active` : 'No active generations'}</span>
        <button class="btn-ghost btn btn-with-icon" id="activity-refresh">${icon('refresh-cw', { size: 14 })} Refresh</button>
      </div>
      <div class="activity-list">${rows}</div>
    `,
  );
  panel.classList.add('activity-panel');
  panel.querySelector('#activity-refresh')?.addEventListener('click', async () => {
    await refreshView();
    openActivityDrawer();
  });
  panel.querySelectorAll('.activity-row[data-task-id]').forEach((row) => {
    row.addEventListener('click', () => {
      const id = row.dataset.taskId;
      closeModal();
      if (!String(id).startsWith('pending_')) goto('detail', { detailId: id });
    });
  });
}

function variantByIndex(task, idx) {
  return (task.variants ?? [])[idx] ?? null;
}

function downloadVariant(task, idx) {
  const variant = variantByIndex(task, idx);
  if (!variant) return toast('No image to download', 'err');
  const a = document.createElement('a');
  a.href = `/images/${variant.image_path}`;
  a.download = `${task.id}-${idx}.png`;
  a.click();
}

async function remixVariant(task, idx) {
  const variant = variantByIndex(task, idx);
  if (!variant) return toast('No variant available to remix', 'err');
  try {
    const resp = await fetch(`/images/${variant.image_path}`);
    if (!resp.ok) throw new Error('Could not load source image');
    const blob = await resp.blob();
    const file = new File([blob], `variant-${idx + 1}.png`, { type: blob.type || 'image/png' });
    const up = await uploadFile(file);
    applyTaskToComposer(task, { prompt: '', referencePath: up.path });
    closeModal();
    await goto('media');
    $('#prompt-input').focus();
    toast(`Variant ${idx + 1} attached as remix reference`);
  } catch (e) {
    toast(e.message, 'err');
  }
}

function markBestVariant(task, idx, { refresh = true } = {}) {
  state.bestVariants[task.id] = idx;
  localStorage.setItem(BEST_VARIANTS_KEY, JSON.stringify(state.bestVariants));
  toast(`Marked variant ${idx + 1} as best`);
  if (refresh) refreshView();
}

function openLightbox(task, startIdx = 0) {
  let idx = Math.max(0, Math.min(startIdx, (task.variants ?? []).length - 1));
  const render = () => {
    const variant = variantByIndex(task, idx);
    const bestIdx = state.bestVariants[task.id];
    const panel = modal(
      `Variant ${idx + 1} of ${task.variants?.length || 1}`,
      `
        <div class="lightbox-layout">
          <div class="lightbox-stage">
            ${variant ? `<img src="/images/${variant.image_path}" alt="variant ${idx + 1}" />` : '<div class="empty-state">No image</div>'}
            ${(task.variants ?? []).length > 1
              ? `<button class="lightbox-nav prev" type="button" title="Previous">${icon('arrow-left', { size: 18 })}</button>
                 <button class="lightbox-nav next" type="button" title="Next">${icon('arrow-right', { size: 18 })}</button>`
              : ''}
          </div>
          <aside class="lightbox-side">
            <div class="lightbox-actions">
              <button class="btn btn-with-icon" id="lightbox-remix">${icon('circle-dot', { size: 14 })} Remix this</button>
              <button class="btn-ghost btn btn-with-icon" id="lightbox-download">${icon('download', { size: 14 })} Download</button>
              <button class="btn-ghost btn btn-with-icon ${bestIdx === idx ? 'active' : ''}" id="lightbox-best">${icon('star', { size: 14 })} ${bestIdx === idx ? 'Best' : 'Mark best'}</button>
              <button class="btn-ghost btn btn-with-icon" id="lightbox-copy">${icon('copy', { size: 14 })} Copy prompt</button>
            </div>
            <div class="task-preset-stack">${(task.presets ?? [])
              .map((p) => `<span class="task-preset-tag ${p.type}">${p.type === 'style' ? '✦' : '❈'} ${escapeHtml(p.name)} v${p.version}</span>`)
              .join('')}</div>
            <div>
              <div class="input-label">User prompt</div>
              <div class="lightbox-prompt">${escapeHtml(task.prompt)}</div>
            </div>
            <div>
              <div class="input-label">Composed prompt</div>
              <div class="lightbox-prompt">${escapeHtml(taskRecipe(task) || 'Not captured for this generation.')}</div>
            </div>
          </aside>
        </div>
        ${(task.variants ?? []).length > 1
          ? `<div class="lightbox-rail">${task.variants
              .map((v, i) => `<button type="button" class="${i === idx ? 'active' : ''} ${bestIdx === i ? 'best' : ''}" data-lightbox-idx="${i}"><img src="/images/${v.image_path}" alt="variant ${i + 1}" /><span>${i + 1}</span></button>`)
              .join('')}</div>`
          : ''}
      `,
    );
    panel.classList.add('lightbox-panel');
    panel.querySelector('#lightbox-remix')?.addEventListener('click', () => remixVariant(task, idx));
    panel.querySelector('#lightbox-download')?.addEventListener('click', () => downloadVariant(task, idx));
    panel.querySelector('#lightbox-best')?.addEventListener('click', () => {
      markBestVariant(task, idx, { refresh: false });
      render();
      refreshView();
    });
    panel.querySelector('#lightbox-copy')?.addEventListener('click', () => copyText(taskRecipe(task) || task.prompt, 'Prompt copied'));
    panel.querySelector('.lightbox-nav.prev')?.addEventListener('click', () => {
      idx = (idx - 1 + task.variants.length) % task.variants.length;
      render();
    });
    panel.querySelector('.lightbox-nav.next')?.addEventListener('click', () => {
      idx = (idx + 1) % task.variants.length;
      render();
    });
    panel.querySelectorAll('[data-lightbox-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        idx = Number(btn.dataset.lightboxIdx);
        render();
      });
    });
  };
  render();
}

function taskCardHtml(task) {
  const count = task.variants?.length || task.variant_count || 1;
  const pending = task.status === 'pending';
  const failed = task.status === 'failed';
  const selected = state.selectedTaskIds.has(task.id);
  const variantsHtml = pending
    ? `<div class="task-pending-content">
        <div class="task-pending-spinner"></div>
        <div class="task-pending-label">generating…</div>
        <div class="task-pending-elapsed">0s</div>
      </div>`
    : failed
      ? `<div style="color: var(--danger); padding: 20px; text-align: center;">${escapeHtml(task.error || 'failed')}</div>`
      : task.variants
          .map(
            (v) =>
              `<img src="/images/${v.image_path}" alt="variant ${v.idx}" data-variant-id="${v.id}" data-task-id="${task.id}" loading="lazy" />`,
          )
          .join('');

  const presets = task.presets ?? [];
  const presetStackHtml = presets.length
    ? `<div class="task-preset-stack">${presets
        .map(
          (p) =>
            `<span class="task-preset-tag ${p.type}">${p.type === 'style' ? '✦' : '❈'} ${escapeHtml(p.name)} v${p.version}</span>`,
        )
        .join('')}${task.reference_image_path ? '<span class="task-ref-indicator">◎ ref</span>' : ''}</div>`
    : task.reference_image_path
      ? `<div class="task-preset-stack"><span class="task-ref-indicator">◎ ref attached</span></div>`
      : '';

  const favoriteIconSvg = task.favorite ? icon('star-filled', { size: 12 }) : icon('star', { size: 12 });
  const kindLabel = (task.kind || 'image_generation').replace('_', ' ');

  return `
    <div class="task-card ${pending ? 'pending' : ''} ${failed ? 'failed' : ''} ${selected ? 'selected' : ''}" data-task-id="${task.id}">
      ${Number.isInteger(state.bestVariants[task.id]) ? '<span class="task-best-badge">Best picked</span>' : ''}
      <div class="task-card-tools">
        <button class="task-select ${selected ? 'active' : ''}" data-action="select" title="Select">${icon(selected ? 'check-square' : 'square', { size: 14 })}</button>
        <button class="task-menu" data-action="menu" title="More actions">${icon('more-horizontal', { size: 15 })}</button>
      </div>
      <div class="task-variants" data-count="${count}" data-aspect="${task.aspect_ratio || '1:1'}">${variantsHtml}</div>
      <div class="task-meta">
        <div class="task-label">${kindLabel}</div>
        ${presetStackHtml}
        <div class="task-prompt">${escapeHtml(task.prompt)}</div>
      </div>
      <div class="task-footer">
        <span>${formatTime(task.created_at)}</span>
        <div class="task-footer-actions">
          <button class="pill ${task.favorite ? 'active' : ''}" data-action="favorite" title="Favorite">${favoriteIconSvg}</button>
          ${task.trashed
            ? `<button class="pill" data-action="restore" title="Restore">${icon('corner-up-left', { size: 12 })}</button>`
            : `<button class="pill pill-danger" data-action="trash" title="Move to trash">${icon('trash', { size: 12 })}</button>`}
        </div>
      </div>
    </div>`;
}

function renderGallery() {
  const root = $('#view-root');
  const tasks = filteredTasks();
  if (state.tasks.length === 0) {
    const emptyByView = {
      media: { icon: 'images', title: 'Nothing here yet', hint: 'Describe an image in the bar below to begin. Attach a character preset to anchor identity.' },
      favorites: { icon: 'star', title: 'No favorites', hint: 'Tap the star on any generation to save it here.' },
      trash: { icon: 'trash', title: 'Trash is empty', hint: 'Removed generations land here before they\'re gone forever.' },
      folder: { icon: 'folder', title: 'Folder is empty', hint: 'Generate with this folder open, or move things in from the gallery.' },
    };
    const e = emptyByView[state.view] ?? emptyByView.media;
    root.innerHTML = `<div class="empty-state">
      <div class="empty-state-icon">${icon(e.icon, { size: 48 })}</div>
      <div class="empty-state-title">${e.title}</div>
      <div class="empty-state-hint">${e.hint}</div>
    </div>`;
    return;
  }
  if (tasks.length === 0) {
    root.innerHTML = `<div class="empty-state">
      <div class="empty-state-icon">${icon('search', { size: 48 })}</div>
      <div class="empty-state-title">No matches</div>
      <div class="empty-state-hint">Try a prompt fragment, preset name, date, aspect ratio, or quality.</div>
    </div>`;
    return;
  }
  const groups = groupTasksByDate(tasks);
  const html = [...groups.entries()]
    .map(
      ([key, tasks]) => `
      <div class="date-group">
        <div class="date-header">${formatDateHeader(key)}</div>
        <div class="task-grid">${tasks.map(taskCardHtml).join('')}</div>
      </div>`,
    )
    .join('');
  root.innerHTML = html;
  updateSelectionBar();

  // Delegate events for task actions
  root.onclick = async (ev) => {
    const btn = ev.target.closest('button[data-action]');
    if (btn) {
      ev.stopPropagation();
      const card = btn.closest('.task-card');
      const taskId = card.dataset.taskId;
      const action = btn.dataset.action;
      const task = taskById(taskId);
      try {
        if (action === 'select') {
          state.selectMode = true;
          toggleTaskSelection(taskId);
        } else if (action === 'menu') {
          if (task) openTaskMenu(btn, task);
        } else if (action === 'favorite') {
          await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { favorite: !task.favorite } });
          await refreshView();
        } else if (action === 'trash') {
          await setTasksTrashed([taskId], true);
        } else if (action === 'restore') {
          await setTasksTrashed([taskId], false);
        }
      } catch (e) {
        toast(e.message, 'err');
      }
      return;
    }
    const card = ev.target.closest('.task-card');
    if (state.selectMode && card) {
      toggleTaskSelection(card.dataset.taskId);
      return;
    }
    const img = ev.target.closest('img[data-variant-id]');
    if (img) {
      goto('detail', { detailId: img.dataset.taskId });
    }
  };
}

// ---- Render: presets ----
async function renderPresets() {
  await loadPresets();
  const root = $('#view-root');

  const countAll = state.presets.length;
  const countCharacter = state.presets.filter((p) => p.type === 'character').length;
  const countStyle = state.presets.filter((p) => p.type === 'style').length;

  root.innerHTML = `
    <div class="presets-layout">
      <div>
        <div class="presets-list-header">
          <span class="input-label">All Presets</span>
          <button id="new-preset-btn">+ New</button>
        </div>
        <div class="preset-tools">
          <label class="preset-search">
            ${icon('search', { size: 14 })}
            <input id="preset-search-input" type="search" value="${escapeHtml(state.presetSearch)}" placeholder="Search presets..." autocomplete="off" />
          </label>
          <div class="preset-filter" role="tablist" aria-label="Preset type filter">
            <button type="button" data-preset-filter="all" class="${state.presetTypeFilter === 'all' ? 'active' : ''}">All (${countAll})</button>
            <button type="button" data-preset-filter="character" class="${state.presetTypeFilter === 'character' ? 'active' : ''}">Characters (${countCharacter})</button>
            <button type="button" data-preset-filter="style" class="${state.presetTypeFilter === 'style' ? 'active' : ''}">Styles (${countStyle})</button>
          </div>
        </div>
        <div class="presets-list" id="presets-list"></div>
      </div>
      <div id="preset-detail-root"></div>
    </div>`;

  const listRoot = $('#presets-list');
  const detailRoot = $('#preset-detail-root');

  const visiblePresets = () => {
    const term = state.presetSearch.trim().toLowerCase();
    return state.presets.filter((p) => {
      if (state.presetTypeFilter !== 'all' && p.type !== state.presetTypeFilter) return false;
      if (!term) return true;
      return `${p.name} ${p.body} ${p.type}`.toLowerCase().includes(term);
    });
  };

  const paintList = () => {
    const visible = visiblePresets();
    let selectedId = root.dataset.selectedId || visible[0]?.id || '';
    if (!visible.some((p) => p.id === selectedId)) selectedId = visible[0]?.id || '';
    root.dataset.selectedId = selectedId;

    listRoot.innerHTML = '';
    for (const p of visible) {
      const el = document.createElement('div');
      el.className = `preset-item preset-item--${p.type}${p.id === selectedId ? ' active' : ''}`;
      el.dataset.presetId = p.id;
      el.innerHTML = `
        <div>
          <span class="preset-item-glyph" aria-hidden="true">${p.type === 'style' ? '✦' : '●'}</span>
          <span class="preset-item-name">${escapeHtml(p.name)}</span>
          <span class="preset-item-version">v${p.version}</span>
          <span class="preset-item-type ${p.type}">${p.type}</span>
        </div>
        <span class="preset-item-count">${String(p.use_count).padStart(4, '0')}</span>`;
      el.onclick = () => selectPreset(p.id);
      listRoot.appendChild(el);
    }

    if (state.presets.length === 0) {
      listRoot.innerHTML = `<div class="empty-state preset-list-empty">No presets yet. Create one to lock in your style.</div>`;
    } else if (visible.length === 0) {
      listRoot.innerHTML = `<div class="empty-state preset-list-empty">No presets match that filter.</div>`;
    }

    if (selectedId) {
      renderPresetDetail(selectedId, false);
    } else if (state.presets.length === 0) {
      renderPresetDetail(null, true);
    } else {
      detailRoot.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">${icon('search', { size: 48 })}</div>
          <div class="empty-state-title">No preset selected</div>
          <div class="empty-state-hint">Clear the search or switch filters to choose a preset.</div>
        </div>`;
    }
  };

  $('#new-preset-btn').onclick = () => renderPresetDetail(null, true);
  $('#preset-search-input').addEventListener('input', (ev) => {
    state.presetSearch = ev.currentTarget.value;
    paintList();
  });
  $$('.preset-filter button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.presetTypeFilter = btn.dataset.presetFilter;
      savePresetFilter(state.presetTypeFilter);
      $$('.preset-filter button').forEach((el) =>
        el.classList.toggle('active', el.dataset.presetFilter === state.presetTypeFilter),
      );
      paintList();
    });
  });

  paintList();
}

function selectPreset(id) {
  $('#view-root').dataset.selectedId = id;
  $$('.preset-item').forEach((el) => el.classList.toggle('active', el.dataset.presetId === id));
  renderPresetDetail(id, false);
}

function renderPresetDetail(id, isNew) {
  const root = $('#preset-detail-root');
  const preset = id ? state.presets.find((p) => p.id === id) : null;

  // Working state for the editor — mirrors preset, but lets us change type and ref on the fly.
  const current = {
    type: preset?.type ?? 'character',
    reference_image_path: preset?.reference_image_path ?? null,
  };

  const refImageHtml = () => {
    if (current.type !== 'character') return '';
    const hasRef = !!current.reference_image_path;
    return `
      <div>
        <div class="input-label">Reference image</div>
        <div class="preset-ref-upload">
          ${
            hasRef
              ? `<img src="/refs/${current.reference_image_path}" alt="reference" />`
              : `<div class="empty">no image</div>`
          }
          <div class="preset-ref-upload-info">
            <span class="label">${hasRef ? 'Pinned to this preset' : 'Anchor for identity'}</span>
            <span class="hint">
              ${hasRef
                ? 'Every generation that uses this preset will route through images.edit with this anchor.'
                : 'Drop a clear shot of the character. Front-facing, good lighting, roughly waist-up works best.'}
            </span>
            <div class="preset-ref-upload-actions">
              <button type="button" class="btn-ghost btn" id="preset-upload-btn">${hasRef ? 'Replace' : 'Upload'}</button>
              ${hasRef ? `<button type="button" class="btn-danger btn" id="preset-remove-ref">Remove</button>` : ''}
              <input type="file" id="preset-ref-input" accept="image/png,image/webp,image/jpeg" hidden />
            </div>
          </div>
        </div>
      </div>`;
  };

  const typeToggleHtml = () => `
    <div class="type-toggle" id="preset-type-toggle">
      <button type="button" data-type="character" class="${current.type === 'character' ? 'active' : ''}">Character</button>
      <button type="button" data-type="style" class="${current.type === 'style' ? 'active' : ''}">Style</button>
    </div>`;

  const render = () => {
    root.innerHTML = `
      <div class="preset-detail">
        <div class="preset-detail-header">
          <div class="preset-detail-title">
            <h2>${isNew ? 'New Preset' : escapeHtml(preset?.name || '')}</h2>
            ${preset ? `<span class="preset-detail-version">v${preset.version}</span>` : ''}
          </div>
          <div class="preset-actions">
            ${preset ? `<button class="btn-danger btn" id="archive-preset">Archive</button>` : ''}
          </div>
        </div>

        <div style="display: flex; align-items: center; gap: 12px;">
          <div class="input-label" style="margin: 0;">Type</div>
          ${typeToggleHtml()}
        </div>

        <div>
          <div class="input-label">Name</div>
          <input type="text" id="preset-name" class="text-input" value="${escapeHtml(preset?.name || '')}" placeholder="${current.type === 'character' ? 'e.g. Mary Vale' : 'e.g. Film Noir'}" />
        </div>

        <div>
          <div class="input-label">${current.type === 'character' ? 'Character description' : 'Style description'}</div>
          <textarea id="preset-body" class="text-input" placeholder="${current.type === 'character' ? 'Physical description, distinguishing features, outfit defaults, mannerisms…' : 'Rendering aesthetic, lighting mood, palette, medium, film reference…'}">${escapeHtml(preset?.body || '')}</textarea>
        </div>

        ${refImageHtml()}

        <div style="display: flex; gap: 10px; justify-content: flex-end;">
          <button class="btn" id="save-preset">${isNew || !preset ? 'Create' : 'Save (new version)'}</button>
        </div>
      </div>`;

    // Type toggle
    root.querySelectorAll('#preset-type-toggle button').forEach((btn) => {
      btn.addEventListener('click', () => {
        current.type = btn.dataset.type;
        render();
      });
    });

    // Upload / remove reference (character only)
    const uploadBtn = $('#preset-upload-btn');
    const fileInput = $('#preset-ref-input');
    if (uploadBtn && fileInput) {
      uploadBtn.onclick = () => fileInput.click();
      fileInput.onchange = async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        try {
          const up = await uploadFile(file);
          current.reference_image_path = up.path;
          render();
        } catch (e) {
          toast(e.message, 'err');
        }
      };
    }
    $('#preset-remove-ref')?.addEventListener('click', () => {
      current.reference_image_path = null;
      render();
    });

    // Save
    $('#save-preset').onclick = async () => {
      const name = $('#preset-name').value.trim();
      const body = $('#preset-body').value.trim();
      if (!name || !body) {
        toast('Name and body are required', 'err');
        return;
      }
      try {
        const payload = {
          name,
          body,
          type: current.type,
          reference_image_path: current.type === 'character' ? current.reference_image_path : null,
          ...(preset ? { fork_from: preset.id } : {}),
        };
        const saved = await api('/api/presets', { method: 'POST', body: payload });
        toast(`${preset ? 'Saved' : 'Created'} ${saved.name} v${saved.version}`);
        await loadPresets();
        $('#view-root').dataset.selectedId = saved.id;
        renderPresets();
      } catch (e) {
        toast(e.message, 'err');
      }
    };

    // Archive
    $('#archive-preset')?.addEventListener('click', async () => {
      if (!preset) return;
      try {
        await api(`/api/presets/${preset.id}`, { method: 'PATCH', body: { archived: true } });
        toast(`Archived ${preset.name}`);
        await loadPresets();
        $('#view-root').dataset.selectedId = '';
        renderPresets();
      } catch (e) {
        toast(e.message, 'err');
      }
    });
  };

  render();
}

// ---- Pending polling + elapsed counter ----
let pendingPollTimer = null;
let elapsedTickerTimer = null;

function anyPending() {
  return state.tasks.some((t) => t.status === 'pending' && String(t.id).startsWith('pending_'));
}

function startPendingPolling() {
  // Start elapsed ticker if not running
  if (!elapsedTickerTimer) {
    elapsedTickerTimer = setInterval(tickElapsed, 1000);
  }
  // Start polling timer if not running
  if (!pendingPollTimer) {
    pendingPollTimer = setInterval(pollPending, 8000);
  }
  tickElapsed();
}

function stopPendingTimers() {
  if (elapsedTickerTimer) {
    clearInterval(elapsedTickerTimer);
    elapsedTickerTimer = null;
  }
  if (pendingPollTimer) {
    clearInterval(pendingPollTimer);
    pendingPollTimer = null;
  }
}

function tickElapsed() {
  if (!anyPending()) {
    stopPendingTimers();
    return;
  }
  // Update elapsed label directly in the DOM — no full re-render
  for (const t of state.tasks) {
    if (t.status !== 'pending' || !t._clientStartMs) continue;
    const el = document.querySelector(`.task-card[data-task-id="${t.id}"] .task-pending-elapsed`);
    if (el) {
      const secs = Math.floor((Date.now() - t._clientStartMs) / 1000);
      el.textContent = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
    }
  }
}

async function pollPending() {
  if (!anyPending()) {
    stopPendingTimers();
    return;
  }
  // Only poll if the user is on a view where tasks are listed
  if (state.view !== 'media' && state.view !== 'folder' && state.view !== 'favorites') return;

  try {
    const params = new URLSearchParams();
    if (state.view === 'favorites') params.set('view', 'favorites');
    else if (state.view === 'folder') {
      params.set('view', 'folder');
      if (state.folderId) params.set('folder_id', state.folderId);
    } else params.set('view', 'media');

    const serverTasks = await api('/api/tasks?' + params.toString());
    const pendingTasks = state.tasks.filter(
      (t) => t.status === 'pending' && String(t.id).startsWith('pending_'),
    );

    // For each pending task, look for a matching server task (same prompt, server created_at >= client start - 5s)
    const matched = new Set();
    const kept = [];
    for (const p of pendingTasks) {
      const match = serverTasks.find(
        (s) =>
          !matched.has(s.id) &&
          s.prompt === p.prompt &&
          s.created_at >= p._clientStartMs - 5000 &&
          s.status !== 'pending',
      );
      if (match) {
        matched.add(match.id);
      } else {
        kept.push(p);
      }
    }

    if (kept.length !== pendingTasks.length) {
      // At least one pending resolved on the server — rebuild state.tasks with server authoritative + remaining pendings
      state.tasks = [...kept, ...serverTasks];
      renderGallery();
      setViewTitle();
      if (!anyPending()) stopPendingTimers();
    }
  } catch (e) {
    console.warn('[poll]', e.message);
  }
}

// ---- Workshop ----
function loadDrafts() {
  return loadJson(DRAFTS_KEY, []).filter((draft) => draft?.id && draft?.prompt);
}

function persistDrafts(drafts) {
  localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts.slice(0, 24)));
}

function savePromptDraft(prompt, title = 'Prompt draft', source = 'Workshop') {
  const cleanPrompt = String(prompt ?? '').trim();
  if (!cleanPrompt) return toast('No prompt to save', 'err');
  const draft = {
    id: `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title,
    source,
    prompt: cleanPrompt,
    created_at: Date.now(),
  };
  persistDrafts([draft, ...loadDrafts()]);
  renderDraftList();
  toast('Draft saved');
}

function draftCardHtml(draft) {
  const created = new Date(draft.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `
    <div class="workshop-draft" data-draft-id="${escapeHtml(draft.id)}">
      <div class="workshop-draft-top">
        <div>
          <span class="workshop-draft-title">${escapeHtml(draft.title || 'Prompt draft')}</span>
          <span class="workshop-draft-meta">${escapeHtml(draft.source || 'Workshop')} · ${created}</span>
        </div>
        <button type="button" class="btn-ghost btn" data-draft-action="delete" title="Delete draft">${icon('trash', { size: 13 })}</button>
      </div>
      <div class="workshop-draft-body">${escapeHtml(draft.prompt)}</div>
      <div class="workshop-draft-actions">
        <button type="button" class="btn btn-with-icon" data-draft-action="send">${icon('arrow-up', { size: 14 })} Send to bar</button>
        <button type="button" class="btn-ghost btn btn-with-icon" data-draft-action="copy">${icon('copy', { size: 14 })} Copy</button>
      </div>
    </div>`;
}

function renderDraftList() {
  const root = $('#ws-drafts-list');
  if (!root) return;
  const drafts = loadDrafts();
  root.innerHTML = drafts.length
    ? drafts.map(draftCardHtml).join('')
    : `<div class="workshop-drafts-empty">Saved workshop prompts will wait here until you are ready to generate.</div>`;
  const count = $('#ws-draft-count');
  if (count) count.textContent = drafts.length === 1 ? '1 draft' : `${drafts.length} drafts`;
}

function wireDraftActions() {
  $('#ws-drafts-list')?.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-draft-action]');
    if (!btn) return;
    const card = btn.closest('[data-draft-id]');
    const draft = loadDrafts().find((item) => item.id === card?.dataset.draftId);
    if (!draft) return;

    if (btn.dataset.draftAction === 'send') {
      sendPromptToBar(draft.prompt);
    } else if (btn.dataset.draftAction === 'copy') {
      await copyText(draft.prompt, 'Draft copied');
    } else if (btn.dataset.draftAction === 'delete') {
      persistDrafts(loadDrafts().filter((item) => item.id !== draft.id));
      renderDraftList();
      toast('Draft deleted', {
        label: 'Undo',
        onClick: () => {
          persistDrafts([draft, ...loadDrafts()]);
          renderDraftList();
        },
      });
    }
  });
}

function renderWorkshop() {
  const root = $('#view-root');
  const sketchpadValue = localStorage.getItem(SKETCHPAD_KEY) ?? '';

  root.innerHTML = `
    <div class="workshop">
      <div class="workshop-panels">

        <!-- From an Image -->
        <div class="workshop-card">
          <div class="workshop-card-header">
            <div class="workshop-card-icon">${icon('image-plus', { size: 18 })}</div>
            <div class="workshop-card-titles">
              <span class="workshop-card-title">From an Image</span>
              <span class="workshop-card-hint">Drop in any image and I'll reverse-engineer it into a prompt.</span>
            </div>
          </div>

          <div id="ws-drop" class="workshop-image-drop">
            Click or drop an image here (PNG, JPG, WEBP)
          </div>
          <input type="file" id="ws-image-input" accept="image/png,image/webp,image/jpeg" hidden />

          <div id="ws-image-preview" hidden></div>

          <div id="ws-image-output" class="workshop-output empty">prompt will appear here</div>

          <div class="workshop-actions">
            <button class="btn-ghost btn" id="ws-image-analyze" disabled>${icon('sparkles', { size: 14 })} <span>Analyze</span></button>
            <button class="btn btn-with-icon" id="ws-image-send" disabled>${icon('arrow-up', { size: 14 })} Send to bar</button>
            <button class="btn-ghost btn btn-with-icon" id="ws-image-draft" disabled>${icon('archive', { size: 14 })} Save draft</button>
          </div>
        </div>

        <!-- Brain Dump -->
        <div class="workshop-card">
          <div class="workshop-card-header">
            <div class="workshop-card-icon">${icon('lightbulb', { size: 18 })}</div>
            <div class="workshop-card-titles">
              <span class="workshop-card-title">Brain Dump</span>
              <span class="workshop-card-hint">Toss me a fragment — I'll come back with three different reads.</span>
            </div>
          </div>

          <textarea id="ws-dump" class="text-input" placeholder="autumn, quiet, window light, cats somewhere…" style="min-height: 90px; font-family: var(--font-body);"></textarea>

          <div class="workshop-actions">
            <button class="btn btn-with-icon" id="ws-brainstorm-btn">${icon('sparkles', { size: 14 })} Generate ideas</button>
          </div>

          <div id="ws-brainstorm-output"></div>
        </div>
      </div>

      <!-- Prompt Drafts -->
      <div class="workshop-drafts">
        <div class="workshop-drafts-header">
          <div class="workshop-card-header" style="padding: 0; border-bottom: none;">
            <div class="workshop-card-icon">${icon('archive', { size: 18 })}</div>
            <div class="workshop-card-titles">
              <span class="workshop-card-title">Prompt Drafts</span>
              <span class="workshop-card-hint">Save ideas from the workshop and send them back into the composer later.</span>
            </div>
          </div>
          <span id="ws-draft-count">0 drafts</span>
        </div>
        <div class="workshop-drafts-list" id="ws-drafts-list"></div>
      </div>

      <!-- Sketchpad -->
      <div class="workshop-sketchpad">
        <div class="workshop-card-header" style="padding-bottom: 8px;">
          <div class="workshop-card-icon">${icon('pen-tool', { size: 18 })}</div>
          <div class="workshop-card-titles">
            <span class="workshop-card-title">Sketchpad</span>
            <span class="workshop-card-hint">Freeform notes that stay here across sessions.</span>
          </div>
        </div>
        <textarea id="ws-sketchpad" placeholder="jot ideas, fragments, phrases, references…">${escapeHtml(sketchpadValue)}</textarea>
        <div class="workshop-sketchpad-footer">
          <span id="ws-sketchpad-status">saved</span>
          <span>auto-saves locally</span>
        </div>
      </div>
    </div>`;

  wireWorkshop();
  renderDraftList();
}

function wireWorkshop() {
  // --- Image to prompt ---
  const drop = $('#ws-drop');
  const fileInput = $('#ws-image-input');
  const preview = $('#ws-image-preview');
  const output = $('#ws-image-output');
  const analyzeBtn = $('#ws-image-analyze');
  const sendBtn = $('#ws-image-send');
  const draftBtn = $('#ws-image-draft');
  let selectedFile = null;
  let generatedPrompt = '';

  const pickFile = () => fileInput.click();
  drop.onclick = pickFile;

  ['dragover', 'dragenter'].forEach((evt) =>
    drop.addEventListener(evt, (e) => {
      e.preventDefault();
      drop.classList.add('dragover');
    }),
  );
  ['dragleave', 'drop'].forEach((evt) =>
    drop.addEventListener(evt, (e) => {
      e.preventDefault();
      drop.classList.remove('dragover');
    }),
  );
  drop.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) handleFile(f);
  });

  fileInput.onchange = () => {
    const f = fileInput.files?.[0];
    if (f) handleFile(f);
  };

  function handleFile(f) {
    if (!f.type.startsWith('image/')) {
      toast('Not an image file', 'err');
      return;
    }
    selectedFile = f;
    const url = URL.createObjectURL(f);
    preview.hidden = false;
    preview.innerHTML = `<div class="workshop-image-preview"><img src="${url}" alt="preview" /><div style="color: var(--text-secondary); font-size: 0.78rem;">${escapeHtml(f.name)}</div></div>`;
    analyzeBtn.disabled = false;
    output.className = 'workshop-output empty';
    output.textContent = 'ready to analyze';
    generatedPrompt = '';
    sendBtn.disabled = true;
    draftBtn.disabled = true;
  }

  analyzeBtn.onclick = async () => {
    if (!selectedFile) return;
    const origHtml = analyzeBtn.innerHTML;
    analyzeBtn.disabled = true;
    analyzeBtn.innerHTML = '<span class="workshop-spinner"></span> <span>Analyzing…</span>';
    output.className = 'workshop-output empty';
    output.textContent = 'thinking…';
    try {
      const fd = new FormData();
      fd.append('file', selectedFile);
      const resp = await fetch('/api/workshop/from-image', { method: 'POST', body: fd });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        throw new Error(err.error || 'Failed');
      }
      const data = await resp.json();
      generatedPrompt = data.prompt || '';
      output.className = 'workshop-output';
      output.textContent = generatedPrompt;
      sendBtn.disabled = !generatedPrompt;
      draftBtn.disabled = !generatedPrompt;
    } catch (e) {
      output.className = 'workshop-output empty';
      output.textContent = 'failed';
      toast(e.message, 'err');
    } finally {
      analyzeBtn.innerHTML = origHtml;
      analyzeBtn.disabled = false;
    }
  };

  sendBtn.onclick = () => {
    if (!generatedPrompt) return;
    sendPromptToBar(generatedPrompt);
  };
  draftBtn.onclick = () => savePromptDraft(generatedPrompt, selectedFile?.name || 'Image prompt', 'From image');

  // --- Brain dump ---
  const dumpInput = $('#ws-dump');
  const brainstormBtn = $('#ws-brainstorm-btn');
  const brainstormOut = $('#ws-brainstorm-output');

  brainstormBtn.onclick = async () => {
    const dump = dumpInput.value.trim();
    if (!dump) {
      toast('Write something first', 'err');
      return;
    }
    const origHtml = brainstormBtn.innerHTML;
    brainstormBtn.disabled = true;
    brainstormBtn.innerHTML = '<span class="workshop-spinner"></span> <span>Generating…</span>';
    brainstormOut.innerHTML = '<div class="workshop-output empty">three reads coming…</div>';
    try {
      const data = await api('/api/workshop/brainstorm', { method: 'POST', body: { dump } });
      const options = data.options || [];
      if (options.length === 0) {
        brainstormOut.innerHTML = '<div class="workshop-output empty">no options returned</div>';
      } else {
        brainstormOut.innerHTML = options
          .map(
            (opt, i) => `
          <div class="workshop-brainstorm-option" data-idx="${i}">
            <span class="workshop-brainstorm-option-title">${escapeHtml(opt.title || `Option ${i + 1}`)}</span>
            <div class="workshop-brainstorm-option-body">${escapeHtml(opt.prompt || '')}</div>
            <div class="workshop-brainstorm-option-actions">
              <button class="btn btn-with-icon" data-action="send-option" data-idx="${i}">${icon('arrow-up', { size: 14 })} Send to bar</button>
              <button class="btn-ghost btn btn-with-icon" data-action="copy-option" data-idx="${i}">${icon('copy', { size: 14 })} Copy</button>
              <button class="btn-ghost btn btn-with-icon" data-action="save-option" data-idx="${i}">${icon('archive', { size: 14 })} Save draft</button>
            </div>
          </div>`,
          )
          .join('');

        brainstormOut.querySelectorAll('button[data-action]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const idx = Number(btn.dataset.idx);
            const opt = options[idx];
            if (btn.dataset.action === 'send-option') {
              sendPromptToBar(opt.prompt);
            } else if (btn.dataset.action === 'copy-option') {
              try {
                await navigator.clipboard.writeText(opt.prompt);
                toast('Copied');
              } catch (e) {
                toast(e.message, 'err');
              }
            } else if (btn.dataset.action === 'save-option') {
              savePromptDraft(opt.prompt, opt.title || `Option ${idx + 1}`, 'Brain dump');
            }
          });
        });
      }
    } catch (e) {
      brainstormOut.innerHTML = '<div class="workshop-output empty">failed</div>';
      toast(e.message, 'err');
    } finally {
      brainstormBtn.innerHTML = origHtml;
      brainstormBtn.disabled = false;
    }
  };

  // --- Sketchpad (localStorage persistence) ---
  const sketchpad = $('#ws-sketchpad');
  const sketchpadStatus = $('#ws-sketchpad-status');
  let sketchpadTimer = null;
  sketchpad.addEventListener('input', () => {
    sketchpadStatus.textContent = 'saving…';
    clearTimeout(sketchpadTimer);
    sketchpadTimer = setTimeout(() => {
      localStorage.setItem(SKETCHPAD_KEY, sketchpad.value);
      sketchpadStatus.textContent = 'saved';
    }, 400);
  });

  wireDraftActions();
}

function sendPromptToBar(promptText) {
  $('#prompt-input').value = promptText;
  autoResizePrompt();
  goto('media').then(() => $('#prompt-input').focus());
  toast('Loaded into prompt bar');
}

// ---- Upload helper ----
async function uploadFile(file) {
  const fd = new FormData();
  fd.append('file', file);
  const resp = await fetch('/api/upload', { method: 'POST', body: fd });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error || 'Upload failed');
  }
  return resp.json();
}

// ---- Render: detail ----
async function renderDetail(taskId) {
  const root = $('#view-root');
  root.innerHTML = `<div class="empty-state">Loading…</div>`;
  let task;
  try {
    task = await api(`/api/tasks/${taskId}`);
  } catch (e) {
    root.innerHTML = `<div class="empty-state">${escapeHtml(e.message)}</div>`;
    return;
  }

  const presets = task.presets ?? [];
  const characterPresetsInTask = presets.filter((p) => p.type === 'character');
  const stylePresetInTask = presets.find((p) => p.type === 'style') ?? null;

  const presetBlock = presets.length
    ? `<div class="task-preset-stack" style="gap: 8px;">${presets
        .map(
          (p) =>
            `<span class="task-preset-tag ${p.type}" style="font-size: 0.66rem; padding: 4px 10px;">${p.type === 'style' ? '✦' : '❈'} ${escapeHtml(p.name)} v${p.version}</span>`,
        )
        .join('')}</div>`
    : '';

  const refBlock = task.reference_image_path
    ? `<div>
        <div class="input-label">Direct reference</div>
        <img src="/refs/${task.reference_image_path}" alt="reference" style="max-width: 180px; border-radius: 8px; border: 1px solid rgba(196, 168, 114, 0.25); margin-top: 6px;" />
       </div>`
    : '';

  root.innerHTML = `
    <div class="detail-view">
      <div class="detail-toolbar">
        <button class="btn-ghost btn btn-with-icon" id="back-btn">${icon('arrow-left', { size: 14 })} Back</button>
        <div class="detail-toolbar-meta">
          ${new Date(task.created_at).toLocaleString()} · ${task.aspect_ratio} · ${task.quality}
        </div>
        <div class="detail-toolbar-actions">
          <button class="btn-ghost btn btn-with-icon ${task.favorite ? 'active' : ''}" id="favorite-detail" title="Favorite">${icon(task.favorite ? 'star-filled' : 'star', { size: 14 })} Favorite</button>
          <button class="btn btn-with-icon" id="reuse-prompt" title="Load prompt and settings into the bar">${icon('refresh-cw', { size: 14 })} Edit prompt</button>
          ${task.variants?.length ? `<button class="btn-ghost btn btn-with-icon" id="remix-btn" title="Use first variant as reference for a new gen">${icon('circle-dot', { size: 14 })} Remix</button>` : ''}
          <button class="btn-ghost btn btn-with-icon" id="move-detail" title="Move to folder">${icon('folder', { size: 14 })} Move</button>
          ${task.variants?.length ? `<button class="btn-ghost btn btn-with-icon" id="download-first" title="Download first variant">${icon('download', { size: 14 })} Download</button>` : ''}
        </div>
      </div>
      <div class="detail-variants">
        ${(task.variants || [])
          .map(
            (v, idx) => `
            <div class="detail-variant-wrap" style="position: relative;">
              <img src="/images/${v.image_path}" alt="variant ${v.idx}" data-variant-idx="${idx}" data-variant-path="${v.image_path}" />
              ${state.bestVariants[task.id] === idx ? '<span class="variant-best-badge">Best</span>' : ''}
              <div class="variant-actions">
                <button type="button" data-variant-action="inspect" data-variant-idx="${idx}" title="Inspect">${icon('eye', { size: 14 })}</button>
                <button type="button" data-variant-action="remix" data-variant-idx="${idx}" title="Remix this">${icon('circle-dot', { size: 14 })}</button>
                <button type="button" data-variant-action="best" data-variant-idx="${idx}" title="Mark best">${icon('star', { size: 14 })}</button>
                <a href="/images/${v.image_path}" download="${task.id}-${idx}.png" title="Download variant ${idx + 1}">${icon('download', { size: 14 })}</a>
              </div>
            </div>`,
          )
          .join('')}
      </div>
      ${(task.variants || []).length > 1
        ? `<div class="detail-variant-rail">${task.variants
            .map(
              (v, idx) =>
                `<button type="button" class="${state.bestVariants[task.id] === idx ? 'best' : ''}" data-scroll-variant="${idx}"><img src="/images/${v.image_path}" alt="variant ${idx + 1}" /><span>${idx + 1}</span></button>`,
            )
            .join('')}</div>`
        : ''}
      ${presetBlock}
      ${refBlock}
      <div class="detail-copy-wrap">
        <div class="input-label">User prompt</div>
        <div class="detail-prompt-block">${escapeHtml(task.prompt)}</div>
        <button class="detail-copy-btn" id="copy-prompt" title="Copy prompt to clipboard">${icon('copy', { size: 14 })}</button>
      </div>
      <div class="detail-copy-wrap">
        <div class="input-label">Composed prompt</div>
        <div class="detail-prompt-block">${escapeHtml(taskRecipe(task) || 'Not captured for this generation.')}</div>
        <button class="detail-copy-btn" id="copy-composed-detail" title="Copy composed prompt">${icon('copy', { size: 14 })}</button>
      </div>
    </div>`;

  $('#back-btn').onclick = () => history.back();
  $('#reuse-prompt').onclick = () => reuseTask(task);
  $('#favorite-detail')?.addEventListener('click', async () => {
    await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: { favorite: !task.favorite } });
    toast(task.favorite ? 'Removed from favorites' : 'Favorited');
    await refreshView();
  });
  $('#move-detail')?.addEventListener('click', (ev) => openMoveMenu(ev.currentTarget, [task.id]));

  $('#copy-prompt')?.addEventListener('click', async () => {
    await copyText(task.prompt, 'Prompt copied');
  });
  $('#copy-composed-detail')?.addEventListener('click', () => copyText(taskRecipe(task) || task.prompt, 'Composed prompt copied'));

  $('#download-first')?.addEventListener('click', () => downloadFirstVariant(task));

  $('#remix-btn')?.addEventListener('click', () => remixTask(task));
  $$('.detail-variants img[data-variant-idx]').forEach((img) => {
    img.addEventListener('click', () => openLightbox(task, Number(img.dataset.variantIdx)));
  });
  $$('.variant-actions [data-variant-action]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const idx = Number(btn.dataset.variantIdx);
      const action = btn.dataset.variantAction;
      if (action === 'inspect') openLightbox(task, idx);
      else if (action === 'remix') remixVariant(task, idx);
      else if (action === 'best') markBestVariant(task, idx);
    });
  });
  $$('.detail-variant-rail button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.scrollVariant);
      $$('.detail-variant-wrap')[idx]?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    });
  });
}

// ---- Views ----
async function refreshView() {
  if (state.view === 'presets') return renderPresets();
  if (state.view === 'detail') return renderDetail(state.detailId);
  if (state.view === 'workshop') return renderWorkshop();
  await loadTasks();
  renderGallery();
}

function setViewTitle() {
  const titles = {
    media: 'My media',
    favorites: 'Favorites',
    trash: 'Trash',
    folder: state.folders.find((f) => f.id === state.folderId)?.name || 'Folder',
    presets: 'Presets',
    workshop: 'Workshop',
    detail: 'Detail',
  };
  $('#view-title').textContent = titles[state.view] || 'Easel';
  const galleryView = isGalleryView();
  const tools = $('#gallery-tools');
  tools.hidden = !galleryView;
  if (!galleryView) {
    state.selectMode = false;
    state.selectedTaskIds.clear();
  }
  updateSelectionBar();
  if (galleryView) {
    const filteredCount = filteredTasks().length;
    const totalCount = state.tasks.length;
    const suffix = filteredCount === 1 ? 'generation' : 'generations';
    $('#view-meta').textContent =
      state.search.trim() && filteredCount !== totalCount
        ? `${filteredCount} of ${totalCount} ${suffix}`
        : `${totalCount} ${totalCount === 1 ? 'generation' : 'generations'}`;
  } else {
    $('#view-meta').textContent = '';
  }
}

async function goto(view, opts = {}) {
  closePopover();
  closeModal();
  state.view = view;
  state.folderId = opts.folderId ?? null;
  state.detailId = opts.detailId ?? null;
  updateActiveNav();
  const hash =
    view === 'folder' ? `#folder/${state.folderId}` :
    view === 'detail' ? `#gen/${state.detailId}` :
    `#${view}`;
  if (location.hash !== hash) history.pushState({}, '', hash);
  await refreshView();
  setViewTitle();
}

// ---- Chips (prompt controls) ----
function characterPresets() {
  return state.presets.filter((p) => (p.type ?? 'character') === 'character');
}
function stylePresets() {
  return state.presets.filter((p) => p.type === 'style');
}

function syncChips() {
  $('#chip-aspect .chip-value').textContent = state.settings.aspect;
  $('#chip-aspect').dataset.value = state.settings.aspect;
  $('#chip-variants .chip-value').textContent = `${state.settings.variants}v`;
  $('#chip-variants').dataset.value = String(state.settings.variants);
  $('#chip-quality .chip-value').textContent = state.settings.quality;
  $('#chip-quality').dataset.value = state.settings.quality;

  const chosenChars = state.settings.characterIds
    .map((id) => state.presets.find((p) => p.id === id))
    .filter(Boolean);
  const charLabel =
    chosenChars.length === 0
      ? 'No character'
      : chosenChars.length === 1
        ? `${chosenChars[0].name} v${chosenChars[0].version}`
        : `${chosenChars.map((p) => p.name).join(' + ')}`;
  $('#chip-character .chip-value').textContent = charLabel;
  $('#chip-character').classList.toggle('has-value', chosenChars.length > 0);

  const style = stylePresets().find((p) => p.id === state.settings.styleId);
  $('#chip-style .chip-value').textContent = style ? `${style.name} v${style.version}` : 'No style';
  $('#chip-style').classList.toggle('has-value', !!style);
  saveSettings();
}

function wireChips() {
  $('#chip-aspect').onclick = (ev) => {
    popover(
      ev.currentTarget,
      'Aspect ratio',
      ASPECTS.map((a) => ({ value: a, label: a, active: a === state.settings.aspect })),
      (v) => {
        state.settings.aspect = v;
        syncChips();
      },
    );
  };
  $('#chip-variants').onclick = (ev) => {
    popover(
      ev.currentTarget,
      'Variants',
      VARIANTS.map((n) => ({ value: n, label: `${n} ${n === 1 ? 'image' : 'images'}`, active: n === state.settings.variants })),
      (v) => {
        state.settings.variants = v;
        syncChips();
      },
    );
  };
  $('#chip-quality').onclick = (ev) => {
    popover(
      ev.currentTarget,
      'Quality',
      QUALITIES.map((q) => ({ value: q, label: q, active: q === state.settings.quality })),
      (v) => {
        state.settings.quality = v;
        syncChips();
      },
    );
  };

  $('#chip-character').onclick = (ev) => {
    const chars = characterPresets();
    if (chars.length === 0) {
      toast('No character presets yet — create one in the Presets page', 'err');
      return;
    }
    const options = chars.map((p) => ({
      value: p.id,
      label: `${p.name} v${p.version}${p.reference_image_path ? ' · ref' : ''}`,
      active: state.settings.characterIds.includes(p.id),
    }));
    popover(
      ev.currentTarget,
      'Characters',
      options,
      (id, active) => {
        if (active) {
          if (!state.settings.characterIds.includes(id)) state.settings.characterIds.push(id);
        } else {
          state.settings.characterIds = state.settings.characterIds.filter((x) => x !== id);
        }
        syncChips();
      },
      { multi: true },
    );
  };

  $('#chip-style').onclick = (ev) => {
    const styles = stylePresets();
    const options = [
      { value: '', label: 'No style', active: state.settings.styleId === '' },
      ...styles.map((p) => ({
        value: p.id,
        label: `${p.name} v${p.version}`,
        active: p.id === state.settings.styleId,
      })),
    ];
    popover(ev.currentTarget, 'Style', options, (v) => {
      state.settings.styleId = v;
      syncChips();
    });
  };
}

// ---- Reference attach (prompt-bar direct single image) ----
function renderRefStrip() {
  const strip = $('#ref-strip');
  strip.innerHTML = '';
  if (!state.settings.referencePath) {
    strip.hidden = true;
    return;
  }
  strip.hidden = false;
  const thumb = document.createElement('div');
  thumb.className = 'ref-thumb';
  thumb.innerHTML = `
    <img src="/refs/${state.settings.referencePath}" alt="reference" />
    <button type="button" class="remove" title="Remove">×</button>
    <span class="ref-thumb-label">Ref</span>`;
  thumb.querySelector('.remove').onclick = () => {
    state.settings.referencePath = null;
    renderRefStrip();
  };
  strip.appendChild(thumb);
}

async function attachReferenceFile(file) {
  if (!file?.type?.startsWith('image/')) {
    toast('Drop an image file to attach a reference', 'err');
    return;
  }
  const up = await uploadFile(file);
  state.settings.referencePath = up.path;
  renderRefStrip();
  toast('Reference attached');
}

function wireAttach() {
  const btn = $('#attach-btn');
  const input = $('#attach-input');
  const form = $('#prompt-form');
  btn.onclick = () => input.click();
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      await attachReferenceFile(file);
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      input.value = ''; // reset so same file can be re-picked
    }
  };
  ['dragenter', 'dragover'].forEach((evt) => {
    form.addEventListener(evt, (e) => {
      if (![...e.dataTransfer?.items ?? []].some((item) => item.type.startsWith('image/'))) return;
      e.preventDefault();
      form.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    form.addEventListener(evt, (e) => {
      e.preventDefault();
      form.classList.remove('dragover');
    });
  });
  form.addEventListener('drop', async (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    try {
      await attachReferenceFile(file);
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

// ---- Generate ----
async function handleGenerate(ev) {
  if (ev) ev.preventDefault();
  const input = $('#prompt-input');
  const prompt = input.value.trim();
  if (!prompt) return;

  const send = $('#send-btn');
  send.disabled = true;
  send.textContent = '…';

  const characterIds = [...state.settings.characterIds];
  const styleId = state.settings.styleId || null;
  const referencePath = state.settings.referencePath;
  const submittedPrompt = prompt;
  const submittedAspect = state.settings.aspect;
  const submittedVariants = state.settings.variants;
  const submittedQuality = state.settings.quality;
  const submittedFolderId = state.view === 'folder' ? state.folderId : null;
  const submittedComposedPrompt = composedPrompt(submittedPrompt);

  // Build the preset stack we'll render optimistically
  const optimisticPresets = [];
  let pos = 0;
  for (const id of characterIds) {
    const p = state.presets.find((pp) => pp.id === id);
    if (p) optimisticPresets.push({ id: p.id, name: p.name, version: p.version, type: 'character', reference_image_path: p.reference_image_path, position: pos++ });
  }
  if (styleId) {
    const p = state.presets.find((pp) => pp.id === styleId);
    if (p) optimisticPresets.push({ id: p.id, name: p.name, version: p.version, type: 'style', reference_image_path: null, position: pos++ });
  }

  const pendingId = 'pending_' + Math.random().toString(36).slice(2, 10);
  const clientStart = Date.now();
  const pendingTask = {
    id: pendingId,
    kind: 'image_generation',
    prompt: submittedPrompt,
    composed_prompt: submittedComposedPrompt,
    preset_id: null,
    parent_task_id: null,
    aspect_ratio: submittedAspect,
    variant_count: submittedVariants,
    quality: submittedQuality,
    reference_image_path: referencePath,
    folder_id: submittedFolderId,
    favorite: 0,
    trashed: 0,
    status: 'pending',
    error: null,
    created_at: clientStart,
    _clientStartMs: clientStart, // for elapsed counter + polling match window
    variants: [],
    presets: optimisticPresets,
  };

  input.value = '';
  autoResizePrompt();

  const navigatedHome = state.view !== 'media' && state.view !== 'folder';
  if (navigatedHome) await goto('media');

  state.tasks = [pendingTask, ...state.tasks];
  renderGallery();
  setViewTitle();
  startPendingPolling();

  try {
    const task = await api('/api/generate', {
      method: 'POST',
      body: {
        prompt: submittedPrompt,
        character_preset_ids: characterIds,
        style_preset_id: styleId,
        reference_image_path: referencePath,
        aspect: submittedAspect,
        n: submittedVariants,
        quality: submittedQuality,
        folder_id: submittedFolderId,
      },
    });
    // Replace pending with real (if polling didn't already swap it out)
    const stillPending = state.tasks.some((t) => t.id === pendingId);
    if (stillPending) {
      state.tasks = state.tasks.map((t) => (t.id === pendingId ? task : t));
      renderGallery();
      setViewTitle();
      toast(`Generated ${task.variants.length} image${task.variants.length === 1 ? '' : 's'}`);
    }
    // Clear the direct reference after a successful gen — character/style persist
    state.settings.referencePath = null;
    renderRefStrip();
  } catch (e) {
    // If polling already resolved the pending task, swallow — the user already sees the result.
    const stillPending = state.tasks.some((t) => t.id === pendingId);
    if (stillPending) {
      state.tasks = state.tasks.map((t) =>
        t.id === pendingId ? { ...t, status: 'failed', error: e.message } : t,
      );
      renderGallery();
      toast(e.message, 'err');
    }
  } finally {
    send.disabled = false;
    send.textContent = '→';
    input.focus();
  }
}

function autoResizePrompt() {
  const el = $('#prompt-input');
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
}

// ---- Util ----
function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- Boot ----
async function boot() {
  // Wire sidebar nav
  $$('.nav-item[data-view]').forEach((el) => {
    el.onclick = (ev) => {
      ev.preventDefault();
      goto(el.dataset.view);
    };
  });

  $('#new-folder-btn').onclick = () => openNewFolderDialog();

  $('#prompt-form').addEventListener('submit', handleGenerate);

  const promptInput = $('#prompt-input');
  promptInput.addEventListener('input', autoResizePrompt);
  promptInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      handleGenerate();
    }
  });
  autoResizePrompt();

  wireChips();
  wireAttach();
  wireKeyboard();
  wireGalleryTools();
  wireSelectionBar();
  $('#activity-btn').onclick = openActivityDrawer;
  $('#chip-review').onclick = openPromptReview;

  window.addEventListener('popstate', () => routeFromHash());

  await Promise.all([loadFolders(), loadPresets()]);
  loadSettings();
  syncChips();
  renderRefStrip();
  hydrateIcons();

  routeFromHash();
}

function wireGalleryTools() {
  const input = $('#gallery-search-input');
  const clear = $('#gallery-search-clear');
  $('#select-mode-btn').addEventListener('click', () => setSelectMode(!state.selectMode));
  input.addEventListener('input', () => {
    state.search = input.value;
    clear.hidden = !state.search;
    if (['media', 'favorites', 'trash', 'folder'].includes(state.view)) {
      renderGallery();
      setViewTitle();
    }
  });
  clear.addEventListener('click', () => {
    state.search = '';
    input.value = '';
    clear.hidden = true;
    renderGallery();
    setViewTitle();
    input.focus();
  });
}

function wireSelectionBar() {
  $('#selection-bar').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-batch-action]');
    if (!btn) return;
    const ids = selectedIds();
    const action = btn.dataset.batchAction;
    if (action === 'clear') {
      return setSelectMode(false);
    }
    if (ids.length === 0) return toast('Select at least one generation', 'err');
    try {
      if (action === 'favorite') {
        await Promise.all(ids.map((id) => api(`/api/tasks/${id}`, { method: 'PATCH', body: { favorite: true } })));
        toast(ids.length === 1 ? 'Favorited' : `Favorited ${ids.length}`);
        setSelectMode(false);
        await refreshView();
      } else if (action === 'trash') {
        await setTasksTrashed(ids, true);
      } else if (action === 'move') {
        openMoveMenu(btn, ids);
      } else if (action === 'export') {
        await exportTasks(ids);
      }
    } catch (e) {
      toast(e.message, 'err');
    }
  });
}

function wireKeyboard() {
  document.addEventListener('keydown', (ev) => {
    const tag = (ev.target?.tagName ?? '').toLowerCase();
    const inField = tag === 'input' || tag === 'textarea' || ev.target?.isContentEditable;

    // Esc — close popover, or go back from detail/presets
    if (ev.key === 'Escape') {
      if (document.getElementById('active-modal')) {
        closeModal();
        return;
      }
      if (document.getElementById('active-popover')) {
        closePopover();
        return;
      }
      if (!inField && (state.view === 'detail' || state.view === 'presets')) {
        history.back();
      }
      return;
    }

    if (inField) return;

    // "/" — focus prompt
    if (ev.key === '/') {
      ev.preventDefault();
      $('#prompt-input').focus();
      return;
    }

    // "n" — new preset when on presets page; new folder otherwise
    if (ev.key === 'n' || ev.key === 'N') {
      if (state.view === 'presets') {
        ev.preventDefault();
        $('#new-preset-btn')?.click();
      }
    }
  });
}

function routeFromHash() {
  const h = location.hash.slice(1) || 'media';
  if (h.startsWith('folder/')) {
    goto('folder', { folderId: h.split('/')[1] });
  } else if (h.startsWith('gen/')) {
    goto('detail', { detailId: h.split('/')[1] });
  } else {
    goto(h);
  }
}

boot().catch((e) => {
  console.error('[easel] boot failed', e);
  toast('Boot failed: ' + e.message, 'err');
});
