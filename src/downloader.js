// downskool - procesa una cola de descargas.
// Para cada elemento: encuentra la fuente del video (pidiéndole a la pestaña de
// Skool que lea la lección), elige la calidad, baja los fragmentos HLS en
// paralelo y entrega el archivo en el formato pedido (MP4, M4A, MP3 o WAV).
// Junto al video se guarda el texto de la lección (.md) si se pidió.
// Lo que el navegador no puede bajar (YouTube) se junta en comandos de yt-dlp.

const $ = (id) => document.getElementById(id);
const status = (t) => ($("status").textContent = t);
const detail = (t) => ($("detail").textContent = t);
const CONCURRENCY = 6;
const FORMAT_LABEL = { mp4: "MP4", m4a: "M4A", mp3: "MP3", wav: "WAV" };
const AUDIO_ONLY = new Set(["m4a", "mp3", "wav"]);

let converterModule = null;
const loadConverter = () => (converterModule ||= import("./convert.mjs"));

function safeName(name) {
  return (name || "video")
    .replace(/\s*[|·-]\s*Skool\s*$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f~%]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 100) || "video";
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
const pad2 = (n) => String(n).padStart(2, "0");

// Ruta relativa (sin extensión) de una lección: Curso/01 - Módulo/01 - Lección.
// Si el título ya empieza con su número ("04 — Demo"), no se repite.
function lessonPath(item, folder) {
  const sectionDir = item.section ? `${pad2(item.sectionNumber || 1)} - ${safeName(item.section)}/` : "";
  const number = item.section ? item.numberInSection : item.number;
  const ownNumber = /^\d{1,3}\s*[-—–.:)]/.test((item.title || "").trim());
  return folder + sectionDir + (number && !ownNumber ? `${pad2(number)} - ` : "") + safeName(item.title);
}

// ---------- red ----------

function fatalHttp(url, res) {
  const err = new Error(`${new URL(url).hostname} rechazó la descarga (HTTP ${res.status}); el enlace pudo caducar`);
  err.fatal = true;
  return err;
}

async function fetchWithRetry(url, { range, as = "bytes", init = {} } = {}, tries = 4) {
  const headers = { ...(init.headers || {}), ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) };
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { credentials: "omit", ...init, headers });
      if ([401, 403, 410].includes(res.status)) throw fatalHttp(url, res);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (as === "text") return await res.text();
      if (as === "json") return await res.json();
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      if (err.fatal) throw err;
      if (attempt >= tries) throw new Error(`no se pudo descargar ${new URL(url).hostname}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 600 * attempt));
    }
  }
}

// Baja un archivo completo a memoria, con progreso (para convertirlo después).
async function fetchBlob(url, onProgress) {
  const res = await fetch(url, { credentials: "omit" });
  if ([401, 403, 410].includes(res.status)) throw fatalHttp(url, res);
  if (!res.ok) throw new Error(`no se pudo descargar ${new URL(url).hostname}: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.byteLength;
    onProgress(total ? got / total : 0, `${mb(got)}${total ? ` de ${mb(total)}` : ""}`);
  }
  return new Blob(parts);
}

// ---------- resolver la fuente de un video ----------

const isYouTube = (link) => /youtube\.com|youtu\.be/i.test(link || "");

