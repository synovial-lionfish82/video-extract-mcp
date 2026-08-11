import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SiglipVisionModel, AutoProcessor, RawImage } from '@huggingface/transformers';

const MODEL_ID = 'Xenova/siglip-base-patch16-224';

async function main(): Promise<void> {
  const listFile = process.argv[2];
  if (!listFile) throw new Error('usage: embedWorker <jsonPathsFile>');
  const paths = JSON.parse(readFileSync(listFile, 'utf8')) as string[];

  const processor = await AutoProcessor.from_pretrained(MODEL_ID);
  // MUST be the vision tower read via pooler_output: pipeline('image-feature-extraction')
  // returns raw preprocessed pixels (150528 = 224*224*3), not embeddings -- a
  // silent, plausible-looking failure. See task-12-brief.md's "THE TRAP".
  // tests/embed.integration.test.ts asserts the 768-dim output specifically
  // to guard against this regression.
  const model = await SiglipVisionModel.from_pretrained(MODEL_ID, { dtype: 'q8' });

  const out: number[][] = [];
  for (const p of paths) {
    try {
      const inputs = await processor(await RawImage.read(p));
      const res = await model(inputs);
      const tensor = res.pooler_output ?? res.last_hidden_state;
      const v = Array.from(tensor.data as Float32Array);
      // L2-normalize: src/vision/select.ts's cosine() is a plain dot product,
      // not a true cosine -- it assumes both operands already are unit
      // vectors.
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      out.push(v.map((x) => x / norm));
    } catch {
      out.push([]); // keep index alignment with the input list
    }
  }
  process.stdout.write(JSON.stringify(out));
}

// ESM "is this the entry module" guard: only auto-run main() when this file
// is executed directly as `node embedWorker.js <jsonPathsFile>` (the worker
// CLI contract embed.ts's embedImages() spawns) -- not when it is imported as
// a module. Mirrors src/transcript/asrWorker.ts's identical guard, added
// there (Task 11 review, addendum A3) after its absence was found to run
// main() against the importer's own process.argv and call process.exit(1) on
// the resulting usage error, killing whatever process did the importing.
// Nothing in this codebase currently imports embedWorker.ts as a module --
// unlike asrWorker.ts's exported runVad, there is no pure helper here for a
// test to exercise in isolation -- so this guard is a defensive/consistency
// addition, not a fix for an active bug.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch((e) => { process.stderr.write(String(e)); process.exit(1); });
}
