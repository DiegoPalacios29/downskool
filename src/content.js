// downskool - content script en *.skool.com
//
// Skool es una app Next.js. Cada página trae sus datos en
// <script id="__NEXT_DATA__">, en props.pageProps:
//   - course: árbol del curso. Cada nodo es { course: {id, unitType, metadata}, children }.
//     Las lecciones tienen unitType "module"; los módulos visibles son "set".
//     metadata.videoId (o videoIds) indica un video nativo de Skool y
//     metadata.videoLink / videoLinksData un video externo (YouTube, Loom...).
//     metadata.desc es el texto de la lección y metadata.resources sus adjuntos.
//   - video: el video nativo de la lección abierta (?md=<id>), con
//     { id, playbackId, playbackToken, status }. El stream es
//     https://stream.video.skool.com/<playbackId>.m3u8?token=<playbackToken>
//     y el token caduca en unas horas.
//
// Skool cambia de lección sin recargar, así que el __NEXT_DATA__ del DOM puede
// ser de otra lección. Por eso siempre se pide una copia fresca de la página.

(() => {
  const STREAM = "https://stream.video.skool.com";
  const MEDIA_RE = /https:\/\/[^"'\s\\]+?\.(?:m3u8|mp4)(?:\?[^"'\s\\]*)?/gi;
  const LINK_RE = /https?:\/\/[^\s"'<>[\]\\]+/g;
  const EMBED_RE = /(youtube\.com|youtu\.be|loom\.com|vimeo\.com|wistia\.(com|net))/i;

  function parseNextData(doc) {
    const node = doc.getElementById("__NEXT_DATA__");
    if (!node) return null;
    try {
      return JSON.parse(node.textContent);
    } catch {
      return null;
    }
  }

  async function fetchNextData(url) {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`Skool respondió ${res.status}`);
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const data = parseNextData(doc);
    if (!data) throw new Error("Skool no devolvió los datos de la lección (¿se cerró la sesión?)");
    return data;
  }

  function* walk(value) {
    if (!value || typeof value !== "object") return;
    yield value;
    for (const child of Array.isArray(value) ? value : Object.values(value)) yield* walk(child);
  }

  const propsOf = (data) => (data && data.props && data.props.pageProps) || data || {};

  function videoIdsOf(meta) {
    const raw = meta.videoIds || meta.videoId || "";
    const list = Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/);
    return [...new Set(list.filter((x) => typeof x === "string" && x))];
  }

  function linksOf(meta) {
    const out = [];
    const add = (value) => {
      if (!value) return;
      const text = typeof value === "string" ? value : JSON.stringify(value);
      for (const m of text.matchAll(LINK_RE)) {
        const url = m[0].replace(/[.,);']+$/, "");
        if (EMBED_RE.test(url) && !out.includes(url)) out.push(url);
      }
    };
    add(meta.videoLink);
    add(meta.videoUrl);
    add(meta.videoLinksData);
    return out;
  }

  function sourceOf(meta) {
    if (videoIdsOf(meta).length) return "Skool";
    const link = linksOf(meta)[0];
    if (link) {
      if (/youtu/i.test(link)) return "YouTube";
      if (/loom/i.test(link)) return "Loom";
      if (/vimeo/i.test(link)) return "Vimeo";
      if (/wistia/i.test(link)) return "Wistia";
    }
    if (meta.videoLenMs || meta.videoThumbnail) return "Skool";
    return null;
  }

  // ---------- lista de lecciones del curso ----------

  function listLessons(data) {
    const props = propsOf(data);
    const tree = props.course;
    const lessons = [];
    let course = "";

    if (tree && typeof tree === "object" && tree.course) {
      course = (tree.course.metadata && tree.course.metadata.title) || "";
      const visit = (node, section) => {
        if (!node || typeof node !== "object") return;
        const unit = node.course || {};
        const meta = unit.metadata || {};
        let childSection = section;
        if (unit.unitType === "module") {
          lessons.push({
            id: unit.id,
            title: meta.title || "Lección",
            section,
            source: sourceOf(meta),
            locked: meta.hasAccess === 0,
            videoLink: linksOf(meta)[0] || null,
          });
        } else if (unit !== tree.course && meta.title) {
          childSection = meta.title;
        }
        for (const child of node.children || []) visit(child, childSection);
      };
      visit(tree, "");
    }

    // Las lecciones sin video (source null) también se listan: pueden traer texto.
    return {
      course: course || document.title.replace(/\s*[|·-]\s*Skool\s*$/i, ""),
      lessons,
    };
  }

  // ---------- video de una lección ----------

  function mediaFrom(data, lessonId) {
    const props = propsOf(data);
    let meta = {};
    for (const obj of walk(props.course || props)) {
      if (obj.id === lessonId && obj.metadata) {
        meta = obj.metadata;
        break;
      }
    }

    const wanted = videoIdsOf(meta);
    const players = [];
    for (const obj of walk(props)) {
      if (typeof obj.playbackId === "string" && obj.playbackId) players.push(obj);
    }
    let chosen = players.filter((p) => wanted.includes(p.id));
    // pageProps.video es el video de la lección pedida; si trae id, debe coincidir.
    const own = props.video;
    if (!chosen.length && own && own.playbackId && (!wanted.length || !own.id || wanted.includes(own.id))) {
      chosen = [own];
    }

    const urls = chosen.map((p) =>
      `${STREAM}/${encodeURIComponent(p.playbackId)}.m3u8` +
      (p.playbackToken ? `?token=${encodeURIComponent(p.playbackToken)}` : ""));
    for (const m of JSON.stringify(meta).matchAll(MEDIA_RE)) urls.push(m[0]);

    return {
      urls: [...new Set(urls)],
      embeds: linksOf(meta),
      processing: chosen.some((p) => p.status && p.status !== "ready"),
      expectsNative: wanted.length > 0,
    };
  }

  // Texto y recursos de la lección, sin procesar (los convierte lessontext.js).
  function textFrom(data, lessonId) {
    let meta = null;
    for (const obj of walk(propsOf(data))) {
      if (obj.id !== lessonId || !obj.metadata) continue;
      if (!meta) meta = obj.metadata;
      if (obj.metadata.desc) {
        meta = obj.metadata;
        break;
      }
    }
    meta = meta || {};
    return {
      desc: meta.desc || meta.description || "",
      resources: meta.resources || null,
      url: lessonUrl(lessonId),
    };
  }

  function lessonUrl(lessonId) {
    const url = new URL(location.href);
    url.searchParams.set("md", lessonId);
    return url.href;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "list-lessons") {
      fetchNextData(location.href)
        .catch(() => parseNextData(document))
        .then((data) => sendResponse(listLessons(data)))
        .catch((err) => sendResponse({ course: "", lessons: [], error: String(err) }));
      return true;
    }
    if (msg.type === "resolve-lesson") {
      fetchNextData(lessonUrl(msg.lessonId))
        .then((data) => sendResponse({ ok: true, ...mediaFrom(data, msg.lessonId), text: textFrom(data, msg.lessonId) }))
        .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
      return true;
    }
  });
})();