async function fromLoom(link) {
  const id = (link.match(/loom\.com\/(?:share|embed)\/([a-f0-9]{16,})/i) || [])[1];
  if (!id) throw new Error("enlace de Loom no reconocido");
  for (const kind of ["transcoded-url", "raw-url"]) {
    try {
      const r = await fetchWithRetry(`https://www.loom.com/api/campaigns/sessions/${id}/${kind}`, {
        as: "json",
        init: { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      }, 2);
      if (r && r.url) return { url: r.url, type: /\.m3u8/i.test(r.url) ? "hls" : "mp4" };
    } catch { /* probar la siguiente */ }
  }
  throw new Error("Loom no entregó el video (puede ser privado)");
}

async function fromVimeo(link, job) {
  const id = (link.match(/vimeo\.com\/(?:video\/)?(\d+)/) || [])[1];
  if (!id) throw new Error("enlace de Vimeo no reconocido");
  const hash = (link.match(/[?&]h=([a-z0-9]+)/i) || link.match(/vimeo\.com\/\d+\/([a-z0-9]+)/i) || [])[1];
  // La regla de background.js manda Referer de Skool: los videos restringidos al dominio lo exigen.
  const cfg = await fetchWithRetry(`https://player.vimeo.com/video/${id}/config${hash ? `?h=${hash}` : ""}`, { as: "json" }, 2);
  const files = (cfg.request && cfg.request.files) || {};
  const hls = files.hls && files.hls.cdns && (files.hls.cdns[files.hls.default_cdn] || Object.values(files.hls.cdns)[0]);
  const progressive = (files.progressive || []).filter((p) => p.url).sort((a, b) => b.height - a.height);
  const max = job.quality === "best" ? Infinity : Number(job.quality);
  const prog = progressive.find((p) => p.height <= max) || progressive[progressive.length - 1];

  // Para solo audio conviene HLS (el audio viene aparte y pesa poco).
  if (AUDIO_ONLY.has(job.format) && hls && hls.url) return { url: hls.url, type: "hls" };
  if (prog) return { url: prog.url, type: "mp4" };
  if (hls && hls.url) return { url: hls.url, type: "hls" };
  throw new Error("Vimeo no entregó el video (puede ser privado)");
}

async function fromLink(link, job) {
  if (isYouTube(link)) return { type: "external", url: link, why: "YouTube" };
  if (/loom\.com/i.test(link)) return fromLoom(link);
  if (/vimeo\.com/i.test(link)) return fromVimeo(link, job);
  throw new Error(`fuente no soportada en el navegador: ${new URL(link).hostname}`);
}

// Pide a la pestaña de Skool los datos frescos de una lección: video y texto.
async function fetchLesson(job, item) {
  const res = await chrome.tabs.sendMessage(job.tabId, { type: "resolve-lesson", lessonId: item.lessonId })
    .catch(() => ({ ok: false, error: "la pestaña de Skool se cerró o se recargó; vuelve a abrir el curso e inténtalo de nuevo" }));
  if (!res.ok) throw new Error(res.error);
  return res;
}

// `lesson` es la respuesta de fetchLesson (o `lessonError` si falló).
// Devuelve null si la lección es de solo texto y no trae video.
async function resolveSource(job, item, lesson, lessonError) {
  if (item.kind === "url") return { url: item.url, type: item.type };
  if (item.source === "YouTube" && isYouTube(item.videoLink)) {
    return { type: "external", url: item.videoLink, why: "YouTube" };
  }

  if (!lesson) throw lessonError;
  const res = lesson;
  if (res.processing) throw new Error("Skool todavía está procesando este video; inténtalo más tarde");

  const hls = res.urls.find((u) => /\.m3u8/i.test(u));
  if (hls) return { url: hls, type: "hls" };
  const mp4 = res.urls.find((u) => /\.mp4/i.test(u));
  if (mp4) return { url: mp4, type: "mp4" };

  const link = res.embeds[0] || item.videoLink;
  if (link) {
    try {
      return await fromLink(link, job);
    } catch (err) {
      err.link = link; // para ofrecerlo con yt-dlp
      throw err;
    }
  }
  if (res.expectsNative) {
    throw new Error("Skool no entregó el enlace del video. Abre la lección, dale play unos segundos y descárgala desde el panel");
  }
  if (item.textOnly) return null;
  throw new Error("esta lección no tiene un video que downskool reconozca");
}

// Guarda el texto de la lección junto al video. Devuelve true si había texto.
async function saveLessonText(item, lesson, base) {
  const markdown = DownskoolText.lessonMarkdown({ title: item.title, ...(lesson.text || {}) });
  if (!markdown) return false;
  await saveBlob([markdown], `${base}.md`, "text/markdown;charset=utf-8");
  return true;
}

// ---------- HLS ----------

async function loadMediaPlaylist(url) {
  const text = await fetchWithRetry(url, { as: "text" });
  const pl = DownskoolHLS.parseMedia(text, url);
  if (pl.encrypted) throw new Error("el video está cifrado y no se puede descargar");
  if (!pl.segments.length) throw new Error("la lista de reproducción está vacía");
  return pl;
}

async function downloadSegments(playlist, onSegment) {
  const { segments } = playlist;
  const out = new Array(segments.length);
  let next = 0;
  async function worker() {
    while (next < segments.length) {
      const i = next++;
      out[i] = await fetchWithRetry(segments[i].uri, { range: segments[i].range });
      onSegment(out[i].byteLength);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (playlist.init) out.unshift(await fetchWithRetry(playlist.init.uri, { range: playlist.init.range }));
  return out;
}

// Devuelve los fragmentos de video y/o audio según el formato pedido.
async function downloadHls(url, job, onProgress) {
  const audioOnly = AUDIO_ONLY.has(job.format);
  const text = await fetchWithRetry(url, { as: "text" });
  let videoUrl = url, audioUrl = null, label = "";
  if (DownskoolHLS.isMaster(text)) {
    const variant = DownskoolHLS.pickVariant(DownskoolHLS.parseMaster(text, url), { quality: job.quality, audioOnly });
    if (!variant) throw new Error("no hay calidades disponibles");
    videoUrl = variant.uri;
    audioUrl = variant.audioUri;
    label = audioOnly ? "audio" : variant.height ? `${variant.height}p` : "";
  }
  // Si solo se quiere el audio y viene aparte, no hace falta bajar el video.
  const video = audioOnly && audioUrl ? null : await loadMediaPlaylist(videoUrl);
  const audio = audioUrl ? await loadMediaPlaylist(audioUrl) : null;
  const total = (video ? video.segments.length : 0) + (audio ? audio.segments.length : 0);
  let done = 0, bytes = 0;
  const tick = (b) => {
    done++;
    bytes += b;
    onProgress(done / total, `${label ? `${label} · ` : ""}${done}/${total} fragmentos · ${mb(bytes)}`);
  };
  const videoChunks = video ? await downloadSegments(video, tick) : null;
  const audioChunks = audio ? await downloadSegments(audio, tick) : null;
  return { videoChunks, audioChunks, container: (video || audio).format };
}

// ---------- conversión y guardado ----------

function transmuxToMp4(chunks) {
  const transmuxer = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: false });
  const parts = [];
  let init = null;
  transmuxer.on("data", (seg) => {
    if (!init) init = new Uint8Array(seg.initSegment);
    parts.push(new Uint8Array(seg.data));
  });
  for (const chunk of chunks) {
    transmuxer.push(chunk);
    transmuxer.flush();
  }
  if (!init || !parts.length) throw new Error("conversión vacía");
  return [init, ...parts];
}

// Nombre sin tildes ni símbolos, por si el sistema rechaza el original.
function asciiPath(path) {
  return path.split("/").map((part) =>
    part.normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[–—]/g, "-").replace(/[^\x20-\x7e]+/g, "").replace(/\s{2,}/g, " ")
      .replace(/^[.\s-]+|[.\s-]+$/g, "") || "video").join("/");
}

