"use strict";
const $ = (id) => document.getElementById(id);
let subtitleStyle;
const subtitleStyleReady = import("/static/subtitle-style.js").then(module => { subtitleStyle = module; });
const state = {
  project: null,
  source: null,
  clip: -1,
  dirty: false,
  playing: false,
  jobs: [],
  modelsReady: false,
  busy: false,
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
function markDirty() {
  state.dirty = true;
  $("saveState").textContent = "有未保存的修改";
  $("saveState").style.color = "#d9c992";
  updateButtons();
}
function markSaved() {
  state.dirty = false;
  state.remoteRevision = null;
  $("saveState").textContent = "已保存在本机";
  $("saveState").style.color = "";
  updateButtons();
}
function updateButtons() {
  const has = Boolean(state.project),
    clip = Boolean(selected()),
    src = source();
  $("saveBtn").disabled = !has || !state.dirty || state.busy;
  $("exportBtn").disabled = !has || !state.project.clips.length || state.busy;
  $("reloadBtn").disabled = !has || state.busy;
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
  state.project.title = $("projectTitle").value;
  const p = state.project;
  state.project = await api(`/api/projects/${p.id}`, "PATCH", {
    revision: p.revision,
    title: p.title,
    clips: p.clips,
    subtitles: p.subtitles,
    voiceovers: p.voiceovers || [],
  });
  markSaved();
  await projectOptions();
  return true;
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
      return `<div class="subtitle-row" data-voice="${i}"><strong>${esc(s?.name || "旁白")}</strong><div class="trim-fields"><label>成片入点 / 秒<input type="number" min="0" step="0.001" data-voice-field="start" value="${v.start}"></label><label>音量 / 倍<input type="number" min="0" max="2" step="0.1" data-voice-field="volume" value="${v.volume ?? 1}"></label></div><audio controls preload="none" src="${mediaUrl(v.source_id)}" style="width:100%"></audio><button class="button small" data-remove-voice="${i}">删除旁白</button></div>`;
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
          sourceId: c.source_id, index, occurrence: `clip:${clipIndex}:${index}`,
        });
    }
    offset += d;
  }
  for (const [voiceIndex, voice] of (state.project?.voiceovers || []).entries()) {
    const s = state.project.sources.find(s => s.id === voice.source_id);
    for (const [index, cue] of (state.project.subtitles[voice.source_id] || []).entries()) {
      const start = Math.max(0, cue.start), end = Math.min(cue.end, s.duration, offset - voice.start);
      if (end > start) result.push({start: voice.start + start, end: voice.start + end, text: cue.text,
        sourceId: voice.source_id, index, occurrence: `voice:${voiceIndex}:${index}`});
    }
  }
  return result.sort((a, b) => a.start - b.start);
}
function renderTimeline() {
  const p = state.project;
  const scroll = $("timelineScroll");
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
          return `<div class="timeline-clip ${i === state.clip ? "selected" : ""}" data-clip="${i}" draggable="true" role="button" tabindex="0" aria-label="片段 ${i + 1}：${esc(s.name)}" style="width:${duration(c) * state.zoom}px"><img src="${mediaUrl(c.source_id, "poster")}" alt=""><span>${i + 1} · ${esc(s.name)}</span><small>${time(duration(c))}</small></div>`;
        })
        .join("")
    : '<div class="timeline-placeholder">导入视频后，片段将出现在这里</div>';
  const lanes = [];
  $("captionTrack").innerHTML = mappedCues()
    .map((c) => {
      let lane = lanes.findIndex(end => end <= c.start);
      if (lane < 0) lane = lanes.length;
      lanes[lane] = c.end;
      const selected = state.subtitleSelection.has(`${c.sourceId}:${c.index}`);
      return `<div class="caption-block ${selected ? "selected" : ""}" data-caption-occurrence="${c.occurrence}" data-caption-key="${c.sourceId}:${c.index}" role="button" tabindex="0" aria-pressed="${selected}" aria-label="编辑字幕：${esc(c.text)}" style="left:${c.start * state.zoom}px;width:${(c.end - c.start) * state.zoom}px;top:${3 + lane * 26}px" title="点击编辑内容和样式：${esc(c.text)}">${esc(c.text)}</div>`;
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
}
function renderSubtitles() {
  const entries = subtitleEntries();
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
            `<div class="subtitle-row ${state.subtitleSelection.has(key) ? "selected" : ""}" data-cue="${i}" data-cue-source="${sourceId}"><div class="subtitle-select-line"><input type="checkbox" data-select-cue="${key}" aria-label="选择字幕 ${i + 1}" ${state.subtitleSelection.has(key) ? "checked" : ""}><span title="${esc(name)}">${esc(name)}</span><button class="button small" data-edit-style="${key}">样式</button></div><div class="subtitle-time"><span class="number">${String(i + 1).padStart(2, "0")}</span><input type="number" min="0" step="0.001" data-field="start" aria-label="字幕 ${i + 1} 开始时间" value="${c.start.toFixed(3)}"><span class="separator">—</span><input type="number" min="0" step="0.001" data-field="end" aria-label="字幕 ${i + 1} 结束时间" value="${c.end.toFixed(3)}"><button class="icon-button" data-remove-cue="${i}" title="删除字幕" aria-label="删除字幕 ${i + 1}">×</button></div><textarea data-field="text" aria-label="字幕 ${i + 1} 文字">${esc(c.text)}</textarea></div>`,
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
function openTimelineCaption(occurrence) {
  const mapped = mappedCues().find(cue => cue.occurrence === occurrence);
  if (!mapped) return;
  state.subtitleSelectionProject = state.project.id;
  state.subtitleSelection = new Set([`${mapped.sourceId}:${mapped.index}`]);
  // Seek the clicked occurrence, including reused clips and repeated voiceovers.
  seekOutput(mapped.start + Math.min(.05, (mapped.end - mapped.start) / 2), false);
  if (mapped.sourceId !== state.source) $("subtitleScope").value = "project";
  document.querySelector('[data-tab="subtitles"]').click();
  renderSubtitles();
  renderTimeline();
  $("captionStyleEditor").open = true;
  $("captionStyleEditor").scrollIntoView({block: "nearest"});
  $("captionFocusedText").focus({preventScroll: true});
}
function previewSubtitle(sourceId, index) {
  const cue = state.project.subtitles[sourceId][index];
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
  markDirty();
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
  const cues = (state.project?.subtitles[state.source] || []).filter(
    (c) => current >= c.start && current < c.end,
  );
  if (c) for (const voice of state.project.voiceovers || []) {
    const at = offset - voice.start;
    cues.push(...(state.project.subtitles[voice.source_id] || []).filter(cue => cue.start <= at && at < cue.end));
  }
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
  if (state.project?.id !== id || state.busy) return;
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
    markDirty();
  }
};
$("saveBtn").onclick = () =>
  saveProject()
    .then(() => toast("项目已保存。"))
    .catch((e) => toast(e.message, true));
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
  markDirty();
};
$("voiceoverList").onclick = (e) => {
  const button = e.target.closest("[data-remove-voice]");
  if (!button) return;
  state.project.voiceovers.splice(Number(button.dataset.removeVoice), 1);
  markDirty();
  renderVoiceovers();
};
for (const tab of document.querySelectorAll(".tab"))
  tab.onclick = () => {
    document
      .querySelectorAll(".tab")
      .forEach((t) => t.classList.toggle("active", t === tab));
    $("clipPanel").hidden = tab.dataset.tab !== "clip";
    $("subtitlesPanel").hidden = tab.dataset.tab !== "subtitles";
  };
