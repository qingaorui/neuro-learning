import fs from "node:fs";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
const cases = [
  ["variable-original", "data/fonts/NotoSansSC-var.ttf"],
  ["static-instanced", "data/fonts/_static.ttf"],
  ["subset-gb2312", "docs/vendor/NotoSansSC-subset.ttf"],
];
for (const [label, path] of cases) {
  try {
    const bytes = fs.readFileSync(path);
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(bytes, { subset: false });
    const page = doc.addPage([400, 80]);
    page.drawText("0123456789 ABC abc", { x: 20, y: 40, size: 14, font, color: rgb(0,0,0) });
    fs.writeFileSync(`data/e2e/cmp-${label}.pdf`, await doc.save());
    console.log(label, "OK");
  } catch (e) {
    console.log(label, "ERR", e.message.slice(0, 100));
  }
}
