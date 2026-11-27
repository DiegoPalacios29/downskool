// downskool - carpeta de destino.
//
// Las extensiones solo pueden guardar (chrome.downloads) dentro de la carpeta de
// descargas, y Chrome impide salir de ella con accesos directos (mklink, ln -s).
// Por eso hay dos casos:
//   - una subcarpeta de Descargas: se antepone a la ruta de cada archivo;
//   - cualquier otra carpeta del disco (p. ej. Documentos): la persona la elige
//     una vez en el selector de carpetas de Chrome y la extensión escribe en ella
//     con ese permiso (File System Access). Ver openDestination en downloader.js.

function cleanSegment(name) {
  return String(name)
    .replace(/[\\/:*?"<>|\u0000-\u001f~%]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 100);
}

const segments = (path) => path.split(/[\\/]+/).map(cleanSegment).filter(Boolean);

/**
 * Interpreta lo que el usuario escribió en "Guardar en".
 * @returns {{ subdir: string, target: string|null }}
 *   subdir: ruta relativa dentro de la carpeta de descargas ("" = la raíz).
 *   target: carpeta fuera de descargas tal como se escribió; hay que elegirla
 *           en el selector de carpetas (null si el destino está en descargas).
 *           En ese caso `subdir` es su nombre, por si hay que usar descargas.
 */
function parseDest(input) {
  const text = String(input || "").trim().replace(/^"+|"+$/g, "").trim();
  if (!text) return { subdir: "", target: null };

  const drive = /^[a-z]:(?=[\\/]|$)/i.test(text);
  const absolute = drive || /^\\\\/.test(text) || /^~?\//.test(text);
  if (!absolute) return { subdir: segments(text).join("/"), target: null };

  // Una ruta que ya está dentro de la carpeta de descargas no necesita permiso.
  const inside = text.match(/[\\/](?:Downloads|Descargas)(?:[\\/]+(.*))?$/i);
  if (inside) return { subdir: segments(inside[1] || "").join("/"), target: null };

  const target = text.replace(/[\\/]+$/, "");
  const parts = segments(drive ? text.slice(2) : text);
  return { subdir: parts[parts.length - 1] || "downskool", target: target || text };
}

// Clave con la que se recuerda el permiso de una carpeta elegida.
const destKey = (target) => String(target).replace(/\\/g, "/").toLowerCase();

const DownskoolDest = { parseDest, destKey };
if (typeof module !== "undefined") module.exports = DownskoolDest;
else self.DownskoolDest = DownskoolDest;
