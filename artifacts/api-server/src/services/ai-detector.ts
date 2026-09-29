import { existsSync } from "node:fs";
import path from "node:path";
import * as ort from "onnxruntime-node";
import sharp from "sharp";

// Models are optional: if the .onnx files aren't present (e.g. a deploy
// target that skips them to save space/cost), every function here resolves
// to `{ available: false }` rather than throwing, so the rest of the app
// keeps working with the honest "model_unavailable" signal it always had.
//
// Path note: this file is bundled by esbuild into a single dist/index.mjs,
// so __dirname at runtime is artifacts/api-server/dist -- one level above
// the package root, not two (unlike this file's own src/services/ location).
const MODELS_DIR = path.join(__dirname, "..", "models");
const IMAGE_MODEL_PATH = path.join(MODELS_DIR, "ai_image_detector.onnx");
const TEXT_MODEL_DIR = path.join(MODELS_DIR, "text-detector");
const TEXT_MODEL_PATH = path.join(TEXT_MODEL_DIR, "model.onnx");

const IMAGE_SIZE = 128;
const IMAGE_MEAN = [0.485, 0.456, 0.406];
const IMAGE_STD = [0.229, 0.224, 0.225];
const TEXT_MAX_LENGTH = 256;

// Measured on held-out test data during training (see the training
// notebooks). Reported alongside every AI-probability signal so a bare
// percentage is never shown without its known, honest error rate.
export const IMAGE_MODEL_STATS = {
  modelVersion: "mobilenetv3-small-cifake-v1",
  datasetNote: "CIFAKE (Stable Diffusion vs. CIFAR-10 photos, trained at 128x128)",
  accuracy: 0.977,
  realFalsePositiveRate: 0.0191,
};
export const TEXT_MODEL_STATS = {
  modelVersion: "distilbert-hc3-v1",
  datasetNote: "HC3 (human vs. ChatGPT answers)",
  accuracy: 0.997,
  humanFalsePositiveRate: 0.0041,
};

type ClassifierResult = { available: boolean; probabilityAi: number | null };

let imageSessionPromise: Promise<ort.InferenceSession | null> | null = null;
let textSessionPromise: Promise<ort.InferenceSession | null> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tokenizerPromise: Promise<any | null> | null = null;

const loadImageSession = (): Promise<ort.InferenceSession | null> => {
  if (!imageSessionPromise) {
    imageSessionPromise = existsSync(IMAGE_MODEL_PATH)
      ? ort.InferenceSession.create(IMAGE_MODEL_PATH).catch(() => null)
      : Promise.resolve(null);
  }
  return imageSessionPromise;
};

