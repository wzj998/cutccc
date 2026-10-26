"use strict";
const $ = (id) => document.getElementById(id);
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
  $("modelHint").textContent = !state.modelsReady
    ? "字幕模型未下载，请按使用说明运行 cutccc download。"
    : src && !src.has_audio
      ? "此素材没有音轨，可手动添加字幕。"
      : running
        ? "正在后台生成字幕，可在下方查看进度。"
        : "识别在本机完成，结果可以逐条修改。";
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
  $("videoFrame").style.width = `${width}px`;
  $("videoFrame").style.height = `${width / ratio}px`;
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
  requestAnimationFrame(fitPreview);
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
  for (const c of state.project?.clips || []) {
    const d = duration(c);
    for (const cue of state.project.subtitles[c.source_id] || []) {
      const a = Math.max(c.start, cue.start),
        b = Math.min(c.end, cue.end, c.start + d);
      if (b > a)
        result.push({
          start: offset + a - c.start,
          end: offset + b - c.start,
          text: cue.text,
        });
    }
    offset += d;
  }
  return result;
}
function renderTimeline() {
  const p = state.project;
  const scroll = $("timelineScroll");
  const previousZoom = state.zoom;
  const previousTime = scroll.scrollLeft / previousZoom;
  const seconds = total();
  $("clipCount").textContent = `${p?.clips.length || 0} 段`;
  $("totalClock").textContent = time(seconds);
  const viewportWidth = Math.max(1, scroll.clientWidth - 1);
  const fitScale = seconds > 0 ? viewportWidth / seconds : 24;
  const maxScale = Math.max(90, fitScale * 4);
  const zoom = Number($("zoom").value) / 100;
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
  $("captionTrack").innerHTML = mappedCues()
    .map(
      (c) =>
        `<div class="caption-block" style="left:${c.start * state.zoom}px;width:${(c.end - c.start) * state.zoom}px" title="${esc(c.text)}">${esc(c.text)}</div>`,
    )
    .join("");
  $("playhead").hidden = !p?.clips.length;
  scroll.scrollLeft = zoom === 0 ? 0 : previousTime * state.zoom;
}
function renderSubtitles() {
  const cues = state.project?.subtitles[state.source] || [];
  $("subtitleCount").textContent = cues.length;
  $("subtitleList").innerHTML = cues.length
    ? cues
        .map(
          (c, i) =>
            `<div class="subtitle-row" data-cue="${i}"><div class="subtitle-time"><span class="number">${String(i + 1).padStart(2, "0")}</span><input type="number" min="0" step="0.001" data-field="start" aria-label="字幕 ${i + 1} 开始时间" value="${c.start.toFixed(3)}"><span class="separator">—</span><input type="number" min="0" step="0.001" data-field="end" aria-label="字幕 ${i + 1} 结束时间" value="${c.end.toFixed(3)}"><button class="icon-button" data-remove-cue="${i}" title="删除字幕" aria-label="删除字幕 ${i + 1}">×</button></div><textarea data-field="text" aria-label="字幕 ${i + 1} 文字">${esc(c.text)}</textarea></div>`,
        )
        .join("")
    : '<p class="muted" style="margin-top:18px">生成字幕后，可以在这里逐条校对文字和时间，也可以点击 ＋ 手动添加。</p>';
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
            `<div class="job ${j.status}"><div class="job-head"><span>${j.kind === "export" ? "↗ 视频导出" : "✧ 自动字幕"}</span><span>${labels[j.status]}</span></div><div class="job-message">${esc(j.message)}</div>${["queued", "running"].includes(j.status) ? `<progress max="100" value="${j.progress}"></progress>` : ""}${j.status === "completed" && j.kind === "export" ? `<div class="job-links"><a href="${j.result.video_url}" download>下载视频 ↓</a><a href="${j.result.subtitles_url}" download>字幕 SRT ↓</a></div>` : ""}${j.status === "failed" ? `<a class="quiet-link" href="/api/jobs/${j.id}/log" target="_blank" rel="noopener">查看任务日志 ↗</a>` : ""}</div>`,
        )
        .join("")
    : '<p class="muted">导出的视频会出现在这里。</p>';
}

