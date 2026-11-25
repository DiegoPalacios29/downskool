const $ = (id) => document.getElementById(id);
const AUDIO_ONLY = new Set(["m4a", "mp3", "wav"]);

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function cleanTitle(t) {
  return (t || "").replace(/\s*[|·-]\s*Skool\s*$/i, "").trim();
}

// ---------- opciones (se recuerdan entre usos) ----------

const prefs = { format: "mp4", quality: "best" };

async function loadPrefs() {
  try {
    const { prefs: stored } = await chrome.storage.local.get("prefs");
    if (stored) Object.assign(prefs, stored);
  } catch { /* valores por defecto */ }
  $("format").value = prefs.format;
  $("quality").value = prefs.quality;
  syncQuality();
}

function syncQuality() {
  // La calidad de imagen no aplica a los formatos de solo audio.
  $("quality").disabled = AUDIO_ONLY.has($("format").value);
}

for (const id of ["format", "quality"]) {
  $(id).addEventListener("change", () => {
    prefs[id] = $(id).value;
    syncQuality();
    chrome.storage.local.set({ prefs }).catch(() => {});
  });
}

// ---------- trabajos de descarga ----------

// Por qué una lección no se puede descargar (o null si sí se puede).
function blockedReason(lesson) {
  if (lesson.locked) return "Bloqueada: no tienes acceso a esta lección";
  return null;
}

// Crea un trabajo de descarga y abre la página que lo procesa.
async function startJob(tabId, course, items) {
  const jobId = `job:${Date.now()}`;
  const job = { tabId, course, items, format: prefs.format, quality: prefs.quality };
  await chrome.storage.session.set({ [jobId]: job });
  chrome.tabs.create({ url: chrome.runtime.getURL(`src/downloader.html?job=${encodeURIComponent(jobId)}`) });
  window.close();
}

function renderCourse(tab, data) {
  if (!data || !data.lessons || !data.lessons.length) return false;
  const { course, lessons } = data;
  $("course").hidden = false;
  $("course-title").textContent = course || "Curso";

  const boxes = [];
  const ul = $("lessons");
  let lastSection = null;
  let locked = 0;
  let youtube = 0;
  let sectionNumber = 0;
  let numberInSection = 0;
  lessons.forEach((lesson, i) => {
    if (lesson.section !== lastSection) {
      if (lesson.section) ul.append(el("li", { className: "section", textContent: lesson.section }));
      lastSection = lesson.section;
      sectionNumber++;
      numberInSection = 0;
    }
    // Posición dentro del módulo, para nombrar los archivos en orden.
    lesson.sectionNumber = sectionNumber;
    lesson.numberInSection = ++numberInSection;
    const reason = blockedReason(lesson);
    const box = el("input", { type: "checkbox", checked: !reason, disabled: !!reason });
    box.dataset.index = i;
    if (reason) locked++;
    else boxes.push(box);
    if (!reason && lesson.source === "YouTube") youtube++;
    const tag = lesson.locked ? "🔒" : lesson.source || "";
    const label = el("label", { title: reason || "" },
      box,
      el("span", { className: "lesson-title", textContent: `${i + 1}. ${lesson.title}` }),
      tag ? el("span", { className: `tag${reason ? " off" : ""}`, textContent: tag }) : "");
    ul.append(el("li", { className: reason ? "disabled" : "" }, label));
  });

  const notes = [];
  if (youtube) notes.push(`${youtube} video(s) de YouTube: al terminar te damos el comando para bajarlos con yt-dlp (gratis).`);
  if (locked) notes.push(`${locked} lección(es) bloqueada(s): no tienes acceso.`);
  if (notes.length) {
    $("note").hidden = false;
    $("note").textContent = notes.join(" ");
  }

  const update = () => {
    const n = boxes.filter((b) => b.checked).length;
    $("count").textContent = `${n}/${boxes.length} videos`;
    $("all").checked = n > 0 && n === boxes.length;
    $("all").indeterminate = n > 0 && n < boxes.length;
    $("all").disabled = boxes.length === 0;
    $("download").disabled = n === 0;
  };
  boxes.forEach((b) => b.addEventListener("change", update));
  $("all").addEventListener("change", () => {
    boxes.forEach((b) => (b.checked = $("all").checked));
    update();
  });
  $("download").addEventListener("click", () => {
    const items = boxes
      .filter((b) => b.checked)
      .map((b) => {
        const i = Number(b.dataset.index);
        const l = lessons[i];
        return {
          kind: "lesson", lessonId: l.id, title: l.title, number: i + 1,
          section: l.section, sectionNumber: l.sectionNumber, numberInSection: l.numberInSection,
          source: l.source, videoLink: l.videoLink,
        };
      });
    startJob(tab.id, course, items);
  });
  update();
  return true;
}

function renderCurrent(tab, videos) {
  if (!videos.length) return false;
  $("current").hidden = false;
  const list = $("current-list");
  const title = cleanTitle(tab.title) || "video";
  videos.forEach((v, i) => {
    const name = title + (videos.length > 1 ? ` (${i + 1})` : "");
    const btn = el("button", { textContent: "Descargar" });
    btn.addEventListener("click", () =>
      startJob(tab.id, "", [{ kind: "url", url: v.url, type: v.type, title: name }]));
    list.append(el("div", { className: "item" },
      el("div", {}, el("strong", { textContent: name }), el("div", { className: "muted", textContent: `${v.source} · ${v.type.toUpperCase()}` })),
      btn));
  });
  return true;
}

async function main() {
  await loadPrefs();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/([^/]+\.)?skool\.com\//.test(tab.url || "")) {
    $("message").textContent = "Abre un curso en skool.com para usar downskool.";
    return;
  }

  const [course, captured] = await Promise.all([
    chrome.tabs.sendMessage(tab.id, { type: "list-lessons" }).catch(() => null),
    chrome.runtime.sendMessage({ type: "get-videos", tabId: tab.id }),
  ]);

  const shownCourse = renderCourse(tab, course);
  const shownCurrent = renderCurrent(tab, captured.videos);

  if (course === null) {
    $("message").textContent = "Recarga la página de Skool (F5) para que downskool pueda leerla.";
  } else if (!shownCourse && !shownCurrent) {
    $("message").textContent = "No se encontraron videos. Entra a la sección Classroom de un curso, o reproduce el video de la lección unos segundos.";
  } else {
    $("message").hidden = true;
  }
}

main();
