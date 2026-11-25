const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function cleanTitle(t) {
  return (t || "").replace(/\s*[|·-]\s*Skool\s*$/i, "").trim();
}

// Crea un trabajo de descarga y abre la página que lo procesa.
async function startJob(tabId, course, items) {
  const jobId = `job:${Date.now()}`;
  await chrome.storage.session.set({ [jobId]: { tabId, course, items } });
  chrome.tabs.create({ url: chrome.runtime.getURL(`src/downloader.html?job=${encodeURIComponent(jobId)}`) });
  window.close();
}

function renderCourse(tab, data) {
  if (!data || !data.lessons.length) return false;
  const { course, lessons } = data;
  $("course").hidden = false;
  $("course-title").textContent = course || "Curso";

  const boxes = [];
  const ul = $("lessons");
  let lastSection = null;
  lessons.forEach((lesson, i) => {
    if (lesson.section && lesson.section !== lastSection) {
      ul.append(el("li", { className: "section", textContent: lesson.section }));
      lastSection = lesson.section;
    }
    const box = el("input", { type: "checkbox", checked: true });
    box.dataset.index = i;
    boxes.push(box);
    ul.append(el("li", {}, el("label", {}, box, el("span", { textContent: `${i + 1}. ${lesson.title}` }))));
  });

  const update = () => {
    const n = boxes.filter((b) => b.checked).length;
    $("count").textContent = `${n}/${boxes.length} videos`;
    $("all").checked = n === boxes.length;
    $("all").indeterminate = n > 0 && n < boxes.length;
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
        return { kind: "lesson", lessonId: l.id, title: l.title, section: l.section, number: i + 1, videoLink: l.videoLink };
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
