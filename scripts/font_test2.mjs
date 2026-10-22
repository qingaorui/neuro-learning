import fs from "node:fs";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
const fontBytes = fs.readFileSync("docs/vendor/NotoSansSC-subset.ttf");
for (const subset of [false, true]) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes, { subset });
  const page = doc.addPage([420, 200]);
  page.drawText("突触释放机器的结构与功能", { x: 30, y: 150, size: 20, font, color: rgb(0,0,0) });
  page.drawText("SNARE 蛋白与 Munc18-1 共同介导膜融合。", { x: 30, y: 110, size: 12, font });
  page.drawText("ABC abc 123 ±≤≥→αβγ", { x: 30, y: 80, size: 12, font });
  const bytes = await doc.save();
  const name = `data/e2e/font-subset-${subset}.pdf`;
  fs.writeFileSync(name, bytes);
  console.log(`subset=${subset}  ->  ${(bytes.length/1024/1024).toFixed(2)} MB  ${name}`);
}