const saved = []; // { id, relative } de lo descargado en este trabajo

// ---------- carpeta elegida (fuera de Descargas) ----------
// chrome.downloads solo guarda dentro de Descargas. Para otra carpeta, la persona
// la elige una vez en el selector de Chrome y se escribe en ella con ese permiso.

let destDir = null;  // FileSystemDirectoryHandle de la carpeta elegida, o null (Descargas)
let destPath = "";   // su ruta tal como se escribió en el panel (para mostrarla y para yt-dlp)

// Los permisos de carpeta se recuerdan en IndexedDB (ahí sí se pueden guardar).
function folderStore(mode, run) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("downskool", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("folders");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("folders", mode);
      const req = run(tx.objectStore("folders"));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    };
  });
}
const loadFolder = (key) => folderStore("readonly", (store) => store.get(key)).catch(() => null);
const rememberFolder = (key, handle) => folderStore("readwrite", (store) => store.put(handle, key)).catch(() => {});

// La carpeta sigue existiendo y se puede escribir en ella sin preguntar.
async function folderReady(handle) {
  try {
    if ((await handle.queryPermission({ mode: "readwrite" })) !== "granted") return false;
    await handle.keys().next();
    return true;
  } catch {
    return false;
  }
}

/**
 * Consigue la carpeta de destino cuando está fuera de Descargas. Si hace falta,
 * espera a que la persona la elija o confirme el permiso (Chrome exige un clic).
 * @returns {Promise<FileSystemDirectoryHandle|null>} null = usar Descargas.
 */
