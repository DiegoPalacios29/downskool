const test = require("node:test");
const assert = require("node:assert");
const { descMarkdown, parseResources, lessonMarkdown } = require("../src/lessontext.js");

const text = (value, ...marks) => ({ type: "text", text: value, ...(marks.length ? { marks } : {}) });
const p = (...content) => ({ type: "paragraph", content });
const link = (href) => ({ type: "link", attrs: { href } });
const v2 = (...nodes) => `[v2]${JSON.stringify(nodes)}`;

test("párrafos, negrita y enlaces", () => {
  const desc = v2(
    p(text("Descarga la "), text("plantilla", link("https://example.com/plantilla.zip")), text(" y sigue los pasos.")),
    p(text("Importante: ", { type: "bold" }), text("https://example.com/x", link("https://example.com/x"))),
  );
  assert.equal(descMarkdown(desc),
    "Descarga la [plantilla](https://example.com/plantilla.zip) y sigue los pasos.\n\n" +
    "**Importante:** https://example.com/x");
});

test("los prompts se conservan tal cual, en bloque de código o en párrafo", () => {
  const prompt = "Actúa como *experto* en ventas.\n  1) Usa [corchetes] y _guiones_";
  const desc = v2(
    { type: "heading", attrs: { level: 2 }, content: [text("Prompt")] },
    { type: "codeBlock", content: [text(prompt)] },
    p(text("Eres un agente_de_ventas: responde con * y #")),
  );
  assert.equal(descMarkdown(desc),
    `### Prompt\n\n\`\`\`\n${prompt}\n\`\`\`\n\nEres un agente_de_ventas: responde con * y #`);
});

test("listas, citas, saltos de línea e imágenes", () => {
  const li = (...content) => ({ type: "listItem", content });
  const desc = v2(
    { type: "orderedList", content: [li(p(text("Abre n8n"))), li(p(text("Importa el flujo")), { type: "bulletList", content: [li(p(text("archivo.json")))] })] },
    { type: "blockquote", content: [p(text("Uno"), { type: "hardBreak" }, text("Dos"))] },
    p({ type: "image", attrs: { src: "https://example.com/a.png", alt: "captura" } }),
    { type: "horizontalRule" },
  );
  assert.equal(descMarkdown(desc),
    "1. Abre n8n\n2. Importa el flujo\n   - archivo.json\n\n> Uno  \n> Dos\n\n![captura](https://example.com/a.png)\n\n---");
});

test("texto plano antiguo, documento vacío y nodos desconocidos", () => {
  assert.equal(descMarkdown("Mira https://example.com\nGracias"), "Mira https://example.com\nGracias");
  assert.equal(descMarkdown(""), "");
  assert.equal(descMarkdown(v2(p())), "");
  assert.equal(descMarkdown("[v2] esto no es JSON"), "esto no es JSON");
  const desc = v2(
    { type: "tarjeta", attrs: { url: "https://example.com/doc", title: "Guía" } },
    { type: "caja", content: [p(text("dentro"))] },
    p({ type: "mention", attrs: { label: "@Ana" } }),
  );
  assert.equal(descMarkdown(desc), "[Guía](https://example.com/doc)\n\ndentro\n\n@Ana");
});

test("recursos adjuntos", () => {
  const raw = JSON.stringify([
    { title: "Plantilla", downloadUrl: "https://example.com/p.zip" },
    { title: "Manual.pdf", file_id: "abc123" },
    { title: "Plantilla", downloadUrl: "https://example.com/p.zip" },
  ]);
  assert.deepEqual(parseResources(raw), [
    { title: "Plantilla", url: "https://example.com/p.zip" },
    { title: "Manual.pdf", url: "" },
  ]);
  assert.deepEqual(parseResources("https://example.com/a https://example.com/b"), [
    { title: "", url: "https://example.com/a" }, { title: "", url: "https://example.com/b" },
  ]);
  assert.deepEqual(parseResources(null), []);
  assert.deepEqual(parseResources("[]"), []);
});

test("archivo completo de la lección", () => {
  assert.equal(lessonMarkdown({ title: "Intro", desc: "", resources: "[]", url: "https://www.skool.com/x?md=1" }), "");
  assert.equal(
    lessonMarkdown({
      title: "01 — Intro",
      desc: v2(p(text("Hola"))),
      resources: [{ title: "Flujo", url: "https://example.com/f.json" }, { name: "Manual.pdf" }],
      url: "https://www.skool.com/x/classroom/abc?md=1",
    }),
    "# 01 — Intro\n\nLección en Skool: https://www.skool.com/x/classroom/abc?md=1\n\nHola\n\n## Recursos\n\n" +
    "- [Flujo](https://example.com/f.json)\n- Manual.pdf (archivo adjunto: descárgalo desde la lección en Skool)\n");
});
