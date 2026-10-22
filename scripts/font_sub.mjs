import fs from "node:fs";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
for (const subset of [true, false]) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fs.readFileSync("data/fonts/nolayout.ttf"), { subset });
  const p = doc.addPage([420, 110]);
  p.drawText("0123456789 ABC abc Munc18-1", { x: 20, y: 70, size: 14, font, color: rgb(0,0,0) });
  p.drawText("突触释放机器的结构与功能", { x: 20, y: 35, size: 14, font });
  const out = await doc.save();
  fs.writeFileSync(`data/e2e/sub-${subset}.pdf`, out);
  console.log(`subset=${subset}  ${(out.length / 1024).toFixed(0)} KB`);
}
