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

const prefs = { format: "mp4", quality: "best", dest: "", text: true };

async function loadPrefs() {
  try {
    const { prefs: stored } = await chrome.storage.local.get("prefs");
    if (stored) Object.assign(prefs, stored);
  } catch { /* valores por defecto */ }
  $("format").value = prefs.format;
  $("quality").value = prefs.quality;
  $("dest").value = prefs.dest || "";
  $("text").checked = prefs.text !== false;
  syncQuality();
  syncDest();
}

const savePrefs = () => chrome.storage.local.set({ prefs }).catch(() => {});

function syncQuality() {
  // La calidad de imagen no aplica a los formatos de solo audio.
  $("quality").disabled = AUDIO_ONLY.has($("format").value);
}

for (const id of ["format", "quality"]) {
  $(id).addEventListener("change", () => {
    prefs[id] = $(id).value;
    syncQuality();
    savePrefs();
  });
}

// Explica dónde se va a guardar.
function syncDest() {
  const dest = DownskoolDest.parseDest($("dest").value);
  const hint = $("dest-hint");
  hint.hidden = !dest.subdir;
  hint.textContent = !dest.subdir ? ""
    : dest.target
      ? `Se guarda en ${dest.target} › <Curso>. La primera vez el navegador te pedirá elegir esa carpeta para darle permiso.`
      : `Se guarda en Descargas › ${dest.subdir.split("/").join(" › ")} › <Curso>.`;
}

$("dest").addEventListener("input", () => {
  prefs.dest = $("dest").value;
  syncDest();
  savePrefs();
});
$("text").addEventListener("change", () => {
  prefs.text = $("text").checked;
  savePrefs();
});

// ---------- trabajos de descarga ----------

// Por qué una lección no se puede descargar (o null si sí se puede).
function blockedReason(lesson) {
  if (lesson.locked) return "Bloqueada: no tienes acceso a esta lección";
  return null;
}

// Crea un trabajo de descarga y abre la página que lo procesa.
async function startJob(tabId, course, items) {
  const jobId = `job:${Date.now()}`;
  const job = { tabId, course, items, format: prefs.format, quality: prefs.quality, dest: prefs.dest, text: prefs.text };
  await chrome.storage.session.set({ [jobId]: job });
  chrome.tabs.create({ url: chrome.runtime.getURL(`src/downloader.html?job=${encodeURIComponent(jobId)}`) });
  window.close();
}

function renderCourse(tab, data) {
  if (!data || !data.lessons || !data.lessons.length) return false;
  const { course, lessons } = data;
  $("course").hidden = false;
  $("course-title").textContent = course || "Curso";

  // Si Skool marca videos en alguna lección, las que no lo tienen son de solo texto.
  const anyVideo = lessons.some((l) => l.source);
  const NO_VIDEO = "No tiene video: marca «Guardar también el texto» para bajar su texto";
  const boxes = [];
  const textBoxes = [];
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
    lesson.textOnly = anyVideo && !lesson.source;
    const box = el("input", { type: "checkbox", checked: !reason, disabled: !!reason });
    box.dataset.index = i;
    if (reason) locked++;
    else boxes.push(box);
    if (!reason && lesson.textOnly) textBoxes.push(box);
    if (!reason && lesson.source === "YouTube") youtube++;
    const tag = lesson.locked ? "🔒" : lesson.source || (lesson.textOnly ? "Texto" : "");
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
    const usable = boxes.filter((b) => !b.disabled);
    const n = usable.filter((b) => b.checked).length;
    $("count").textContent = `${n}/${usable.length} lecciones`;
    $("all").checked = n > 0 && n === usable.length;
    $("all").indeterminate = n > 0 && n < usable.length;
    $("all").disabled = usable.length === 0;
    $("download").disabled = n === 0;
  };
  // Las lecciones de solo texto solo se pueden elegir si se va a guardar el texto.
  const syncTextOnly = () => {
    const on = $("text").checked;
    for (const box of textBoxes) {
      box.disabled = !on;
      box.checked = on;
      const label = box.closest("label");
      label.title = on ? "" : NO_VIDEO;
      label.parentElement.className = on ? "" : "disabled";
      label.querySelector(".tag").classList.toggle("off", !on);
    }
    update();
  };
  $("text").addEventListener("change", syncTextOnly);
  boxes.forEach((b) => b.addEventListener("change", update));
  $("all").addEventListener("change", () => {
    boxes.forEach((b) => (b.checked = !b.disabled && $("all").checked));
    update();
  });
  $("download").addEventListener("click", () => {
    const items = boxes
      .filter((b) => b.checked && !b.disabled)
      .map((b) => {
        const i = Number(b.dataset.index);
        const l = lessons[i];
        return {
          kind: "lesson", lessonId: l.id, title: l.title, number: i + 1,
          section: l.section, sectionNumber: l.sectionNumber, numberInSection: l.numberInSection,
          source: l.source, videoLink: l.videoLink, textOnly: l.textOnly,
        };
      });
    startJob(tab.id, course, items);
  });
  syncTextOnly();
  return true;
}

function renderCurrent(tab, videos) {
  if (!videos.length) return false;
  $("current").hidden = false;
  const list = $("current-list");
  const title = cleanTitle(tab.title) || "video";
  // Lección abierta (?md=<id>), para guardar también su texto.
  const lessonId = new URL(tab.url).searchParams.get("md") || undefined;
  videos.forEach((v, i) => {
    const name = title + (videos.length > 1 ? ` (${i + 1})` : "");
    const btn = el("button", { textContent: "Descargar" });
    btn.addEventListener("click", () =>
      startJob(tab.id, "", [{ kind: "url", url: v.url, type: v.type, title: name, lessonId: i === 0 ? lessonId : undefined }]));
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
