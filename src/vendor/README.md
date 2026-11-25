# Librerías incluidas

Se incluyen ya compiladas para que la extensión funcione sin pasos de build.

| Archivo | Librería | Licencia | Para qué |
| --- | --- | --- | --- |
| `mux.min.js` | [mux.js](https://github.com/videojs/mux.js) 7.0.3 | Apache-2.0 | Pasar MPEG-TS (HLS de Skool) a MP4. |
| `mediabunny.bundle.mjs` | [mediabunny](https://github.com/Vanilagy/mediabunny) 1.65.2 + `@mediabunny/mp3-encoder` 1.65.2 | MPL-2.0 (el codificador MP3 incluye [LAME](https://lame.sourceforge.io/), LGPL) | Convertir a MP4, M4A, MP3 y WAV, y unir video y audio que vienen por separado. |

`mediabunny.bundle.mjs` es un único módulo ES generado con esbuild a partir de
`tools/mediabunny-entry.mjs`, sin modificar el código de las librerías. Para
regenerarlo:

```bash
npm run vendor
```

El código fuente de mediabunny está en https://github.com/Vanilagy/mediabunny
(versión 1.65.2). El codificador MP3 usa WebAssembly en un worker, por eso el
`manifest.json` permite `'wasm-unsafe-eval'`.
