# downskool

Extensión de Chrome y Edge (Manifest V3), gratuita y de código abierto, para descargar
los videos de los cursos de [Skool](https://www.skool.com) **a los que ya tienes acceso**.

## Qué hace

- **Modo curso:** al abrir la sección *Classroom* de un curso, el panel lista todas las
  lecciones con video, agrupadas por módulo. Marcas o desmarcas las que quieras
  (o usas "Todos") y pulsas **Descargar seleccionados**.
- **Formato:** video **MP4**, o solo audio en **MP3**, **M4A** (AAC, sin recodificar) o
  **WAV**. Para solo audio se baja la versión más liviana del stream, así es más rápido.
- **Calidad:** máxima, 1080p, 720p, 480p o 360p (la más cercana sin pasarse).
- **Cola de descargas:** se abre una pestaña que baja los videos uno por uno, con
  progreso y el estado de cada lección. Se guardan por módulo:
  `Descargas/<Curso>/01 - <Módulo>/01 - <Lección>.mp4`.
- **Guardar en:** una subcarpeta de Descargas (escribe su nombre, p. ej. `Cursos`) o
  cualquier otra carpeta del disco (pega su ruta, p. ej.
  `C:\Users\tú\Documents\Cursos`). Ver [Carpeta de destino](#carpeta-de-destino).
- **Texto de la lección:** junto a cada video se guarda un `.md` con lo que el creador
  escribió debajo (explicación, enlaces, prompts) y la lista de recursos adjuntos. Las
  lecciones que solo tienen texto también aparecen en la lista, con la etiqueta *Texto*.
- **YouTube:** se prepara el comando de [yt-dlp](https://github.com/yt-dlp/yt-dlp)
  (gratuito) con el mismo formato, calidad y carpeta, listo para copiar y pegar.
- **Modo lección:** si un video no aparece en la lista, reprodúcelo unos segundos. La
  extensión detecta el stream en la red y lo muestra en *Video de esta lección*.

| Origen del video | Soporte |
| --- | --- |
| Videos nativos de Skool (`stream.video.skool.com`, HLS) | ✅ en el navegador |
| Vimeo | ✅ en el navegador (une video y audio en un MP4); si Vimeo lo bloquea, se ofrece el comando de yt-dlp |
| Loom | ✅ en el navegador (si el video es público o tienes acceso); si falla, comando de yt-dlp |
| MP4 directos | ✅ |
| YouTube | ✅ con yt-dlp (el navegador no puede: YouTube lo impide y cambia sus protecciones a menudo) |
| Lecciones sin acceso (🔒) o streams cifrados / DRM | ❌ |

### Carpeta de destino

Chrome solo deja a las extensiones guardar dentro de la carpeta de descargas, y no
permite salir de ella con accesos directos (`mklink`, `ln -s`). Para guardar en otra
carpeta, downskool usa el permiso de carpetas de Chrome:

1. En el panel, pega la ruta en **Guardar en** (se recuerda).
2. La primera vez, la pestaña de descargas muestra el botón **Elegir la carpeta**:
   selecciónala en la ventana que se abre y acepta el permiso de edición.
3. Las siguientes veces downskool la recuerda. Si Chrome vuelve a pedir el permiso,
   basta un clic en **Permitir guardar en la carpeta**.

La carpeta tiene que existir, y Chrome no acepta carpetas del sistema ni la raíz de
Documentos, Escritorio o Descargas (una subcarpeta sí). Con **Guardar en Descargas esta
vez** se usa `Descargas/<nombre de la carpeta>/`.

### YouTube con yt-dlp

1. Instala yt-dlp y FFmpeg una sola vez, en el Símbolo del sistema:

   ```bash
   winget install yt-dlp.yt-dlp
   ```

   ```bash
   winget install Gyan.FFmpeg
   ```

2. Cierra y vuelve a abrir el Símbolo del sistema.
3. Al terminar la cola, downskool muestra el comando de cada video de YouTube. Pulsa
   **Copiar**, pégalo en el Símbolo del sistema y pulsa Enter.

Descargar videos de YouTube va contra sus condiciones de uso: hazlo solo con contenido
que tengas derecho a guardar.

## Instalación (modo desarrollador)

1. Descarga o clona este repositorio.
2. Abre `chrome://extensions` (o `edge://extensions` en Edge) y activa **Modo de desarrollador**.
3. Pulsa **Cargar descomprimida** (**Cargar desempaquetada** en Edge) y elige la carpeta `downskool`.
4. Abre (o recarga con F5) la página de un curso en Skool y pulsa el icono de downskool.

Para actualizar: `git pull` en la carpeta y el botón **Recargar** de la extensión.

## Desarrollo

```bash
npm test         # pruebas del lector HLS, yt-dlp, carpeta de destino y texto de lecciones
npm run vendor   # regenera src/vendor/mediabunny.bundle.mjs
npm run zip      # genera downskool.zip para distribuir
```

Estructura:

- `src/background.js`: service worker. Detecta streams `.m3u8`/`.mp4` en la red y añade
  el Referer de Skool a las descargas de la extensión.
- `src/content.js`: lee `__NEXT_DATA__` de Skool para listar lecciones y resolver el video de cada una.
- `src/popup.*`: panel con formato, calidad y la lista de lecciones.
- `src/downloader.*`: cola de descargas, descarga HLS en paralelo y escritura en la carpeta elegida.
- `src/dest.js`: interpreta el destino escrito en el panel.
- `src/lessontext.js`: convierte el texto de una lección a Markdown.
- `src/convert.mjs`: conversión de formatos y unión de video + audio con mediabunny.
- `src/hls.js`: lector de listas HLS (master y media, fMP4, rangos de bytes, calidad).
- `src/ytdlp.js`: comandos de yt-dlp.
- `src/vendor/`: librerías incluidas (ver [su README](src/vendor/README.md)).

### Cómo encuentra los videos

Skool es una app Next.js y cada página trae sus datos en `<script id="__NEXT_DATA__">`:

- `props.pageProps.course` es el árbol del curso. Las lecciones tienen `unitType: "module"`;
  `metadata.videoId` indica un video nativo y `metadata.videoLink` uno externo.
  `metadata.desc` es el texto de la lección (`[v2]` + JSON del editor, o texto plano) y
  `metadata.resources` sus archivos y enlaces adjuntos.
- Al abrir una lección (`?md=<id>`), `props.pageProps.video` trae `playbackId` y
  `playbackToken`, y el stream es
  `https://stream.video.skool.com/<playbackId>.m3u8?token=<playbackToken>`.
  El token caduca en unas horas, así que downskool pide cada lección justo antes de
  descargarla.

> Skool no publica la estructura de sus datos, y puede cambiarla. Si la lista del curso
> sale vacía, el modo lección (reproducir el video) sigue funcionando. Abre un issue
> con la URL del tipo de página donde falla.

## Uso responsable

Usa downskool solo con contenido que tienes derecho a ver, para verlo sin conexión.
No redistribuyas cursos de otras personas. Respeta los términos de Skool y de los
creadores.

Proyecto independiente, sin relación con Skool ni con otras extensiones.
