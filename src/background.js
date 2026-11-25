// downskool - service worker
// Observa las peticiones de red de las pestañas de Skool y guarda las URLs de
// video (listas HLS .m3u8 y archivos .mp4) para que el popup pueda ofrecerlas.

const MEDIA_RE = /\.(m3u8|mp4)(\?|$)/i;
// Fragmentos de una lista HLS: no son videos completos, se ignoran.
const SEGMENT_RE = /(\/rendition\.m3u8|\/segment|\.ts(\?|$)|\.m4s(\?|$)|init\.mp4)/i;

const key = (tabId) => `tab:${tabId}`;

async function getVideos(tabId) {
  const data = await chrome.storage.session.get(key(tabId));
  return data[key(tabId)] || [];
}

async function setVideos(tabId, videos) {
  await chrome.storage.session.set({ [key(tabId)]: videos });
  chrome.action.setBadgeBackgroundColor({ color: "#5b3df5", tabId });
  chrome.action.setBadgeText({ text: videos.length ? String(videos.length) : "", tabId });
}

function classify(url) {
  const u = new URL(url);
  const type = /\.m3u8/i.test(u.pathname) ? "hls" : "mp4";
  let source = "otro";
  if (u.hostname.endsWith("mux.com")) source = "Skool (Mux)";
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

async function addVideo(tabId, url, origin) {
  if (tabId < 0 || !MEDIA_RE.test(url) || SEGMENT_RE.test(url)) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !tab.url || !/^https:\/\/([^/]+\.)?skool\.com\//.test(tab.url)) return;

  const videos = await getVideos(tabId);
  const id = identity(url);
  const existing = videos.find((v) => v.id === id);
  if (existing) {
    existing.url = url; // refresca el token firmado
  } else {
    videos.push({ id, url, ...classify(url), origin, title: tab.title || "video", foundAt: Date.now() });
  }
  await setVideos(tabId, videos);
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    queue = queue.then(() => addVideo(details.tabId, details.url, "red")).catch(() => {});
  },
  { urls: ["<all_urls>"], types: ["xmlhttprequest", "media", "other"] }
);

// Skool es una SPA: al cambiar de lección se vacía la lista de esa pestaña.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) queue = queue.then(() => setVideos(tabId, []));
});
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(key(tabId)));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "page-videos" && sender.tab) {
    // URLs encontradas en los datos de la página (content.js).
    queue = queue.then(async () => {
      for (const url of msg.urls) await addVideo(sender.tab.id, url, "página");
      const embeds = msg.embeds || [];
      if (embeds.length) {
        await chrome.storage.session.set({ [`embeds:${sender.tab.id}`]: embeds });
      }
    });
  } else if (msg.type === "get-videos") {
    Promise.all([
      getVideos(msg.tabId),
      chrome.storage.session.get(`embeds:${msg.tabId}`),
    ]).then(([videos, e]) => sendResponse({ videos, embeds: e[`embeds:${msg.tabId}`] || [] }));
    return true;
  }
});
