"use strict";
const $ = (id) => document.getElementById(id);
let subtitleStyle;
let captionTiming;
const captionTimingReady = import("/static/caption-timing.js").then(module => { captionTiming = module; });
const subtitleStyleReady = import("/static/subtitle-style.js").then(module => { subtitleStyle = module; });
let editHistory;
const editHistoryReady = import("/static/edit-history.js").then(({EditHistory}) => { editHistory = new EditHistory(); });
const state = {
  project: null,
  source: null,
  clip: -1,
  dirty: false,
  playing: false,
  jobs: [],
  modelsReady: false,
  busy: false,
  saving: false,
  toastTimer: null,
  zoom: 24,
  switching: false,
  remoteRevision: null,
  previewToken: 0,
  previewZoom: 1,
  previewPan: { x: 0, y: 0 },
  previewDrag: null,
  seekDragging: false,
  pendingOutputSeek: null,
  outputEndSelected: false,
  fullscreenPointerNearBottom: false,
  timelineScrub: null,
  subtitleSelection: new Set(),
  subtitleSelectionProject: null,
  captionRenderKey: null,
  waveforms: new Map(),
  waveformDrawQueued: false,
  audioView: "waveform",
  spectrograms: new Map(),
  spectrogramLoading: 0,
  captionGesture: null,
  captionSelectionAnchor: null,
  suppressCaptionClick: false,
  previewCues: null,
};
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const duration = (clip) =>
  Math.max(1, Math.round((clip.end - clip.start) * 30)) / 30;
const total = () =>
  state.project ? state.project.clips.reduce((s, c) => s + duration(c), 0) : 0;
const selected = () => state.project?.clips[state.clip];
const source = () => state.project?.sources.find((s) => s.id === state.source);
const time = (value) => {
  const v = Math.max(0, Number(value) || 0);
  return `${String(Math.floor(v / 60)).padStart(2, "0")}:${(v % 60).toFixed(2).padStart(5, "0")}`;
};
const mediaUrl = (id, type = "media") =>
  `/api/projects/${state.project.id}/sources/${id}/${type}`;

function toast(message, error = false) {
  $("toast").textContent = message;
  $("toast").classList.toggle("error", error);
  $("toast").hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(
    () => ($("toast").hidden = true),
    error ? 8000 : 4000,
  );
}
function busy(message = "") {
  state.busy = Boolean(message);
  $("busy").hidden = !message;
  $("busyText").textContent = message;
  updateButtons();
}
async function api(path, method = "GET", body) {
  const options = { method };
  if (body !== undefined) {
    options.body = body instanceof FormData ? body : JSON.stringify(body);
    if (!(body instanceof FormData))
      options.headers = { "Content-Type": "application/json" };
  }
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) {
    const detail =
      typeof data.detail === "string"
        ? data.detail
        : JSON.stringify(data.detail);
    throw new Error(
      response.status === 409
        ? "项目已在其他窗口更新，请重新载入后再编辑。"
        : detail || "请求未完成",
    );
  }
  return data;
}
function editSnapshot() {
  if (!state.project) return null;
  const p = state.project;
  return {title: p.title, clips: p.clips, subtitles: p.subtitles, voiceovers: p.voiceovers || []};
}
function refreshDirtyState() {
  state.dirty = editHistory.dirty;
  $("saveState").textContent = state.dirty ? "有未保存的修改" : "已保存在本机";
  $("saveState").style.color = state.dirty ? "#d9c992" : "";
  updateButtons();
}
function markDirty(group = null) {
  state.previewCues = null;
  editHistory.record(editSnapshot(), {group});
  refreshDirtyState();
}
function markSaved(resetHistory = true) {
  if (resetHistory) editHistory.reset(editSnapshot());
  state.remoteRevision = null;
  refreshDirtyState();
}
function undoEdit(redo = false) {
  if (!state.project || state.busy || state.saving) return;
  if (state.captionGesture) finishCaptionGesture(null, true);
  const edit = redo ? editHistory.redo() : editHistory.undo();
  if (!edit) return;
  const active = document.activeElement;
  const row = active.closest?.("[data-cue]");
  const focus = {id: active.id, style: active.dataset?.captionStyle, source: row?.dataset.cueSource,
    index: row?.dataset.cue, field: active.dataset?.field, start: active.selectionStart, end: active.selectionEnd};
  const currentTime = $("video").currentTime, previousSource = state.source;
  const sizesChanged = Object.keys(edit.subtitles).some(id => edit.subtitles[id].length !== state.project.subtitles[id]?.length);
  pause();
  // Keep current sources and revision so the restored edit can be saved normally.
  Object.assign(state.project, edit);
  state.clip = Math.min(state.clip, state.project.clips.length - 1);
  if (selected()) state.source = selected().source_id;
  if (sizesChanged) state.subtitleSelection.clear();
  state.captionRenderKey = null;
  refreshDirtyState();
  render();
  const clip = selected();
  const at = previousSource === state.source ? currentTime : clip?.start || 0;
  setPreview(clip ? Math.max(clip.start, Math.min(at, clip.end - 1 / 30)) : at);
  let target = focus.id ? $(focus.id) : null;
  if (!target && focus.style) target = document.querySelector(`[data-caption-style="${focus.style}"]`);
  if (!target && focus.source) {
    const restoredRow = [...$("subtitleList").querySelectorAll("[data-cue]")].find(r => r.dataset.cueSource === focus.source && r.dataset.cue === focus.index);
    target = restoredRow?.querySelector(`[data-field="${focus.field}"]`);
  }
  if (target && !target.disabled && target.getClientRects().length) {
    target.focus({preventScroll: true});
    if (focus.start !== null && focus.start !== undefined && ["text", "textarea"].includes(target.type))
      target.setSelectionRange(focus.start, focus.end);
  }
}
function updateButtons() {
  const has = Boolean(state.project),
    clip = Boolean(selected()),
    src = source();
  $("saveBtn").disabled = !has || !state.dirty || state.busy || state.saving;
  $("undoBtn").disabled = !has || !editHistory?.canUndo || state.busy || state.saving;
  $("redoBtn").disabled = !has || !editHistory?.canRedo || state.busy || state.saving;
  $("exportBtn").disabled = !has || !state.project.clips.length || state.busy || state.saving;
  $("reloadBtn").disabled = !has || state.busy || state.saving;
  $("projectSelect").disabled = state.busy || state.saving;
  $("projectTitle").disabled = !has;
  $("importBtn").disabled = state.busy;
  $("welcomeImport").disabled = state.busy;
  $("fullscreenBtn").hidden = !src;
  $("fullscreenBtn").disabled = !src || !document.fullscreenEnabled;
  for (const id of ["previewZoom", "fullscreenZoom", "previewFitBtn", "fullscreenFitBtn"])
    $(id).disabled = !src;
  updatePreviewZoomButtons();
  $("fullscreenSeek").disabled = !state.project?.clips.length;
  $("fullscreenSeek").max = total();
  for (const id of [
    "splitBtn",
    "removeClipBtn",
    "setInBtn",
    "setOutBtn",
    "trimStart",
    "trimEnd",
  ])
    $(id).disabled = !clip || state.busy;
  $("moveLeftBtn").disabled = !clip || state.clip === 0;
  $("moveRightBtn").disabled =
    !clip || state.clip === state.project.clips.length - 1;
  $("appendBtn").disabled = !src || state.busy;
  $("addVoiceoverBtn").disabled = !src?.has_audio || !total() || state.busy;
  $("addCaptionBtn").disabled = !src || state.busy;
  $("timelineAddCaptionBtn").disabled = !src || state.busy;
  const running = state.jobs.some(
    (j) =>
      j.kind === "transcribe" &&
      j.source_id === state.source &&
      ["queued", "running"].includes(j.status),
  );
  $("transcribeBtn").disabled =
    !src || !src.has_audio || !state.modelsReady || state.busy || running;
  $("recognitionLanguage").disabled = state.busy || running;
  $("modelHint").textContent = !state.modelsReady
    ? "字幕模型未下载，请按使用说明运行 cutccc download。"
    : src && !src.has_audio
      ? "此素材没有音轨，可手动添加字幕。"
      : running
        ? "正在后台生成字幕，可在下方查看进度。"
        : "保留中文和英文原文；降噪复听后，疑似遗漏和不确定区间会列入复核清单。";
}
async function projectOptions() {
  const data = await api("/api/projects");
  $("projectSelect").innerHTML =
    '<option value="">选择项目</option>' +
    data.projects
      .map((p) => `<option value="${p.id}">${esc(p.title)}</option>`)
      .join("");
  if (state.project) $("projectSelect").value = state.project.id;
}
async function loadProject(id, confirmChanges = true) {
  if (!id) return;
  if (
    confirmChanges &&
    state.dirty &&
    !confirm("当前修改尚未保存，是否放弃修改并载入项目？")
  ) {
    $("projectSelect").value = state.project.id;
    return;
  }
  pause();
  state.project = await api(`/api/projects/${id}`);
  state.waveforms.clear();
  state.spectrograms.clear();
  state.clip = state.project.clips.length ? 0 : -1;
  state.source = selected()?.source_id || state.project.sources[0]?.id || null;
  state.jobs = [];
  localStorage.setItem("cutccc-project", id);
  markSaved();
  render();
  setPreview(selected()?.start || 0);
  await projectOptions();
  await pollJobs();
}
async function saveProject() {
  if (!state.project || !state.dirty) return true;
  if (state.saving) return false;
  state.project.title = $("projectTitle").value;
  const p = state.project;
  const sent = structuredClone(editSnapshot());
  editHistory.breakGroup();
  state.saving = true;
  updateButtons();
  try {
    const saved = await api(`/api/projects/${p.id}`, "PATCH", {revision: p.revision, ...sent});
    if (state.project?.id === p.id) {
      const current = editSnapshot();
      state.project = {...saved, ...current};
      editHistory.markSaved(sent);
      markSaved(false);
      await projectOptions();
    }
    return true;
  } finally {
    state.saving = false;
    updateButtons();
  }
}
async function newProject() {
  if (state.dirty && !confirm("当前修改尚未保存，是否新建项目？")) return;
  const p = await api("/api/projects", "POST", { title: "未命名项目" });
  state.dirty = false;
  await loadProject(p.id, false);
  $("projectTitle").focus();
  $("projectTitle").select();
}
async function importFiles(files) {
  if (!files.length) return;
  try {
    busy("正在导入视频…");
    if (state.dirty) await saveProject();
    if (!state.project) {
      const p = await api("/api/projects", "POST", {
        title: files[0].name.replace(/\.[^.]+$/, "").slice(0, 120) || "新项目",
      });
      state.project = p;
    }
    for (const file of files) {
      busy(`正在导入 ${file.name}`);
      const data = new FormData();
      data.append("file", file);
      state.project = await api(
        `/api/projects/${state.project.id}/sources/upload`,
        "POST",
        data,
      );
    }
    state.clip = state.project.clips.length - 1;
    state.source = selected()?.source_id || null;
    localStorage.setItem("cutccc-project", state.project.id);
    markSaved();
    render();
    setPreview(selected()?.start || 0);
    await projectOptions();
    toast("视频已导入，可以开始剪辑。");
  } catch (error) {
    toast(error.message, true);
  } finally {
    busy();
    $("fileInput").value = "";
  }
}

