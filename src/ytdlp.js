// downskool - comandos de yt-dlp para los videos que el navegador no puede bajar
// (YouTube, o un Vimeo/Loom que falló). yt-dlp es un programa gratuito y de
// código abierto: https://github.com/yt-dlp/yt-dlp
//
// Se genera una línea por video, con el mismo nombre y carpeta que usa downskool,
// para pegar en el Símbolo del sistema (cmd) o en PowerShell.

const YTDLP_INSTALL = [
  "winget install yt-dlp.yt-dlp",
  "winget install Gyan.FFmpeg",
];

// Argumentos de yt-dlp según el formato y la calidad elegidos.
function ytdlpFormatArgs(format, quality) {
  switch (format) {
    case "m4a": return ["-f", "ba[ext=m4a]/ba/b", "-x", "--audio-format", "m4a"];
    case "mp3": return ["-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "0"];
    case "wav": return ["-f", "ba/b", "-x", "--audio-format", "wav"];
    default: {
      // H.264 + AAC en MP4: lo que mejor se reproduce en Windows.
      const sort = quality && quality !== "best"
        ? `res:${Number(quality)},vcodec:h264,acodec:aac`
        : "vcodec:h264,res,acodec:aac";
      return ["-S", sort, "--merge-output-format", "mp4"];
    }
  }
}

// Comillas dobles para cmd/PowerShell. Se quitan las comillas internas y, en
// los nombres, los "%" (cmd los interpretaría como variables).
function q(value, { keepPercent = true } = {}) {
  let text = String(value).replace(/"/g, "");
  if (!keepPercent) text = text.replace(/%/g, "");
  return `"${text}"`;
}

/**
 * @param {object} p
 * @param {string} p.url     Enlace del video (YouTube, Vimeo, Loom...).
 * @param {string} p.output  Ruta relativa sin extensión, p. ej. "Curso/07 - Clase".
 * @param {string} [p.format]  mp4 | m4a | mp3 | wav
 * @param {string|number} [p.quality]  best | 1080 | 720 | 480 | 360
 * @param {string} [p.dir]   Carpeta base (la de descargas).
 */
function ytdlpCommand({ url, output, format = "mp4", quality = "best", dir = "~/Downloads" }) {
  const args = ytdlpFormatArgs(format, quality).map((a) => (a.startsWith("-") ? a : q(a)));
  return [
    "yt-dlp",
    "-P", q(dir),
    "--referer", q("https://www.skool.com/"),
    ...args,
    "-o", `${q(output, { keepPercent: false }).slice(0, -1)}.%(ext)s"`,
    q(url),
  ].join(" ");
}

// Carpeta de descargas a partir de la ruta completa de un archivo ya descargado.
// `relative` es la ruta que se pidió (p. ej. "Curso/01 - Clase.mp4").
function downloadsDirFrom(fullPath, relative) {
  if (!fullPath) return null;
  const sep = fullPath.includes("\\") ? "\\" : "/";
  const depth = String(relative || "").split("/").length;
  const parts = fullPath.split(sep);
  if (parts.length <= depth) return null;
  return parts.slice(0, parts.length - depth).join(sep);
}

const DownskoolYtDlp = { YTDLP_INSTALL, ytdlpFormatArgs, ytdlpCommand, downloadsDirFrom };
if (typeof module !== "undefined") module.exports = DownskoolYtDlp;
else self.DownskoolYtDlp = DownskoolYtDlp;