async function openDestination(dest) {
  if (!dest.target || !window.showDirectoryPicker) return null;
  const key = DownskoolDest.destKey(dest.target);
  const name = dest.target.split(/[\\/]/).pop();
  let handle = await loadFolder(key);
  if (handle && (await folderReady(handle))) return handle;

  status("Falta un paso para empezar");
  const show = (problem) => {
    $("grant-text").textContent = (problem ? `${problem} ` : "") + (handle
      ? `Confirma el permiso para guardar en ${dest.target}.`
      : `Para guardar en ${dest.target}, pulsa el botón y elige esa carpeta. El navegador te pedirá permiso para guardar en ella; downskool la recuerda para las próximas veces.`);
    $("grant-ok").textContent = handle ? "Permitir guardar en la carpeta" : `Elegir la carpeta «${name}»`;
  };
  show("");
  $("grant").hidden = false;
  try {
    return await new Promise((resolve) => {
      $("grant-skip").onclick = () => resolve(null);
      $("grant-ok").onclick = async () => {
        let problem = "";
        try {
          if (handle) {
            const state = await handle.requestPermission({ mode: "readwrite" });
            if (state === "granted" && (await folderReady(handle))) return resolve(handle);
            handle = null; // sin permiso, o la carpeta ya no existe: elegirla de nuevo
          } else {
            const picked = await window.showDirectoryPicker({ id: "downskool", mode: "readwrite", startIn: "documents" });
            // La ruta del panel es la que se muestra y la que usa yt-dlp: deben coincidir.
            if (picked.name.toLowerCase() !== name.toLowerCase()) {
              problem = `Elegiste «${picked.name}», pero la ruta del panel termina en «${name}». Elige «${name}» o cambia la ruta en el panel.`;
            } else if (await folderReady(picked)) {
              await rememberFolder(key, picked);
              return resolve(picked);
            } else {
              problem = "El navegador no dio permiso para escribir en esa carpeta.";
            }
          }
        } catch (err) {
          // AbortError: se cerró el selector sin elegir nada.
          if (err.name !== "AbortError") problem = `No se pudo usar la carpeta (${err.message}).`;
        }
        show(problem);
      };
    });
  } finally {
    $("grant").hidden = true;
  }
}

// Crea el archivo (y sus carpetas) sin pisar uno que ya exista: "nombre (1).ext".
async function createFile(relative) {
  const parts = relative.split("/");
  const name = parts.pop();
  let dir = destDir;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 0; ; n++) {
    const candidate = n ? `${stem} (${n})${ext}` : name;
    const exists = await dir.getFileHandle(candidate).then(() => true, (err) => {
      if (err.name === "NotFoundError") return false;
      throw err;
    });
    if (!exists) return { dir, name: candidate, file: await dir.getFileHandle(candidate, { create: true }) };
  }
}

// Escribe un Blob o un ReadableStream en la carpeta elegida.
async function writeToFolder(data, relative) {
  let target;
  try {
    target = await createFile(relative);
  } catch (err) {
    if (err.name !== "TypeError") throw err; // TypeError: nombre no permitido
    target = await createFile(asciiPath(relative));
  }
  try {
    const writable = await target.file.createWritable();
    if (data instanceof Blob) {
      await writable.write(data);
      await writable.close();
    } else {
      await data.pipeTo(writable);
    }
  } catch (err) {
    await target.dir.removeEntry(target.name).catch(() => {}); // no dejar un archivo vacío
    throw new Error(`no se pudo escribir en la carpeta (${err.message})`);
  }
}

