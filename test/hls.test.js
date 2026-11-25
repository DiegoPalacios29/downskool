const test = require("node:test");
const assert = require("node:assert");
const { parseMaster, parseMedia, isMaster } = require("../src/hls.js");

const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="es",DEFAULT=YES,URI="audio/es.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
low/index.m3u8?token=abc
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="aud"
https://cdn.example.com/high/index.m3u8
`;

test("elige la variante de mayor resolución y su audio", () => {
  assert.ok(isMaster(MASTER));
  const v = parseMaster(MASTER, "https://stream.mux.com/ID.m3u8");
  assert.equal(v.length, 2);
  assert.equal(v[0].height, 1080);
  assert.equal(v[0].uri, "https://cdn.example.com/high/index.m3u8");
  assert.equal(v[0].audioUri, "https://stream.mux.com/audio/es.m3u8");
  assert.equal(v[1].uri, "https://stream.mux.com/low/index.m3u8?token=abc");
  assert.equal(v[1].audioUri, null);
});

test("lee fragmentos TS", () => {
  const pl = parseMedia(`#EXTM3U
#EXT-X-TARGETDURATION:4
#EXTINF:4.0,
seg0.ts
#EXTINF:4.0,
seg1.ts
#EXT-X-ENDLIST`, "https://a.com/v/index.m3u8");
  assert.equal(pl.format, "ts");
  assert.equal(pl.encrypted, false);
  assert.deepEqual(pl.segments.map((s) => s.uri), ["https://a.com/v/seg0.ts", "https://a.com/v/seg1.ts"]);
});

test("detecta fMP4, rangos de bytes y cifrado", () => {
  const pl = parseMedia(`#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="key"
#EXT-X-MAP:URI="file.mp4",BYTERANGE="700@0"
#EXTINF:6,
#EXT-X-BYTERANGE:1000@700
file.mp4
#EXTINF:6,
#EXT-X-BYTERANGE:500
file.mp4`, "https://a.com/x/p.m3u8");
  assert.equal(pl.format, "fmp4");
  assert.equal(pl.encrypted, true);
  assert.deepEqual(pl.init.range, { start: 0, end: 699 });
  assert.deepEqual(pl.segments[0].range, { start: 700, end: 1699 });
  assert.deepEqual(pl.segments[1].range, { start: 1700, end: 2199 });
});

const { pickVariant } = require("../src/hls.js");

const VARIANTS = parseMaster(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080
v1080.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720
v720.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360
v360.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=130000,CODECS="mp4a.40.2"
audio.m3u8
`, "https://a.com/master.m3u8");

test("calidad: máxima, tope de altura y respaldo", () => {
  assert.equal(pickVariant(VARIANTS).height, 1080);
  assert.equal(pickVariant(VARIANTS, { quality: "720" }).height, 720);
  assert.equal(pickVariant(VARIANTS, { quality: "480" }).height, 360);
  // Ninguna es tan pequeña: la de video más baja, nunca la de solo audio.
  assert.equal(pickVariant(VARIANTS, { quality: "240" }).height, 360);
});

test("solo audio: la variante más liviana, o la que trae el audio aparte", () => {
  assert.equal(pickVariant(VARIANTS, { audioOnly: true }).uri, "https://a.com/audio.m3u8");
  const split = parseMaster(MASTER, "https://stream.mux.com/ID.m3u8");
  assert.equal(pickVariant(split, { audioOnly: true }).audioUri, "https://stream.mux.com/audio/es.m3u8");
  assert.equal(pickVariant([], {}), null);
});
