import fs from "node:fs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
const doc = await PDFDocument.create();
const f = await doc.embedFont(StandardFonts.Helvetica);
const p = doc.addPage([400, 80]);
p.drawText("0123456789 ABC abc", { x: 20, y: 40, size: 14, font: f, color: rgb(0,0,0) });
fs.writeFileSync("data/e2e/cmp-helvetica.pdf", await doc.save());
console.log("Helvetica 对照已生成");