// Baja un archivo directo a la carpeta elegida sin pasarlo por memoria.
// Devuelve false si el servidor no deja leerlo desde la extensión.
async function streamToFolder(url, relative, onProgress) {
  let res;
  try {
    res = await fetch(url, { credentials: "omit" });
  } catch {
    return false;
  }
  if ([401, 403, 410].includes(res.status)) throw fatalHttp(url, res);
  if (!res.ok || !res.body) return false;
  const total = Number(res.headers.get("content-length")) || 0;
  let got = 0;
  const meter = new TransformStream({
    transform(chunk, controller) {
      got += chunk.byteLength;
      onProgress(total ? got / total : 0, `${mb(got)}${total ? ` de ${mb(total)}` : ""}`);
      controller.enqueue(chunk);
    },
  });
  await writeToFolder(res.body.pipeThrough(meter), relative);
  return true;
}

// ---------- guardar ----------

async function startDownload(url, filename) {
  let id;
  try {
    id = await chrome.downloads.download({ url, filename, conflictAction: "uniquify" });
  } catch (err) {
    if (!/filename/i.test(String(err && err.message))) throw err;
    filename = asciiPath(filename);
    id = await chrome.downloads.download({ url, filename, conflictAction: "uniquify" });
  }
  saved.push({ id, relative: filename });
  return id;
}

async function saveBlob(parts, filename, type) {
  if (destDir) return writeToFolder(new Blob(parts, { type }), filename);
  const url = URL.createObjectURL(new Blob(parts, { type }));
  try {
    await waitForDownload(await startDownload(url, filename));
  } finally {
    URL.revokeObjectURL(url);
  }
}

function waitForDownload(id) {
  return new Promise((resolve, reject) => {
    const settle = (state, error) => {
      if (state !== "complete" && state !== "interrupted") return;
      chrome.downloads.onChanged.removeListener(listener);
      if (state === "complete") resolve();
      else reject(new Error(`descarga interrumpida${error ? ` (${error})` : ""}`));
    };
    const listener = (delta) => {
      if (delta.id === id && delta.state) settle(delta.state.current, delta.error && delta.error.current);
    };
    chrome.downloads.onChanged.addListener(listener);
    // Un archivo pequeño puede terminar antes de empezar a escuchar: mirar el estado actual.
    chrome.downloads.search({ id })
      .then(([item]) => item && settle(item.state, item.error))
      .catch(() => {});
  });
}

// Convierte lo descargado al formato pedido y lo guarda. Devuelve una nota si
// hubo que guardar algo sin convertir.
async function finish(media, base, format, onProgress) {
  const { videoChunks, audioChunks, container } = media;

  // MP4 desde un solo stream MPEG-TS (videos nativos de Skool): mux.js, el camino más probado.
  if (format === "mp4" && videoChunks && !audioChunks && container === "ts") {
    let parts = null;
    try {
      parts = transmuxToMp4(videoChunks);
    } catch (err) {
      console.warn("downskool: mux.js no pudo convertir, se usa mediabunny", err);
    }
    if (parts) {
      await saveBlob(parts, `${base}.mp4`, "video/mp4");
      return null;
    }
  }

  const label = format === "mp4" ? (audioChunks ? "uniendo video y audio" : "preparando el MP4") : `convirtiendo a ${FORMAT_LABEL[format]}`;
  onProgress(0, `${label}…`);
  const run = async (main) => {
    const { convert } = await loadConverter();
    return convert({
      main,
      audio: audioChunks ? new Blob(audioChunks) : null,
      format,
      onProgress: (p) => onProgress(p, `${label}… ${Math.round(p * 100)}%`),
    });
  };

  let result = null;
  let failure = null;
  try {
    result = await run(videoChunks ? new Blob(videoChunks) : null);
  } catch (err) {
    failure = err;
    // Plan B para MPEG-TS: pasarlo antes a MP4 con mux.js y convertir eso.
    if (videoChunks && container === "ts" && !/no tiene pista de audio/.test(err.message)) {
      console.warn("downskool: reintento vía mux.js", err);
      try {
        result = await run(new Blob(transmuxToMp4(videoChunks)));
      } catch (err2) {
        failure = err2;
      }
    }
  }
  if (result) {
    await saveBlob([result.blob], `${base}.${result.ext}`, result.blob.type);
    return null;
  }
  if (format !== "mp4" || !videoChunks) throw failure;
  // No perder la descarga: guardar las pistas tal cual.
  await saveBlob(videoChunks, `${base}.${container === "ts" ? "ts" : "mp4"}`, container === "ts" ? "video/mp2t" : "video/mp4");
  if (audioChunks) await saveBlob(audioChunks, `${base} (audio).${container === "ts" ? "ts" : "m4a"}`, "audio/mp4");
  return `guardado sin unir/convertir (${failure.message})`;
}

