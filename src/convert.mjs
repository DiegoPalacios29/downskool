// downskool - conversión de formatos con mediabunny (MPL-2.0).
// Recibe el video ya descargado (MPEG-TS, MP4 o MP4 fragmentado) y produce
// MP4, M4A, MP3 o WAV. También une video y audio que vienen por separado
// (Vimeo) sin recodificar. El MP3 se codifica con LAME (WebAssembly) en un worker.

import {
  Input, Output, Conversion, BlobSource, BufferTarget, ALL_FORMATS,
  Mp4OutputFormat, Mp3OutputFormat, WavOutputFormat,
  QUALITY_HIGH, canEncodeAudio, registerMp3Encoder,
} from "./vendor/mediabunny.bundle.mjs";

export const FORMATS = {
  mp4: { ext: "mp4", mime: "video/mp4", audioOnly: false },
  m4a: { ext: "m4a", mime: "audio/mp4", audioOnly: true },
  mp3: { ext: "mp3", mime: "audio/mpeg", audioOnly: true },
  wav: { ext: "wav", mime: "audio/wav", audioOnly: true },
};

let mp3Ready = null;
function ensureMp3Encoder() {
  mp3Ready ||= (async () => {
    if (!(await canEncodeAudio("mp3"))) registerMp3Encoder();
  })();
  return mp3Ready;
}

const REASONS = {
  undecodable_source_codec: "el navegador no puede decodificar el audio/video original",
  no_encodable_target_codec: "el navegador no puede codificar el formato pedido",
  unknown_source_codec: "códec desconocido",
};

function conversionError(conversion) {
  const why = conversion.discardedTracks
    .filter((d) => d.reason !== "discarded_by_user")
    .map((d) => `${d.track.type}: ${REASONS[d.reason] || d.reason}`);
  return new Error(`no se pudo convertir (${why.join("; ") || "no hay pistas que convertir"})`);
}

function newInput(blob) {
  return new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
}

function newOutput(format) {
  const target = new BufferTarget();
  if (format === "mp3") return new Output({ format: new Mp3OutputFormat(), target });
  if (format === "wav") return new Output({ format: new WavOutputFormat(), target });
  return new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
}

function audioOptions(format) {
  if (format === "mp3") return { codec: "mp3", quality: QUALITY_HIGH };
  if (format === "wav") return { codec: "pcm-s16" };
  return {}; // MP4/M4A: el AAC se copia tal cual
}

/**
 * Convierte el medio descargado al formato pedido.
 * @param {object} p
 * @param {Blob} p.main    Video (con o sin audio).
 * @param {Blob} [p.audio] Audio que vino aparte, si lo hay.
 * @param {"mp4"|"m4a"|"mp3"|"wav"} p.format
 * @param {(progress: number) => void} [p.onProgress]
 * @returns {Promise<{blob: Blob, ext: string}>}
 */
export async function convert({ main, audio = null, format, onProgress = () => {} }) {
  const info = FORMATS[format];
  if (!info) throw new Error(`formato desconocido: ${format}`);
  if (format === "mp3") await ensureMp3Encoder();

  const output = newOutput(format);
  const inputs = [];
  try {
    if (!info.audioOnly && audio && main) {
      // Video de un archivo + audio de otro, en un mismo MP4.
      const videoIn = newInput(main);
      const audioIn = newInput(audio);
      inputs.push(videoIn, audioIn);
      const videoPart = await Conversion.init({
        input: videoIn, output, audio: { discard: true }, composable: true, showWarnings: false,
      });
      const audioPart = await Conversion.init({
        input: audioIn, output, video: { discard: true }, audio: audioOptions(format), composable: true, showWarnings: false,
      });
      if (!videoPart.utilizedTracks.some((t) => t.type === "video")) throw conversionError(videoPart);
      if (!audioPart.utilizedTracks.some((t) => t.type === "audio")) throw conversionError(audioPart);
      let pv = 0, pa = 0;
      videoPart.onProgress = (p) => { pv = p; onProgress((pv + pa) / 2); };
      audioPart.onProgress = (p) => { pa = p; onProgress((pv + pa) / 2); };
      await output.start();
      await Promise.all([videoPart.execute(), audioPart.execute()]);
      await output.finalize();
    } else {
      const input = newInput(info.audioOnly && audio ? audio : main);
      inputs.push(input);
      const conversion = await Conversion.init({
        input,
        output,
        video: info.audioOnly ? { discard: true } : {},
        audio: audioOptions(format),
        showWarnings: false,
      });
      if (!conversion.isValid) throw conversionError(conversion);
      if (info.audioOnly && !conversion.utilizedTracks.some((t) => t.type === "audio")) {
        throw new Error("el video no tiene pista de audio");
      }
      conversion.onProgress = (p) => onProgress(p);
      await conversion.execute();
    }
  } finally {
    for (const input of inputs) input.dispose();
  }
  return { blob: new Blob([output.target.buffer], { type: info.mime }), ext: info.ext };
}
