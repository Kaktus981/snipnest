import { mkdir } from "node:fs/promises";
import sharp from "sharp";

await mkdir("public/icons", { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await sharp("assets/icon.svg")
    .resize(size, size)
    .png()
    .toFile(`public/icons/icon-${size}.png`);
}
