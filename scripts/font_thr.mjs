import fs from "node:fs";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
for (const label of ["tiny","small","mid","gb1","full"]) {
  const path = `data/fonts/test-${label}.ttf`;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fs.readFileSync(path), { subset: false });
  const p = doc.addPage([420, 90]);
  p.drawText("0123456789 ABC abc", { x: 20, y: 55, size: 14, font, color: rgb(0,0,0) });
  p.drawText("突触释放机器的结构与功能", { x: 20, y: 25, size: 14, font });
  fs.writeFileSync(`data/e2e/thr-${label}.pdf`, await doc.save());
}
console.log("生成完毕");
