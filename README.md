# downskool

Extensión de Chrome (Manifest V3), gratuita y de código abierto, para descargar los
videos de los cursos de [Skool](https://www.skool.com) **a los que ya tienes acceso**.

## Qué hace

- **Modo curso:** al abrir la sección *Classroom* de un curso, el panel lista todas las
  lecciones con video, agrupadas por módulo. Marcas o desmarcas las que quieras
  (o usas "Todos") y pulsas **Descargar seleccionados**.
- **Cola de descargas:** se abre una pestaña que baja los videos uno por uno, con
  progreso y el estado de cada lección. Se guardan en
  `Descargas/<Nombre del curso>/01 - <Lección>.mp4`.
- **Modo lección:** si un video no aparece en la lista, reprodúcelo unos segundos. La
  extensión detecta el stream en la red y lo muestra en *Video de esta lección*.
- Elige siempre la mejor calidad disponible y convierte HLS (MPEG-TS) a **MP4** con
  [mux.js](https://github.com/videojs/mux.js).

| Origen del video | Soporte |
| --- | --- |
| Videos nativos de Skool (`stream.video.skool.com`, HLS) | ✅ |
| Loom | ✅ (si el video es público o tienes acceso) |
| Vimeo | ⚠️ funciona si Vimeo entrega el archivo; los videos con restricción de dominio pueden fallar |
| MP4 directos | ✅ |
| YouTube | ❌ aparece desactivado: no se descarga (lo prohíben las condiciones de YouTube y de la Chrome Web Store) |
| Lecciones sin acceso (🔒) o streams cifrados / DRM | ❌ |

### Cómo encuentra los videos

Skool es una app Next.js y cada página trae sus datos en `<script id="__NEXT_DATA__">`:

- `props.pageProps.course` es el árbol del curso. Las lecciones tienen `unitType: "module"`;
  `metadata.videoId` indica un video nativo y `metadata.videoLink` uno externo.
- Al abrir una lección (`?md=<id>`), `props.pageProps.video` trae `playbackId` y
  `playbackToken`, y el stream es
  `https://stream.video.skool.com/<playbackId>.m3u8?token=<playbackToken>`.
  El token caduca en unas horas, así que downskool pide cada lección justo antes de
  descargarla.

## Instalación (modo desarrollador)

1. Descarga o clona este repositorio.
2. Abre `chrome://extensions` y activa **Modo de desarrollador**.
3. Pulsa **Cargar descomprimida** y elige la carpeta `downskool`.
4. Abre (o recarga con F5) la página de un curso en Skool y pulsa el icono de downskool.

## Desarrollo

```bash
npm test      # pruebas del lector de listas HLS
npm run zip   # genera downskool.zip para distribuir
```

Estructura:

- `src/background.js`: service worker que detecta streams `.m3u8`/`.mp4` en la red.
- `src/content.js`: lee `__NEXT_DATA__` de Skool para listar lecciones y resolver el video de cada una.
- `src/popup.*`: panel con la lista y las casillas de selección.
- `src/downloader.*`: cola de descargas, descarga HLS en paralelo y conversión a MP4.
- `src/hls.js`: lector de listas HLS (master y media, fMP4, rangos de bytes).

> Skool no publica la estructura de sus datos, y puede cambiarla. Si la lista del curso
> sale vacía, el modo lección (reproducir el video) sigue funcionando. Abre un issue
> con la URL del tipo de página donde falla.

## Uso responsable

Usa downskool solo con contenido que tienes derecho a ver, para verlo sin conexión.
No redistribuyas cursos de otras personas. Respeta los términos de Skool y de los
creadores.

Proyecto independiente, sin relación con Skool ni con otras extensiones.
