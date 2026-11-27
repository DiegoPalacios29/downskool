// downskool - texto de una lección (lo que el creador escribe debajo del video:
// explicación, enlaces, prompts, recursos) convertido a Markdown.
//
// Skool guarda la descripción en metadata.desc. Las lecciones nuevas usan
// "[v2]" seguido del JSON de un documento de editor (nodos paragraph, heading,
// bulletList, codeBlock..., y texto con marcas bold/italic/code/link); las
// antiguas son texto plano. Los recursos adjuntos van en metadata.resources.
// Skool no documenta este formato, así que todo se lee con tolerancia: un nodo
// desconocido conserva su texto y sus enlaces.

const URL_RE = /^https?:\/\//i;

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Devuelve la lista de nodos del documento, o un string si es texto plano.
function parseDesc(desc) {
  if (!desc) return "";
  if (typeof desc === "object") return Array.isArray(desc) ? desc : desc.content || [desc];
  let text = String(desc).trim();
  if (text.startsWith("[v2]")) text = text.slice(4).trim();
  if (/^[[{]/.test(text)) {
    const doc = parseJson(text);
    if (Array.isArray(doc)) return doc;
    if (doc && typeof doc === "object") return doc.content || [doc];
  }
  return text;
}

const linkOf = (attrs) => {
  for (const key of ["href", "url", "src", "link"]) {
    if (attrs && typeof attrs[key] === "string" && URL_RE.test(attrs[key])) return attrs[key];
  }
  return "";
};

// El texto no se escapa: los prompts deben quedar tal cual se escribieron.
function inline(nodes) {
  let out = "";
  for (const node of nodes || []) {
    if (!node || typeof node !== "object") continue;
    if (node.type === "hardBreak") {
      out += "  \n";
      continue;
    }
    if (node.type === "image") {
      const src = linkOf(node.attrs);
      if (src) out += `![${(node.attrs && node.attrs.alt) || "imagen"}](${src})`;
      continue;
    }
    let text = typeof node.text === "string" ? node.text : inline(node.content);
    const attrs = node.attrs || {};
    if (!text) text = attrs.label || attrs.title || attrs.name || "";
    let href = node.type === "text" ? "" : linkOf(attrs);
    for (const mark of node.marks || []) {
      const type = mark && mark.type;
      if (type === "link") href = linkOf(mark.attrs) || href;
      else if (!text.trim()) continue;
      else if (type === "code") text = `\`${text}\``;
      else if (type === "bold" || type === "strong") text = wrap(text, "**");
      else if (type === "italic" || type === "em") text = wrap(text, "*");
      else if (type === "strike") text = wrap(text, "~~");
    }
    if (href) text = !text.trim() || text.trim() === href ? href : `[${text}](${href})`;
    out += text;
  }
  return out;
}

// Las marcas de Markdown no admiten espacios pegados por dentro.
function wrap(text, mark) {
  const [, before, body, after] = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
  return `${before}${mark}${body}${mark}${after}`;
}

const plain = (node) =>
  typeof node.text === "string" ? node.text
    : node.type === "hardBreak" ? "\n"
      : (node.content || []).map(plain).join("");

const indent = (text, pad) => text.split("\n").map((line, i) => (i && line ? pad + line : line)).join("\n");

function list(node, ordered) {
  const start = Number(node.attrs && node.attrs.start) || 1;
  return (node.content || []).map((item, i) => {
    const bullet = ordered ? `${start + i}. ` : "- ";
    return bullet + indent(blocks(item.content || [item], "\n"), " ".repeat(bullet.length));
  }).join("\n");
}

function block(node) {
  if (!node || typeof node !== "object") return "";
  const attrs = node.attrs || {};
  switch (node.type) {
    case "paragraph": return inline(node.content);
    case "heading": return `${"#".repeat(Math.min(6, (Number(attrs.level) || 1) + 1))} ${inline(node.content)}`;
    case "bulletList": case "unorderedList": return list(node, false);
    case "orderedList": return list(node, true);
    case "listItem": return blocks(node.content, "\n");
    case "blockquote": return blocks(node.content).split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");
    case "codeBlock": return `\`\`\`${attrs.language || ""}\n${plain(node)}\n\`\`\``;
    case "horizontalRule": return "---";
    case "text": case "hardBreak": case "image": return inline([node]);
    default: {
      // Nodo desconocido: conservar su contenido y, si trae un enlace, también.
      const isBlock = (child) => child && child.type && !["text", "hardBreak", "image"].includes(child.type) && !child.marks;
      const body = (node.content || []).some(isBlock) ? blocks(node.content) : inline(node.content);
      const href = linkOf(attrs);
      if (!href || body.includes(href)) return body;
      const label = body || attrs.title || attrs.name || attrs.label || "";
      return label && !label.includes("\n") ? `[${label}](${href})` : [body, href].filter(Boolean).join("\n\n");
    }
  }
}

function blocks(nodes, sep = "\n\n") {
  return (nodes || []).map(block).filter((text) => text.trim()).join(sep);
}

function descMarkdown(desc) {
  const doc = parseDesc(desc);
  return (typeof doc === "string" ? doc : blocks(doc)).trim();
}

// Recursos adjuntos: [{ title, url }]. `url` queda vacío si es un archivo subido
// a Skool (solo se puede bajar desde la página de la lección).
function parseResources(raw) {
  let value = raw;
  if (typeof value === "string") value = parseJson(value) ?? value;
  const out = [];
  const visit = (item) => {
    if (!item) return;
    if (typeof item === "string") {
      for (const m of item.matchAll(/https?:\/\/[^\s"'<>\\]+/g)) out.push({ title: "", url: m[0] });
    } else if (Array.isArray(item)) {
      item.forEach(visit);
    } else if (typeof item === "object") {
      const pick = (keys) => keys.map((k) => item[k]).find((v) => typeof v === "string" && v.trim());
      const title = pick(["title", "name", "label", "file_name", "fileName"]) || "";
      const url = [pick(["downloadUrl", "download_url", "url", "link", "href"]),
        ...Object.values(item)].find((v) => typeof v === "string" && URL_RE.test(v)) || "";
      if (title || url) out.push({ title: title.trim(), url });
      else Object.values(item).forEach(visit);
    }
  };
  visit(value);
  return out.filter((r, i) => out.findIndex((x) => x.title === r.title && x.url === r.url) === i);
}

/**
 * Markdown completo de una lección, o "" si no tiene texto ni recursos.
 * @param {{ title?: string, desc?: any, resources?: any, url?: string }} lesson
 */
function lessonMarkdown({ title, desc, resources, url } = {}) {
  const body = descMarkdown(desc);
  const files = parseResources(resources);
  if (!body && !files.length) return "";
  const parts = [`# ${title || "Lección"}`];
  if (url) parts.push(`Lección en Skool: ${url}`);
  if (body) parts.push(body);
  if (files.length) {
    parts.push("## Recursos", files.map((r) =>
      r.url ? `- ${r.title && r.title !== r.url ? `[${r.title}](${r.url})` : r.url}`
        : `- ${r.title} (archivo adjunto: descárgalo desde la lección en Skool)`).join("\n"));
  }
  return `${parts.join("\n\n")}\n`;
}

const DownskoolText = { descMarkdown, parseResources, lessonMarkdown };
if (typeof module !== "undefined") module.exports = DownskoolText;
else self.DownskoolText = DownskoolText;
