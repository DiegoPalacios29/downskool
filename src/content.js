// downskool - content script en *.skool.com
//
// 1. Lee los datos que Skool incrusta en la página (__NEXT_DATA__) para listar
//    TODAS las lecciones del curso abierto (modo curso).
// 2. A pedido del descargador, abre cada lección (misma sesión, mismas cookies)
//    y busca la fuente de su video.
// 3. Informa los videos de la lección actual al service worker (modo lección).

(() => {
  const MEDIA_RE = /https:\/\/[^"'\s\\]+?\.(?:m3u8|mp4)(?:\?[^"'\s\\]*)?/gi;
  const EMBED_RE = /(youtube\.com|youtu\.be|loom\.com\/(share|embed)|vimeo\.com|wistia)/i;
  const VIDEO_KEYS = ["videoLink", "videoId", "videoLenMs", "videoThumbnail", "playbackId", "muxPlaybackId", "video"];

  function readNextData(doc) {
    const node = doc.getElementById("__NEXT_DATA__");
    if (!node) return null;
    try {
      return JSON.parse(node.textContent);
    } catch {
      return null;
    }
  }

  function* walk(value, parents = []) {
    if (!value || typeof value !== "object") return;
    yield [value, parents];
    const next = parents.concat([value]);
    for (const child of Array.isArray(value) ? value : Object.values(value)) yield* walk(child, next);
  }

  const titleOf = (o) => (o && (o.metadata?.title || o.title || o.name)) || "";
  const hasVideoHint = (o) => {
    const m = o.metadata || o;
    return VIDEO_KEYS.some((k) => m[k] !== undefined && m[k] !== null && m[k] !== "");
  };

  // El módulo visible es la unidad más cercana con título que contiene a la
  // lección (directamente, o como hermana dentro de un nodo {course, children}).
  function sectionOf(id, parents) {
    for (const p of [...parents].reverse()) {
      if (!p || Array.isArray(p)) continue;
      const unit = p.metadata?.title ? p : Object.values(p).find(
        (v) => v && typeof v === "object" && !Array.isArray(v) && v.metadata?.title && v.id !== id);
      if (unit && unit.id !== id && unit.unitType !== "module") {
        return unit.unitType === "course" ? "" : unit.metadata.title;
      }
    }
    return "";
  }

  // Lista las lecciones del curso abierto, en orden, con el módulo al que
  // pertenecen. Skool guarda el curso como un árbol de unidades con metadata.
  function listLessons() {
    const data = readNextData(document);
    if (!data) return { course: document.title, lessons: [] };
    const seen = new Map();
    let course = "";

    for (const [obj, parents] of walk(data.props || data)) {
      const id = obj.id;
      const meta = obj.metadata;
      if (typeof id !== "string" || !meta || typeof meta !== "object" || !meta.title) continue;
      const isLesson = obj.unitType === "module" || hasVideoHint(obj);
      if (!isLesson) {
        if (obj.unitType === "course" && !course) course = meta.title;
        continue;
      }
      if (seen.has(id)) continue;
      seen.set(id, {
        id,
        title: meta.title,
        section: sectionOf(id, parents),
        hasVideo: hasVideoHint(obj),
        videoLink: typeof meta.videoLink === "string" ? meta.videoLink : null,
      });
    }

    let lessons = [...seen.values()];
    if (lessons.some((l) => l.hasVideo)) lessons = lessons.filter((l) => l.hasVideo);
    return { course: course || document.title.replace(/\s*[|·-]\s*Skool\s*$/i, ""), lessons };
  }

  // Extrae las fuentes de video de un documento de lección.
  function mediaFrom(data, lessonId) {
    const out = { urls: [], embeds: [] };
    if (!data) return out;
    // Si se puede, limitar la búsqueda a la unidad de esta lección.
    let scope = data;
    if (lessonId) {
      for (const [obj] of walk(data)) {
        if (obj.id === lessonId && obj.metadata) { scope = obj; break; }
      }
    }
    const text = JSON.stringify(scope);
    for (const m of text.matchAll(MEDIA_RE)) out.urls.push(m[0]);
    for (const m of text.matchAll(/"(?:playbackId|playback_id|muxPlaybackId)"\s*:\s*"([A-Za-z0-9]{20,})"/g)) {
      const token = (text.match(/"(?:playbackToken|muxToken|videoToken)"\s*:\s*"([^"]+)"/) || [])[1];
      out.urls.push(`https://stream.mux.com/${m[1]}.m3u8${token ? `?token=${token}` : ""}`);
    }
    for (const m of text.matchAll(/"(?:videoLink|video_link|videoUrl)"\s*:\s*"([^"]+)"/g)) {
      if (EMBED_RE.test(m[1])) out.embeds.push(m[1]);
    }
    out.urls = [...new Set(out.urls)];
    out.embeds = [...new Set(out.embeds)];
    return out;
  }

  async function resolveLesson(lessonId) {
    if (lessonId === currentLessonId()) {
      return mediaFrom(readNextData(document), lessonId);
    }
    const url = new URL(location.href);
    url.searchParams.set("md", lessonId);
    const html = await fetch(url.href, { credentials: "include" }).then((r) => r.text());
    const doc = new DOMParser().parseFromString(html, "text/html");
    return mediaFrom(readNextData(doc), lessonId);
  }

  const currentLessonId = () => new URL(location.href).searchParams.get("md");

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "list-lessons") {
      sendResponse(listLessons());
    } else if (msg.type === "resolve-lesson") {
      resolveLesson(msg.lessonId)
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
  });

  // Modo lección: informa lo que se ve en la página actual.
  function scanCurrent() {
    const found = mediaFrom(readNextData(document), currentLessonId());
    document.querySelectorAll("video[src], video source[src]").forEach((el) => {
      const src = el.getAttribute("src");
      if (src && /^https:/.test(src) && /\.(m3u8|mp4)/i.test(src)) found.urls.push(src);
    });
    document.querySelectorAll("iframe[src]").forEach((el) => {
      if (EMBED_RE.test(el.src)) found.embeds.push(el.src);
    });
    chrome.runtime.sendMessage({ type: "page-videos", urls: found.urls, embeds: found.embeds }).catch(() => {});
  }

  scanCurrent();
  let timer;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(scanCurrent, 1500);
  }).observe(document.body, { childList: true, subtree: true });
})();
