// downskool - procesa una cola de descargas.
// Para cada elemento: encuentra la fuente del video (pidiéndole a la pestaña de
// Skool que lea la lección), elige la mejor calidad, baja los fragmentos HLS en
// paralelo, convierte MPEG-TS a MP4 con mux.js y guarda con chrome.downloads.

const $ = (id) => document.getElementById(id);
const status = (t) => ($("status").textContent = t);
const detail = (t) => ($("detail").textContent = t);
const CONCURRENCY = 6;

function safeName(name) {
  return (name || "video")
    .replace(/\s*[|·-]\s*Skool\s*$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f~]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 100) || "video";
}

// ---------- red ----------

async function fetchWithRetry(url, { range, as = "bytes", init = {} } = {}, tries = 4) {
  const headers = { ...(init.headers || {}), ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) };
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { credentials: "omit", ...init, headers });
      if ([401, 403, 410].includes(res.status)) {
        const err = new Error(`${new URL(url).hostname} rechazó la descarga (HTTP ${res.status}); el enlace pudo caducar`);
        err.fatal = true;
        throw err;
      }
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

// ---------- resolver la fuente de un video ----------

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

async function fromVimeo(link) {
  const id = (link.match(/vimeo\.com\/(?:video\/)?(\d+)/) || [])[1];
  if (!id) throw new Error("enlace de Vimeo no reconocido");
  const hash = (link.match(/[?&]h=([a-z0-9]+)/i) || link.match(/vimeo\.com\/\d+\/([a-z0-9]+)/i) || [])[1];
  const cfg = await fetchWithRetry(`https://player.vimeo.com/video/${id}/config${hash ? `?h=${hash}` : ""}`, { as: "json" }, 2);
  const prog = (cfg.request?.files?.progressive || []).sort((a, b) => b.height - a.height)[0];
  if (prog) return { url: prog.url, type: "mp4" };
  const hls = cfg.request?.files?.hls;
  const cdn = hls && (hls.cdns[hls.default_cdn] || Object.values(hls.cdns)[0]);
  if (cdn) return { url: cdn.url, type: "hls" };
  throw new Error("Vimeo no entregó el video (puede ser privado)");
}

async function fromLink(link) {
  if (/loom\.com/i.test(link)) return fromLoom(link);
  if (/vimeo\.com/i.test(link)) return fromVimeo(link);
  if (/youtube\.com|youtu\.be/i.test(link)) throw new Error("es un video de YouTube (downskool no descarga YouTube)");
  throw new Error(`fuente no soportada: ${new URL(link).hostname}`);
}

async function resolveSource(job, item) {
  if (item.kind === "url") return { url: item.url, type: item.type };
  if (item.source === "YouTube") throw new Error("es un video de YouTube (downskool no descarga YouTube)");

  const res = await chrome.tabs.sendMessage(job.tabId, { type: "resolve-lesson", lessonId: item.lessonId })
    .catch(() => ({ ok: false, error: "la pestaña de Skool se cerró o se recargó; vuelve a abrir el curso e inténtalo de nuevo" }));
  if (!res.ok) throw new Error(res.error);
  if (res.processing) throw new Error("Skool todavía está procesando este video; inténtalo más tarde");

  const hls = res.urls.find((u) => /\.m3u8/i.test(u));
  if (hls) return { url: hls, type: "hls" };
  const mp4 = res.urls.find((u) => /\.mp4/i.test(u));
  if (mp4) return { url: mp4, type: "mp4" };

  const link = res.embeds[0] || item.videoLink;
  if (link) return fromLink(link);
  throw new Error(res.expectsNative
    ? "Skool no entregó el enlace del video. Abre la lección, dale play unos segundos y descárgala desde el panel"
    : "esta lección no tiene un video que downskool reconozca");
}

// ---------- HLS ----------

async function loadMediaPlaylist(url) {
  const text = await fetchWithRetry(url, { as: "text" });
  const pl = DownskoolHLS.parseMedia(text, url);
  if (pl.encrypted) throw new Error("el video está cifrado y no se puede descargar");
  if (!pl.segments.length) throw new Error("la lista de reproducción está vacía");
  return pl;
}

async function downloadSegments(playlist, onProgress) {
  const { segments } = playlist;
  const out = new Array(segments.length);
  let next = 0, done = 0, bytes = 0;
  async function worker() {
    while (next < segments.length) {
      const i = next++;
      out[i] = await fetchWithRetry(segments[i].uri, { range: segments[i].range });
      bytes += out[i].byteLength;
      onProgress(++done, segments.length, bytes);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (playlist.init) out.unshift(await fetchWithRetry(playlist.init.uri, { range: playlist.init.range }));
  return out;
}

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
    part.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[\u2013\u2014]/g, "-").replace(/[^\x20-\x7e]+/g, "").replace(/\s{2,}/g, " ")
      .replace(/^[.\s-]+|[.\s-]+$/g, "") || "video").join("/");
}

