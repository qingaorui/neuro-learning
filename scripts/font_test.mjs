/** 验证：pdf-lib + fontkit 能否嵌入中文字体并生成可提取的文字层。 */
import fs from "node:fs";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

const fontBytes = fs.readFileSync("docs/vendor/NotoSansSC-subset.ttf");
const doc = await PDFDocument.create();
doc.registerFontkit(fontkit);
const font = await doc.embedFont(fontBytes, { subset: true });

const page = doc.addPage([420, 200]);
page.drawText("突触释放机器的结构与功能", { x: 30, y: 150, size: 20, font, color: rgb(0, 0, 0) });
page.drawText("SNARE 蛋白与 Munc18-1 共同介导膜融合。", { x: 30, y: 110, size: 12, font });
page.drawText("ABC abc 123 ±≤≥→αβγ", { x: 30, y: 80, size: 12, font });

const bytes = await doc.save();
fs.writeFileSync("data/e2e/fonttest.pdf", bytes);
console.log("生成 data/e2e/fonttest.pdf", (bytes.length / 1024).toFixed(1), "KB");

// 顺带验证：原 PDF 能否被 pdf-lib 载入并复制页面（矢量路径的前提）
const src = fs.readFileSync("data/test_paper.pdf");
const srcDoc = await PDFDocument.load(src, { ignoreEncryption: true });
console.log("原 PDF 页数:", srcDoc.getPageCount());
const out2 = await PDFDocument.create();
const copied = await out2.copyPages(srcDoc, srcDoc.getPageIndices());
copied.forEach((p) => out2.addPage(p));
const p0 = out2.getPage(0);
const { width, height } = p0.getSize();
p0.drawRectangle({ x: 56, y: height - 108, width: 440, height: 18, color: rgb(1, 1, 1) });
p0.drawText("中文覆盖到原 PDF 上：突触释放机器的结构与功能", { x: 56, y: height - 104, size: 15, font });
const bytes2 = await out2.save();
fs.writeFileSync("data/e2e/vector-test.pdf", bytes2);
console.log("生成 data/e2e/vector-test.pdf", (bytes2.length / 1024 / 1024).toFixed(2), "MB");
