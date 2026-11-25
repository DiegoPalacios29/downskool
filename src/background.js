// downskool - service worker
// 1. Observa las peticiones de red de las pestañas de Skool y guarda las URLs de
//    video (listas HLS .m3u8 y archivos .mp4): es el respaldo "modo lección".
// 2. Hace que las descargas de la extensión lleguen a los CDN de video con
//    Referer de Skool, como las haría el reproductor de la página.

const MEDIA_RE = /\.(m3u8|mp4)(\?|$)/i;
// Fragmentos de una lista HLS: no son videos completos, se ignoran.
const SEGMENT_RE = /(\/rendition\.m3u8|\/segment|\.ts(\?|$)|\.m4s(\?|$)|init\.mp4)/i;

chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: [1],
  addRules: [{
    id: 1,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header: "referer", operation: "set", value: "https://www.skool.com/" }],
    },
    condition: {
      initiatorDomains: [chrome.runtime.id],
      requestDomains: ["skool.com", "mux.com", "vimeo.com", "vimeocdn.com", "akamaized.net", "loom.com", "wistia.com", "wistia.net"],
      resourceTypes: ["xmlhttprequest", "media", "other"],
    },
  }],
}).catch((err) => console.warn("downskool: no se pudo registrar la regla de Referer", err));

const key = (tabId) => `tab:${tabId}`;

async function getVideos(tabId) {
  const data = await chrome.storage.session.get(key(tabId));
  return data[key(tabId)] || [];
}

async function setVideos(tabId, videos) {
  await chrome.storage.session.set({ [key(tabId)]: videos });
  chrome.action.setBadgeBackgroundColor({ color: "#5b3df5", tabId }).catch(() => {});
  chrome.action.setBadgeText({ text: videos.length ? String(videos.length) : "", tabId }).catch(() => {});
}

function classify(url) {
  const u = new URL(url);
  const type = /\.m3u8/i.test(u.pathname) ? "hls" : "mp4";
  let source = "Otro";
  if (u.hostname.endsWith("skool.com") || u.hostname.endsWith("mux.com")) source = "Skool";
  else if (u.hostname.includes("loom")) source = "Loom";
  else if (u.hostname.includes("vimeo") || u.hostname.includes("akamaized")) source = "Vimeo";
  else if (u.hostname.includes("wistia")) source = "Wistia";
  return { type, source };
}

// Identidad de un video sin los parámetros que cambian (tokens, rangos).
function identity(url) {
  const u = new URL(url);
  return u.origin + u.pathname;
}

// Cola para que las escrituras concurrentes no se pisen.
let queue = Promise.resolve();

async function addVideo(tabId, url) {
  if (tabId < 0 || !MEDIA_RE.test(url) || SEGMENT_RE.test(url)) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !tab.url || !/^https:\/\/([^/]+\.)?skool\.com\//.test(tab.url)) return;

  const videos = await getVideos(tabId);
  const id = identity(url);
  const existing = videos.find((v) => v.id === id);
  if (existing) {
    existing.url = url; // refresca el token firmado
  } else {
    videos.push({ id, url, ...classify(url), title: tab.title || "video", foundAt: Date.now() });
  }
  await setVideos(tabId, videos);
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    queue = queue.then(() => addVideo(details.tabId, details.url)).catch(() => {});
  },
  { urls: ["<all_urls>"], types: ["xmlhttprequest", "media", "other"] }
);

// Skool cambia de lección sin recargar: al cambiar la URL se vacía la lista.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) queue = queue.then(() => setVideos(tabId, []));
});
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(key(tabId)));

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "get-videos") {
    getVideos(msg.tabId).then((videos) => sendResponse({ videos }));
    return true;
  }
});