function render() {
  const p = state.project;
  $("projectTitle").value = p?.title || "";
  $("sourceCount").textContent = p?.sources.length || 0;
  $("sourceList").innerHTML = p?.sources.length
    ? p.sources
        .map(
          (s) =>
            `<div class="source-card ${s.id === state.source ? "selected" : ""}" data-source="${s.id}" role="button" tabindex="0"><div class="source-image"><img src="${mediaUrl(s.id, "poster")}" alt=""><span class="duration-tag">${time(s.duration)}</span></div><div class="source-title"><span>▣</span><strong>${esc(s.name)}</strong></div><div class="source-caption">${s.width} × ${s.height}${s.has_audio ? " · 带音频" : " · 无音轨"}</div></div>`,
        )
        .join("")
    : '<div class="muted empty-library">素材只保存在你的电脑上。<br>导入视频，开始一次剪辑。</div>';
  $("welcome").hidden = Boolean(source());
  $("videoFrame").hidden = !source();
  $("previewMeta").textContent = source()
    ? `${source().width} × ${source().height} · ${time(source().duration)}`
    : "你的故事，从这里开始";
  renderTimeline();
  renderInspector();
  renderVoiceovers();
  renderSubtitles();
  renderJobs();
  updateButtons();
  fitPreview();
}
function setPreviewZoom(percent) {
  const value = Number(percent);
  if (!Number.isFinite(value)) return;
  const zoom = Math.max(25, Math.min(400, value));
  state.previewZoom = zoom / 100;
  for (const id of ["previewZoom", "fullscreenZoom"]) {
    $(id).value = zoom;
    $(id).setAttribute("aria-valuetext", `${zoom}%（100% 为适应窗口）`);
  }
  for (const id of ["previewZoomValue", "fullscreenZoomValue"])
    $(id).textContent = `${zoom}%`;
  updatePreviewZoomButtons();
  fitPreview();
}
function updatePreviewZoomButtons() {
  for (const prefix of ["preview", "fullscreen"]) {
    $(prefix + "ZoomOut").disabled = !source() || state.previewZoom <= .25;
    $(prefix + "ZoomIn").disabled = !source() || state.previewZoom >= 4;
  }
}
function fitPreview() {
  const s = source();
  if (!s) return;
  const area = $("previewArea");
  const css = getComputedStyle(area);
  const availableWidth =
    area.clientWidth -
    parseFloat(css.paddingLeft) -
    parseFloat(css.paddingRight);
  const availableHeight =
    area.clientHeight -
    parseFloat(css.paddingTop) -
    parseFloat(css.paddingBottom);
  const ratio = s.width / s.height;
  const width = Math.min(availableWidth, availableHeight * ratio);
  const maxX = Math.abs(availableWidth - width * state.previewZoom) / 2;
  const maxY = Math.abs(availableHeight - (width / ratio) * state.previewZoom) / 2;
  state.previewPan.x = Math.max(-maxX, Math.min(maxX, state.previewPan.x));
  state.previewPan.y = Math.max(-maxY, Math.min(maxY, state.previewPan.y));
  $("videoFrame").style.width = `${width}px`;
  $("videoFrame").style.height = `${width / ratio}px`;
  $("videoFrame").style.transform =
    `translate(${state.previewPan.x}px, ${state.previewPan.y}px) scale(${state.previewZoom})`;
}
function resetPreviewView() {
  finishPreviewPan();
  state.previewPan = { x: 0, y: 0 };
  setPreviewZoom(100);
}
function startPreviewPan(event) {
  if (event.button !== 0 || !event.isPrimary || !source() || state.previewDrag) return;
  event.preventDefault();
  state.previewDrag = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    panX: state.previewPan.x,
    panY: state.previewPan.y,
  };
  $("videoFrame").setPointerCapture(event.pointerId);
  $("videoFrame").classList.add("is-panning");
}
function movePreviewPan(event) {
  const drag = state.previewDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  event.preventDefault();
  state.previewPan.x = drag.panX + event.clientX - drag.x;
  state.previewPan.y = drag.panY + event.clientY - drag.y;
  fitPreview();
}
function finishPreviewPan(event) {
  const drag = state.previewDrag;
  if (!drag || (event && event.pointerId !== drag.pointerId)) return;
  if (event?.type === "pointerup") movePreviewPan(event);
  state.previewDrag = null;
  $("videoFrame").classList.remove("is-panning");
  if ($("videoFrame").hasPointerCapture(drag.pointerId))
    $("videoFrame").releasePointerCapture(drag.pointerId);
}
function syncFullscreen() {
  const active = document.fullscreenElement === $("previewArea");
  $("fullscreenBtn").textContent = active ? "⛶ 退出全屏" : "⛶ 全屏";
  $("fullscreenBtn").setAttribute(
    "aria-label",
    active ? "退出全屏" : "全屏预览",
  );
  $("fullscreenBtn").setAttribute("aria-pressed", String(active));
  $("fullscreenBtn").title = active ? "退出全屏（Esc / F）" : "全屏预览（F）";
  $("fullscreenControls").hidden = !active;
  if (!active) finishFullscreenSeek();
  state.fullscreenPointerNearBottom = false;
  setFullscreenControlsVisible(false);
  requestAnimationFrame(fitPreview);
}
function setFullscreenControlsVisible(visible) {
  if (visible && document.fullscreenElement !== $("previewArea")) return;
  $("fullscreenControls").classList.toggle("is-hidden", !visible);
  $("fullscreenControls").setAttribute("aria-hidden", String(!visible));
}
function updateFullscreenControlsForPointer(event) {
  if (document.fullscreenElement !== $("previewArea")) return;
  const area = $("previewArea").getBoundingClientRect();
  const revealHeight = Math.max(
    $("fullscreenControls").offsetHeight + 24,
    Math.min(180, area.height * 0.2),
  );
  state.fullscreenPointerNearBottom =
    event.clientY >= area.bottom - revealHeight;
  setFullscreenControlsVisible(
    state.seekDragging || state.fullscreenPointerNearBottom,
  );
}
async function toggleFullscreen() {
  if (!source()) return;
  try {
    if (document.fullscreenElement === $("previewArea"))
      await document.exitFullscreen();
    else await $("previewArea").requestFullscreen();
  } catch (error) {
    toast("无法切换全屏预览：" + error.message, true);
  }
}
function renderInspector() {
  const c = selected(),
    s = source();
  $("selectedName").textContent = c ? s?.name || "片段" : "选择一个片段";
  $("selectedMeta").textContent = c
    ? `片段 ${state.clip + 1} · 保留 ${time(duration(c))} / 原片 ${time(s.duration)}`
    : "在时间线上点击片段进行编辑。";
  $("trimStart").value = c ? c.start.toFixed(3) : "";
  $("trimEnd").value = c ? c.end.toFixed(3) : "";
  $("trimStart").max = $("trimEnd").max = s?.duration || 0;
}
function renderVoiceovers() {
  const p = state.project;
  $("voiceoverList").innerHTML = (p?.voiceovers || [])
    .map((v, i) => {
      const s = p.sources.find((s) => s.id === v.source_id);
      return `<div class="subtitle-row" data-voice="${i}"><strong>${esc(s?.name || "旁白")}</strong>${v.volume === 0 ? '<p class="muted">语音已关闭，保留字幕显示位置。</p>' : ''}<div class="trim-fields"><label>成片入点 / 秒<input type="number" min="0" step="0.001" data-voice-field="start" value="${v.start}"></label><label>音量 / 倍<input type="number" min="0" max="2" step="0.1" data-voice-field="volume" value="${v.volume ?? 1}"></label></div><audio controls preload="none" src="${mediaUrl(v.source_id)}" style="width:100%"></audio><div class="voice-actions">${v.volume === 0 ? `<button class="button small" data-restore-voice="${i}">恢复语音</button>` : `<button class="button small" data-remove-voice="${i}">仅移除语音</button>`}<button class="button small" data-remove-voice-all="${i}">移除语音及字幕</button></div></div>`;
    })
    .join("");
}
function mappedCues() {
  let offset = 0,
    result = [];
  for (const [clipIndex, c] of (state.project?.clips || []).entries()) {
    const d = duration(c);
    for (const [index, cue] of (state.project.subtitles[c.source_id] || []).entries()) {
      const a = Math.max(c.start, cue.start),
        b = Math.min(c.end, cue.end, c.start + d);
      if (b > a)
        result.push({
          start: offset + a - c.start,
          end: offset + b - c.start,
          text: cue.text,
          style: cue.style,
          sourceId: c.source_id, index, occurrence: `clip:${clipIndex}:${index}`,
        });
    }
    offset += d;
  }
  for (const [voiceIndex, voice] of (state.project?.voiceovers || []).entries()) {
    const s = state.project.sources.find(s => s.id === voice.source_id);
    for (const [index, cue] of (state.project.subtitles[voice.source_id] || []).entries()) {
      const start = Math.max(0, cue.start), end = Math.min(cue.end, s.duration, offset - voice.start);
      if (end > start) result.push({start: voice.start + start, end: voice.start + end, text: cue.text, style: cue.style,
        sourceId: voice.source_id, index, occurrence: `voice:${voiceIndex}:${index}`});
    }
  }
  return result.map(cue => {
    const shift = state.project.subtitles[cue.sourceId][cue.index].shift || 0;
    return {...cue, start: Math.max(0, cue.start + shift), end: Math.min(offset, cue.end + shift)};
  }).filter(cue => cue.end > cue.start).sort((a, b) => a.start - b.start);
}
function renderTimeline() {
  const p = state.project;
  const scroll = $("timelineScroll");
  const timelinePanel = scroll.closest(".timeline-panel");
  timelinePanel.dataset.audioView = state.audioView;
  const audioHeight = `${state.audioView === "waveform" ? 28 : state.audioView === "both" ? 112 : 84}px`;
  if (timelinePanel.style.getPropertyValue("--clip-audio-height") !== audioHeight) {
    timelinePanel.style.setProperty("--clip-audio-height", audioHeight);
    requestAnimationFrame(fitPreview);
  }
  const previousZoom = state.zoom;
  const previousTime = scroll.scrollLeft / previousZoom;
  const playheadTime = Number($("fullscreenSeek").value) || 0;
  const playheadX = playheadTime * previousZoom - scroll.scrollLeft;
  const seconds = total();
  $("clipCount").textContent = `${p?.clips.length || 0} 段`;
  $("totalClock").textContent = time(seconds);
  const viewportWidth = Math.max(1, scroll.clientWidth - 1);
  const fitScale = seconds > 0 ? viewportWidth / seconds : 24;
  const maxScale = Math.max(90, fitScale * 4);
  const zoom = Number($("zoom").value) / 100;
  $("timelineZoomOut").disabled = !p?.clips.length || zoom <= 0;
  $("timelineZoomIn").disabled = !p?.clips.length || zoom >= 1;
  state.zoom = fitScale * Math.pow(maxScale / fitScale, zoom);
  const width = Math.max(seconds * state.zoom, viewportWidth);
  $("timelineCanvas").style.width = `${width}px`;
  $("zoom").setAttribute(
    "aria-valuetext",
    zoom === 0 ? "完整时间轴" : `${Math.round((state.zoom / fitScale) * 100)}%`,
  );
  const targetStep = 64 / state.zoom;
  const step =
    [
      0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600,
    ].find((value) => value >= targetStep) ||
    Math.ceil(targetStep / 3600) * 3600;
  let ruler = "";
  for (let t = 0; t * state.zoom < width - (seconds > 0 ? 70 : 40); t += step)
    ruler += `<span class="ruler-label" style="left:${t * state.zoom}px">${step < 1 ? time(t) : time(t).slice(0, -3)}</span>`;
  if (seconds > 0)
    ruler += `<span class="ruler-label ruler-end" title="成片结束">${time(seconds)}</span>`;
  $("ruler").innerHTML = ruler;
  $("clipTrack").innerHTML = p?.clips.length
    ? p.clips
        .map((c, i) => {
          const s = p.sources.find((s) => s.id === c.source_id);
          return `<div class="timeline-clip ${i === state.clip ? "selected" : ""}" data-clip="${i}" draggable="true" role="button" tabindex="0" aria-label="片段 ${i + 1}：${esc(s.name)}" style="width:${duration(c) * state.zoom}px"><img src="${mediaUrl(c.source_id, "poster")}" alt=""><span>${i + 1} · ${esc(s.name)}</span><small>${time(duration(c))}</small><canvas class="clip-waveform" aria-hidden="true"></canvas><small class="waveform-status">${s.has_audio ? "生成波形中…" : "无音轨"}</small><canvas class="clip-spectrogram" aria-hidden="true"></canvas><small class="spectrogram-status">${s.has_audio ? "生成频谱中…" : "无音轨"}</small></div>`;
        })
        .join("")
    : '<div class="timeline-placeholder">导入视频后，片段将出现在这里</div>';
  const lanes = [];
  const timelineCues = mappedCues();
  state.previewCues = timelineCues;
  $("captionTrack").innerHTML = timelineCues
    .map((c) => {
      let lane = lanes.findIndex(end => end <= c.start);
      if (lane < 0) lane = lanes.length;
      lanes[lane] = c.end;
      const selected = state.subtitleSelection.has(`${c.sourceId}:${c.index}`);
      return `<div class="caption-block ${selected ? "selected" : ""}" data-caption-occurrence="${c.occurrence}" data-caption-key="${c.sourceId}:${c.index}" role="button" tabindex="0" aria-pressed="${selected}" aria-label="编辑字幕：${esc(c.text)}" style="left:${c.start * state.zoom}px;width:${(c.end - c.start) * state.zoom}px;top:${3 + lane * 26}px" title="拖动中间移动字幕；拖动两端调整时长：${esc(c.text)}"><span class="caption-resize-handle start" data-resize-caption="start" title="拖动调整字幕开始时间"></span><span class="caption-block-text">${esc(c.text)}</span><span class="caption-resize-handle end" data-resize-caption="end" title="拖动调整字幕结束时间"></span></div>`;
    })
    .join("");
  const panel = scroll.closest(".timeline-panel");
  const extraHeight = `${Math.min(2, Math.max(0, lanes.length - 1)) * 26}px`;
  if (panel.style.getPropertyValue("--caption-extra-height") !== extraHeight) {
    panel.style.setProperty("--caption-extra-height", extraHeight);
    requestAnimationFrame(fitPreview);
  }
  $("playhead").hidden = !p?.clips.length;
  const anchor = playheadX >= 0 && playheadX <= viewportWidth ? playheadX : viewportWidth / 2;
  scroll.scrollLeft = zoom === 0 ? 0 : Math.abs(previousZoom - state.zoom) > .000001
    ? playheadTime * state.zoom - anchor : previousTime * state.zoom;
  ensureWaveforms();
  scheduleWaveformDraw();
}
function ensureWaveforms() {
  const project = state.project;
  if (!project || state.audioView === "spectrogram") return;
  for (const id of new Set(project.clips.map(clip => clip.source_id))) {
    if (!project.sources.find(source => source.id === id)?.has_audio) continue;
    const key = `${project.id}:${id}`;
    if (state.waveforms.has(key)) continue;
    const entry = {status: "loading", data: null};
    state.waveforms.set(key, entry);
    api(`/api/projects/${project.id}/sources/${id}/waveform`).then(data => {
      entry.data = data; entry.status = "ready";
    }).catch(error => { entry.status = "error"; entry.error = error.message; }).finally(() => {
      if (state.project?.id === project.id && state.waveforms.get(key) === entry) scheduleWaveformDraw();
    });
  }
}
function scheduleWaveformDraw() {
  if (state.waveformDrawQueued) return;
  state.waveformDrawQueued = true;
  requestAnimationFrame(() => { state.waveformDrawQueued = false; drawClipWaveforms(); });
}
function drawClipWaveforms() {
  if (!state.project) return;
  if (state.audioView === "spectrogram") { drawClipSpectrograms(); return; }
  const scroll = $("timelineScroll"), bounds = scroll.getBoundingClientRect();
  const viewportLeft = bounds.left + scroll.clientLeft, viewportRight = viewportLeft + scroll.clientWidth;
  const ratio = Math.min(2, window.devicePixelRatio || 1), height = 28;
  for (const block of $("clipTrack").querySelectorAll("[data-clip]")) {
    const clip = state.project.clips[Number(block.dataset.clip)];
    if (!clip) continue;
    const source = state.project.sources.find(source => source.id === clip.source_id);
    const canvas = block.querySelector("canvas"), status = block.querySelector(".waveform-status");
    const entry = state.waveforms.get(`${state.project.id}:${clip.source_id}`), data = entry?.data;
    status.textContent = !source.has_audio ? "无音轨" : entry?.status === "error" ? "波形不可用，点击重试"
      : entry?.status !== "ready" ? "生成波形中…" : data.peak_max < .0001 ? "静音" : "";
    status.hidden = !status.textContent;
    status.classList.toggle("retry", entry?.status === "error");
    status.title = entry?.status === "error" ? entry.error : "原素材音频波形";
    const rect = block.getBoundingClientRect();
    const left = Math.max(0, viewportLeft - rect.left), right = Math.min(rect.width, viewportRight - rect.left);
    canvas.hidden = right <= left;
    if (canvas.hidden) continue;
    const width = Math.ceil(right - left);
    canvas.style.left = `${left}px`; canvas.style.width = `${width}px`;
    canvas.width = Math.ceil(width * ratio); canvas.height = Math.ceil(height * ratio);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = "#0d1c1ce6"; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#45615f"; ctx.fillRect(0, height / 2, width, .6);
    if (!source.has_audio || !data?.peaks.length) continue;
    const rate = data.peaks_per_second, gain = 1 / Math.max(.02, data.peak_max);
    for (let x = 0; x < width; x += 2) {
      const start = Math.max(0, Math.floor((clip.start + (left + x) / state.zoom) * rate));
      const end = Math.min(data.peaks.length, Math.ceil(Math.min(clip.end, clip.start + (left + x + 2) / state.zoom) * rate));
      let peak = 0, rms = 0;
      for (let i = start; i < end; i++) { peak = Math.max(peak, data.peaks[i]); rms = Math.max(rms, data.rms[i]); }
      // Compress the display range so quiet speech remains visible next to loud transients.
      const outer = Math.sqrt(Math.min(1, peak * gain)) * 12;
      const inner = Math.sqrt(Math.min(1, rms * gain)) * 12;
      ctx.fillStyle = "#80cbd0a8"; ctx.fillRect(x, height / 2 - outer, 1.5, outer * 2);
      ctx.fillStyle = "#aff2bd"; ctx.fillRect(x, height / 2 - inner, 1.5, inner * 2);
    }
  }
  drawClipSpectrograms();
}
function setAudioView(value) {
  state.audioView = ["waveform", "spectrogram", "both"].includes(value) ? value : "waveform";
  $("audioView").value = state.audioView;
  const hint = state.audioView === "waveform" ? "原音轨音量起伏" : "下→上：80 Hz–8 kHz · 越亮能量越强";
  $("audioViewHint").textContent = hint;
  $("audioViewHint").title = hint;
  localStorage.setItem("cutccc-audio-view", state.audioView);
  renderTimeline();
}
function requestSpectrogram(source, tile) {
  const projectId = state.project.id, key = `${projectId}:${source.id}:${tile}`;
  const cached = state.spectrograms.get(key);
  if (cached) return cached;
  if (state.spectrogramLoading >= 4) return null;
  const image = new Image(), entry = {status: "loading", image};
  state.spectrograms.set(key, entry);
  state.spectrogramLoading++;
  const complete = status => {
    entry.status = status; state.spectrogramLoading--;
    scheduleWaveformDraw();
  };
  image.onload = () => complete("ready");
  image.onerror = () => complete("error");
  image.src = `/api/projects/${projectId}/sources/${source.id}/spectrogram?tile=${tile}&v=2`;
  return entry;
}
function drawClipSpectrograms() {
  if (!state.project || state.audioView === "waveform") return;
  const scroll = $("timelineScroll"), bounds = scroll.getBoundingClientRect();
  const viewportLeft = bounds.left + scroll.clientLeft, viewportRight = viewportLeft + scroll.clientWidth;
  const ratio = Math.min(2, window.devicePixelRatio || 1), height = 84, needed = new Set();
  for (const block of $("clipTrack").querySelectorAll("[data-clip]")) {
    const clip = state.project.clips[Number(block.dataset.clip)];
    if (!clip) continue;
    const source = state.project.sources.find(s => s.id === clip.source_id);
    const canvas = block.querySelector(".clip-spectrogram"), status = block.querySelector(".spectrogram-status");
    const rect = block.getBoundingClientRect();
    const left = Math.max(0, viewportLeft - rect.left), right = Math.min(rect.width, viewportRight - rect.left);
    canvas.hidden = right <= left;
    if (canvas.hidden) continue;
    const width = Math.ceil(right - left);
    canvas.style.left = `${left}px`; canvas.style.width = `${width}px`;
    canvas.width = Math.ceil(width * ratio); canvas.height = Math.ceil(height * ratio);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = "#090717"; ctx.fillRect(0, 0, width, height);
    let loading = false, error = false;
    if (source.has_audio) {
      const start = Math.max(clip.start, clip.start + left / state.zoom);
      const end = Math.min(clip.end, source.duration, clip.start + right / state.zoom);
      const overview = state.zoom <= 2048 / source.duration;
      const first = overview ? 0 : Math.floor(start / 20), last = overview ? 0 : Math.floor(Math.max(start, end - .000001) / 20);
      for (let tileIndex = first; tileIndex <= last; tileIndex++) {
        const tile = overview ? "overview" : String(tileIndex);
        const key = `${state.project.id}:${source.id}:${tile}`;
        needed.add(key);
        const entry = requestSpectrogram(source, tile);
        if (!entry || entry.status === "loading") { loading = true; continue; }
        if (entry.status === "error") { error = true; continue; }
        const from = overview ? 0 : tileIndex * 20, span = overview ? source.duration : Math.min(20, source.duration - from);
        const a = Math.max(start, from), b = Math.min(end, from + span);
        if (b <= a) continue;
        for (let y = 0; y < height; y++) {
          const highHz = 80 * Math.pow(100, 1 - y / height);
          const lowHz = 80 * Math.pow(100, 1 - (y + 1) / height);
          const sourceY = (8000 - highHz) / 7920 * entry.image.naturalHeight;
          const sourceHeight = (highHz - lowHz) / 7920 * entry.image.naturalHeight;
          ctx.drawImage(entry.image, (a - from) / span * entry.image.naturalWidth, sourceY,
            (b - a) / span * entry.image.naturalWidth, sourceHeight,
            (a - clip.start) * state.zoom - left, y, (b - a) * state.zoom, 1);
        }
      }
      ctx.font = "9px sans-serif";
      for (const [y, label] of [[0, "8k"], [height / 2, "800"], [height - 1, "80 Hz"]]) {
        ctx.fillStyle = "#ffffff22"; ctx.fillRect(0, y, width, .6);
        const textY = Math.max(10, Math.min(height - 2, y + 3));
        ctx.fillStyle = "#080810bb"; ctx.fillRect(1, textY - 9, label.length * 5 + 3, 11);
        ctx.fillStyle = "#e1e4eb"; ctx.fillText(label, 3, textY);
      }
    }
    status.textContent = !source.has_audio ? "无音轨" : error ? "频谱不可用，点击重试" : loading ? "生成频谱中…" : "";
    status.hidden = !status.textContent;
    status.classList.toggle("retry", error);
  }
  // Bound decoded image memory while keeping the currently visible tiles.
  for (const [key, entry] of state.spectrograms) {
    if (state.spectrograms.size <= 80) break;
    if (!needed.has(key) && entry.status !== "loading") state.spectrograms.delete(key);
  }
}
function renderSubtitles() {
  const entries = subtitleEntries();
  const placements = new Map();
  for (const cue of mappedCues()) {
    const key = `${cue.sourceId}:${cue.index}`;
    if (!placements.has(key)) placements.set(key, []);
    placements.get(key).push(cue);
  }
  const placementLabel = key => {
    const list = placements.get(key) || [];
    const position = Number($("fullscreenSeek").value);
    const cue = list.find(c => c.start <= position && position < c.end) || list[0];
    return cue ? `成片 ${time(cue.start)} – ${time(cue.end)}${list.length > 1 ? `（${list.length}处）` : ""}` : "未出现在当前成片中";
  };
  if (state.subtitleSelectionProject !== state.project?.id) {
    state.subtitleSelection.clear();
    state.subtitleSelectionProject = state.project?.id;
  }
  const valid = new Set(subtitleEntries(true).map(entry => entry.key));
  for (const key of state.subtitleSelection) if (!valid.has(key)) state.subtitleSelection.delete(key);
  $("subtitleCount").textContent = entries.length;
  $("subtitleList").innerHTML = entries.length
    ? entries
        .map(
          ({cue: c, index: i, sourceId, key, name}) =>
            `<div class="subtitle-row ${state.subtitleSelection.has(key) ? "selected" : ""}" data-cue="${i}" data-cue-source="${sourceId}"><div class="subtitle-select-line"><input type="checkbox" data-select-cue="${key}" aria-label="选择字幕 ${i + 1}" ${state.subtitleSelection.has(key) ? "checked" : ""}><span title="${esc(name)}">${String(i + 1).padStart(2, "0")} · ${esc(name)}</span><button class="icon-button" data-remove-cue="${i}" title="删除字幕" aria-label="删除字幕 ${i + 1}">×</button></div><button class="subtitle-open" data-edit-style="${key}" aria-label="编辑字幕 ${i + 1}">${esc(c.text)}</button><div class="subtitle-placement">${placementLabel(key)}</div><div class="subtitle-clock-label">原素材 ${time(c.start)} – ${time(c.end)}</div></div>`,
        )
        .join("")
    : '<p class="muted" style="margin-top:18px">生成字幕后，可以在这里逐条校对文字和时间，也可以点击 ＋ 手动添加。</p>';
  renderCaptionStyleEditor();
}
function subtitleEntries(all = false) {
  return (state.project?.sources || []).flatMap(s =>
    all || $("subtitleScope").value === "project" || s.id === state.source
      ? (state.project.subtitles[s.id] || []).map((cue, index) => ({cue, index, sourceId: s.id, name: s.name, key: `${s.id}:${index}`})) : []);
}
function selectedSubtitleEntries() {
  return subtitleEntries(true).filter(entry => state.subtitleSelection.has(entry.key));
}
function revealSubtitleInList(sourceId, index, focus = false) {
  if (!state.project?.subtitles[sourceId]?.[index]) return;
  state.subtitleSelectionProject = state.project.id;
  state.subtitleSelection.add(`${sourceId}:${index}`);
  if (sourceId !== state.source) $("subtitleScope").value = "project";
  selectLibraryTab("captions");
  document.querySelector('[data-tab="subtitles"]').click();
  $("captionStyleEditor").open = true;
  renderSubtitles();
  const row = [...$("subtitleList").querySelectorAll("[data-cue]")].find(
    row => row.dataset.cueSource === sourceId && Number(row.dataset.cue) === index,
  );
  if (!row) return;
  row.scrollIntoView({block: "center", inline: "nearest"});
  if (focus) row.querySelector(".subtitle-open").focus({preventScroll: true});
}
function openTimelineCaption(occurrence) {
  const mapped = mappedCues().find(cue => cue.occurrence === occurrence);
  if (!mapped) return;
  state.captionSelectionAnchor = occurrence;
  state.subtitleSelectionProject = state.project.id;
  state.subtitleSelection = new Set([`${mapped.sourceId}:${mapped.index}`]);
  // Seek the clicked occurrence, including reused clips and repeated voiceovers.
  seekOutput(mapped.start + Math.min(.05, (mapped.end - mapped.start) / 2), false);
  renderTimeline();
  revealSubtitleInList(mapped.sourceId, mapped.index, true);
}
function captionMoveContext() {
  const placements = mappedCues().filter(c => state.subtitleSelection.has(`${c.sourceId}:${c.index}`));
  const keys = new Set(placements.map(c => `${c.sourceId}:${c.index}`));
  const entries = selectedSubtitleEntries().filter(entry => keys.has(entry.key)).map(entry => ({...entry, shift: entry.cue.shift || 0}));
  if (!entries.length) return null;
  return {projectId: state.project.id, placements, entries,
    minimum: Math.max(...placements.map(c => -c.start), ...entries.map(e => -86400 - e.shift)),
    maximum: Math.min(...placements.map(c => total() - c.end), ...entries.map(e => 86400 - e.shift))};
}
function commitCaptionMove(context, delta, occurrence) {
  if (!context || state.project?.id !== context.projectId) return;
  if (Math.abs(delta) >= .000001) {
    for (const entry of context.entries) {
      const shift = Math.round((entry.shift + delta) * 1e6) / 1e6;
      if (shift) entry.cue.shift = shift; else delete entry.cue.shift;
    }
    markDirty();
  }
  $("subtitleScope").value = "project";
  const anchor = context.placements.find(c => c.occurrence === occurrence) || context.placements[0];
  seekOutput(anchor.start + delta + Math.min(.05, (anchor.end - anchor.start) / 2), false);
  renderTimeline();
  revealSubtitleInList(anchor.sourceId, anchor.index);
}
function selectTimelineCaption(block, event) {
  const key = block.dataset.captionKey, occurrence = block.dataset.captionOccurrence;
  if (event.shiftKey) {
    const cues = mappedCues();
    let from = cues.findIndex(c => c.occurrence === state.captionSelectionAnchor);
    const to = cues.findIndex(c => c.occurrence === occurrence);
    if (from < 0) from = to;
    const selection = event.ctrlKey || event.metaKey ? new Set(state.subtitleSelection) : new Set();
    for (const cue of cues.slice(Math.min(from, to), Math.max(from, to) + 1)) selection.add(`${cue.sourceId}:${cue.index}`);
    state.subtitleSelection = selection;
  } else {
    if (state.subtitleSelection.has(key)) state.subtitleSelection.delete(key); else state.subtitleSelection.add(key);
    state.captionSelectionAnchor = occurrence;
  }
  state.subtitleSelectionProject = state.project.id;
  renderSubtitles();
}
function startCaptionGesture(event) {
  if (event.button !== 0 || !event.isPrimary || !state.project || state.busy || state.saving || state.captionGesture) return;
  const block = event.target.closest("[data-caption-occurrence]");
  const edge = event.target.closest("[data-resize-caption]")?.dataset.resizeCaption;
  if (block && (event.ctrlKey || event.metaKey || event.shiftKey)) { event.preventDefault(); return; }
  event.preventDefault();
  pause();
  const track = $("captionTrack"), rect = track.getBoundingClientRect();
  if (block && (edge || !state.subtitleSelection.has(block.dataset.captionKey))) {
    state.subtitleSelection = new Set([block.dataset.captionKey]);
    state.subtitleSelectionProject = state.project.id;
    renderSubtitles();
  }
  const context = edge ? captionTiming?.captionResizeContext(state.project,
    mappedCues().find(c => c.occurrence === block.dataset.captionOccurrence), edge) : block ? captionMoveContext() : null;
  if (block && !context) return;
  const overlay = document.createElement("div");
  overlay.className = block ? "caption-move-label" : "caption-selection-box";
  overlay.hidden = true;
  (block ? document.body : track).append(overlay);
  state.captionGesture = {kind: edge ? "resize" : block ? "move" : "box", pointerId: event.pointerId,
    projectId: state.project.id, occurrence: block?.dataset.captionOccurrence, context, overlay,
    startX: event.clientX - rect.left, startY: event.clientY - rect.top + track.scrollTop,
    clientX: event.clientX, clientY: event.clientY, delta: 0, moved: false,
    initialSelection: new Set(state.subtitleSelection),
    previousSelection: event.ctrlKey || event.metaKey ? new Set(state.subtitleSelection) : new Set()};
  track.setPointerCapture(event.pointerId);
}
function moveCaptionGesture(event) {
  const gesture = state.captionGesture;
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  event.preventDefault();
  if (Math.hypot(event.clientX - gesture.clientX, event.clientY - gesture.clientY) >= 3) gesture.moved = true;
  if (!gesture.moved) return;
  gesture.overlay.hidden = false;
  const track = $("captionTrack"), rect = track.getBoundingClientRect();
  const x = event.clientX - rect.left, y = event.clientY - rect.top + track.scrollTop;
  if (gesture.kind === "resize") {
    const context = gesture.context;
    gesture.delta = Math.max(context.minimum, Math.min(context.maximum,
      Math.round((x - gesture.startX) / state.zoom * 30) / 30));
    const point = context.edge === "start" ? context.mapped.start : context.mapped.end;
    if (!event.altKey) {
      const edges = [0];
      for (const clip of state.project.clips) edges.push(edges.at(-1) + duration(clip));
      let nearest = 8 / state.zoom;
      const requested = gesture.delta;
      for (const edge of edges) {
        const delta = edge - point, distance = Math.abs(delta - requested);
        if (delta >= context.minimum && delta <= context.maximum && distance < nearest) { gesture.delta = delta; nearest = distance; }
      }
    }
    const start = context.mapped.start + (context.edge === "start" ? gesture.delta : 0);
    const end = context.mapped.end + (context.edge === "end" ? gesture.delta : 0);
    const block = [...track.querySelectorAll("[data-caption-occurrence]")].find(b => b.dataset.captionOccurrence === gesture.occurrence);
    if (block) { block.classList.add("dragging"); block.style.left = `${start * state.zoom}px`; block.style.width = `${(end - start) * state.zoom}px`; }
    gesture.overlay.textContent = `${time(start)} – ${time(end)} · 时长 ${time(end - start)}`;
    gesture.overlay.style.left = `${Math.max(8, Math.min(innerWidth - 260, event.clientX + 12))}px`;
    gesture.overlay.style.top = `${Math.max(8, event.clientY - 34)}px`;
  } else if (gesture.kind === "move") {
    gesture.delta = Math.max(gesture.context.minimum, Math.min(gesture.context.maximum,
      Math.round((x - gesture.startX) / state.zoom * 30) / 30));
    let snapped = false;
    if (!event.altKey) {
      const anchor = gesture.context.placements.find(c => c.occurrence === gesture.occurrence);
      const edges = [0];
      for (const clip of state.project.clips) edges.push(edges[edges.length - 1] + duration(clip));
      const requestedDelta = gesture.delta;
      let closest = 8 / state.zoom;
      for (const edge of edges) for (const point of [anchor.start, anchor.end]) {
        const delta = edge - point, distance = Math.abs(delta - requestedDelta);
        if (delta >= gesture.context.minimum && delta <= gesture.context.maximum && distance < closest) {
          closest = distance; gesture.delta = delta; snapped = true;
        }
      }
    }
    for (const block of track.querySelectorAll("[data-caption-key]")) {
      if (!state.subtitleSelection.has(block.dataset.captionKey)) continue;
      block.classList.add("dragging");
      block.style.transform = `translateX(${gesture.delta * state.zoom}px)`;
    }
    gesture.overlay.textContent = `${gesture.context.entries.length} 条字幕 · ${gesture.delta < 0 ? "−" : "+"}${time(Math.abs(gesture.delta))}${snapped ? " · 已吸附切点" : ""}`;
    gesture.overlay.style.left = `${Math.max(8, Math.min(innerWidth - 220, event.clientX + 12))}px`;
    gesture.overlay.style.top = `${Math.max(8, event.clientY - 34)}px`;
  } else {
    const left = Math.min(x, gesture.startX), top = Math.min(y, gesture.startY);
    const right = Math.max(x, gesture.startX), bottom = Math.max(y, gesture.startY);
    Object.assign(gesture.overlay.style, {left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px`});
    const selection = new Set(gesture.previousSelection);
    for (const block of track.querySelectorAll("[data-caption-key]")) {
      const bx = parseFloat(block.style.left), by = parseFloat(block.style.top);
      if (bx < right && bx + block.offsetWidth > left && by < bottom && by + block.offsetHeight > top)
        selection.add(block.dataset.captionKey);
    }
    state.subtitleSelection = selection;
    state.subtitleSelectionProject = state.project.id;
    renderCaptionStyleEditor();
  }
}
function finishCaptionGesture(event, cancel = false) {
  const gesture = state.captionGesture;
  if (!gesture || (event && event.pointerId !== gesture.pointerId)) return;
  if (event?.type === "pointerup") moveCaptionGesture(event);
  state.captionGesture = null;
  gesture.overlay.remove();
  const track = $("captionTrack");
  if (track.hasPointerCapture(gesture.pointerId)) track.releasePointerCapture(gesture.pointerId);
  for (const block of track.querySelectorAll(".dragging")) { block.style.transform = ""; block.classList.remove("dragging"); }
  state.suppressCaptionClick = true;
  setTimeout(() => { state.suppressCaptionClick = false; }, 0);
  if (cancel || event?.type === "pointercancel" || state.project?.id !== gesture.projectId) {
    if (gesture.kind === "resize") renderTimeline();
    if (gesture.kind === "box" && state.project?.id === gesture.projectId) {
      state.subtitleSelection = gesture.initialSelection; renderSubtitles();
    }
    return;
  }
  if (gesture.kind === "resize") {
    const context = gesture.context;
    if (gesture.moved && Math.abs(gesture.delta) > .000001) {
      const cue = state.project.subtitles[context.sourceId][context.index];
      cue[context.edge] = captionTiming.resizedCaptionTime(context, gesture.delta);
      markDirty();
      seekOutput(context.offset + cue[context.edge] + (context.edge === "start" ? .01 : -.01), false);
    }
    renderTimeline();
    revealSubtitleInList(context.sourceId, context.index);
  } else if (gesture.kind === "move") {
    if (gesture.moved) commitCaptionMove(gesture.context, gesture.delta, gesture.occurrence);
    else openTimelineCaption(gesture.occurrence);
  } else {
    if (!gesture.moved) state.subtitleSelection = gesture.previousSelection;
    renderSubtitles();
  }
}
function previewSubtitle(sourceId, index) {
  const cue = state.project.subtitles[sourceId][index];
  const mapped = mappedCues().find(c => c.sourceId === sourceId && c.index === index);
  if (mapped) { seekOutput(mapped.start + Math.min(.05, (mapped.end - mapped.start) / 2), false); return; }
  const voice = (state.project.voiceovers || []).find(v => v.source_id === sourceId);
  const at = cue.start + Math.min(.05, (cue.end - cue.start) / 2);
  pause();
  if (voice) { seekOutput(voice.start + at, false); return; }
  const clipIndex = state.project.clips.findIndex(c => c.source_id === sourceId && c.start < cue.end && c.end > cue.start);
  if (clipIndex >= 0) selectClip(clipIndex, Math.max(at, state.project.clips[clipIndex].start));
  else { state.source = sourceId; state.clip = -1; render(); setPreview(at); }
}
function renderCaptionStyleEditor() {
  const entries = selectedSubtitleEntries();
  for (const block of $("captionTrack").querySelectorAll("[data-caption-key]")) {
    const selected = state.subtitleSelection.has(block.dataset.captionKey);
    block.classList.toggle("selected", selected);
    block.setAttribute("aria-pressed", String(selected));
  }
  $("captionSelectionCount").textContent = entries.length ? `已选 ${entries.length} 条` : "未选择字幕";
  $("captionStyleFields").disabled = !entries.length;
  $("captionFocusedContent").hidden = entries.length !== 1;
  if (entries.length === 1 && $("captionFocusedText").value !== entries[0].cue.text)
    $("captionFocusedText").value = entries[0].cue.text;
  if (entries.length === 1) {
    $("captionSourceStart").value = entries[0].cue.start;
    $("captionSourceEnd").value = entries[0].cue.end;
    $("captionTimeShift").value = entries[0].cue.shift || 0;
    const placements = mappedCues().filter(c => `${c.sourceId}:${c.index}` === entries[0].key);
    const active = placements.find(c => c.start <= Number($("fullscreenSeek").value) && c.end > Number($("fullscreenSeek").value)) || placements[0];
    $("captionTimelineRange").textContent = active ? `成片：${time(active.start)} – ${time(active.end)}` : "此字幕不在当前成片范围内";
  }
  if (!entries.length || !subtitleStyle) return;
  const styles = entries.map(entry => subtitleStyle.resolvedStyle(entry.cue.style));
  let mixed = false;
  for (const input of document.querySelectorAll("[data-caption-style]")) {
    const key = input.dataset.captionStyle, value = styles[0][key];
    const different = styles.some(s => s[key] !== value);
    mixed ||= different;
    if (input.type === "checkbox") { input.checked = value; input.indeterminate = different; }
    else input.value = different && input.type === "number" ? "" : value;
    input.title = different ? "所选字幕的此项不同；修改后统一此项" : "";
  }
  $("captionStyleHint").textContent = mixed
    ? "所选样式有差异；修改一项只统一该项。应用到全部时使用第一条所选字幕的完整样式。"
    : "修改会立即应用到所选字幕。字号随画面尺寸等比缩放。";
}
function updateCaptionStyleField(event) {
  const input = event.target, key = input.dataset.captionStyle;
  if (!key) return;
  const value = input.type === "checkbox" ? input.checked : input.type === "number" ? Number(input.value) : input.value;
  if (input.type === "number" && (!input.value || !input.checkValidity())) return;
  const entries = selectedSubtitleEntries();
  if (!entries.length) return;
  try { subtitleStyle.validateStyle({[key]: value}); } catch (error) { toast(error.message, true); return; }
  for (const {cue} of entries) cue.style = {...cue.style, [key]: value};
  input.indeterminate = false;
  markDirty(`style:${entries.map(entry => entry.key).join(",")}:${key}`);
  state.captionRenderKey = null;
  renderCaptionStyleEditor();
}
function renderCaptionPreview(cues) {
  const frame = $("videoFrame"), overlay = $("captionOverlay");
  const width = frame.clientWidth, height = frame.clientHeight;
  const key = JSON.stringify([cues, width, height, $("showCaptions").checked]);
  if (key === state.captionRenderKey) return;
  state.captionRenderKey = key;
  overlay.replaceChildren();
  if (!$("showCaptions").checked || !subtitleStyle) return;
  for (const cue of cues) {
  const s = subtitleStyle.subtitleLayout(cue.style, width, height);
  const text = document.createElement("span");
  text.className = "caption-text";
  text.textContent = cue.text;
  Object.assign(text.style, {
    left: `${s.x}px`, top: `${s.y}px`, transform: `translate(${-100 * s.anchorX}%, ${-100 * s.anchorY}%)`,
    maxWidth: `${s.maxWidth}px`, fontFamily: `"${s.fontFamily}", sans-serif`, fontSize: `${s.fontPixels}px`,
    fontWeight: s.bold ? "700" : "400", fontStyle: s.italic ? "italic" : "normal", color: s.color,
    textAlign: s.textAlign, webkitTextStroke: `${s.outlinePixels * 2}px ${s.outlineColor}`,
  });
  overlay.append(text);
  }
}
function recognitionLinks(job) {
  if (job.status !== "completed" || job.kind !== "transcribe" || !job.result)
    return "";
  const result = job.result;
  const links = [
    result.subtitles_url
      ? `<a href="${esc(result.subtitles_url)}" download>原文 SRT ↓</a>`
      : "",
    result.transcript_url
      ? `<a href="${esc(result.transcript_url)}" download>转写文字 ↓</a>`
      : "",
    result.review_url
      ? `<a href="${esc(result.review_url)}" download>待复核清单（${result.review_count || 0}处）↓</a>`
      : "",
  ]
    .filter(Boolean)
    .join("");
  return links ? `<div class="job-links">${links}</div>` : "";
}
function renderJobs() {
  const labels = {
    queued: "排队中",
    running: "处理中",
    completed: "已完成",
    failed: "未完成",
  };
  $("jobCount").textContent = state.jobs.length;
  $("jobList").innerHTML = state.jobs.length
    ? state.jobs
        .slice(0, 8)
        .map(
          (j) =>
            `<div class="job ${j.status}"><div class="job-head"><span>${j.kind === "export" ? "↗ 视频导出" : "✧ 自动字幕"}</span><span>${labels[j.status]}</span></div>${j.source_id ? `<div class="job-message">${esc(state.project?.sources.find((s) => s.id === j.source_id)?.name || "")}</div>` : ""}<div class="job-message">${esc(j.message)}</div>${["queued", "running"].includes(j.status) ? `<progress max="100" value="${j.progress}"></progress>` : ""}${j.status === "completed" && j.kind === "export" ? `<div class="job-links"><a href="${j.result.video_url}" download>下载视频 ↓</a><a href="${j.result.subtitles_url}" download>字幕 SRT ↓</a></div>` : ""}${recognitionLinks(j)}${j.status === "failed" ? `<a class="quiet-link" href="/api/jobs/${j.id}/log" target="_blank" rel="noopener">查看任务日志 ↗</a>` : ""}</div>`,
        )
        .join("")
    : '<p class="muted">导出的视频会出现在这里。</p>';
  for (const job of state.jobs) {
    if (!job.result?.styled_subtitles_url) continue;
    const videoLink = [...$("jobList").querySelectorAll("a")].find(a => a.getAttribute("href") === job.result.video_url);
    if (!videoLink) continue;
    const link = document.createElement("a");
    link.href = job.result.styled_subtitles_url;
    link.download = "subtitles.ass";
    link.textContent = "样式字幕 ASS ↓";
    videoLink.parentElement.append(link);
  }
}

function setPlaying(playing) {
  state.playing = playing;
  for (const id of ["playBtn", "fullscreenPlayBtn"]) {
    $(id).textContent = playing ? "Ⅱ" : "▶";
    $(id).setAttribute("aria-label", playing ? "暂停" : "播放");
  }
}
function pause() {
  setPlaying(false);
  $("video").pause();
}
function setPreview(at = 0, autoplay = false) {
  const token = ++state.previewToken;
  state.outputEndSelected = false;
  const s = source();
  if (!s) {
    $("video").removeAttribute("src");
    return;
  }
  const video = $("video"),
    url = mediaUrl(s.id);
  state.switching = true;
  const seek = () => {
    if (token !== state.previewToken) return;
    video.currentTime = Math.max(0, Math.min(at, s.duration));
    state.switching = false;
    if (autoplay && state.playing && !state.seekDragging) {
      video.play().catch((e) => {
        if (token !== state.previewToken || !state.playing) return;
        pause();
        toast("点击播放按钮开始预览。", true);
      });
    }
  };
  if (video.getAttribute("src") !== url) {
    video.src = url;
    video.addEventListener("loadedmetadata", seek, { once: true });
    video.load();
  } else if (video.readyState < 1) {
    video.addEventListener("loadedmetadata", seek, { once: true });
  } else seek();
}
function selectClip(index, at, autoplay = false) {
  if (!state.project?.clips[index]) return;
  if (!autoplay) pause();
  else setPlaying(true);
  state.clip = index;
  state.source = selected().source_id;
  render();
  setPreview(at ?? selected().start, autoplay);
}
function seekOutput(seconds, autoplay = state.playing) {
  if (!Number.isFinite(seconds) || !state.project?.clips.length) return;
  const position = Math.max(0, Math.min(seconds, total()));
  let offset = 0;
  for (const [index, clip] of state.project.clips.entries()) {
    const length = duration(clip);
    if (
      position < offset + length ||
      index === state.project.clips.length - 1
    ) {
      // The endpoint displays the last retained frame, never the trimmed tail.
      const at = Math.max(
        clip.start,
        Math.min(clip.end - 1 / 30, clip.start + position - offset),
      );
      if (state.clip !== index || state.source !== clip.source_id)
        selectClip(index, at, autoplay);
      else {
        if (!autoplay) pause();
        else setPlaying(true);
        setPreview(at, autoplay);
      }
      state.pendingOutputSeek = position;
      state.outputEndSelected = position === total();
      return;
    }
    offset += length;
  }
}
function finishFullscreenSeek() {
  if (!state.seekDragging) return;
  state.seekDragging = false;
  seekOutput(Number($("fullscreenSeek").value), false);
  setFullscreenControlsVisible(state.fullscreenPointerNearBottom);
}
function scrubTimeline(event) {
  const drag = state.timelineScrub;
  if (!drag || event.pointerId !== drag.pointerId) return;
  event.preventDefault();
  const left = $("timelineCanvas").getBoundingClientRect().left;
  drag.position = Math.max(
    0,
    Math.min(total(), (event.clientX - left - drag.grabOffset) / state.zoom),
  );
  seekOutput(drag.position, false);
}
function startTimelineScrub(event) {
  if (
    event.button !== 0 ||
    !event.isPrimary ||
    !state.project?.clips.length ||
    state.timelineScrub
  )
    return;
  event.preventDefault();
  event.stopPropagation();
  const target = event.currentTarget;
  const left = $("playhead").getBoundingClientRect().left;
  state.timelineScrub = {
    pointerId: event.pointerId,
    target,
    grabOffset: target === $("playheadHandle") ? event.clientX - left : 0,
    position: Number($("fullscreenSeek").value),
  };
  pause();
  target.setPointerCapture(event.pointerId);
  $("timelineCanvas").classList.add("is-scrubbing");
  scrubTimeline(event);
}
function finishTimelineScrub(event) {
  const drag = state.timelineScrub;
  if (!drag || (event && event.pointerId !== drag.pointerId)) return;
  if (event?.type === "pointerup") scrubTimeline(event);
  state.timelineScrub = null;
  $("timelineCanvas").classList.remove("is-scrubbing");
  if (drag.target.hasPointerCapture(drag.pointerId))
    drag.target.releasePointerCapture(drag.pointerId);
  seekOutput(drag.position, false);
}
function togglePlay() {
  if (!selected()) {
    if (state.project?.clips.length) selectClip(0);
    else return;
  }
  if (state.playing) {
    pause();
    return;
  }
  if (state.outputEndSelected) {
    seekOutput(0, true);
    return;
  }
  setPlaying(true);
  const token = state.previewToken;
  const c = selected();
  if (
    $("video").currentTime < c.start ||
    $("video").currentTime >= c.end - 0.02
  )
    $("video").currentTime = c.start;
  $("video")
    .play()
    .catch(() => {
      if (token !== state.previewToken || !state.playing) return;
      pause();
      toast("当前视频编码无法在浏览器中播放，仍可剪辑并导出 MP4。", true);
    });
}
function nextClip() {
  if (state.clip + 1 < state.project.clips.length)
    selectClip(state.clip + 1, undefined, true);
  else {
    pause();
    state.outputEndSelected = true;
  }
}
function tick() {
  const video = $("video"),
    c = selected();
  if (
    state.playing &&
    c &&
    !state.switching &&
    !video.seeking &&
    video.currentTime >= c.end - 0.012
  )
    nextClip();
  const current = video.currentTime || 0;
  $("sourceClock").textContent = `素材 ${time(current)}`;
  let offset = 0;
  if (state.project && c) {
    offset =
      state.project.clips
        .slice(0, state.clip)
        .reduce((s, c) => s + duration(c), 0) +
      Math.max(0, Math.min(current - c.start, duration(c)));
  }
  if (state.outputEndSelected && !state.playing) offset = total();
  if (state.timelineScrub) offset = state.timelineScrub.position;
  else if (state.seekDragging) offset = Number($("fullscreenSeek").value);
  else if (state.switching && state.pendingOutputSeek !== null)
    offset = state.pendingOutputSeek;
  else state.pendingOutputSeek = null;
  $("outputClock").textContent = time(offset);
  $("fullscreenClock").textContent = `${time(offset)} / ${time(total())}`;
  if (!state.seekDragging) $("fullscreenSeek").value = offset;
  $("fullscreenSeek").setAttribute(
    "aria-valuetext",
    `${time(offset)} / ${time(total())}`,
  );
  $("playhead").style.left = `${offset * state.zoom}px`;
  $("playheadHandle").setAttribute("aria-valuemax", total());
  $("playheadHandle").setAttribute("aria-valuenow", offset);
  $("playheadHandle").setAttribute("aria-valuetext", time(offset));
  const captionTime = state.outputEndSelected ? Math.max(0, total() - 1 / 30) : offset;
  const cues = c ? (state.previewCues ||= mappedCues()).filter(cue => cue.start <= captionTime && captionTime < cue.end)
    : (state.project?.subtitles[state.source] || []).filter(cue => cue.start <= current && current < cue.end);
  renderCaptionPreview(cues);
  requestAnimationFrame(tick);
}
function updateRange(start, end) {
  const c = selected(),
    s = source();
  if (!c) return;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end > s.duration + 0.001 ||
    end - start < 1 / 30
  ) {
    toast("请设置素材范围内的入点和出点，至少保留一帧。", true);
    renderInspector();
    return;
  }
  c.start = start;
  c.end = end;
  markDirty();
  renderTimeline();
  renderInspector();
  updateButtons();
}
function splitClip() {
  const c = selected(),
    at = $("video").currentTime;
  if (!c || at - c.start < 1 / 30 || c.end - at < 1 / 30) {
    toast("请将播放头移到片段内部再分割。", true);
    return;
  }
  pause();
  state.project.clips.splice(
    state.clip,
    1,
    { ...c, end: at },
    { ...c, start: at },
  );
  markDirty();
  render();
}
function moveClip(to) {
  if (to < 0 || to >= state.project.clips.length) return;
  const [c] = state.project.clips.splice(state.clip, 1);
  state.project.clips.splice(to, 0, c);
  state.clip = to;
  markDirty();
  render();
}
function removeClip() {
  if (!selected()) return;
  pause();
  state.project.clips.splice(state.clip, 1);
  state.clip = Math.min(state.clip, state.project.clips.length - 1);
  if (selected()) state.source = selected().source_id;
  markDirty();
  render();
  if (selected()) setPreview(selected().start);
}
async function pollJobs() {
  if (!state.project) return;
  const id = state.project.id;
  const data = await api(`/api/projects/${id}/jobs`);
  if (state.project?.id !== id) return;
  const justFinished = data.jobs.some(
    (j) =>
      j.status === "completed" &&
      j.kind === "transcribe" &&
      state.jobs.some((old) => old.id === j.id && old.status !== "completed"),
  );
  state.jobs = data.jobs;
  renderJobs();
  updateButtons();
  const latest = await api(`/api/projects/${id}`);
  if (state.project?.id !== id || state.busy || state.saving || state.captionGesture) return;
  if (latest.revision !== state.project.revision) {
    if (state.dirty) {
      if (state.remoteRevision !== latest.revision) {
        state.remoteRevision = latest.revision;
        toast(
          "项目已从其他入口更新。请保存一份修改记录，再点击顶部 ↻ 重新载入。",
          true,
        );
      }
    } else {
      const currentTime = $("video").currentTime;
      pause();
      state.project = latest;
      state.clip = Math.min(state.clip, latest.clips.length - 1);
      if (selected()) state.source = selected().source_id;
      markSaved();
      render();
      const c = selected();
      setPreview(c ? Math.max(c.start, Math.min(currentTime, c.end)) : 0);
      toast(
        justFinished
          ? "原文字幕已生成，请查看任务中的待复核清单。"
          : "项目已同步其他入口的修改。",
      );
    }
  }
}

$("importBtn").onclick = $("welcomeImport").onclick = () =>
  $("fileInput").click();
$("fileInput").onchange = (e) => importFiles([...e.target.files]);
$("newProjectBtn").onclick = () =>
  newProject().catch((e) => toast(e.message, true));
$("projectSelect").onchange = (e) =>
  loadProject(e.target.value).catch((e) => toast(e.message, true));
$("reloadBtn").onclick = () =>
  state.project &&
  loadProject(state.project.id).catch((e) => toast(e.message, true));
$("projectTitle").oninput = (e) => {
  if (state.project) {
    state.project.title = e.target.value;
    markDirty("title");
  }
};
$("saveBtn").onclick = () =>
  saveProject()
    .then(() => toast("项目已保存。"))
    .catch((e) => toast(e.message, true));
$("undoBtn").onclick = () => undoEdit();
$("redoBtn").onclick = () => undoEdit(true);
document.addEventListener("focusout", () => editHistory?.breakGroup());
$("sourceList").onclick = (e) => {
  const card = e.target.closest("[data-source]");
  if (!card) return;
  const index = state.project.clips.findIndex(
    (c) => c.source_id === card.dataset.source,
  );
  if (index >= 0) selectClip(index);
  else {
    pause();
    state.source = card.dataset.source;
    state.clip = -1;
    render();
    setPreview(0);
  }
};
$("sourceList").onkeydown = (e) => {
  if (e.key === "Enter") e.target.click();
};
$("clipTrack").onclick = (e) => {
  if (e.target.closest(".spectrogram-status.retry")) {
    const clip = state.project.clips[Number(e.target.closest("[data-clip]").dataset.clip)];
    const prefix = `${state.project.id}:${clip.source_id}:`;
    for (const [key, entry] of state.spectrograms) if (key.startsWith(prefix) && entry.status === "error") state.spectrograms.delete(key);
    scheduleWaveformDraw(); return;
  }
  if (e.target.closest(".waveform-status.retry")) {
    const block = e.target.closest("[data-clip]"), clip = state.project.clips[Number(block.dataset.clip)];
    state.waveforms.delete(`${state.project.id}:${clip.source_id}`);
    ensureWaveforms(); scheduleWaveformDraw(); return;
  }
  const clip = e.target.closest("[data-clip]");
  if (!clip) return;
  const index = Number(clip.dataset.clip),
    c = state.project.clips[index];
  const f = Math.max(
    0,
    Math.min(
      1,
      (e.clientX - clip.getBoundingClientRect().left) / clip.clientWidth,
    ),
  );
  selectClip(index, c.start + f * (c.end - c.start));
};
$("clipTrack").onkeydown = (e) => {
  if (e.key === "Enter") {
    const clip = e.target.closest("[data-clip]");
    if (clip) selectClip(Number(clip.dataset.clip));
  }
};
$("clipTrack").ondragstart = (e) => {
  if (state.timelineScrub) {
    e.preventDefault();
    return;
  }
  const clip = e.target.closest("[data-clip]");
  if (clip) {
    e.dataTransfer.setData("text/x-cutccc-clip", clip.dataset.clip);
    e.dataTransfer.effectAllowed = "move";
  }
};
$("clipTrack").ondragover = (e) => {
  if ([...e.dataTransfer.types].includes("text/x-cutccc-clip"))
    e.preventDefault();
};
$("clipTrack").ondrop = (e) => {
  const target = e.target.closest("[data-clip]"),
    raw = e.dataTransfer.getData("text/x-cutccc-clip");
  if (!target || raw === "") return;
  e.preventDefault();
  const from = Number(raw);
  if (!Number.isInteger(from) || !state.project.clips[from]) return;
  state.clip = from;
  moveClip(Number(target.dataset.clip));
};
$("playBtn").onclick = togglePlay;
for (const target of [$("playheadHandle"), $("ruler")]) {
  target.addEventListener("pointerdown", startTimelineScrub);
  target.addEventListener("lostpointercapture", finishTimelineScrub);
}
document.addEventListener("pointermove", scrubTimeline);
document.addEventListener("pointerup", finishTimelineScrub);
document.addEventListener("pointercancel", finishTimelineScrub);
$("playheadHandle").onclick = (event) => event.stopPropagation();
$("playheadHandle").ondragstart = (event) => event.preventDefault();
$("playheadHandle").onkeydown = (event) => {
  let position = Number($("fullscreenSeek").value);
  if (event.key === "Home") position = 0;
  else if (event.key === "End") position = total();
  else if (event.key === "ArrowLeft") position -= event.shiftKey ? 1 : 1 / 30;
  else if (event.key === "ArrowRight") position += event.shiftKey ? 1 : 1 / 30;
  else return;
  event.preventDefault();
  event.stopPropagation();
  seekOutput(position);
};
window.addEventListener("blur", () => finishTimelineScrub());
$("fullscreenPlayBtn").onclick = togglePlay;
$("fullscreenSeek").onpointerdown = () => {
  if ($("fullscreenSeek").disabled) return;
  state.seekDragging = true;
  state.fullscreenPointerNearBottom = true;
  pause();
};
$("fullscreenSeek").oninput = (event) => {
  seekOutput(
    Number(event.target.value),
    state.seekDragging ? false : state.playing,
  );
};
$("fullscreenSeek").onchange = finishFullscreenSeek;
$("fullscreenSeek").onblur = finishFullscreenSeek;
document.addEventListener("pointerup", finishFullscreenSeek);
document.addEventListener("pointercancel", finishFullscreenSeek);
$("previewArea").addEventListener(
  "pointermove",
  updateFullscreenControlsForPointer,
);
$("previewArea").addEventListener("pointerdown", (event) => {
  if (
    document.fullscreenElement !== $("previewArea") ||
    $("fullscreenControls").contains(event.target)
  )
    return;
  if (event.pointerType === "touch") updateFullscreenControlsForPointer(event);
  else setFullscreenControlsVisible(false);
});
$("previewArea").addEventListener("pointerleave", () => {
  if (!state.seekDragging) setFullscreenControlsVisible(false);
});
$("fullscreenControls").addEventListener("focusin", () =>
  setFullscreenControlsVisible(true),
);
$("fullscreenBtn").onclick = toggleFullscreen;
for (const id of ["previewZoom", "fullscreenZoom"])
  $(id).oninput = (event) => setPreviewZoom(event.target.value);
for (const id of ["previewFitBtn", "fullscreenFitBtn"])
  $(id).onclick = resetPreviewView;
for (const prefix of ["preview", "fullscreen"]) {
  $(prefix + "ZoomOut").onclick = () => setPreviewZoom(Math.round(state.previewZoom * 100) - 5);
  $(prefix + "ZoomIn").onclick = () => setPreviewZoom(Math.round(state.previewZoom * 100) + 5);
}
$("videoFrame").addEventListener("pointerdown", startPreviewPan);
$("videoFrame").addEventListener("lostpointercapture", finishPreviewPan);
$("videoFrame").ondragstart = (event) => event.preventDefault();
document.addEventListener("pointermove", movePreviewPan);
document.addEventListener("pointerup", finishPreviewPan);
document.addEventListener("pointercancel", finishPreviewPan);
window.addEventListener("blur", () => finishPreviewPan());
$("videoFrame").ondblclick = toggleFullscreen;
document.addEventListener("fullscreenchange", syncFullscreen);
$("backBtn").onclick = () => {
  if (selected()) {
    pause();
    setPreview(selected().start);
  }
};
$("video").onended = () => {
  if (state.playing) nextClip();
};
$("video").onerror = () => {
  state.switching = false;
  pause();
  toast("浏览器无法预览当前编码。可以继续设置剪辑范围并导出兼容的 MP4。", true);
};
$("zoom").oninput = () => renderTimeline();
$("timelineScroll").addEventListener("scroll", scheduleWaveformDraw, {passive: true});
$("audioView").onchange = (event) => setAudioView(event.target.value);
for (const [id, delta] of [["timelineZoomOut", -5], ["timelineZoomIn", 5]])
  $(id).onclick = () => {
    $("zoom").value = Math.max(0, Math.min(100, Number($("zoom").value) + delta));
    renderTimeline();
  };
$("splitBtn").onclick = splitClip;
$("removeClipBtn").onclick = removeClip;
$("trimStart").onchange = () =>
  updateRange(Number($("trimStart").value), Number($("trimEnd").value));
$("trimEnd").onchange = $("trimStart").onchange;
$("setInBtn").onclick = () =>
  selected() && updateRange($("video").currentTime, selected().end);
$("setOutBtn").onclick = () =>
  selected() && updateRange(selected().start, $("video").currentTime);
$("moveLeftBtn").onclick = () => moveClip(state.clip - 1);
$("moveRightBtn").onclick = () => moveClip(state.clip + 1);
$("appendBtn").onclick = () => {
  const s = source();
  if (!s) return;
  state.project.clips.push({ source_id: s.id, start: 0, end: s.duration });
  state.clip = state.project.clips.length - 1;
  markDirty();
  render();
  setPreview(0);
};
$("addVoiceoverBtn").onclick = () => {
  const s = source();
  if (!s?.has_audio) return;
  state.project.voiceovers ||= [];
  state.project.voiceovers.push({ source_id: s.id, start: 0, volume: 1 });
  markDirty();
  renderVoiceovers();
};
$("voiceoverList").oninput = (e) => {
  const row = e.target.closest("[data-voice]"),
    field = e.target.dataset.voiceField;
  if (!row || !field) return;
  state.project.voiceovers[Number(row.dataset.voice)][field] = Number(
    e.target.value,
  );
  markDirty(`voice:${row.dataset.voice}:${field}`);
  renderTimeline();
};
$("voiceoverList").onclick = (e) => {
  const button = e.target.closest("[data-remove-voice],[data-remove-voice-all],[data-restore-voice]");
  if (!button) return;
  const index = Number(button.dataset.removeVoice ?? button.dataset.removeVoiceAll ?? button.dataset.restoreVoice);
  const voice = state.project.voiceovers[index];
  if (button.hasAttribute("data-restore-voice")) voice.volume = 1;
  else if (button.hasAttribute("data-remove-voice") && state.project.subtitles[voice.source_id]?.length) voice.volume = 0;
  else state.project.voiceovers.splice(index, 1);
  markDirty();
  renderVoiceovers();
  renderTimeline();
};
function selectLibraryTab(name) {
  for (const tab of document.querySelectorAll("[data-library-tab]")) {
    const active = tab.dataset.libraryTab === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  $("materialsPanel").hidden = name !== "materials";
  $("subtitleListPanel").hidden = name !== "captions";
}
for (const tab of document.querySelectorAll("[data-library-tab]")) {
  tab.onclick = () => selectLibraryTab(tab.dataset.libraryTab);
  tab.onkeydown = event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const name = event.key === "Home" ? "materials" : event.key === "End" ? "captions" : tab.dataset.libraryTab === "materials" ? "captions" : "materials";
    selectLibraryTab(name);
    document.querySelector(`[data-library-tab="${name}"]`).focus();
  };
}
for (const tab of document.querySelectorAll(".inspector-tabs .tab"))
  tab.onclick = () => {
    document
      .querySelectorAll(".inspector-tabs .tab")
      .forEach((t) => t.classList.toggle("active", t === tab));
    $("clipPanel").hidden = tab.dataset.tab !== "clip";
    $("subtitlesPanel").hidden = tab.dataset.tab !== "subtitles";
  };
$("subtitleList").onclick = (e) => {
  const styleButton = e.target.closest("[data-edit-style]");
  if (styleButton) {
    state.subtitleSelection = new Set([styleButton.dataset.editStyle]);
    const entry = selectedSubtitleEntries()[0];
    previewSubtitle(entry.sourceId, entry.index);
    renderSubtitles();
    document.querySelector('[data-tab="subtitles"]').click();
    $("captionStyleEditor").open = true;
    $("captionStyleEditor").scrollIntoView({block: "nearest"});
    return;
  }
  const button = e.target.closest("[data-remove-cue]");
  if (button) {
    const row = button.closest("[data-cue]");
    state.project.subtitles[row.dataset.cueSource].splice(
      Number(button.dataset.removeCue),
      1,
    );
    state.subtitleSelection.clear();
    markDirty();
    renderSubtitles();
    renderTimeline();
  } else if (e.target.classList.contains("number")) {
    const row = e.target.closest("[data-cue]");
    previewSubtitle(row.dataset.cueSource, Number(row.dataset.cue));
  }
};
$("subtitleList").onchange = (event) => {
  const key = event.target.dataset.selectCue;
  if (!key) return;
  if (event.target.checked) state.subtitleSelection.add(key);
  else state.subtitleSelection.delete(key);
  event.target.closest("[data-cue]").classList.toggle("selected", event.target.checked);
  renderCaptionStyleEditor();
  document.querySelector('[data-tab="subtitles"]').click();
  $("captionStyleEditor").open = true;
};
$("subtitleList").onkeydown = event => {
  if (event.key !== "Delete" || event.target.matches("input") || event.repeat || state.busy) return;
  const row = event.target.closest("[data-cue]");
  if (row) { event.preventDefault(); event.stopPropagation(); row.querySelector("[data-remove-cue]").click(); }
};
$("subtitleScope").onchange = renderSubtitles;
$("captionTrack").onclick = (event) => {
  if (state.suppressCaptionClick) return;
  const block = event.target.closest("[data-caption-occurrence]");
  if (!block) return;
  if (event.ctrlKey || event.metaKey || event.shiftKey) selectTimelineCaption(block, event);
  else openTimelineCaption(block.dataset.captionOccurrence);
};
$("captionTrack").onkeydown = (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
    event.preventDefault(); event.stopPropagation();
    state.subtitleSelection = new Set(mappedCues().map(c => `${c.sourceId}:${c.index}`));
    renderSubtitles(); return;
  }
  if (event.key !== "Enter" && event.code !== "Space") return;
  const block = event.target.closest("[data-caption-occurrence]");
  if (!block) return;
  event.preventDefault();
  event.stopPropagation();
  openTimelineCaption(block.dataset.captionOccurrence);
};
$("captionTrack").addEventListener("pointerdown", startCaptionGesture);
$("captionTrack").addEventListener("lostpointercapture", (event) => finishCaptionGesture(event, true));
$("captionTrack").ondragstart = event => event.preventDefault();
document.addEventListener("pointermove", moveCaptionGesture);
document.addEventListener("pointerup", finishCaptionGesture);
document.addEventListener("pointercancel", finishCaptionGesture);
window.addEventListener("blur", () => finishCaptionGesture(null, true));
$("captionTimeShift").onchange = event => {
  const context = captionMoveContext(), value = Number(event.target.value);
  if (!context || context.entries.length !== 1 || !event.target.value || !Number.isFinite(value)) return;
  commitCaptionMove(context, Math.max(context.minimum, Math.min(context.maximum, value - context.entries[0].shift)));
};
$("captionFocusedText").oninput = (event) => {
  const entries = selectedSubtitleEntries();
  if (entries.length !== 1) return;
  const entry = entries[0];
  entry.cue.text = event.target.value;
  const row = [...$("subtitleList").querySelectorAll("[data-cue]")].find(
    row => row.dataset.cueSource === entry.sourceId && Number(row.dataset.cue) === entry.index,
  );
  if (row) row.querySelector(".subtitle-open").textContent = entry.cue.text;
  markDirty(`cue:${entry.sourceId}:${entry.index}:text`);
  renderTimeline();
};
for (const [id, field] of [["captionSourceStart", "start"], ["captionSourceEnd", "end"]]) {
  $(id).onchange = event => {
    const entries = selectedSubtitleEntries();
    if (entries.length !== 1) return;
    const {cue, index, sourceId} = entries[0], value = Number(event.target.value);
    const cues = state.project.subtitles[sourceId], source = state.project.sources.find(s => s.id === sourceId);
    const low = field === "start" ? (cues[index - 1]?.end ?? 0) : cue.start + 1 / 30;
    const high = field === "start" ? cue.end - 1 / 30 : (cues[index + 1]?.start ?? source.duration);
    if (!event.target.value || !Number.isFinite(value) || value < low || value > high) {
      event.target.value = cue[field]; toast("时间需在素材范围内，且不能与相邻字幕重叠。", true); return;
    }
    if (value === cue[field]) return;
    cue[field] = value;
    markDirty(); renderTimeline();
    revealSubtitleInList(sourceId, index);
  };
}
$("selectAllCaptions").onclick = () => {
  for (const entry of subtitleEntries()) state.subtitleSelection.add(entry.key);
  renderSubtitles();
  $("captionStyleEditor").open = true;
  document.querySelector('[data-tab="subtitles"]').click();
};
$("clearCaptionSelection").onclick = () => { state.subtitleSelection.clear(); renderSubtitles(); };
$("captionStyleFields").oninput = updateCaptionStyleField;
$("applyStyleToAll").onclick = () => {
  const first = selectedSubtitleEntries()[0];
  if (!first) return;
  const style = subtitleStyle.resolvedStyle(first.cue.style);
  const entries = subtitleEntries(true);
  for (const {cue} of entries) cue.style = {...style};
  markDirty();
  renderCaptionStyleEditor();
  toast(`已将样式应用到工程全部 ${entries.length} 条字幕。`);
};
$("resetCaptionStyle").onclick = () => {
  const entries = selectedSubtitleEntries();
  if (!entries.length) return;
  for (const {cue} of entries) delete cue.style;
  markDirty();
  renderCaptionStyleEditor();
};
function addCaption() {
  const s = source();
  if (!s || state.busy) return;
  pause();
  const cues = state.project.subtitles[s.id];
  const clip = selected();
  const limit = clip?.source_id === s.id ? clip.end : s.duration;
  const requested = Math.max($("video").currentTime, clip?.start || 0);
  let start = requested;
  for (const c of cues) if (start >= c.start && start < c.end) start = c.end;
  const next = cues.find((c) => c.start >= start),
    end = Math.min(start + 2, next?.start ?? limit, limit);
  if (end - start < 0.05) {
    toast("当前位置没有可用的字幕间隙，请移动播放头。", true);
    return;
  }
  const cue = { start, end, text: "新字幕" };
  cues.push(cue);
  cues.sort((a, b) => a.start - b.start);
  const index = cues.indexOf(cue);
  state.subtitleSelection = new Set([`${s.id}:${index}`]);
  markDirty();
  selectLibraryTab("captions");
  document.querySelector('[data-tab="subtitles"]').click();
  previewSubtitle(s.id, index);
  renderSubtitles();
  renderTimeline();
  revealSubtitleInList(s.id, index);
  $("captionStyleEditor").open = true;
  $("captionStyleEditor").scrollIntoView({block: "nearest"});
  $("captionFocusedText").focus({preventScroll: true});
  $("captionFocusedText").select();
  if (start - requested > .05) toast("当前位置已有字幕，已在下一段空白处新增。");
}
$("addCaptionBtn").onclick = $("timelineAddCaptionBtn").onclick = addCaption;
$("transcribeBtn").onclick = async () => {
  try {
    await saveProject();
    if (
      (state.project.subtitles[state.source] || []).length &&
      !confirm("重新生成会替换当前素材的字幕，是否继续？")
    )
      return;
    const job = await api(
      `/api/projects/${state.project.id}/transcribe`,
      "POST",
      { source_id: state.source, language: $("recognitionLanguage").value },
    );
    state.jobs.unshift(job);
    renderJobs();
    updateButtons();
    toast("字幕任务已加入队列。");
  } catch (e) {
    toast(e.message, true);
  }
};
const exportOptionsReady = import("/static/export-options.js");
function selectedExportOptions() {
  return { fps: Number($("exportFps").value), resolution: $("exportResolution").value, quality: $("exportQuality").value };
}
async function updateExportEstimate() {
  const { exportProfile } = await exportOptionsReady;
  const source = state.project?.sources.find(s => s.id === state.project.clips[0]?.source_id);
  if (!source) return;
  const p = exportProfile(source, selectedExportOptions());
  const mb = Math.round(total() * (p.bitrate + p.audioBitrate) / 8 / 1000);
  $("exportEstimate").textContent = `${p.width} × ${p.height} · ${p.fps} 帧/秒 · 参考大小约 ${mb} MB（实际随画面复杂度变化）`;
}
for (const id of ["exportFps", "exportResolution", "exportQuality"]) $(id).onchange = updateExportEstimate;
$("exportBtn").onclick = async () => {
  try {
    await saveProject();
    $("exportDuration").textContent = time(total());
    await updateExportEstimate();
    $("exportDialog").showModal();
  } catch (e) {
    toast(e.message, true);
  }
};
$("confirmExport").onclick = async () => {
  try {
    const job = await api(`/api/projects/${state.project.id}/export`, "POST", {
      burn_subtitles: $("burnCaptions").checked,
      ...selectedExportOptions(),
    });
    $("exportDialog").close();
    state.jobs.unshift(job);
    renderJobs();
    toast("已开始导出，完成后可在右下方下载。");
  } catch (e) {
    toast(e.message, true);
  }
};
function handleEditorKeydown(e) {
  if (e.key === "Escape" && state.captionGesture) { e.preventDefault(); finishCaptionGesture(null, true); return; }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.isComposing && !$("exportDialog").open &&
      ["z", "y"].includes(e.key.toLowerCase())) {
    e.preventDefault();
    if (!e.repeat) undoEdit(e.key.toLowerCase() === "y" || e.shiftKey);
    return;
  }
  if (e.key === "Tab" && document.fullscreenElement === $("previewArea"))
    setFullscreenControlsVisible(true);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveProject()
      .then(() => toast("项目已保存。"))
      .catch((err) => toast(err.message, true));
    return;
  }
  if (
    e.target.matches("input,textarea,select,button") ||
    e.target.isContentEditable ||
    e.isComposing ||
    $("exportDialog").open
  )
    return;
  if (e.key === "Delete") {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat || state.busy || !selected())
      return;
    e.preventDefault();
    removeClip();
  } else if (e.code === "Space") {
    e.preventDefault();
    togglePlay();
  } else if (
    e.key.toLowerCase() === "f" &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey
  ) {
    e.preventDefault();
    toggleFullscreen();
  } else if (e.key.toLowerCase() === "s") splitClip();
  else if (e.key.toLowerCase() === "i") $("setInBtn").click();
  else if (e.key.toLowerCase() === "o") $("setOutBtn").click();
}
document.addEventListener("keydown", handleEditorKeydown);
let dragDepth = 0;
document.addEventListener("dragenter", (e) => {
  if ([...e.dataTransfer.types].includes("Files")) {
    e.preventDefault();
    dragDepth++;
    $("dropOverlay").hidden = false;
  }
});
document.addEventListener("dragleave", (e) => {
  if ([...e.dataTransfer.types].includes("Files") && --dragDepth <= 0)
    $("dropOverlay").hidden = true;
});
document.addEventListener("dragover", (e) => {
  if ([...e.dataTransfer.types].includes("Files")) e.preventDefault();
});
document.addEventListener("drop", (e) => {
  if ([...e.dataTransfer.types].includes("Files")) {
    e.preventDefault();
    dragDepth = 0;
    $("dropOverlay").hidden = true;
    importFiles([...e.dataTransfer.files]);
  }
});
window.addEventListener("beforeunload", (e) => {
  if (state.dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
window.addEventListener("resize", () => {
  renderTimeline();
  fitPreview();
});
let polling = false;
setInterval(async () => {
  if (polling) return;
  polling = true;
  try {
    await pollJobs();
  } catch (e) {
    $("saveState").textContent = "服务连接中断";
  } finally {
    polling = false;
  }
}, 1500);
async function health() {
  try {
    const data = await api("/api/health");
    state.modelsReady = data.models_ready;
    updateButtons();
  } catch (e) {
    toast("无法连接本地剪辑服务。", true);
  }
}
(async () => {
  try {
    await Promise.all([subtitleStyleReady, editHistoryReady, captionTimingReady]);
    setAudioView(localStorage.getItem("cutccc-audio-view") || "waveform");
    await health();
    await projectOptions();
    const id = localStorage.getItem("cutccc-project");
    if (id) {
      try {
        await loadProject(id, false);
      } catch (e) {
        localStorage.removeItem("cutccc-project");
      }
    }
    render();
  } catch (e) {
    toast(e.message, true);
  }
  requestAnimationFrame(tick);
})();
setInterval(health, 15000);