$("subtitleList").oninput = (e) => {
  const row = e.target.closest("[data-cue]"),
    field = e.target.dataset.field;
  if (!row || !field) return;
  const cue = state.project.subtitles[row.dataset.cueSource][Number(row.dataset.cue)];
  cue[field] = field === "text" ? e.target.value : Number(e.target.value);
  if (field === "text") renderCaptionStyleEditor();
  markDirty();
  renderTimeline();
};
$("subtitleList").onclick = (e) => {
  const styleButton = e.target.closest("[data-edit-style]");
  if (styleButton) {
    state.subtitleSelection = new Set([styleButton.dataset.editStyle]);
    const entry = selectedSubtitleEntries()[0];
    previewSubtitle(entry.sourceId, entry.index);
    renderSubtitles();
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
};
$("subtitleScope").onchange = renderSubtitles;
$("captionTrack").onclick = (event) => {
  const block = event.target.closest("[data-caption-occurrence]");
  if (block) openTimelineCaption(block.dataset.captionOccurrence);
};
$("captionTrack").onkeydown = (event) => {
  if (event.key !== "Enter" && event.code !== "Space") return;
  const block = event.target.closest("[data-caption-occurrence]");
  if (!block) return;
  event.preventDefault();
  event.stopPropagation();
  openTimelineCaption(block.dataset.captionOccurrence);
};
$("captionFocusedText").oninput = (event) => {
  const entries = selectedSubtitleEntries();
  if (entries.length !== 1) return;
  const entry = entries[0];
  entry.cue.text = event.target.value;
  const row = [...$("subtitleList").querySelectorAll("[data-cue]")].find(
    row => row.dataset.cueSource === entry.sourceId && Number(row.dataset.cue) === entry.index,
  );
  if (row) row.querySelector("textarea").value = entry.cue.text;
  markDirty();
  renderTimeline();
};
$("selectAllCaptions").onclick = () => {
  for (const entry of subtitleEntries()) state.subtitleSelection.add(entry.key);
  renderSubtitles();
  $("captionStyleEditor").open = true;
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
$("addCaptionBtn").onclick = () => {
  const s = source();
  if (!s) return;
  const cues = state.project.subtitles[s.id];
  let start = $("video").currentTime;
  for (const c of cues) if (start >= c.start && start < c.end) start = c.end;
  const next = cues.find((c) => c.start >= start),
    end = Math.min(start + 2, next?.start ?? s.duration, s.duration);
  if (end - start < 0.05) {
    toast("当前位置没有可用的字幕间隙，请移动播放头。", true);
    return;
  }
  cues.push({ start, end, text: "新字幕" });
  cues.sort((a, b) => a.start - b.start);
  state.subtitleSelection.clear();
  markDirty();
  renderSubtitles();
  renderTimeline();
};
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
$("exportBtn").onclick = async () => {
  try {
    await saveProject();
    $("exportDuration").textContent = time(total());
    $("exportDialog").showModal();
  } catch (e) {
    toast(e.message, true);
  }
};
$("confirmExport").onclick = async () => {
  try {
    const job = await api(`/api/projects/${state.project.id}/export`, "POST", {
      burn_subtitles: $("burnCaptions").checked,
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
    e.target.matches("input,textarea,select") ||
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
    await subtitleStyleReady;
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
