const test = require("node:test");
const assert = require("node:assert");
const { parseDest, destKey } = require("../src/dest.js");

test("sin destino: la carpeta de descargas", () => {
  assert.deepEqual(parseDest(""), { subdir: "", target: null });
  assert.deepEqual(parseDest(undefined), { subdir: "", target: null });
  assert.deepEqual(parseDest("   "), { subdir: "", target: null });
});

test("subcarpeta relativa, limpia y sin salir de descargas", () => {
  assert.deepEqual(parseDest("Cursos"), { subdir: "Cursos", target: null });
  assert.deepEqual(parseDest(" Cursos\\Skool/ "), { subdir: "Cursos/Skool", target: null });
  assert.deepEqual(parseDest("../../Windows/a:b?"), { subdir: "Windows/a b", target: null });
});

test("ruta completa de Windows fuera de descargas", () => {
  const dest = parseDest('"C:\\Users\\dipal\\Documents\\Imperio Agentico\\"');
  assert.deepEqual(dest, { subdir: "Imperio Agentico", target: "C:\\Users\\dipal\\Documents\\Imperio Agentico" });
  assert.equal(destKey(dest.target), "c:/users/dipal/documents/imperio agentico");
  assert.equal(destKey("c:/Users/dipal/Documents/Imperio Agentico"), destKey(dest.target));
  assert.deepEqual(parseDest("D:\\"), { subdir: "downskool", target: "D:" });
});

test("ruta completa que ya está dentro de descargas", () => {
  assert.deepEqual(parseDest("C:\\Users\\dipal\\Downloads\\Cursos\\Skool"), { subdir: "Cursos/Skool", target: null });
  assert.deepEqual(parseDest("C:\\Users\\dipal\\Downloads"), { subdir: "", target: null });
});

test("ruta completa en macOS o Linux", () => {
  const dest = parseDest("~/Documents/Cursos");
  assert.deepEqual(dest, { subdir: "Cursos", target: "~/Documents/Cursos" });
  assert.deepEqual(parseDest("/home/ana/Cursos/"), { subdir: "Cursos", target: "/home/ana/Cursos" });
});