async function startDownload(url, filename) {
  try {
    return await chrome.downloads.download({ url, filename, conflictAction: "uniquify" });
  } catch (err) {
    if (!/filename/i.test(String(err && err.message))) throw err;
    return chrome.downloads.download({ url, filename: asciiPath(filename), conflictAction: "uniquify" });
  }
}

async function saveBlob(chunks, filename, type) {
  const url = URL.createObjectURL(new Blob(chunks, { type }));
  try {
    await waitForDownload(await startDownload(url, filename));
  } finally {
    URL.revokeObjectURL(url);
  }
}

function waitForDownload(id) {
  return new Promise((resolve, reject) => {
    const listener = (delta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === "complete") { chrome.downloads.onChanged.removeListener(listener); resolve(); }
      if (delta.state.current === "interrupted") { chrome.downloads.onChanged.removeListener(listener); reject(new Error("descarga interrumpida")); }
    };
    chrome.downloads.onChanged.addListener(listener);
  });
}

async function downloadHls(url, base, onProgress) {
  const text = await fetchWithRetry(url, { as: "text" });
  let videoUrl = url, audioUrl = null, quality = "";
  if (DownskoolHLS.isMaster(text)) {
    const variants = DownskoolHLS.parseMaster(text, url);
    if (!variants.length) throw new Error("no hay calidades disponibles");
    ({ uri: videoUrl, audioUri: audioUrl } = variants[0]);
    quality = variants[0].height ? `${variants[0].height}p` : "";
  }
  const video = await loadMediaPlaylist(videoUrl);
  const audio = audioUrl ? await loadMediaPlaylist(audioUrl) : null;
  const total = video.segments.length + (audio ? audio.segments.length : 0);

  const v = await downloadSegments(video, (d, _n, b) => onProgress(d / total, `${quality} · ${d}/${total} fragmentos · ${(b / 1048576).toFixed(1)} MB`));
  const a = audio ? await downloadSegments(audio, (d) => onProgress((video.segments.length + d) / total, `audio · ${d}/${audio.segments.length}`)) : null;

  onProgress(1, "uniendo el archivo…");
  if (video.format === "fmp4") {
    await saveBlob(v, `${base}.mp4`, "video/mp4");
    if (a) await saveBlob(a, `${base} (audio).m4a`, "audio/mp4");
    return;
  }
  if (!a) {
    try {
      return await saveBlob(transmuxToMp4(v), `${base}.mp4`, "video/mp4");
    } catch (err) {
      console.warn("downskool: no se pudo convertir a MP4, se guarda .ts", err);
    }
  }
  await saveBlob(v, `${base}.ts`, "video/mp2t");
  if (a) await saveBlob(a, `${base} (audio).ts`, "video/mp2t");
}

// ---------- cola ----------

async function main() {
  const jobId = new URLSearchParams(location.search).get("job");
  const job = jobId && (await chrome.storage.session.get(jobId))[jobId];
  if (!job) throw new Error("No se encontró la lista de descargas. Vuelve a intentarlo desde el panel.");

  const folder = job.course ? `${safeName(job.course)}/` : "";
  const pad = String(job.items.length).length < 2 ? 2 : String(job.items.length).length;
  $("name").textContent = job.course || job.items[0].title;
  document.title = `downskool · ${$("name").textContent}`;

  const rows = job.items.map((item) => {
    const state = el("span", "muted", "en espera");
    const li = document.createElement("li");
    li.append(el("span", "", item.title), " ", state);
    $("queue").append(li);
    return state;
  });

  let ok = 0;
  for (let i = 0; i < job.items.length; i++) {
    const item = job.items[i];
    const row = rows[i];
    const base = folder + (item.number ? `${String(item.number).padStart(pad, "0")} - ` : "") + safeName(item.title);
    status(`(${i + 1}/${job.items.length}) ${item.title}`);
    row.textContent = "buscando video…";
    row.className = "muted";
    try {
      const src = await resolveSource(job, item);
      row.textContent = "descargando…";
      if (src.type === "mp4") {
        detail("descarga directa");
        await waitForDownload(await startDownload(src.url, `${base}.mp4`));
      } else {
        await downloadHls(src.url, base, (p, text) => {
          $("bar").value = (i + p) / job.items.length;
          detail(text);
        });
      }
      row.textContent = "✓ listo";
      row.className = "ok";
      ok++;
    } catch (err) {
      row.textContent = `✗ ${err.message}`;
      row.className = "err";
    }
    $("bar").value = (i + 1) / job.items.length;
  }

  detail("");
  status(ok === job.items.length
    ? `¡Listo! ${ok} video(s) en tu carpeta de descargas${folder ? ` › ${folder}` : ""}.`
    : `Terminado: ${ok} de ${job.items.length} descargados. Revisa los errores en la lista.`);
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
