import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { COLORS, renderScene, rosetteScene, type SceneSpec } from "../tests/synthetic";

// Writes synthetic photos with known answers to test-images/synthetic/ plus a manifest.json.
// Each 1000 px scene is padded into a 4:3 "camera photo" (1666 × 1250) whose guide square
// (lib/vision/guide.ts: centred, 80% of 1250 = 1000 px) is exactly the scene, so uploading a
// fixture in the app reproduces the manifest numbers. Usage: npm run fixtures

const out = path.join(process.cwd(), "test-images", "synthetic");
const PHOTO = { width: 1666, height: 1250 };

const scenes: Record<string, { spec: SceneSpec; blur?: number; note: string }> = {
  "shape-known": {
    note: "One green ellipse with a known pixel count",
    spec: {
      width: 1000,
      height: 1000,
      noise: 3,
      shapes: [{ kind: "ellipse", cx: 500, cy: 500, rx: 220, ry: 140, color: COLORS.leaf, class: "leaf" }],
    },
  },
  "rosette-healthy": { note: "Healthy rosette framed in the square", spec: rosetteScene({}) },
  "rosette-wilted": { note: "Leaves drooped: ~36% less leaf cover", spec: rosetteScene({ leafLength: 176 }) },
  "rosette-yellowing": { note: "Two outer leaves yellowed", spec: rosetteScene({ yellowLeaves: 2 }) },
  "rosette-warm-light": { note: "Warm colour cast, corrected from the white background", spec: rosetteScene({ cast: [1.12, 1, 0.8] }) },
  "rosette-blurry": { note: "Out of focus: rejected as blurry", spec: rosetteScene({}), blur: 10 },
  "rosette-dark": { note: "Under-exposed: rejected as too dark", spec: rosetteScene({ cast: [0.18, 0.18, 0.18] }) },
};

async function main() {
  await mkdir(out, { recursive: true });
  // Remove fixtures from earlier versions so the folder matches the manifest.
  for (const file of await readdir(out)) {
    if (file.endsWith(".jpg") && !(file.replace(/\.jpg$/, "") in scenes)) await rm(path.join(out, file));
  }
  const manifest: Record<string, unknown> = {};
  for (const [name, { spec, blur, note }] of Object.entries(scenes)) {
    const { image, truth } = renderScene(spec);
    const cast = spec.cast ?? [1, 1, 1];
    const backdrop = (spec.background ?? COLORS.backdrop).map((c, i) => Math.min(255, Math.round(c * cast[i])));
    const padX = (PHOTO.width - image.width) / 2;
    const padY = (PHOTO.height - image.height) / 2;
    let pipeline = sharp(
      await sharp(Buffer.from(image.data), { raw: { width: image.width, height: image.height, channels: 3 } })
        .extend({ top: padY, bottom: padY, left: padX, right: padX, background: { r: backdrop[0], g: backdrop[1], b: backdrop[2] } })
        .raw()
        .toBuffer(),
      { raw: { width: PHOTO.width, height: PHOTO.height, channels: 3 } },
    );
    if (blur) pipeline = pipeline.blur(blur);
    await pipeline.jpeg({ quality: 90 }).toFile(path.join(out, `${name}.jpg`));
    manifest[`${name}.jpg`] = {
      note,
      leafPixels: truth.leafPixels,
      stressedPixels: truth.stressedPixels,
      coverPct: Math.round(truth.coverPct * 100) / 100,
    };
    console.log(`${name}.jpg`, truth.coverPct.toFixed(2), "% leaf cover of the guide square");
  }
  await writeFile(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
