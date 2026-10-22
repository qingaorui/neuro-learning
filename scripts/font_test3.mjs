import fs from "node:fs";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
const cases = [
  ["static-full", "data/fonts/_static.ttf"],
  ["subset", "docs/vendor/NotoSansSC-subset.ttf"],
];
for (const [label, path] of cases) {
  const bytes = fs.readFileSync(path);
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(bytes, { subset: false });
  const page = doc.addPage([420, 140]);
  page.drawText("SNARE 蛋白与 Munc18-1 共同介导膜融合。", { x: 24, y: 100, size: 13, font, color: rgb(0,0,0) });
  page.drawText("ABC abc 0123456789 ±→α", { x: 24, y: 70, size: 13, font });
  const out = await doc.save();
  fs.writeFileSync(`data/e2e/m-${label}.pdf`, out);
  console.log(`${label}: ${(out.length/1024/1024).toFixed(2)} MB`);
}
