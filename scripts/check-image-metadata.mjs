// TC-N15：公開する画像に EXIF / XMP などのメタデータ（撮影場所などを含みうる）が残っていないかを検査する（NFR-06、DD-16）。
// 画像を追加するときは、メタデータを削除してから置く（例：magick in.jpg -strip out.webp）。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const roots = ["public", "src"];
const imageExt = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"]);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (imageExt.has(extname(name).toLowerCase())) yield path;
  }
}

const markers = [
  { label: "EXIF（JPEG APP1）", bytes: Buffer.from("Exif\0\0", "latin1") },
  { label: "XMP", bytes: Buffer.from("http://ns.adobe.com/xap/", "latin1") },
  { label: "EXIF（PNG eXIf）", bytes: Buffer.from("eXIf", "latin1") },
  { label: "EXIF（WebP）", bytes: Buffer.from("EXIF", "latin1"), webpOnly: true },
  { label: "XMP（WebP）", bytes: Buffer.from("XMP ", "latin1"), webpOnly: true },
];

const problems = [];
for (const root of roots) {
  for (const file of walk(root)) {
    const data = readFileSync(file);
    const isWebp = extname(file).toLowerCase() === ".webp";
    for (const m of markers) {
      if (m.webpOnly && !isWebp) continue;
      if (data.includes(m.bytes)) problems.push(`${file}: ${m.label} が残っています`);
    }
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(p);
  console.error("メタデータを削除してください（例：magick in.jpg -strip out.jpg）");
  process.exit(1);
}
console.log("check-image-metadata: 問題はありません");