function pause() {
  state.playing = false;
  $("video").pause();
  $("playBtn").textContent = "▶";
  $("playBtn").setAttribute("aria-label", "播放");
  $("fullscreenPlayBtn").textContent = "▶";
  $("fullscreenPlayBtn").setAttribute("aria-label", "播放");
}
function setPreview(at = 0, autoplay = false) {
  const s = source();
  if (!s) {
    $("video").removeAttribute("src");
    return;
  }
  const video = $("video"),
    url = mediaUrl(s.id);
  state.switching = true;
  const seek = () => {
    video.currentTime = Math.max(0, Math.min(at, s.duration));
    state.switching = false;
    if (autoplay) {
      video.play().catch((e) => {
        pause();
        toast("点击播放按钮开始预览。", true);
      });
    }
  };
  if (video.getAttribute("src") !== url) {
    video.src = url;
    video.addEventListener("loadedmetadata", seek, { once: true });
    video.load();
  } else seek();
}
function selectClip(index, at, autoplay = false) {
  if (!state.project?.clips[index]) return;
  if (!autoplay) pause();
  state.clip = index;
  state.source = selected().source_id;
  render();
  setPreview(at ?? selected().start, autoplay);
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
  state.playing = true;
  $("playBtn").textContent = "Ⅱ";
  $("playBtn").setAttribute("aria-label", "暂停");
  $("fullscreenPlayBtn").textContent = "Ⅱ";
  $("fullscreenPlayBtn").setAttribute("aria-label", "暂停");
  const c = selected();
  if (
    $("video").currentTime < c.start ||
    $("video").currentTime >= c.end - 0.02
  )
    $("video").currentTime = c.start;
  $("video")
    .play()
    .catch(() => {
      pause();
      toast("当前视频编码无法在浏览器中播放，仍可剪辑并导出 MP4。", true);
    });
}
function nextClip() {
  if (state.clip + 1 < state.project.clips.length)
    selectClip(state.clip + 1, undefined, true);
  else pause();
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
  $("outputClock").textContent = time(offset);
  $("fullscreenClock").textContent = `${time(offset)} / ${time(total())}`;
  $("playhead").style.left = `${offset * state.zoom}px`;
  const cue = (state.project?.subtitles[state.source] || []).find(
    (c) => current >= c.start && current < c.end,
  );
  $("captionOverlay").textContent =
    $("showCaptions").checked && cue ? cue.text : "";
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
          ? "中文字幕已生成，可以开始校对。"
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
$("fullscreenPlayBtn").onclick = togglePlay;
$("fullscreenBtn").onclick = toggleFullscreen;
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
  const cue = state.project.subtitles[state.source][Number(row.dataset.cue)];
  cue[field] = field === "text" ? e.target.value : Number(e.target.value);
  markDirty();
  renderTimeline();
};
$("subtitleList").onclick = (e) => {
  const button = e.target.closest("[data-remove-cue]");
  if (button) {
    state.project.subtitles[state.source].splice(
      Number(button.dataset.removeCue),
      1,
    );
    markDirty();
    renderSubtitles();
    renderTimeline();
  } else if (e.target.classList.contains("number")) {
    const row = e.target.closest("[data-cue]");
    pause();
    setPreview(
      state.project.subtitles[state.source][Number(row.dataset.cue)].start,
    );
  }
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
      { source_id: state.source },
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
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveProject()
      .then(() => toast("项目已保存。"))
      .catch((err) => toast(err.message, true));
    return;
  }
  if (e.target.matches("input,textarea,select") || $("exportDialog").open)
    return;
  if (e.code === "Space") {
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
});
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
