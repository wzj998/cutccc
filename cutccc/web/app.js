"use strict";
const $ = (id) => document.getElementById(id);
let subtitleStyle;
let captionTiming;
let timelineClipboard;
let timelineNavigation;
let audioTracks;
let timelineTracks;
const tracksReady=import('/static/tracks.js').then(module=>{timelineTracks=module;});
const audioTracksReady = import("/static/audio-tracks.js").then(module => {audioTracks=module;});
const timelineNavigationReady = import("/static/timeline-navigation.js").then(module => { timelineNavigation = module; });
const timelineClipboardReady = import("/static/timeline-clipboard.js").then(module => { timelineClipboard = module; });
const captionTimingReady = import("/static/caption-timing.js").then(module => { captionTiming = module; });
const subtitleStyleReady = import("/static/subtitle-style.js").then(module => { subtitleStyle = module; });
let editHistory;
const editHistoryReady = import("/static/edit-history.js").then(({EditHistory}) => { editHistory = new EditHistory(); });
const state = {
  project: null,
  source: null,
  clip: -1,
  previewContext: null,
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
  clipTrim: null,
  suppressClipClick: false,
  audioPlayers: new Map(),
  audioClock: null,
  sourceMenu: null,
  selectedTrack: null,
  captionSelectionAnchor: null,
  suppressCaptionClick: false,
  previewCues: null,
  clipboardKind: "clip",
  selectedVoice: -1,
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
  timelineTracks?timelineTracks.clipDuration(clip):Math.max(1, Math.round((clip.end - clip.start) * 30)) / 30;
const total = () =>
  state.project ? audioTracks ? audioTracks.projectDuration(state.project) : state.project.clips.reduce((s,c)=>s+duration(c),0) : 0;
const selectedAudio = () => state.clipboardKind === "voice" ? state.project?.voiceovers?.[state.selectedVoice] : null;
const selected = () => state.project?.clips[state.clip];
const source = () => state.project?.sources.find((s) => s.id === state.source);
// Timeline selection can differ from the clip currently shown in the player.
const previewClipIndex = () => state.previewContext
  ? state.project?.clips.indexOf(state.previewContext.clip) ?? -1 : state.clip;
const previewClip = () => state.project?.clips[previewClipIndex()];
const previewSource = () => state.project?.sources.find(s => s.id ===
  (state.previewContext ? state.previewContext.sourceId : state.source));
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
  return {title: p.title, clips: p.clips, subtitles: p.subtitles, voiceovers: p.voiceovers || [],tracks:p.tracks??null};
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
  if (state.clipTrim) finishClipTrim(null, true);
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
  if(edit.tracks==null)delete state.project.tracks;
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
  $("saveBtn").disabled = !has || !state.dirty || state.busy || state.saving || !!state.clipTrim;
  $("undoBtn").disabled = !has || !editHistory?.canUndo || state.busy || state.saving;
  $("redoBtn").disabled = !has || !editHistory?.canRedo || state.busy || state.saving;
  $("exportBtn").disabled = !has || !total() || state.busy || state.saving || !!state.clipTrim;
  $("addTrackBtn").disabled=!has||state.busy||state.saving||!!state.clipTrim||!!state.captionGesture;
  $("newTrackType").disabled=$("addTrackBtn").disabled;
  $("reloadBtn").disabled = !has || state.busy || state.saving || !!state.clipTrim;
  $("projectSelect").disabled = state.busy || state.saving || !!state.clipTrim;
  $("projectTitle").disabled = !has;
  $("importBtn").disabled = state.busy;
  $("welcomeImport").disabled = state.busy;
  const preview = previewSource();
  $("fullscreenBtn").hidden = !preview;
  $("fullscreenBtn").disabled = !preview || !document.fullscreenEnabled;
  for (const id of ["previewZoom", "fullscreenZoom", "previewFitBtn", "fullscreenFitBtn"])
    $(id).disabled = !preview;
  updatePreviewZoomButtons();
  $("fullscreenSeek").disabled = !total();
  $("fullscreenSeek").max = total();
  for (const id of [
    "splitBtn",
    "removeClipBtn",
    "setInBtn",
    "setOutBtn",
    "trimStart",
    "trimEnd",
  ])
    $(id).disabled = !clip || state.busy || !!state.clipTrim;
  for (const id of ["splitBtn", "setInBtn", "setOutBtn"])
    $(id).disabled ||= selected() !== previewClip();
  if(selectedAudio()) for(const id of ["removeClipBtn","splitBtn","trimStart","trimEnd"])
    $(id).disabled=state.busy||!!state.clipTrim;
  if(selectedAudio()) {
    const v=selectedAudio(),s=state.project.sources.find(s=>s.id===v.source_id),position=Number($("fullscreenSeek").value);
    for(const id of ['setInBtn','setOutBtn'])$(id).disabled=!!state.clipTrim||position<v.start||position>=v.start+audioTracks.audioDuration(v,s);
  }
  $("detachAudioBtn").disabled=!selected()||!!selectedAudio()||!src?.has_audio||!!state.clipTrim||state.busy||!audioTracks||audioTracks.ownsAudioCaptions(state.project,selected());
  $("moveLeftBtn").disabled = !!selectedAudio() || !clip || timelineTracks.hasFreeVideo(state.project) || state.clip === 0;
  $("moveRightBtn").disabled =
    !!selectedAudio() || !clip || timelineTracks.hasFreeVideo(state.project) || state.clip === state.project.clips.length - 1;
  $("appendBtn").disabled = !src || state.busy;
  $("addVoiceoverBtn").disabled = !src?.has_audio || !total() || state.busy;
  $("addCaptionBtn").disabled = !src || state.busy;
  $("timelineAddCaptionBtn").disabled = !src || state.busy;
  const running = state.jobs.find(
    (j) =>
      j.kind === "transcribe" &&
      j.source_id === state.source &&
      ["queued", "running"].includes(j.status),
  );
  $("transcribeBtn").disabled =
    !src || !src.has_audio || !state.modelsReady || state.busy || !!running;
  $("transcribeBtn").textContent = running
    ? running.status === "queued" ? "✧ 字幕识别排队中…" : "✧ 正在识别人声…"
    : "✧ 识别人声并生成字幕";
  $("recognitionLanguage").disabled = !src || state.busy || !!running;
  $("recognitionTarget").textContent = src?.name || "请先选择素材";
  $("recognitionTarget").title = src?.name || "";
  $("recognitionProgress").hidden = !running;
  $("recognitionProgress").value = running?.progress || 0;
  $("modelHint").textContent = !src
    ? "先选择一个素材，再识别其中完整音轨的人声。"
    : !src.has_audio
      ? "此素材没有音轨，可手动添加字幕。"
      : !state.modelsReady
        ? "字幕模型未下载，请按使用说明运行 cutccc download。"
        : running
          ? running.message || "正在后台识别人声。"
          : state.busy
            ? "当前操作完成后即可识别人声。"
            : "识别完整素材，保留中英文原文，不翻译。疑似遗漏和不确定区间列入待复核清单。";
  const completed = state.jobs.find(j => j.kind === "transcribe" &&
    j.source_id === state.source && j.status === "completed" && j.result);
  $("recognitionResult").hidden = !completed;
  $("recognitionResult").innerHTML = completed
    ? `<div>上次识别 · ${completed.result.subtitle_count || 0} 条字幕</div>${recognitionLinks(completed)}`
    : "";
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
  state.previewContext = null;
  state.project = await api(`/api/projects/${id}`);
  state.clipboardKind = "clip";
  state.selectedVoice = -1;
  state.waveforms.clear();
  state.spectrograms.clear();
  state.clip = state.project.clips.length ? 0 : -1;
  state.source = selected()?.source_id || state.project.sources[0]?.id || null;
  state.jobs = [];
  localStorage.setItem("cutccc-project", id);
  markSaved();
  render();
  if(total())seekOutput(0,false);else setPreview(0);
  await projectOptions();
  await pollJobs();
}
async function saveProject() {
  if (state.clipTrim) return false;
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
  closeSourceMenu();
  const p = state.project;
  $("projectTitle").value = p?.title || "";
  $("sourceCount").textContent = p?.sources.length || 0;
  $("sourceList").innerHTML = p?.sources.length
    ? p.sources
        .map(
          (s) =>
            `<div class="source-card ${s.id === state.source ? "selected" : ""}" data-source="${s.id}" draggable="true" role="button" tabindex="0"><div class="source-image"><img src="${mediaUrl(s.id, "poster")}" alt=""><span class="duration-tag">${time(s.duration)}</span></div><button class="source-menu-button" type="button" data-source-menu="${s.id}" aria-label="${esc(s.name)}：更多操作" aria-haspopup="menu" aria-expanded="false" title="素材操作">⋯</button><div class="source-title"><span>▣</span><strong>${esc(s.name)}</strong></div><div class="source-caption">${s.width} × ${s.height}${s.has_audio ? " · 带音频" : " · 无音轨"}</div></div>`,
        )
        .join("")
    : '<div class="muted empty-library">素材只保存在你的电脑上。<br>导入视频，开始一次剪辑。</div>';
  const preview = previewSource();
  $("welcome").hidden = Boolean(preview);
  $("videoFrame").hidden = !preview;
  $("videoFrame").classList.toggle("audio-only",!!state.audioClock);
  $("previewMeta").textContent = preview
    ? `${preview.width} × ${preview.height} · ${time(preview.duration)}`
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
    $(prefix + "ZoomOut").disabled = !previewSource() || state.previewZoom <= .25;
    $(prefix + "ZoomIn").disabled = !previewSource() || state.previewZoom >= 4;
  }
}
function fitPreview() {
  const s = previewSource();
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
  const audio=selectedAudio();
  if(audio) {
    const s=state.project.sources.find(s=>s.id===audio.source_id),r=audioTracks.audioRange(audio,s);
    $("selectedName").textContent=`音频 · ${s.name}`;
    $("selectedMeta").textContent=`时间轴 ${time(audio.start)} · 时长 ${time(r.end-r.start)}`;
    $("trimStart").value=r.start.toFixed(3);$("trimEnd").value=r.end.toFixed(3);
    $("trimStart").max=$("trimEnd").max=s.duration;return;
  }
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
  for(const audio of $("voiceoverList").querySelectorAll('audio'))audio.pause();
  $("voiceoverList").innerHTML = (p?.voiceovers || [])
    .map((v, i) => {
      const s = p.sources.find((s) => s.id === v.source_id);
      const r=audioTracks.audioRange(v,s);
      return `<div class="subtitle-row ${selectedAudio()===v?'selected':''}" data-voice="${i}"><strong>${esc(s?.name || "音频")}</strong><p class="muted">原素材 ${time(r.start)} – ${time(r.end)}</p>${v.volume === 0 ? '<p class="muted">语音已关闭，保留字幕显示位置。</p>' : ''}<div class="trim-fields"><label>时间轴开始 / 秒<input type="number" min="0" step="0.001" data-voice-field="start" value="${v.start}"></label><label>音量 / 倍<input type="number" min="0" max="2" step="0.1" data-voice-field="volume" value="${v.volume ?? 1}"></label></div><audio controls preload="none" data-preview-voice="${i}" src="${mediaUrl(v.source_id)}" style="width:100%"></audio><div class="voice-actions">${v.volume === 0 ? `<button class="button small" data-restore-voice="${i}">恢复语音</button>` : `<button class="button small" data-remove-voice="${i}">仅移除语音</button>`}<button class="button small" data-remove-voice-all="${i}">移除语音及字幕</button></div></div>`;
    })
    .join("");
  for(const audio of $("voiceoverList").querySelectorAll('audio')) {
    const voice=p.voiceovers[Number(audio.dataset.previewVoice)],source=p.sources.find(s=>s.id===voice.source_id),range=audioTracks.audioRange(voice,source);
    audio.onplay=()=>{pause();if(audio.currentTime<range.start||audio.currentTime>=range.end)audio.currentTime=range.start;};
    audio.ontimeupdate=()=>{if(audio.currentTime>=range.end)audio.pause();};
    audio.onseeked=()=>{if(audio.currentTime<range.start)audio.currentTime=range.start;if(audio.currentTime>=range.end)audio.pause();};
  }
}
function mappedCues() {
  let offset = 0,
    result = [];
  for (const placement of (state.project&&timelineTracks?timelineTracks.videoPlacements(state.project):[])) {
    const c=placement.clip,clipIndex=placement.index;offset=placement.start;
    const d = duration(c);
    for (const [index, cue] of (state.project.subtitles[c.source_id] || []).entries()) {
      if(audioTracks?.ownsAudioCaptions(state.project,c))continue;
      if (cue.timeline_offset !== undefined) continue;
      const a = Math.max(c.start, cue.start),
        b = Math.min(c.end, cue.end, c.start + d);
      if (b > a)
        result.push({
          start: offset + a - c.start,
          end: offset + b - c.start,
          text: cue.text,
          style: cue.style,
          sourceId: c.source_id, index, occurrence: `clip:${clipIndex}:${index}`,trackId:timelineTracks.trackId(cue,'subtitle'),
        });
    }
    offset += d;
  }
  for (const [voiceIndex, voice] of (state.project?.voiceovers || []).entries()) {
    const s = state.project.sources.find(s => s.id === voice.source_id);
    const range=audioTracks.audioRange(voice,s);
    for (const [index, cue] of (state.project.subtitles[voice.source_id] || []).entries()) {
      if (cue.timeline_offset !== undefined) continue;
      const start = Math.max(range.start, cue.start), end = Math.min(cue.end, range.end, total() - voice.start+range.start);
      if (end > start) result.push({start: voice.start + start-range.start, end: voice.start + end-range.start, text: cue.text, style: cue.style,
        sourceId: voice.source_id, index, occurrence: `voice:${voiceIndex}:${index}`,trackId:timelineTracks.trackId(cue,'subtitle')});
    }
  }
  for (const [sourceId, list] of Object.entries(state.project?.subtitles || {})) for (const [index, cue] of list.entries()) {
    if (cue.timeline_offset === undefined) continue;
    result.push({start:cue.start+cue.timeline_offset,end:cue.end+cue.timeline_offset,text:cue.text,style:cue.style,
      sourceId,index,occurrence:`copy:${sourceId}:${index}`,trackId:timelineTracks.trackId(cue,'subtitle')});
  }
  return result.map(cue => {
    const shift = state.project.subtitles[cue.sourceId][cue.index].shift || 0;
    return {...cue, start: Math.max(0, cue.start + shift), end: Math.min(total(), cue.end + shift)};
  }).filter(cue => cue.end > cue.start).sort((a, b) => a.start - b.start);
}
function trackHeader(track) {
  return `<div class="track-row-header ${state.selectedTrack===track.id?'selected':''}" data-track-header><div><span>${esc(track.name)}</span><button type="button" class="track-delete-button" data-delete-track="${esc(track.id)}" title="删除轨道" aria-label="删除${esc(track.name)}">×</button></div></div>`;
}
function trackAtPointer(event,type) {
  const row=document.elementFromPoint(event.clientX,event.clientY)?.closest('[data-track-id]');
  for(const current of $("timelineCanvas").querySelectorAll('.drop-target'))current.classList.remove('drop-target');
  if(row?.dataset.trackType===type){row.classList.add('drop-target');return row;}
  return null;
}
function applyTrackEdit(project,kind,index) {
  const position=Number($("fullscreenSeek").value);pause();state.project=project;state.previewContext=null;state.audioClock=null;
  state.clip=Math.min(state.clip,project.clips.length-1);state.source=project.clips[state.clip]?.source_id||project.sources[0]?.id||null;
  state.subtitleSelection.clear();state.selectedVoice=-1;state.clipboardKind='clip';markDirty();render();
  if(total())seekOutput(Math.min(position,total()),false);else setPreview(0);
  if(kind==='clip')selectTimelineClip(index);else if(kind==='voice')selectAudioTrack(index);
}
function addTimelineTrack(type) {
  if(!state.project||state.busy||state.saving||state.clipTrim||state.captionGesture)return;
  try{const result=timelineTracks.addTrack(state.project,type);state.selectedTrack=result.track.id;applyTrackEdit(result.project);toast(`已添加${result.track.name}。`);}catch(error){toast(error.message,true);}
}
function removeTimelineTrack(id) {
  if(!state.project||state.busy||state.saving||state.clipTrim||state.captionGesture)return;
  const track=timelineTracks.getTracks(state.project).find(t=>t.id===id);if(!track)return;
  const count=timelineTracks.trackItems(state.project,id);
  if(count&&!confirm(`删除“${track.name}”及其中的 ${count} 项素材？\n原始文件保留，可用 Ctrl+Z 撤销。`))return;
  state.selectedTrack=null;applyTrackEdit(timelineTracks.removeTrack(state.project,id));
}
$("addTrackBtn").onclick=()=>addTimelineTrack($("newTrackType").value);
$("timelineCanvas").addEventListener('click',event=>{
  const header=event.target.closest('[data-track-header]');if(!header)return;
  event.stopPropagation();const row=header.closest('[data-track-id]'),remove=event.target.closest('[data-delete-track]');
  if(remove)removeTimelineTrack(remove.dataset.deleteTrack);
  else {state.selectedTrack=row.dataset.trackId;for(const item of $("timelineCanvas").querySelectorAll('[data-track-header]'))item.classList.toggle('selected',item===header);}
});
function renderTrackRows(p,audioHeight) {
  const tracks=timelineTracks?.getTracks(p)||[],placements=p?timelineTracks.videoPlacements(p):[];
  const timelineCues=mappedCues();state.previewCues=timelineCues;
  let videoHeight=0,audioHeightTotal=0,captionHeight=0;
  $("clipTrack").innerHTML=tracks.filter(t=>t.type==='video').map(track=>{
    const height=66+audioHeight;videoHeight+=22+height;
    const blocks=placements.filter(item=>item.trackId===track.id).map(({clip:c,index:i,start})=>{
      const s=p.sources.find(s=>s.id===c.source_id);
      return `<div class="timeline-clip ${i===state.clip?'selected':''}" data-clip="${i}" draggable="true" role="button" tabindex="0" aria-label="片段 ${i+1}：${esc(s.name)}" style="left:${start*state.zoom}px;width:${duration(c)*state.zoom}px"><img src="${mediaUrl(c.source_id,'poster')}" alt=""><span>${i+1} · ${esc(s.name)}</span><small>${time(duration(c))}</small><canvas class="clip-waveform" aria-hidden="true"></canvas><small class="waveform-status">${s.has_audio?'生成波形中…':'无音轨'}</small><canvas class="clip-spectrogram" aria-hidden="true"></canvas><small class="spectrogram-status"></small><span class="clip-resize-handle start" data-resize-clip="start" title="拖动调整素材入点" aria-hidden="true"></span><span class="clip-resize-handle end" data-resize-clip="end" title="拖动调整素材出点" aria-hidden="true"></span></div>`;
    }).join('');
    return `<div class="track-row" data-track-id="${esc(track.id)}" data-track-type="video">${trackHeader(track)}<div class="video-track-content track-content" style="height:${height}px">${blocks||'<div class="timeline-placeholder">将素材拖入视频轨道</div>'}</div></div>`;
  }).join('');
  $("audioTrack").innerHTML=tracks.filter(t=>t.type==='audio').map(track=>{
    const lanes=[];const blocks=(p.voiceovers||[]).map((v,i)=>({v,i})).filter(({v})=>timelineTracks.trackId(v,'audio')===track.id).sort((a,b)=>a.v.start-b.v.start).map(({v,i})=>{
      const s=p.sources.find(s=>s.id===v.source_id),length=audioTracks.audioDuration(v,s);let lane=lanes.findIndex(end=>end<=v.start);if(lane<0)lane=lanes.length;lanes[lane]=v.start+length;
      return `<div class="timeline-clip timeline-audio ${selectedAudio()===v?'selected':''}" data-audio-index="${i}" role="button" tabindex="0" aria-label="音频 ${i+1}：${esc(s.name)}" style="left:${v.start*state.zoom}px;top:${lane*38+3}px;width:${length*state.zoom}px"><span>♫ ${esc(s.name)}</span><canvas class="audio-waveform" aria-hidden="true"></canvas><span class="clip-resize-handle start" data-resize-clip="start" title="拖动调整音频入点" aria-hidden="true"></span><span class="clip-resize-handle end" data-resize-clip="end" title="拖动调整音频出点" aria-hidden="true"></span></div>`;
    }).join('');const height=Math.max(1,lanes.length)*38+7;audioHeightTotal+=22+height;
    return `<div class="track-row" data-track-id="${esc(track.id)}" data-track-type="audio">${trackHeader(track)}<div class="audio-track-content track-content" style="height:${height}px">${blocks||'<div class="timeline-placeholder">将音频拖入此轨道</div>'}</div></div>`;
  }).join('');
  $("captionTrack").innerHTML=tracks.filter(t=>t.type==='subtitle').map(track=>{
    const lanes=[];const blocks=timelineCues.filter(c=>c.trackId===track.id).map(c=>{
      let lane=lanes.findIndex(end=>end<=c.start);if(lane<0)lane=lanes.length;lanes[lane]=c.end;
      return `<div class="caption-block ${state.subtitleSelection.has(`${c.sourceId}:${c.index}`)?'selected':''}" data-caption-occurrence="${c.occurrence}" data-caption-key="${c.sourceId}:${c.index}" role="button" tabindex="0" aria-label="编辑字幕：${esc(c.text)}" style="left:${c.start*state.zoom}px;top:${3+lane*26}px;width:${(c.end-c.start)*state.zoom}px" title="${esc(c.text)}"><span class="caption-resize-handle start" data-resize-caption="start" title="拖动调整字幕开始时间"></span><span class="caption-block-text">${esc(c.text)}</span><span class="caption-resize-handle end" data-resize-caption="end" title="拖动调整字幕结束时间"></span></div>`;
    }).join('');const height=Math.max(1,lanes.length)*26+3;captionHeight+=22+height;
    return `<div class="track-row" data-track-id="${esc(track.id)}" data-track-type="subtitle">${trackHeader(track)}<div class="subtitle-track-content track-content" style="height:${height}px">${blocks}</div></div>`;
  }).join('');
  for(const [id,height] of [['clipTrack',videoHeight],['audioTrack',audioHeightTotal],['captionTrack',captionHeight]]){$(id).hidden=!height;$(id).style.height=`${height}px`;}
  const canvasHeight=26+videoHeight+audioHeightTotal+captionHeight+16;
  $("timelineCanvas").style.height=`${canvasHeight}px`;
  const viewportHeight=Math.min(canvasHeight+12,Math.max(120,Math.min(420,innerHeight*.4)));
  const panel=$("timelineScroll").closest('.timeline-panel');
  const overhead=panel.querySelector('.timeline-toolbar').offsetHeight+panel.querySelector('.audio-view-toolbar').offsetHeight+panel.querySelector('.timeline-footer').offsetHeight+8;
  if($("timelineScroll").style.height!==`${viewportHeight}px`||panel.style.height!==`${viewportHeight+overhead}px`){$("timelineScroll").style.height=`${viewportHeight}px`;panel.style.height=`${viewportHeight+overhead}px`;requestAnimationFrame(fitPreview);}
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
  $("clipCount").textContent = `${p?.clips.length || 0} 段视频${p?.voiceovers?.length?' · '+p.voiceovers.length+' 段音频':''}`;
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
  renderTrackRows(p,parseInt(audioHeight));
  if(Math.abs(scroll.clientWidth-1-viewportWidth)>1)requestAnimationFrame(()=>renderTimeline());
  $("playhead").hidden = !seconds;
  const anchor = playheadX >= 0 && playheadX <= viewportWidth ? playheadX : viewportWidth / 2;
  scroll.scrollLeft = zoom === 0 ? 0 : Math.abs(previousZoom - state.zoom) > .000001
    ? playheadTime * state.zoom - anchor : previousTime * state.zoom;
  ensureWaveforms();
  scheduleWaveformDraw();
}
function ensureWaveforms() {
  const project = state.project;
  if (!project || state.audioView === "spectrogram") return;
  for (const id of new Set([...project.clips,...(project.voiceovers||[])].map(clip => clip.source_id))) {
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
function drawAudioWaveforms() {
  if(!state.project||!audioTracks)return;
  const viewport=$("timelineScroll").getBoundingClientRect();
  for(const block of $("audioTrack").querySelectorAll('[data-audio-index]')) {
    const voice=state.project.voiceovers[Number(block.dataset.audioIndex)],source=state.project.sources.find(s=>s.id===voice.source_id);
    const data=state.waveforms.get(`${state.project.id}:${source.id}`)?.data,canvas=block.querySelector('canvas');
    const rect=block.getBoundingClientRect(),left=Math.max(0,viewport.left-rect.left),right=Math.min(rect.width,viewport.right-rect.left);
    canvas.hidden=right<=left;if(canvas.hidden)continue;
    const width=Math.ceil(right-left),height=20;canvas.width=width;canvas.height=height;canvas.style.left=`${left}px`;canvas.style.width=`${width}px`;
    const ctx=canvas.getContext('2d');ctx.clearRect(0,0,width,height);ctx.fillStyle='#8bdab9';
    if(!data)continue;
    const range=audioTracks.audioRange(voice,source),rate=data.peaks_per_second,gain=1/Math.max(.02,data.peak_max);
    for(let x=0;x<width;x+=2) {
      const a=Math.floor((range.start+(left+x)/state.zoom)*rate),b=Math.min(data.peaks.length,Math.ceil((range.start+(left+x+2)/state.zoom)*rate));
      let peak=0;for(let i=Math.max(0,a);i<b;i++)peak=Math.max(peak,data.peaks[i]);
      const h=Math.sqrt(Math.min(1,peak*gain))*9;ctx.fillRect(x,10-h,1.5,h*2);
    }
  }
}
function drawClipWaveforms() {
  drawAudioWaveforms();
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
            `<div class="subtitle-row ${state.subtitleSelection.has(key) ? "selected" : ""}" data-cue="${i}" data-cue-source="${sourceId}"><div class="subtitle-select-line"><input type="checkbox" data-select-cue="${key}" aria-label="选择字幕 ${i + 1}" ${state.subtitleSelection.has(key) ? "checked" : ""}><span title="${esc(name)}">${String(i + 1).padStart(2, "0")} · ${esc(name)}</span><button class="icon-button" data-remove-cue="${i}" title="删除字幕" aria-label="删除字幕 ${i + 1}">×</button></div><button class="subtitle-open" data-edit-style="${key}" aria-label="编辑字幕 ${i + 1}">${esc(c.text)}</button><div class="subtitle-placement">${placementLabel(key)}</div><div class="subtitle-clock-label">${c.timeline_offset === undefined ? "原素材" : "独立副本 · 参考区间"} ${time(c.start)} – ${time(c.end)}</div></div>`,
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
  state.clipboardKind = "captions";
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
  state.selectedTrack=mapped.trackId;
  state.captionSelectionAnchor = occurrence;
  state.subtitleSelectionProject = state.project.id;
  state.subtitleSelection = new Set([`${mapped.sourceId}:${mapped.index}`]);
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
function commitCaptionMove(context, delta, occurrence, trackId) {
  if (!context || state.project?.id !== context.projectId) return;
  const trackChanged=trackId&&context.entries.some(entry=>timelineTracks.trackId(entry.cue,'subtitle')!==trackId);
  if (Math.abs(delta) >= .000001 || trackChanged) {
    for (const entry of context.entries) {
      const shift = Math.round((entry.shift + delta) * 1e6) / 1e6;
      if (shift) entry.cue.shift = shift; else delete entry.cue.shift;
      if(trackId)entry.cue.track_id=trackId;
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
  state.clipboardKind = "captions";
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
  block.focus({preventScroll:true});
}
function startCaptionGesture(event) {
  if(event.target.closest('[data-track-header]'))return;
  if (event.button !== 0 || !event.isPrimary || !state.project || state.busy || state.saving || state.captionGesture || state.clipTrim) return;
  const block = event.target.closest("[data-caption-occurrence]");
  const edge = event.target.closest("[data-resize-caption]")?.dataset.resizeCaption;
  if (block && (event.ctrlKey || event.metaKey || event.shiftKey)) { event.preventDefault(); return; }
  event.preventDefault();
  state.clipboardKind = "captions";
  (block || $("captionTrack")).focus({preventScroll:true});
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
    const target=trackAtPointer(event,'subtitle');gesture.targetTrack=target?.dataset.trackId;
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
      block.style.transform = `translate(${gesture.delta * state.zoom}px,${gesture.targetTrack?event.clientY-gesture.clientY:0}px)`;
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
      const bounds=block.getBoundingClientRect();const bx=bounds.left-rect.left,by=bounds.top-rect.top+track.scrollTop;
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
    if (gesture.moved) commitCaptionMove(gesture.context, gesture.delta, gesture.occurrence,gesture.targetTrack);
    else openTimelineCaption(gesture.occurrence);
  } else {
    if (!gesture.moved) state.subtitleSelection = gesture.previousSelection;
    renderSubtitles();
    if (!gesture.moved && event) seekTimelineAt(event.clientX);
  }
}
function previewSubtitle(sourceId, index) {
  const cue = state.project.subtitles[sourceId][index];
  const mapped = mappedCues().find(c => c.sourceId === sourceId && c.index === index);
  if (mapped) { seekOutput(mapped.start + Math.min(.05, (mapped.end - mapped.start) / 2), false); return; }
  const voice = (state.project.voiceovers || []).find(v => v.source_id === sourceId);
  const at = cue.start + Math.min(.05, (cue.end - cue.start) / 2);
  pause();
  if (voice) {
    const range=audioTracks.audioRange(voice,state.project.sources.find(s=>s.id===sourceId));
    if(cue.start<range.end&&cue.end>range.start){seekOutput(voice.start + Math.max(0,at-range.start), false); return;}
  }
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
    const copied = entries[0].cue.timeline_offset !== undefined;
    $("captionSourceStart").parentElement.firstChild.textContent = copied ? "副本参考开始 / 秒" : "原素材开始 / 秒";
    $("captionSourceEnd").parentElement.firstChild.textContent = copied ? "副本参考结束 / 秒" : "原素材结束 / 秒";
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
            `<div class="job ${j.status}"><div class="job-head"><span>${j.kind === "export" ? "↗ 视频导出" : "✧ 人声字幕"}</span><span>${labels[j.status]}</span></div>${j.source_id ? `<div class="job-message">${esc(state.project?.sources.find((s) => s.id === j.source_id)?.name || "")}</div>` : ""}<div class="job-message">${esc(j.message)}</div>${["queued", "running"].includes(j.status) ? `<progress max="100" value="${j.progress}"></progress>` : ""}${j.status === "completed" && j.kind === "export" ? `<div class="job-links"><a href="${j.result.video_url}" download>下载视频 ↓</a><a href="${j.result.subtitles_url}" download>字幕 SRT ↓</a></div>` : ""}${recognitionLinks(j)}${j.status === "failed" ? `<a class="quiet-link" href="/api/jobs/${j.id}/log" target="_blank" rel="noopener">查看任务日志 ↗</a>` : ""}</div>`,
        )
        .join("")
    : '<p class="muted">导出的视频会出现在这里。</p>';
  for (const job of state.jobs) {
    if (job.status !== "completed" || job.kind !== "export" || !job.result?.video_url) continue;
    const videoLink = [...$("jobList").querySelectorAll("a")].find(a => a.getAttribute("href") === job.result.video_url);
    if (!videoLink) continue;
    if (job.result.styled_subtitles_url) {
      const link = document.createElement("a");
      link.href = job.result.styled_subtitles_url;
      link.download = "subtitles.ass";
      link.textContent = "样式字幕 ASS ↓";
      videoLink.parentElement.append(link);
    }
    const button = document.createElement("button");
    button.type = "button"; button.className = "job-folder-button";
    button.dataset.openExportFolder = job.id;
    button.textContent = "打开所在文件夹";
    button.title = "在本机文件资源管理器中打开该次导出的目录";
    videoLink.parentElement.append(button);
  }
}
$("jobList").addEventListener("click", async event => {
  const button = event.target.closest("[data-open-export-folder]");
  if (!button || button.disabled) return;
  button.disabled = true;
  try {
    await api(`/api/jobs/${button.dataset.openExportFolder}/open-folder`,"POST",{});
    toast("已打开导出所在文件夹。");
  } catch (error) { toast(error.message,true); }
  finally { button.disabled = false; }
});

function setPlaying(playing) {
  if(playing)for(const audio of $("voiceoverList").querySelectorAll('audio'))audio.pause();
  if(state.audioClock&&playing&&!state.playing)state.audioClock.at=performance.now();
  state.playing = playing;
  for (const id of ["playBtn", "fullscreenPlayBtn"]) {
    $(id).textContent = playing ? "Ⅱ" : "▶";
    $(id).setAttribute("aria-label", playing ? "暂停" : "播放");
  }
  syncTimelineAudio(Number($("fullscreenSeek").value));
}
function pause() {
  if(state.audioClock&&state.playing)state.audioClock.position=Math.min(total(),state.audioClock.position+(performance.now()-state.audioClock.at)/1000);
  setPlaying(false);
  $("video").pause();
}
function syncTimelineAudio(position,force=false) {
  if(!audioTracks||!state.project)return;
  const duck=(state.project.voiceovers||[]).some(v=>!v.detached&&(v.volume??1)>0&&position>=v.start&&position<v.start+audioTracks.audioDuration(v,state.project.sources.find(s=>s.id===v.source_id)));
  const free=timelineTracks?.hasFreeVideo(state.project);
  $("video").volume=(free||state.audioClock||previewClip()?.muted)?0:(duck?0.3:1);
  const active=new Set();
  const entries=(state.project.voiceovers||[]).map((voice,index)=>({voice,id:`voice:${index}`}));
  if(free)for(const p of timelineTracks.videoPlacements(state.project)) {
    const source=state.project.sources.find(s=>s.id===p.clip.source_id);
    if(source.has_audio&&!p.clip.muted)entries.push({id:`video:${p.index}`,voice:{source_id:source.id,start:p.start,source_start:p.clip.start,source_end:Math.min(p.clip.end,p.clip.start+duration(p.clip)),volume:duck?0.3:1}});
  }
  for(const {voice,id} of entries) {
    const key=`${state.project.id}:${id}`,source=state.project.sources.find(s=>s.id===voice.source_id),range=audioTracks.audioRange(voice,source);
    active.add(key);let player=state.audioPlayers.get(key);
    if(!player||player.sourceId!==voice.source_id) {
      player?.element.pause();const element=new Audio(mediaUrl(voice.source_id));element.preload='metadata';
      player={element,sourceId:voice.source_id,pending:false};state.audioPlayers.set(key,player);
    }
    const audio=player.element,inside=position>=voice.start&&position<voice.start+range.end-range.start;
    audio.volume=Math.max(0,Math.min(1,voice.volume??1));
    if(!inside||!state.playing||(voice.volume??1)===0)audio.pause();
    if(inside&&audio.readyState>=1) {
      const desired=range.start+position-voice.start;
      if(force||Math.abs(audio.currentTime-desired)>.18)audio.currentTime=Math.max(range.start,Math.min(range.end,desired));
    }
    if(inside&&state.playing&&(voice.volume??1)>0&&audio.paused&&!player.pending) {
      player.pending=true;audio.play().catch(()=>{}).finally(()=>{player.pending=false;});
    }
  }
  for(const [key,player] of state.audioPlayers)if(!active.has(key)){player.element.pause();state.audioPlayers.delete(key);}
}
function setPreview(at = 0, autoplay = false) {
  if(!state.project?.clips.length&&total()>0){seekOutput(0,autoplay);return;}
  state.audioClock=null;$("videoFrame").classList.remove('audio-only');
  const wasDetached = !!state.previewContext;
  state.previewContext = null;
  if (wasDetached) render();
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
function selectTimelineClip(index, renderAll = true) {
  const clip = state.project?.clips[index];
  if (!clip) return;
  state.previewContext ||= {clip: previewClip(), sourceId: state.source};
  state.clip = index;
  state.selectedTrack=timelineTracks.trackId(clip,'video');
  state.source = clip.source_id;
  if (state.previewContext.clip === clip) state.previewContext = null;
  state.clipboardKind = "clip";
  state.subtitleSelection.clear();
  if (renderAll) render();
  else {
    for (const block of $("clipTrack").querySelectorAll("[data-clip]"))
      block.classList.toggle("selected", Number(block.dataset.clip) === index);
    for (const card of $("sourceList").querySelectorAll("[data-source]"))
      card.classList.toggle("selected", card.dataset.source === state.source);
    renderInspector(); renderSubtitles(); updateButtons();
  }
}
function seekTimelineAt(clientX) {
  const left = $("timelineCanvas").getBoundingClientRect().left;
  seekOutput((clientX - left) / state.zoom, false);
}
function selectClip(index, at, autoplay = false) {
  if (!state.project?.clips[index]) return;
  if (!autoplay) pause();
  else setPlaying(true);
  state.clip = index;
  state.source = selected().source_id;
  render();
  state.pendingOutputSeek = timelineTracks.videoPlacements(state.project)[index].start +
    Math.max(0,Math.min((at ?? selected().start)-selected().start,duration(selected())));
  setPreview(at ?? selected().start, autoplay);
}
function seekOutput(seconds, autoplay = state.playing) {
  if (!Number.isFinite(seconds) || !state.project || !total()) return;
  const position = Math.max(0, Math.min(seconds, total()));
  const placement=timelineTracks.videoAtTime(state.project,position===total()?Math.max(0,position-1/30):position);
  if(!placement) {
    pause();state.audioClock={position,at:performance.now()};state.outputEndSelected=position===total();
    state.pendingOutputSeek=null;$("fullscreenSeek").value=position;$("videoFrame").classList.add('audio-only');
    setPlaying(autoplay);syncTimelineAudio(position,true);followPlayhead(position,true);return;
  }
  const {index,clip,start:offset}=placement;
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
      syncTimelineAudio(position,true);
      followPlayhead(position,true);
      return;
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
    !total() ||
    state.timelineScrub || state.clipTrim
  )
    return;
  event.preventDefault();
  event.stopPropagation();
  const target = event.currentTarget;
  const left = $("playhead").getBoundingClientRect().left;
  state.timelineScrub = {
    pointerId: event.pointerId,
    target,
    grabOffset: target === $("ruler") ? 0 : event.clientX - left,
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
  if(state.audioClock) {
    if(state.playing)pause();else if(state.outputEndSelected)seekOutput(0,true);else setPlaying(true);
    return;
  }
  if (!previewClip()) {
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
  const c = previewClip();
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
  const placement=timelineTracks.videoPlacements(state.project)[previewClipIndex()];
  const position=placement?.end??total();
  if(position<total()-1e-8)seekOutput(position,true);
  else {
    pause();
    state.outputEndSelected = true;
    followPlayhead(total(),true);
  }
}
function followPlayhead(position, force = false) {
  if (!timelineNavigation || (!state.playing && !force) || state.captionGesture || state.clipTrim || state.timelineScrub || state.seekDragging) return;
  const scroll = $("timelineScroll");
  const left = timelineNavigation.followScrollLeft(position,state.zoom,scroll.scrollLeft,scroll.clientWidth,scroll.scrollWidth);
  if (Math.abs(left-scroll.scrollLeft) > .5) scroll.scrollLeft = left;
}
function stepTimelineFrame(direction) {
  if (!total() || state.busy || state.captionGesture || state.clipTrim || state.timelineScrub || state.seekDragging || !timelineNavigation) return;
  const clip = previewClip();
  // Paused media may be clamped before a fractional trim endpoint; the edit playhead remains authoritative.
  let position = state.outputEndSelected ? total() : Number($("fullscreenSeek").value);
  if (clip && state.playing && !$("video").paused && !state.switching && !$("video").seeking)
    position = timelineTracks.videoPlacements(state.project)[previewClipIndex()].start +
      Math.max(0, Math.min($("video").currentTime-clip.start,duration(clip)));
  if (state.pendingOutputSeek !== null) position = state.pendingOutputSeek;
  pause();
  const next = timelineNavigation.stepFrameTime(position,direction,total());
  seekOutput(next,false);
  $("fullscreenSeek").value = next;
  followPlayhead(next,true);
}
function tick() {
  const video = $("video");
  let c = previewClip();
  if (
    state.playing &&
    c && !state.audioClock &&
    !state.switching &&
    !video.seeking &&
    video.currentTime >= c.end - 0.012
  )
    nextClip();
  c = previewClip();
  const current = video.currentTime || 0;
  $("sourceClock").textContent = `素材 ${time(current)}`;
  let offset = 0;
  if (state.project && c) {
    offset =
      (timelineTracks.videoPlacements(state.project)[previewClipIndex()]?.start||0) +
      Math.max(0, Math.min(current - c.start, duration(c)));
  }
  if(state.audioClock) {
    offset=Math.min(total(),state.audioClock.position+(state.playing?(performance.now()-state.audioClock.at)/1000:0));
    if(state.playing&&offset>=total()){pause();state.audioClock.position=total();state.outputEndSelected=true;}
  }
  if(state.playing&&!state.switching&&!video.seeking) {
    const visible=timelineTracks.videoAtTime(state.project,offset);
    if(visible&& (state.audioClock||visible.index!==previewClipIndex())){seekOutput(offset,true);c=previewClip();}
  }
  if (state.outputEndSelected && !state.playing) offset = total();
  if (state.timelineScrub) offset = state.timelineScrub.position;
  else if (state.seekDragging) offset = Number($("fullscreenSeek").value);
  else if ((state.switching||video.seeking) && state.pendingOutputSeek !== null)
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
  syncTimelineAudio(offset);
  followPlayhead(offset);
  $("playheadHandle").setAttribute("aria-valuemax", total());
  $("playheadHandle").setAttribute("aria-valuenow", offset);
  $("playheadHandle").setAttribute("aria-valuetext", time(offset));
  const captionTime = state.outputEndSelected ? Math.max(0, total() - 1 / 30) : offset;
  const cues = c||state.audioClock ? (state.previewCues ||= mappedCues()).filter(cue => cue.start <= captionTime && captionTime < cue.end)
    : (state.project?.subtitles[previewSource()?.id] || []).filter(cue => cue.timeline_offset === undefined && cue.start <= current && current < cue.end);
  renderCaptionPreview(cues);
  requestAnimationFrame(tick);
}
function updateRange(start, end) {
  if(selectedAudio()) {
    const v=selectedAudio(),s=state.project.sources.find(s=>s.id===v.source_id);
    if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end>s.duration||end-start<1/30){toast('请设置音频范围内的入点和出点，至少保留一帧。',true);renderInspector();return;}
    v.source_start=start;v.source_end=end;v.detached=true;markDirty();render();return;
  }
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
function startClipTrim(event) {
  const handle = event.target.closest("[data-resize-clip]");
  const audioBlock=event.target.closest('[data-audio-index]');
  if ((!handle&&!audioBlock) || event.button !== 0 || !event.isPrimary) return;
  event.preventDefault(); event.stopPropagation();
  if (state.busy || state.saving || state.clipTrim || state.captionGesture || state.timelineScrub) return;
  const isAudio=!!audioBlock,index=Number(isAudio?audioBlock.dataset.audioIndex:handle.closest("[data-clip]").dataset.clip);
  const context = isAudio ? handle?audioTracks.audioResizeContext(state.project,index,handle.dataset.resizeClip):
    {projectId:state.project.id,index,voice:{...state.project.voiceovers[index]},edge:'move'} :
    captionTiming?.clipResizeContext(state.project, index, handle.dataset.resizeClip);
  if (!context) return;
  pause();
  const overlay = document.createElement("div");
  overlay.className = "caption-move-label"; overlay.hidden = true; document.body.append(overlay);
  state.clipTrim = {context,isAudio,target:isAudio?$("audioTrack"):$("clipTrack"), original: isAudio?state.project.voiceovers[index]:state.project.clips[index], pointerId: event.pointerId,
    clientX: event.clientX,clientY:event.clientY, scrollLeft: $("timelineScroll").scrollLeft, zoom: state.zoom,
    range: isAudio?context.voice:context.clip, moved: false, overlay};
  // Keep the pressed handle in the DOM and disable native reordering for this gesture.
  if(isAudio)selectAudioTrack(index,false);
  else {handle.closest("[data-clip]").draggable = false;selectTimelineClip(index, false);}
  state.clipTrim.target.setPointerCapture(event.pointerId);
}
function moveClipTrim(event) {
  const gesture = state.clipTrim;
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  event.preventDefault();
  const dx = event.clientX - gesture.clientX + $("timelineScroll").scrollLeft - gesture.scrollLeft;
  if (Math.hypot(dx,gesture.isAudio&&gesture.context.edge==='move'?event.clientY-gesture.clientY:0) >= 3) gesture.moved = true;
  if (!gesture.moved) return;
  if(gesture.isAudio) {
    const context=gesture.context,delta=Math.round(dx/gesture.zoom*30)/30;
    gesture.range=context.edge==='move'?{...context.voice,start:Math.max(0,Math.min(86400-audioTracks.audioDuration(context.voice,state.project.sources.find(s=>s.id===context.voice.source_id)),context.voice.start+delta))}:
      audioTracks.resizedAudioClip(context,delta);
    const target=context.edge==='move'?trackAtPointer(event,'audio'):null;
    if(target)gesture.range.track_id=target.dataset.trackId;
    const block=$("audioTrack").querySelector(`[data-audio-index="${context.index}"]`),source=state.project.sources.find(s=>s.id===context.voice.source_id),range=audioTracks.audioRange(gesture.range,source);
    if(block){block.style.left=`${gesture.range.start*gesture.zoom}px`;block.style.width=`${(range.end-range.start)*gesture.zoom}px`;block.classList.add('is-trimming');if(context.edge==='move')block.style.pointerEvents='none';}
    gesture.overlay.hidden=false;gesture.overlay.textContent=`音频 ${time(gesture.range.start)} · 入点 ${time(range.start)} · 出点 ${time(range.end)}`;
    gesture.overlay.style.left=`${Math.max(8,Math.min(innerWidth-340,event.clientX+12))}px`;gesture.overlay.style.top=`${Math.max(8,event.clientY-34)}px`;
    $("timelineCanvas").style.width=`${Math.max(total(),gesture.range.start+range.end-range.start)*gesture.zoom}px`;return;
  }
  gesture.range = captionTiming.resizedClipRange(gesture.context, Math.round(dx / gesture.zoom * 30) / 30);
  const block = $("clipTrack").querySelector(`[data-clip="${gesture.context.index}"]`);
  if (block) {
    block.classList.add("is-trimming");
    block.style.width = `${duration(gesture.range) * gesture.zoom}px`;
    if(gesture.range.timeline_start!==undefined)block.style.left=`${gesture.range.timeline_start*gesture.zoom}px`;
    block.querySelector("small").textContent = time(duration(gesture.range));
  }
  const seconds = gesture.range.timeline_start!==undefined?Math.max(gesture.context.total,gesture.range.timeline_start+duration(gesture.range)):
    gesture.context.total - duration(gesture.context.clip) + duration(gesture.range);
  $("timelineCanvas").style.width = `${Math.max(seconds * gesture.zoom, $("timelineScroll").clientWidth - 1)}px`;
  gesture.overlay.hidden = false;
  gesture.overlay.textContent = `入点 ${time(gesture.range.start)} · 出点 ${time(gesture.range.end)} · 时长 ${time(duration(gesture.range))}`;
  gesture.overlay.style.left = `${Math.max(8, Math.min(innerWidth - 340, event.clientX + 12))}px`;
  gesture.overlay.style.top = `${Math.max(8, event.clientY - 34)}px`;
}
function finishClipTrim(event, cancel = false) {
  const gesture = state.clipTrim;
  if (!gesture || (event && event.pointerId !== gesture.pointerId)) return;
  if (event?.type === "pointerup") moveClipTrim(event);
  state.clipTrim = null;
  gesture.overlay.remove();
  const track = gesture.target;
  if (track.hasPointerCapture(gesture.pointerId)) track.releasePointerCapture(gesture.pointerId);
  state.suppressClipClick = true;
  setTimeout(() => { state.suppressClipClick = false; }, 0);
  const context = gesture.context, range = gesture.range;
  const current = state.project?.id === context.projectId && (gesture.isAudio?state.project.voiceovers[context.index]:state.project.clips[context.index]);
  const changed = JSON.stringify(range)!==JSON.stringify(gesture.isAudio?context.voice:context.clip);
  if (!cancel && event?.type !== "pointercancel" && current === gesture.original && gesture.moved && changed) {
    Object.assign(current, range);
    markDirty();
    render();
    if(gesture.isAudio){seekOutput(range.start,false);return;}
    const offset = timelineTracks.videoPlacements(state.project)[context.index].start;
    seekOutput(offset + (context.edge === "start" ? 0 : Math.max(0, duration(range) - 1 / 30)), false);
  } else render();
}
function splitClip() {
  if(selectedAudio()) {
    if(state.project.voiceovers.length>=32){toast('音频片段数量已达到上限。',true);return;}
    const v=selectedAudio(),s=state.project.sources.find(s=>s.id===v.source_id),r=audioTracks.audioRange(v,s),at=Number($("fullscreenSeek").value)-v.start;
    if(at<1/30||r.end-r.start-at<1/30){toast('请将播放头移到音频片段内部再分割。',true);return;}
    pause();state.project.voiceovers.splice(state.selectedVoice,1,{...v,source_start:r.start,source_end:r.start+at,detached:true},
      {...v,start:v.start+at,source_start:r.start+at,source_end:r.end,detached:true});markDirty();render();return;
  }
  const c = selected(),
    at = $("video").currentTime;
  if (!c || c !== previewClip() || at - c.start < 1 / 30 || c.end - at < 1 / 30) {
    toast("请将播放头移到片段内部再分割。", true);
    return;
  }
  pause();
  state.previewContext = null;
  state.project.clips.splice(
    state.clip,
    1,
    { ...c, end: at },
    { ...c, start: at,...(c.timeline_start!==undefined?{timeline_start:c.timeline_start+duration({...c,end:at})}:{}) },
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
  if(selectedAudio()) {
    const position=Number($("fullscreenSeek").value);pause();state.project=audioTracks.removeAudioClip(state.project,state.selectedVoice);
    state.selectedVoice=-1;state.clipboardKind='clip';markDirty();render();if(total())seekOutput(Math.min(position,total()),false);return;
  }
  if (!selected()) return;
  pause();
  state.project.clips.splice(state.clip, 1);
  state.clip = Math.min(state.clip, state.project.clips.length - 1);
  if (selected()) state.source = selected().source_id;
  markDirty();
  render();
  if (selected()) setPreview(selected().start);
  else if(total())seekOutput(Math.min(Number($("fullscreenSeek").value),total()),false);
}
function selectAudioTrack(index,renderAll=true) {
  if(!state.project?.voiceovers[index])return;
  state.previewContext ||= {clip:previewClip(),sourceId:previewSource()?.id||state.source};
  state.source=state.project.voiceovers[index].source_id;
  state.selectedTrack=timelineTracks.trackId(state.project.voiceovers[index],'audio');
  state.clipboardKind='voice';state.selectedVoice=index;state.subtitleSelection.clear();
  if(renderAll)render();else {for(const block of $("audioTrack").querySelectorAll('[data-audio-index]'))block.classList.toggle('selected',Number(block.dataset.audioIndex)===index);renderInspector();renderVoiceovers();updateButtons();}
  document.querySelector('[data-tab="clip"]').click();
}
function detachSelectedAudio() {
  try {
    const position=Number($("fullscreenSeek").value),index=state.clip;pause();
    const result=audioTracks.detachClipAudio(state.project,index);
    state.project=result.project;state.previewContext=null;state.selectedVoice=-1;state.clipboardKind='clip';
    markDirty();render();seekOutput(position,false);selectTimelineClip(index);toast('音频已分离，可在音频轨单独移动、裁剪或删除。');
    return result.index;
  }catch(error){toast(error.message,true);return -1;}
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
  if (state.project?.id !== id || state.busy || state.saving || state.captionGesture || state.clipTrim) return;
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
  const menuButton=e.target.closest('[data-source-menu]');
  if(menuButton){const r=menuButton.getBoundingClientRect();openSourceMenu(menuButton.dataset.sourceMenu,r.right,r.bottom,menuButton);return;}
  if(state.busy||state.saving||state.clipTrim||state.captionGesture)return;
  const card = e.target.closest("[data-source]");
  if (!card) return;
  state.clipboardKind = "clip"; state.subtitleSelection.clear();
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
  if(e.target.closest('[data-source-menu]'))return;
  if(e.key==='ContextMenu'||(e.shiftKey&&e.key==='F10')) {
    const card=e.target.closest('[data-source]');if(!card)return;
    e.preventDefault();const r=card.getBoundingClientRect();openSourceMenu(card.dataset.source,r.left+12,r.top+12,card);return;
  }
  if (e.key === "Enter"||e.code==='Space'){e.preventDefault();e.target.click();}
};
$("sourceList").oncontextmenu=event=>{
  const card=event.target.closest('[data-source]');if(!card)return;
  event.preventDefault();openSourceMenu(card.dataset.source,event.clientX,event.clientY,card);
};
function closeSourceMenu(restoreFocus=false) {
  if(!state.sourceMenu&&$("sourceContextMenu").hidden)return;
  const previous=state.sourceMenu;state.sourceMenu=null;
  $("sourceContextMenu").hidden=true;
  for(const button of $("sourceList").querySelectorAll('[data-source-menu]'))button.setAttribute('aria-expanded','false');
  if(restoreFocus&&previous?.trigger?.isConnected)previous.trigger.focus({preventScroll:true});
}
function openSourceMenu(sourceId,x,y,trigger) {
  const source=state.project?.sources.find(s=>s.id===sourceId);if(!source)return;
  closeSourceMenu();state.sourceMenu={projectId:state.project.id,sourceId,trigger};
  const menu=$("sourceContextMenu"),activeJob=state.jobs.some(j=>['queued','running'].includes(j.status));
  $("sourceMenuName").textContent=source.name;$("sourceMenuName").title=source.name;
  $("removeSourceBtn").disabled=state.busy||state.saving||!!state.clipTrim||!!state.captionGesture||activeJob;
  $("sourceMenuHint").textContent=activeJob?'请等待当前工程任务完成后再移除':state.busy||state.saving||state.clipTrim||state.captionGesture?'请先完成当前操作':'原始文件保留';
  trigger?.closest('[data-source]')?.querySelector('[data-source-menu]')?.setAttribute('aria-expanded','true');
  menu.hidden=false;menu.style.left=`${Math.max(8,Math.min(x,innerWidth-menu.offsetWidth-8))}px`;
  menu.style.top=`${Math.max(8,Math.min(y,innerHeight-menu.offsetHeight-8))}px`;
  if(!$("removeSourceBtn").disabled)$("removeSourceBtn").focus({preventScroll:true});
}
async function removeLibrarySource() {
  const menu=state.sourceMenu;if(!menu||$("removeSourceBtn").disabled)return;
  if(state.jobs.some(j=>['queued','running'].includes(j.status))){closeSourceMenu(true);toast('请等待当前工程任务完成后再移除素材。',true);return;}
  const p=state.project,source=p.sources.find(s=>s.id===menu.sourceId);if(!source||p.id!==menu.projectId)return;
  const clips=p.clips.filter(c=>c.source_id===source.id).length,voices=(p.voiceovers||[]).filter(v=>v.source_id===source.id).length,cues=(p.subtitles[source.id]||[]).length;
  const usage=clips||voices?`此素材被 ${clips} 段视频、${voices} 段音频使用。\n移除时会一并移除这些片段及 ${cues} 条字幕。\n`:`将从工程移除此素材${cues?`及 ${cues} 条字幕`:''}。\n`;
  closeSourceMenu(true);
  if(!confirm(`从工程移除“${source.name}”？\n\n${usage}磁盘原文件保留。此操作会重置当前撤销记录。`))return;
  try {
    if(!(await saveProject())||state.project?.id!==menu.projectId)return;
    if(state.dirty){toast('仍有新的编辑，请保存后再移除素材。',true);return;}
    pause();busy('正在从工程移除素材…');
    const sent=JSON.stringify(editSnapshot()),position=Number($("fullscreenSeek").value);
    const result=await api(`/api/projects/${menu.projectId}/sources/${source.id}`,'DELETE',{revision:state.project.revision,remove_used:!!(clips||voices)});
    if(state.project?.id!==menu.projectId)return;
    const incoming=editSnapshot(),changed=JSON.stringify(incoming)!==sent;
    state.project=result;state.previewContext=null;state.audioClock=null;state.selectedVoice=-1;state.clipboardKind='clip';state.subtitleSelection.clear();
    state.clip=result.clips.length?0:-1;state.source=result.clips[0]?.source_id||result.sources[0]?.id||null;
    markSaved();
    if(changed){state.project.title=incoming.title;state.project.clips=incoming.clips.filter(c=>c.source_id!==source.id);state.project.voiceovers=incoming.voiceovers.filter(v=>v.source_id!==source.id);state.project.subtitles=Object.fromEntries(result.sources.map(s=>[s.id,incoming.subtitles[s.id]||[]]));if(incoming.tracks==null)delete state.project.tracks;else state.project.tracks=incoming.tracks;markDirty();}
    state.clip=state.project.clips.length?0:-1;state.source=state.project.clips[0]?.source_id||state.project.sources[0]?.id||null;
    render();if(total())seekOutput(Math.min(position,total()),false);else setPreview(0);
    await projectOptions();toast('素材已从工程移除，原始文件保留。');
  }catch(error){toast(error.message,true);}
  finally{busy();}
}
$("removeSourceBtn").onclick=removeLibrarySource;
$("sourceContextMenu").onkeydown=event=>{
  event.stopPropagation();
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeSourceMenu(true);}
  else if(['ArrowDown','ArrowUp','Home','End','Tab'].includes(event.key)){event.preventDefault();if(event.key==='Tab')closeSourceMenu(true);else $("removeSourceBtn").focus();}
};
document.addEventListener('keydown',event=>{
  if(!state.sourceMenu)return;
  event.stopImmediatePropagation();
  if(['Escape','Tab'].includes(event.key)){event.preventDefault();closeSourceMenu(true);}
  else if(['Enter',' '].includes(event.key)){event.preventDefault();$("removeSourceBtn").click();}
  else if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','Delete'].includes(event.key))event.preventDefault();
});
document.addEventListener('pointerdown',event=>{if(state.sourceMenu&&!event.target.closest('#sourceContextMenu,[data-source-menu]'))closeSourceMenu();},true);
document.addEventListener('scroll',()=>closeSourceMenu(),true);
window.addEventListener('blur',()=>closeSourceMenu());
window.addEventListener('resize',()=>closeSourceMenu());
$("clipTrack").onclick = (e) => {
  if (state.suppressClipClick || e.target.closest("[data-resize-clip]")) return;
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
  selectTimelineClip(Number(clip.dataset.clip));
};
$("clipTrack").onkeydown = (e) => {
  if (e.key === "Enter") {
    const clip = e.target.closest("[data-clip]");
    if (clip) { e.preventDefault(); selectTimelineClip(Number(clip.dataset.clip)); }
  }
};
$("clipTrack").ondragstart = (e) => {
  if (state.timelineScrub || state.clipTrim || e.target.closest("[data-resize-clip]")) {
    e.preventDefault();
    return;
  }
  const clip = e.target.closest("[data-clip]");
  if (clip) {
    e.dataTransfer.setData("text/x-cutccc-clip", clip.dataset.clip);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData('text/x-cutccc-grab',String((e.clientX-clip.getBoundingClientRect().left)/state.zoom));
    e.dataTransfer.setData('text/x-cutccc-project',state.project.id);
  }
};
$("sourceList").ondragstart=event=>{
  const card=event.target.closest('[data-source]');if(!card||event.target.closest('[data-source-menu]')){event.preventDefault();return;}
  event.dataTransfer.setData('text/x-cutccc-source',card.dataset.source);event.dataTransfer.setData('text/x-cutccc-project',state.project.id);event.dataTransfer.effectAllowed='copy';
};
$("timelineCanvas").addEventListener('dragover',event=>{
  if(![...event.dataTransfer.types].some(t=>['text/x-cutccc-clip','text/x-cutccc-source'].includes(t)))return;
  const row=event.target.closest('[data-track-id]');if(!row||row.dataset.trackType==='subtitle')return;
  event.preventDefault();for(const current of $("timelineCanvas").querySelectorAll('.drop-target'))current.classList.remove('drop-target');row.classList.add('drop-target');
});
$("timelineCanvas").addEventListener('drop',event=>{
  const row=event.target.closest('[data-track-id]'),types=[...event.dataTransfer.types];
  if(!row||!types.some(t=>['text/x-cutccc-clip','text/x-cutccc-source'].includes(t)))return;
  event.preventDefault();event.stopPropagation();
  for(const current of $("timelineCanvas").querySelectorAll('.drop-target'))current.classList.remove('drop-target');
  if(state.busy||state.saving||state.clipTrim||state.captionGesture)return;
  const projectId=event.dataTransfer.getData('text/x-cutccc-project');if(projectId&&projectId!==state.project.id){toast('请先将素材导入当前工程。',true);return;}
  const at=Math.max(0,(event.clientX-$("timelineCanvas").getBoundingClientRect().left)/state.zoom);
  try {
    const sid=event.dataTransfer.getData('text/x-cutccc-source');
    if(sid){const result=timelineTracks.insertSourceOnTrack(state.project,sid,row.dataset.trackId,at);applyTrackEdit(result.project,result.kind,result.index);return;}
    const raw=event.dataTransfer.getData('text/x-cutccc-clip'),index=Number(raw);if(raw===''||!Number.isInteger(index)||!state.project.clips[index])return;
    const target=event.target.closest('[data-clip]');
    if(row.dataset.trackType==='video'&&!timelineTracks.hasFreeVideo(state.project)&&target&&timelineTracks.trackId(state.project.clips[index],'video')===row.dataset.trackId){selectTimelineClip(index);moveClip(Number(target.dataset.clip));return;}
    const grab=Number(event.dataTransfer.getData('text/x-cutccc-grab'))||0;
    applyTrackEdit(timelineTracks.moveVideoToTrack(state.project,index,row.dataset.trackId,at-grab),'clip',index);
  }catch(error){toast(error.message,true);}
});
document.addEventListener('dragend',()=>{for(const row of $("timelineCanvas").querySelectorAll('.drop-target'))row.classList.remove('drop-target');});
$("clipTrack").addEventListener("pointerdown", startClipTrim);
$("clipTrack").addEventListener("lostpointercapture", event => finishClipTrim(event, true));
$("audioTrack").addEventListener("pointerdown", startClipTrim);
$("audioTrack").addEventListener("lostpointercapture",event=>finishClipTrim(event,true));
$("audioTrack").onclick=event=>{if(state.suppressClipClick)return;const block=event.target.closest('[data-audio-index]');if(block)selectAudioTrack(Number(block.dataset.audioIndex));};
$("audioTrack").onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();const block=event.target.closest('[data-audio-index]');if(block)selectAudioTrack(Number(block.dataset.audioIndex));}};
document.addEventListener("pointermove", moveClipTrim);
document.addEventListener("pointerup", finishClipTrim);
document.addEventListener("pointercancel", event => finishClipTrim(event, true));
window.addEventListener("blur", () => finishClipTrim(null, true));
$("playBtn").onclick = togglePlay;
for (const target of [$("playhead"), $("playheadHandle"), $("ruler")]) {
  target.addEventListener("pointerdown", startTimelineScrub);
  target.addEventListener("lostpointercapture", finishTimelineScrub);
}
document.addEventListener("pointermove", scrubTimeline);
document.addEventListener("pointerup", finishTimelineScrub);
document.addEventListener("pointercancel", finishTimelineScrub);
$("playheadHandle").onclick = (event) => event.stopPropagation();
$("playhead").onclick = (event) => event.stopPropagation();
$("timelineCanvas").addEventListener("click", event => {
  if (state.suppressClipClick || event.defaultPrevented || event.target.closest("[data-track-header], [data-clip], [data-audio-index], [data-caption-occurrence], #captionTrack, #ruler, #playheadHandle")) return;
  seekTimelineAt(event.clientX);
});
$("playheadHandle").ondragstart = (event) => event.preventDefault();
$("playheadHandle").onkeydown = (event) => {
  if (["ArrowLeft","ArrowRight"].includes(event.key) && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault(); event.stopPropagation(); stepTimelineFrame(event.key === "ArrowLeft" ? -1 : 1); return;
  }
  let position = Number($("fullscreenSeek").value);
  if (event.key === "Home") position = 0;
  else if (event.key === "End") position = total();
  else if (event.key === "ArrowLeft") position -= event.shiftKey ? 1 : 1 / 30;
  else if (event.key === "ArrowRight") position += event.shiftKey ? 1 : 1 / 30;
  else return;
  event.preventDefault();
  event.stopPropagation();
  seekOutput(position,false);
  followPlayhead(Math.max(0,Math.min(total(),position)),true);
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
$("detachAudioBtn").onclick=detachSelectedAudio;
$("removeClipBtn").onclick = removeClip;
$("trimStart").onchange = () =>
  updateRange(Number($("trimStart").value), Number($("trimEnd").value));
$("trimEnd").onchange = $("trimStart").onchange;
$("setInBtn").onclick = () =>
  selectedAudio()?setAudioRangeAtPlayhead('start'):selected() && updateRange($("video").currentTime, selected().end);
$("setOutBtn").onclick = () =>
  selectedAudio()?setAudioRangeAtPlayhead('end'):selected() && updateRange(selected().start, $("video").currentTime);
function setAudioRangeAtPlayhead(edge) {
  const v=selectedAudio(),s=state.project.sources.find(s=>s.id===v.source_id),r=audioTracks.audioRange(v,s),at=r.start+Number($("fullscreenSeek").value)-v.start;
  if(edge==='start')updateRange(at,r.end);else updateRange(r.start,at);
}
$("moveLeftBtn").onclick = () => moveClip(state.clip - 1);
$("moveRightBtn").onclick = () => moveClip(state.clip + 1);
$("appendBtn").onclick = () => {
  const s = source();
  if (!s) return;
  if(timelineTracks.hasFreeVideo(state.project)){
    try{const track=timelineTracks.getTracks(state.project).find(t=>t.id===state.selectedTrack&&t.type==='video')||timelineTracks.getTracks(state.project).find(t=>t.type==='video');
      const result=timelineTracks.insertSourceOnTrack(state.project,s.id,track.id,audioTracks.videoDuration(state.project));applyTrackEdit(result.project,result.kind,result.index);
    }catch(error){toast(error.message,true);}return;
  }
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
  renderInspector();updateButtons();
};
$("voiceoverList").addEventListener("pointerdown", event => {
  const row = event.target.closest("[data-voice]");
  if (!row) return;
  state.clipboardKind = "voice"; state.selectedVoice = Number(row.dataset.voice);renderInspector();updateButtons();
  for (const item of $("voiceoverList").querySelectorAll("[data-voice]")) item.classList.toggle("selected", item === row);
});
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
    state.clipboardKind = "captions";
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
  state.clipboardKind = "captions";
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
    const cues = state.project.subtitles[sourceId].filter(c=>c.timeline_offset===undefined), source = state.project.sources.find(s => s.id === sourceId);
    const originalIndex = cues.indexOf(cue);
    const low = field === "start" ? (originalIndex>=0 ? cues[originalIndex - 1]?.end ?? 0 : 0) : cue.start + 1 / 30;
    const high = field === "start" ? cue.end - 1 / 30 : (originalIndex>=0 ? cues[originalIndex + 1]?.start ?? source.duration : source.duration);
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
  state.clipboardKind = "captions";
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
  let cues = state.project.subtitles[s.id];
  const clip = selected();
  const audio=selectedAudio(),range=audio?audioTracks.audioRange(audio,s):null,position=Number($("fullscreenSeek").value);
  if(audio&&(position<audio.start||position>=audio.start+range.end-range.start)){toast('请将播放头移到选中音频片段内部。',true);return;}
  const limit = audio?range.end:clip?.source_id === s.id ? clip.end : s.duration;
  const requested = audio?range.start+position-audio.start:Math.max($("video").currentTime, clip?.start || 0);
  let target=timelineTracks.getTracks(state.project).find(t=>t.id===state.selectedTrack&&t.type==='subtitle')||timelineTracks.getTracks(state.project).find(t=>t.type==='subtitle');
  const independent=state.project.tracks!==undefined||!target;
  const originals = independent?[]:cues.filter(c=>c.timeline_offset===undefined);
  let start = requested;
  for (const c of originals) if (start >= c.start && start < c.end) start = c.end;
  const next = originals.find((c) => c.start >= start),
    end = Math.min(start + 2, next?.start ?? limit, limit);
  if (end - start < 0.05) {
    toast("当前位置没有可用的字幕间隙，请移动播放头。", true);
    return;
  }
  const cue = { start, end:independent?Math.min(end,start+Math.max(0,total()-position)):end, text: "新字幕",...(independent?{timeline_offset:position-start}:{}) };
  if(cue.end-cue.start<.05){toast('当前位置没有可用的字幕时长。',true);return;}
  if(!target){try{const added=timelineTracks.addTrack(state.project,'subtitle');state.project=added.project;target=added.track;state.previewContext=null;cues=state.project.subtitles[s.id];}catch(error){toast(error.message,true);return;}}
  cue.track_id=target.id;
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
    if (!(await saveProject())) return;
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
  return $("exportPreset").value === "feishu" ? {preset:"feishu"} :
    {preset:"standard",fps: Number($("exportFps").value), resolution: $("exportResolution").value, quality: $("exportQuality").value};
}
async function updateExportEstimate() {
  const { exportProfile } = await exportOptionsReady;
  const source = state.project?.sources.find(s => s.id === (state.project.clips[0]?.source_id||state.project.voiceovers?.[0]?.source_id));
  if (!source) return;
  const sample = $("exportPreset").value === "feishu";
  $("standardExportSettings").hidden = sample;
  $("exportPresetHint").hidden = !sample;
  let p;
  try { p = exportProfile(source, selectedExportOptions(), total()); }
  catch (error) { $("exportEstimate").textContent = error.message; $("confirmExport").disabled = true; return; }
  $("confirmExport").disabled = false;
  const mb = Math.round(total() * (p.bitrate + p.audioBitrate) / 8 / 1000);
  $("exportEstimate").textContent = `${p.width} × ${p.height} · ${p.fps} 帧/秒 · ${sample ? `目标约 ${mb} MB，完成后校验小于30 MB` : `参考大小约 ${mb} MB（实际随画面复杂度变化）`}`;
}
for (const id of ["exportPreset", "exportFps", "exportResolution", "exportQuality"]) $(id).onchange = updateExportEstimate;
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
  if (e.key === "Escape" && state.clipTrim) { e.preventDefault(); finishClipTrim(null, true); return; }
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
  if (["ArrowLeft","ArrowRight"].includes(e.key) && !e.defaultPrevented && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey &&
      !e.isComposing && !$("exportDialog").open && !e.target.isContentEditable &&
      (!e.target.matches("input,textarea,select") || e.target === $("fullscreenSeek"))) {
    e.preventDefault(); e.stopPropagation();
    stepTimelineFrame(e.key === "ArrowLeft" ? -1 : 1);
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
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat || state.busy || (!selected()&&!selectedAudio()))
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
function clipboardTextTarget(event) {
  const target = event.target instanceof Element ? event.target : document.activeElement;
  return !!target?.closest("input,textarea,select") || !!target?.isContentEditable;
}
function clipboardUnavailable(event) {
  return clipboardTextTarget(event) || !state.project || !timelineClipboard || state.busy || state.saving ||
    state.captionGesture || state.clipTrim || state.timelineScrub || $("exportDialog").open;
}
document.addEventListener("copy", event => {
  if (clipboardUnavailable(event) || !event.clipboardData || window.getSelection()?.toString()) return;
  try {
    let placements = [];
    if (state.clipboardKind === "captions") {
      const all = mappedCues().filter(c=>state.subtitleSelection.has(`${c.sourceId}:${c.index}`));
      const anchor = all.find(c=>c.occurrence===state.captionSelectionAnchor) ||
        [...all].sort((a,b)=>Math.abs(a.start-Number($("fullscreenSeek").value))-Math.abs(b.start-Number($("fullscreenSeek").value)))[0];
      for (const key of state.subtitleSelection) {
        const candidates = all.filter(c=>`${c.sourceId}:${c.index}`===key);
        candidates.sort((a,b)=>Math.abs(a.start-anchor.start)-Math.abs(b.start-anchor.start));
        if (candidates[0]) placements.push(candidates[0]);
      }
    }
    const payload = timelineClipboard.copyTimelineItems(state.project,state.clipboardKind,
      state.clipboardKind === "voice" ? state.selectedVoice : state.clip,placements);
    const encoded = timelineClipboard.encodeClipboard(payload);
    event.clipboardData.setData("text/plain",payload.kind === "captions" ? payload.items.map(c=>c.text).join("\n") :
      state.project.sources.find(s=>s.id===payload.items[0].source_id)?.name || "cutccc 时间轴元素");
    event.clipboardData.setData(timelineClipboard.CLIPBOARD_MIME,encoded);
    event.preventDefault();
    toast(`已复制 ${payload.items.length} ${payload.kind === "captions" ? "条字幕" : payload.kind === "voice" ? "段旁白音频" : "个视频片段"}，移动播放头后按 Ctrl+V 粘贴。`);
  } catch (error) { event.preventDefault(); toast(error.message,true); }
});
document.addEventListener("paste", event => {
  if (clipboardUnavailable(event) || !event.clipboardData) return;
  const text = event.clipboardData.getData(timelineClipboard.CLIPBOARD_MIME) || event.clipboardData.getData("text/plain");
  if (!text.startsWith(timelineClipboard.CLIPBOARD_PREFIX)) return;
  event.preventDefault();
  try {
    const payload=timelineClipboard.decodeClipboard(text),type={clip:'video',voice:'audio',captions:'subtitle'}[payload.kind];
    if(timelineTracks.getTracks(state.project).some(t=>t.id===state.selectedTrack&&t.type===type))for(const item of payload.items)item.track_id=state.selectedTrack;
    const result = timelineClipboard.pasteTimelineItems(state.project,payload,Number($("fullscreenSeek").value));
    pause(); state.project = result.project;
    state.clipboardKind = result.kind; state.subtitleSelection.clear();
    if (result.kind === "captions") {
      state.subtitleSelection = new Set(result.keys); state.subtitleSelectionProject = state.project.id;
    } else if (result.kind === "clip") {
      state.clip = result.index; state.source = state.project.clips[result.index].source_id;
    } else state.selectedVoice = result.index;
    markDirty(); render(); seekOutput(result.position,false);
    if (result.kind === "captions") {
      const first = selectedSubtitleEntries()[0];
      state.captionSelectionAnchor = mappedCues().find(c=>`${c.sourceId}:${c.index}`===first.key)?.occurrence;
      revealSubtitleInList(first.sourceId,first.index);
    } else {
      document.querySelector('[data-tab="clip"]').click();
      if (result.kind === "clip") selectLibraryTab("materials");
      else {
        const row = $("voiceoverList").querySelector(`[data-voice="${result.index}"]`);
        row?.classList.add("selected"); row?.scrollIntoView({block:"nearest"});
      }
    }
    toast("已粘贴到播放位置，可按 Ctrl+Z 撤销。");
  } catch (error) {toast(error.message,true);}
});
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
    await Promise.all([subtitleStyleReady, editHistoryReady, captionTimingReady, timelineClipboardReady, timelineNavigationReady,audioTracksReady,tracksReady]);
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
