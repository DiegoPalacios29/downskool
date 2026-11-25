// Entrada para generar src/vendor/mediabunny.bundle.mjs con `npm run vendor`.
// Exporta solo lo que usa src/convert.mjs.
export {
  Input, Output, Conversion, BlobSource, BufferTarget, ALL_FORMATS,
  Mp4OutputFormat, Mp3OutputFormat, WavOutputFormat,
  QUALITY_HIGH, canEncodeAudio,
} from "mediabunny";
export { registerMp3Encoder } from "@mediabunny/mp3-encoder";
