const test = require("node:test");
const assert = require("node:assert");
const { ytdlpCommand, ytdlpFormatArgs, downloadsDirFrom } = require("../src/ytdlp.js");

test("comando MP4 con calidad y nombre con tildes", () => {
  const cmd = ytdlpCommand({
    url: "https://www.youtube.com/watch?v=abc123",
    output: "Cómo Vender/07 - Recurso CUESTIONARIO",
    format: "mp4",
    quality: "720",
    dir: "C:\\Users\\dipal\\Downloads",
  });
  assert.equal(cmd,
    'yt-dlp -P "C:\\Users\\dipal\\Downloads" --referer "https://www.skool.com/" ' +
    '-S "res:720,vcodec:h264,acodec:aac" --merge-output-format "mp4" ' +
    '-o "Cómo Vender/07 - Recurso CUESTIONARIO.%(ext)s" "https://www.youtube.com/watch?v=abc123"');
});

test("formatos de audio y limpieza de comillas y %", () => {
  assert.deepEqual(ytdlpFormatArgs("mp3"), ["-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "0"]);
  assert.deepEqual(ytdlpFormatArgs("wav").slice(-2), ["--audio-format", "wav"]);
  assert.deepEqual(ytdlpFormatArgs("mp4", "best"), ["-S", "vcodec:h264,res,acodec:aac", "--merge-output-format", "mp4"]);
  const cmd = ytdlpCommand({ url: "https://youtu.be/x", output: 'Clase "100%" real', format: "m4a" });
  assert.match(cmd, /-o "Clase 100 real\.%\(ext\)s"/);
  assert.match(cmd, /-P "~\/Downloads"/);
});

test("carpeta de descargas desde la ruta de un archivo ya bajado", () => {
  assert.equal(downloadsDirFrom("C:\\Users\\dipal\\Downloads\\Cómo Vender\\01 - Intro (1).mp4", "Cómo Vender/01 - Intro.mp4"),
    "C:\\Users\\dipal\\Downloads");
  assert.equal(downloadsDirFrom("/home/ana/Descargas/clase.mp3", "clase.mp3"), "/home/ana/Descargas");
  assert.equal(downloadsDirFrom("", "x.mp4"), null);
});