async function processItem(src, base, job, onProgress) {
  const audioOnly = AUDIO_ONLY.has(job.format);
  if (src.type === "mp4" && !audioOnly) {
    onProgress(0, "descarga directa");
    if (destDir && (await streamToFolder(src.url, `${base}.mp4`, onProgress))) return null;
    await waitForDownload(await startDownload(src.url, `${base}.mp4`));
    return destDir ? "guardado en tu carpeta de Descargas (el servidor del video no dejó escribirlo en la carpeta elegida)" : null;
  }
  // Descarga 0–85 %, conversión 85–100 %.
  const dl = (p, text) => onProgress(p * 0.85, text);
  const media = src.type === "mp4"
    ? { videoChunks: [await fetchBlob(src.url, dl)], audioChunks: null, container: "mp4" }
    : await downloadHls(src.url, job, dl);
  return finish(media, base, job.format, (p, text) => onProgress(0.85 + p * 0.15, text));
}

// ---------- yt-dlp ----------

async function downloadsDir() {
  if (destDir) return destPath;
  for (const { id, relative } of [...saved].reverse()) {
    const [item] = await chrome.downloads.search({ id }).catch(() => []);
    const dir = item && DownskoolYtDlp.downloadsDirFrom(item.filename, relative);
    if (dir) return dir;
  }
  return "~/Downloads";
}

function codeBlock(text) {
  const wrap = el("div", "code");
  const pre = el("pre", "", text);
  const btn = el("button", "copy", "Copiar");
  btn.addEventListener("click", async () => {
    await navigator.clipboard.writeText(text.replace(/\n/g, "\r\n"));
    btn.textContent = "¡Copiado!";
    setTimeout(() => (btn.textContent = "Copiar"), 1500);
  });
  wrap.append(pre, btn);
  return wrap;
}

async function renderYtDlp(external, job) {
  const dir = await downloadsDir();
  const commands = external.map((x) => DownskoolYtDlp.ytdlpCommand({
    url: x.url, output: x.output, format: job.format, quality: job.quality, dir,
  }));
  const box = $("ytdlp");
  box.hidden = false;
  box.append(
    el("h2", "", `Descargar con yt-dlp (${external.length})`),
    el("p", "muted", "Estos videos no se pueden bajar desde el navegador (YouTube no lo permite). " +
      "yt-dlp es un programa gratuito que sí puede, y los guarda en la misma carpeta y formato."),
  );
  const list = el("ul", "small", "");
  for (const x of external) list.append(el("li", "", `${x.title}${x.reason ? ` — ${x.reason}` : ""}`));
  box.append(list,
    el("h3", "", "1. Instálalo (solo la primera vez)"),
    el("p", "muted small", "En el Símbolo del sistema. Después ciérralo y ábrelo de nuevo."),
    codeBlock(DownskoolYtDlp.YTDLP_INSTALL.join("\n")),
    el("h3", "", "2. Copia y pega esto en el Símbolo del sistema"),
    codeBlock(commands.join("\n")));
}

// ---------- cola ----------