const loadTextSession = (): Promise<ort.InferenceSession | null> => {
  if (!textSessionPromise) {
    textSessionPromise = existsSync(TEXT_MODEL_PATH)
      ? ort.InferenceSession.create(TEXT_MODEL_PATH).catch(() => null)
      : Promise.resolve(null);
  }
  return textSessionPromise;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loadTokenizer = (): Promise<any | null> => {
  if (!tokenizerPromise) {
    tokenizerPromise = existsSync(TEXT_MODEL_DIR)
      ? import("@huggingface/transformers")
          .then(({ AutoTokenizer }) => AutoTokenizer.from_pretrained(TEXT_MODEL_DIR, { local_files_only: true }))
          .catch(() => null)
      : Promise.resolve(null);
  }
  return tokenizerPromise;
};

const softmax = (logits: number[]): number[] => {
  const max = Math.max(...logits);
  const exps = logits.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((v) => v / sum);
};

/**
 * Runs the image classifier. Preprocessing intentionally mirrors the
 * training pipeline exactly: resize to 128x128 with bilinear interpolation
 * (torchvision's `Resize` default -- sharp's default kernel is lanczos3,
 * which would silently skew predictions on upscaled low-res inputs like
 * CIFAKE's 32x32 source images), then normalize with ImageNet mean/std.
 * Training used label order ['FAKE', 'REAL'], so index 0 is the AI/fake
 * probability.
 */
export const classifyImage = async (bytes: Buffer): Promise<ClassifierResult> => {
  const session = await loadImageSession();
  if (!session) return { available: false, probabilityAi: null };

  try {
    const { data, info } = await sharp(bytes)
      .resize(IMAGE_SIZE, IMAGE_SIZE, { fit: "fill", kernel: "linear" })
      .removeAlpha()
      .toColorspace("srgb")
      .raw()
      .toBuffer({ resolveWithObject: true });

    if (info.channels < 3) return { available: false, probabilityAi: null };

    const chw = new Float32Array(3 * IMAGE_SIZE * IMAGE_SIZE);
    const plane = IMAGE_SIZE * IMAGE_SIZE;
    for (let i = 0; i < plane; i++) {
      const r = data[i * info.channels] / 255;
      const g = data[i * info.channels + 1] / 255;
      const b = data[i * info.channels + 2] / 255;
      chw[i] = (r - IMAGE_MEAN[0]) / IMAGE_STD[0];
      chw[plane + i] = (g - IMAGE_MEAN[1]) / IMAGE_STD[1];
      chw[2 * plane + i] = (b - IMAGE_MEAN[2]) / IMAGE_STD[2];
    }

    const tensor = new ort.Tensor("float32", chw, [1, 3, IMAGE_SIZE, IMAGE_SIZE]);
    const result = await session.run({ [session.inputNames[0]]: tensor });
    const logits = Array.from(result[session.outputNames[0]].data as Float32Array);
    const [probabilityAi] = softmax(logits);
    return { available: true, probabilityAi };
  } catch {
    return { available: false, probabilityAi: null };
  }
};

/**
 * Runs the text classifier. Tokenization uses the exact tokenizer.json
 * exported from training (via transformers.js), so wordpiece splitting
 * matches the Python tokenizer byte-for-byte -- inference then runs
 * directly against the ONNX model, bypassing transformers.js's higher-level
 * pipeline() API (which expects a config.json we didn't export). Training
 * used label 0 = human, label 1 = AI.
 */
export const classifyText = async (text: string): Promise<ClassifierResult> => {
  const [session, tokenizer] = await Promise.all([loadTextSession(), loadTokenizer()]);
  if (!session || !tokenizer) return { available: false, probabilityAi: null };

  try {
    const encoded = tokenizer(text, { padding: "max_length", truncation: true, max_length: TEXT_MAX_LENGTH });
    const seqLen = encoded.input_ids.dims[encoded.input_ids.dims.length - 1];
    const inputIds = BigInt64Array.from(Array.from(encoded.input_ids.data as Iterable<number>, (v) => BigInt(v)));
    const attentionMask = BigInt64Array.from(
      Array.from(encoded.attention_mask.data as Iterable<number>, (v) => BigInt(v)),
    );

    const feeds = {
      input_ids: new ort.Tensor("int64", inputIds, [1, seqLen]),
      attention_mask: new ort.Tensor("int64", attentionMask, [1, seqLen]),
    };
    const result = await session.run(feeds);
    const logits = Array.from(result[session.outputNames[0]].data as Float32Array);
    const [, probabilityAi] = softmax(logits);
    return { available: true, probabilityAi };
  } catch {
    return { available: false, probabilityAi: null };
  }
};

/**
 * Eagerly triggers both models (and the tokenizer) to load into memory.
 * Call this once at server startup so the ~15-20s cost of reading the
 * 268MB text model off disk happens during boot, not on whichever request
 * happens to arrive first -- this matters most right after a deploy, or
 * after a free-tier host spins the server back up from idle.
 */
export const warmUpModels = async (): Promise<void> => {
  await Promise.all([loadImageSession(), loadTextSession(), loadTokenizer()]);
};
