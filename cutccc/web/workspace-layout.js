const STORAGE_KEY = "cutccc-timeline-height";

// View preferences stay local to the browser and never change the project.
export function mountWorkspaceLayout({onResize}) {
  const handle = document.getElementById("timelineSplitter");
  const center = handle.closest(".center-stage");
  const panel = document.getElementById("timelinePanel");
  let preferred = null;
  let contentHeight = 160;
  let drag = null;
  let frame = null;
  try {
    const saved = Number(localStorage.getItem(STORAGE_KEY));
    if (Number.isFinite(saved) && saved > 0) preferred = saved;
  } catch { /* Layout remains usable when browser storage is unavailable. */ }

  function limits() {
    const height = selector => center.querySelector(selector).getBoundingClientRect().height;
    const overhead = height(".timeline-toolbar") + height(".audio-view-toolbar") + height(".timeline-footer") + 1;
    const previewMin = parseFloat(getComputedStyle(document.getElementById("previewArea")).minHeight) || 220;
    const min = overhead + 72;
    const max = Math.max(min, center.clientHeight - height(".preview-header") - height(".transport") - handle.offsetHeight - previewMin);
    return {min, max, overhead};
  }

  function update(canvasHeight = contentHeight) {
    contentHeight = canvasHeight;
    const {min, max, overhead} = limits();
    const auto = overhead + Math.min(contentHeight + 12, Math.max(120, Math.min(420, innerHeight * .4)));
    const height = Math.min(max, Math.max(min, preferred ?? auto));
    if (panel.style.height !== `${height}px`) {
      panel.style.height = `${height}px`;
      if (frame === null) frame = requestAnimationFrame(() => { frame = null; onResize(); });
    }
    handle.setAttribute("aria-valuemin", Math.round(min));
    handle.setAttribute("aria-valuemax", Math.round(max));
    handle.setAttribute("aria-valuenow", Math.round(height));
    handle.setAttribute("aria-valuetext", `时间轴高度 ${Math.round(height)} 像素`);
  }

  function save() {
    try {
      if (preferred === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, String(preferred));
    } catch { /* Resizing does not depend on persistence. */ }
  }

  function setHeight(height) {
    const {min, max} = limits();
    preferred = Math.min(max, Math.max(min, height));
    update();
  }

  handle.addEventListener("pointerdown", event => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    event.stopPropagation();
    drag = {id: event.pointerId, y: event.clientY, height: panel.getBoundingClientRect().height, previous: preferred};
    handle.setPointerCapture(event.pointerId);
    handle.focus({preventScroll: true});
    handle.classList.add("is-resizing");
    document.body.classList.add("is-resizing-workspace");
  });
  handle.addEventListener("pointermove", event => {
    if (drag?.id === event.pointerId) setHeight(drag.height + drag.y - event.clientY);
  });
  function finish(event) {
    if (!drag || drag.id !== event.pointerId) return;
    if (event.type === "pointercancel") { preferred = drag.previous; update(); }
    else save();
    drag = null;
    handle.classList.remove("is-resizing");
    document.body.classList.remove("is-resizing-workspace");
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  }
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) handle.addEventListener(type, finish);
  function reset() { preferred = null; update(); save(); }
  handle.addEventListener("dblclick", reset);
  handle.addEventListener("keydown", event => {
    if (!["ArrowUp", "ArrowDown", "Home", "End", "Enter"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Enter") { reset(); return; }
    const {min, max} = limits();
    const step = event.shiftKey ? 40 : 16;
    setHeight(event.key === "Home" ? min : event.key === "End" ? max : panel.getBoundingClientRect().height + (event.key === "ArrowUp" ? step : -step));
    save();
  });
  const observer = new ResizeObserver(() => update());
  observer.observe(center);
  observer.observe(center.querySelector(".preview-header"));
  observer.observe(center.querySelector(".transport"));
  observer.observe(panel.querySelector(".timeline-toolbar"));
  observer.observe(panel.querySelector(".audio-view-toolbar"));
  observer.observe(panel.querySelector(".timeline-footer"));
  update();
  return {update};
}