async function main() {
  const jobId = new URLSearchParams(location.search).get("job");
  const job = jobId && (await chrome.storage.session.get(jobId))[jobId];
  if (!job) throw new Error("No se encontró la lista de descargas. Vuelve a intentarlo desde el panel.");
  job.format = FORMAT_LABEL[job.format] ? job.format : "mp4";
  job.quality = job.quality || "best";

  $("name").textContent = job.course || job.items[0].title;
  $("options").textContent = `Formato: ${FORMAT_LABEL[job.format]}` +
    (AUDIO_ONLY.has(job.format) ? " (solo audio)" : ` · Calidad: ${job.quality === "best" ? "máxima" : `${job.quality}p`}`) +
    (job.text ? " · Con el texto de cada lección" : "");
  document.title = `downskool · ${$("name").textContent}`;

  const rows = job.items.map((item) => {
    const state = el("span", "muted", "en espera");
    const li = document.createElement("li");
    li.append(el("span", "", item.title), " ", state);
    $("queue").append(li);
    return state;
  });

  // Destino: la carpeta elegida, o [subcarpeta/] dentro de Descargas. Luego, Curso/.
  const dest = DownskoolDest.parseDest(job.dest);
  destDir = await openDestination(dest);
  destPath = destDir ? dest.target : "";
  const folder = [destDir ? "" : dest.subdir, job.course && safeName(job.course)]
    .filter(Boolean).map((part) => `${part}/`).join("");
  const place = destDir ? destPath : "tu carpeta de descargas";

  let ok = 0, failed = 0, empty = 0;
  const external = [];
  for (let i = 0; i < job.items.length; i++) {
    const item = job.items[i];
    const row = rows[i];
    const base = lessonPath(item, folder);
    status(`(${i + 1}/${job.items.length}) ${item.title}`);
    row.textContent = "buscando video…";
    row.className = "muted";
    // Texto de la lección: `texted` se añade al estado de la fila.
    let lesson = null, lessonError = null, texted = "";
    if (item.lessonId) {
      try {
        lesson = await fetchLesson(job, item);
      } catch (err) {
        lessonError = err;
      }
    }
    if (job.text && item.lessonId) {
      try {
        if (!lesson) throw lessonError;
        if (await saveLessonText(item, lesson, base)) texted = " · texto guardado";
      } catch (err) {
        texted = ` · no se pudo guardar el texto (${err.message})`;
      }
    }
    try {
      const src = await resolveSource(job, item, lesson, lessonError);
      if (!src) {
        // Lección de solo texto.
        const done = texted === " · texto guardado";
        row.textContent = done ? "✓ texto guardado (no tiene video)" : `— sin video${texted || " ni texto"}`;
        row.className = done ? "ok" : "muted";
        if (done) ok++;
        else empty++;
        continue;
      }
      if (src.type === "external") {
        external.push({ title: item.title, url: src.url, output: base, reason: "" });
        row.textContent = `→ con yt-dlp (abajo)${texted}`;
        row.className = "muted";
        continue;
      }
      row.textContent = "descargando…";
      const note = await processItem(src, base, job, (p, text) => {
        $("bar").value = (i + p) / job.items.length;
        detail(text);
      });
      row.textContent = `✓ ${note || "listo"}${texted}`;
      row.className = "ok";
      ok++;
    } catch (err) {
      // Si había un enlace externo (Vimeo, Loom...), yt-dlp puede intentarlo.
      const link = err.link || item.videoLink;
      if (link && /^https?:/.test(link)) {
        external.push({ title: item.title, url: link, output: base, reason: err.message });
        row.textContent = `✗ ${err.message} → prueba con yt-dlp (abajo)${texted}`;
      } else {
        row.textContent = `✗ ${err.message}${texted}`;
        failed++;
      }
      row.className = "err";
    } finally {
      $("bar").value = (i + 1) / job.items.length;
    }
  }

  detail("");
  const parts = [`${ok} de ${job.items.length} descargado(s) en ${place}${folder ? ` › ${folder}` : ""}`];
  if (external.length) parts.push(`${external.length} para bajar con yt-dlp (instrucciones abajo)`);
  if (empty) parts.push(`${empty} sin video ni texto`);
  if (failed) parts.push(`${failed} con error (revisa la lista)`);
  const allGood = failed === 0 && external.every((x) => !x.reason);
  status(`${allGood ? "¡Listo! " : "Terminado: "}${parts.join(" · ")}.`);
  if (external.length) await renderYtDlp(external, job);
  chrome.storage.session.remove(jobId);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

main().catch((err) => {
  status(`Error: ${err.message}`);
  document.body.classList.add("error");
});
