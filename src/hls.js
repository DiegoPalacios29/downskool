// downskool - utilidades para leer listas HLS (.m3u8). Sin dependencias, para
// poder usarlas tanto en la página de descarga como en las pruebas con Node.

function parseAttributes(line) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(line))) attrs[m[1]] = m[2].replace(/^"|"$/g, "");
  return attrs;
}

function resolve(uri, base) {
  return new URL(uri, base).href;
}

function isMaster(text) {
  return /#EXT-X-STREAM-INF/.test(text);
}

// Devuelve las variantes ordenadas de mayor a menor calidad.
function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const audio = {};
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("#EXT-X-MEDIA:")) {
      const a = parseAttributes(line);
      if (a.TYPE === "AUDIO" && a.URI) {
        const group = (audio[a["GROUP-ID"]] ||= []);
        group.push({ uri: resolve(a.URI, baseUrl), isDefault: a.DEFAULT === "YES", name: a.NAME });
      }
    } else if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const a = parseAttributes(line);
      let j = i + 1;
      while (j < lines.length && (!lines[j] || lines[j].startsWith("#"))) j++;
      if (j >= lines.length) break;
      const [w, h] = (a.RESOLUTION || "0x0").split("x").map(Number);
      variants.push({
        uri: resolve(lines[j], baseUrl),
        bandwidth: Number(a.BANDWIDTH || 0),
        width: w,
        height: h,
        audioGroup: a.AUDIO || null,
      });
      i = j;
    }
  }
  variants.sort((x, y) => y.height - x.height || y.bandwidth - x.bandwidth);
  for (const v of variants) {
    const group = v.audioGroup && audio[v.audioGroup];
    v.audioUri = group ? (group.find((g) => g.isDefault) || group[0]).uri : null;
  }
  return variants;
}

function parseMedia(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const segments = [];
  let init = null;
  let encrypted = false;
  let pendingRange = null;
  let nextOffset = 0;

  const range = (spec) => {
    const [len, off] = spec.split("@");
    const start = off !== undefined ? Number(off) : nextOffset;
    nextOffset = start + Number(len);
    return { start, end: start + Number(len) - 1 };
  };

  for (const line of lines) {
    if (line.startsWith("#EXT-X-KEY:")) {
      const a = parseAttributes(line);
      if (a.METHOD && a.METHOD !== "NONE") encrypted = true;
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const a = parseAttributes(line);
      init = { uri: resolve(a.URI, baseUrl), range: a.BYTERANGE ? range(a.BYTERANGE) : null };
    } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
      pendingRange = range(line.slice("#EXT-X-BYTERANGE:".length));
    } else if (line && !line.startsWith("#")) {
      segments.push({ uri: resolve(line, baseUrl), range: pendingRange });
      pendingRange = null;
    }
  }

  const sample = (segments[0] && new URL(segments[0].uri).pathname) || "";
  const format = init || /\.(m4s|mp4)$/i.test(sample) ? "fmp4" : "ts";
  return { segments, init, encrypted, format };
}

const DownskoolHLS = { parseAttributes, parseMaster, parseMedia, isMaster };
if (typeof module !== "undefined") module.exports = DownskoolHLS;
else self.DownskoolHLS = DownskoolHLS;
