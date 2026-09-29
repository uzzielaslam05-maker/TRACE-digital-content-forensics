import { createHash, randomUUID } from "node:crypto";
import { classifyImage, classifyText, IMAGE_MODEL_STATS, TEXT_MODEL_STATS } from "./ai-detector";
import type {
  FileMetadata,
  ForensicResult,
  ForensicResultClassification,
  ForensicResultEvidenceStrength,
  ForensicSignal,
  TextStatistics,
} from "@workspace/api-zod";

type AiInspectionResult = { available: boolean; probabilityAi: number | null };

type ImageInspection = {
  metadata: FileMetadata;
  signals: ForensicSignal[];
  ai: AiInspectionResult;
};

// Thresholds are deliberately conservative: anything short of strong model
// confidence stays "inconclusive" rather than guessing a direction, matching
// this app's evidence-first philosophy even now that a real model exists.
const AI_LIKELY_THRESHOLD = 0.85;
const HUMAN_LIKELY_THRESHOLD = 0.15;

const deriveClassification = (
  probabilityAi: number,
): { classification: ForensicResultClassification; evidenceStrength: ForensicResultEvidenceStrength } => {
  const distanceFromMidpoint = Math.abs(probabilityAi - 0.5);
  const evidenceStrength: ForensicResultEvidenceStrength =
    distanceFromMidpoint > 0.45 ? "strong" : distanceFromMidpoint > 0.35 ? "moderate" : "limited";

  if (probabilityAi >= AI_LIKELY_THRESHOLD) return { classification: "likely_ai", evidenceStrength };
  if (probabilityAi <= HUMAN_LIKELY_THRESHOLD) return { classification: "likely_human", evidenceStrength };
  return { classification: "inconclusive", evidenceStrength: "limited" };
};

const buildLimitations = (base: string[], aiAvailable: boolean): string[] => [
  ...base,
  aiAvailable
    ? "The AI-generation model reports a probability, not a certainty -- it has a measured, non-zero error rate and has not been evaluated on every generator or writing style."
    : "The AI-generation model is not configured in this deployment.",
];

const LIMITATIONS = [
  "Deterministic file and language statistics cannot prove authorship, origin, or AI generation.",
  "Absence of metadata or provenance is not evidence that content is fake.",
];

const round = (value: number, digits = 3) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const safeFilename = (filename: string) => {
  const normalized = filename.replaceAll("\\", "/").split("/").pop() ?? "untitled";
  return normalized.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 255) || "untitled";
};

const entropy = (bytes: Buffer) => {
  if (bytes.length === 0) return 0;
  const counts = new Uint32Array(256);
  for (const byte of bytes) counts[byte] += 1;
  let value = 0;
  for (const count of counts) {
    if (count === 0) continue;
    const probability = count / bytes.length;
    value -= probability * Math.log2(probability);
  }
  return round(value, 2);
};

const formatBytes = (bytes: Buffer) => bytes.subarray(0, Math.min(bytes.length, 262_144));

const detectDimensions = (
  bytes: Buffer,
  mimeType: string,
): { width: number | null; height: number | null; colorMode: string | null; format: string } => {
  if (mimeType === "image/png" && bytes.length >= 26) {
    const colorType = bytes[25];
    const colorMode =
      colorType === 0 ? "L" : colorType === 2 ? "RGB" : colorType === 3 ? "Indexed" : colorType === 4 ? "LA" : colorType === 6 ? "RGBA" : "Unknown";
    return {
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
      colorMode,
      format: "PNG",
    };
  }

  if (mimeType === "image/gif" && bytes.length >= 10) {
    const packed = bytes[10];
    return {
      width: bytes.readUInt16LE(6),
      height: bytes.readUInt16LE(8),
      colorMode: packed & 0x80 ? "Indexed" : "L",
      format: "GIF",
    };
  }

  if (
    mimeType === "image/webp" &&
    bytes.length >= 16 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    const chunkId = bytes.toString("ascii", 12, 16);

    if (chunkId === "VP8X" && bytes.length >= 30) {
      const flags = bytes[20];
      const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
      return { width, height, colorMode: flags & 0x10 ? "RGBA" : "RGB", format: "WEBP" };
    }

    if (chunkId === "VP8 " && bytes.length >= 30) {
      // Lossy WebP (simple format): 3-byte frame tag, then a 3-byte sync code
      // (0x9d 0x01 0x2a), then packed 16-bit width/height fields.
      const dataStart = 20;
      const hasSyncCode = bytes[dataStart + 3] === 0x9d && bytes[dataStart + 4] === 0x01 && bytes[dataStart + 5] === 0x2a;
      if (hasSyncCode) {
        const widthField = bytes.readUInt16LE(dataStart + 6);
        const heightField = bytes.readUInt16LE(dataStart + 8);
        return { width: widthField & 0x3fff, height: heightField & 0x3fff, colorMode: "RGB", format: "WEBP" };
      }
    }

    if (chunkId === "VP8L" && bytes.length >= 25) {
      // Lossless WebP: 1-byte signature (0x2f), then a little-endian
      // bitfield packing 14-bit width-1, 14-bit height-1, and an alpha flag.
      const dataStart = 20;
      if (bytes[dataStart] === 0x2f) {
        const packed = bytes[dataStart + 1] | (bytes[dataStart + 2] << 8) | (bytes[dataStart + 3] << 16) | (bytes[dataStart + 4] << 24);
        const width = (packed & 0x3fff) + 1;
        const height = ((packed >>> 14) & 0x3fff) + 1;
        const hasAlpha = (packed >>> 28) & 0x1;
        return { width, height, colorMode: hasAlpha ? "RGBA" : "RGB", format: "WEBP" };
      }
    }

    return { width: null, height: null, colorMode: null, format: "WEBP" };
  }

  if (mimeType === "image/jpeg" && bytes.length > 4) {
    let offset = 2;
    while (offset + 1 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];

      if (marker === 0xff) {
        // Fill byte between markers; re-scan from here.
        offset += 1;
        continue;
      }

      // TEM (0x01), RSTn (0xD0-0xD7), SOI (0xD8), and EOI (0xD9) carry no
      // length field. Treating them like length-prefixed markers would
      // misread entropy-coded scan bytes as a bogus segment length.
      const isStandalone = marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9);
      if (isStandalone) {
        if (marker === 0xd9) break; // EOI reached without finding a frame header
        offset += 2;
        continue;
      }

      if (offset + 3 >= bytes.length) break;
      const length = bytes.readUInt16BE(offset + 2);

      if (marker >= 0xc0 && marker <= 0xc3 && length >= 7 && offset + 9 < bytes.length) {
        const components = bytes[offset + 9];
        return {
          width: bytes.readUInt16BE(offset + 7),
          height: bytes.readUInt16BE(offset + 5),
          colorMode: components === 1 ? "L" : components === 4 ? "CMYK" : "RGB",
          format: "JPEG",
        };
      }

      if (marker === 0xda) break; // Start of scan reached without a frame header (malformed ordering)
      if (length < 2) break;
      offset += 2 + length;
    }
    return { width: null, height: null, colorMode: null, format: "JPEG" };
  }

  return { width: null, height: null, colorMode: null, format: mimeType.split("/")[1]?.toUpperCase() ?? "UNKNOWN" };
};

const hasImageSignature = (bytes: Buffer, mimeType: string) => {
  if (mimeType === "image/png") return bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (mimeType === "image/jpeg") return bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"));
  if (mimeType === "image/gif") return bytes.toString("ascii", 0, 4) === "GIF8";
  if (mimeType === "image/webp") return bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  return false;
};

// --- EXIF/TIFF parsing ------------------------------------------------
// Reads real IFD0 tags (Make, Model, Software, Orientation) and detects the
// presence of a GPS IFD pointer by walking the actual TIFF structure,
// instead of guessing camera/software names from a raw string search.

const TIFF_TYPE_SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

type TiffEntry = { type: number; count: number; valueOffset: number };

const decodeAsciiField = (buf: Buffer, start: number, length: number) => {
  if (start < 0 || start + length > buf.length) return null;
  const raw = buf.toString("latin1", start, start + length).replace(/\u0000+$/, "").trim();
  return raw.length > 0 ? raw : null;
};

const readTiffIfd = (
  tiff: Buffer,
  ifdOffset: number,
  littleEndian: boolean,
): { entries: Map<number, TiffEntry> } | null => {
  if (ifdOffset < 0 || ifdOffset + 2 > tiff.length) return null;
  const readU16 = (o: number) => (littleEndian ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const readU32 = (o: number) => (littleEndian ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));

  const entryCount = readU16(ifdOffset);
  if (entryCount > 512) return null; // sanity bound against malformed/corrupt data
  const entries = new Map<number, TiffEntry>();
  for (let i = 0; i < entryCount; i += 1) {
    const entryOffset = ifdOffset + 2 + i * 12;
    if (entryOffset + 12 > tiff.length) break;
    entries.set(readU16(entryOffset), {
      type: readU16(entryOffset + 2),
      count: readU32(entryOffset + 4),
      valueOffset: entryOffset + 8,
    });
  }
  return { entries };
};

const readTiffValue = (tiff: Buffer, entry: TiffEntry, littleEndian: boolean): string | number | null => {
  const readU16 = (o: number) => (littleEndian ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const readU32 = (o: number) => (littleEndian ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const size = TIFF_TYPE_SIZES[entry.type] ?? 1;
  const totalBytes = size * entry.count;
  if (totalBytes <= 0) return null;
  const dataOffset = totalBytes <= 4 ? entry.valueOffset : readU32(entry.valueOffset);
  if (dataOffset < 0 || dataOffset + totalBytes > tiff.length) return null;

  if (entry.type === 2) return decodeAsciiField(tiff, dataOffset, entry.count);
  if (entry.type === 3) return readU16(dataOffset);
  if (entry.type === 4) return readU32(dataOffset);
  return null;
};

type ExifInfo = {
  found: boolean;
  camera: string | null;
  software: string | null;
  orientation: number | null;
  gpsPresent: boolean;
};

const EXIF_TAG_MAKE = 0x010f;
const EXIF_TAG_MODEL = 0x0110;
const EXIF_TAG_ORIENTATION = 0x0112;
const EXIF_TAG_SOFTWARE = 0x0131;
const EXIF_TAG_GPS_IFD = 0x8825;

const parseExif = (bytes: Buffer): ExifInfo => {
  const empty: ExifInfo = { found: false, camera: null, software: null, orientation: null, gpsPresent: false };
  const markerIndex = bytes.indexOf(Buffer.from("Exif\u0000\u0000", "latin1"));
  if (markerIndex === -1) return empty;

  const tiff = bytes.subarray(markerIndex + 6);
  if (tiff.length < 8) return empty;

  const byteOrder = tiff.toString("ascii", 0, 2);
  if (byteOrder !== "II" && byteOrder !== "MM") return empty;
  const littleEndian = byteOrder === "II";
  const magic = littleEndian ? tiff.readUInt16LE(2) : tiff.readUInt16BE(2);
  if (magic !== 42) return empty;

  const ifd0Offset = littleEndian ? tiff.readUInt32LE(4) : tiff.readUInt32BE(4);
  const ifd0 = readTiffIfd(tiff, ifd0Offset, littleEndian);
  if (!ifd0) return empty;

  const readTag = (tag: number) => (ifd0.entries.has(tag) ? readTiffValue(tiff, ifd0.entries.get(tag)!, littleEndian) : null);
  const make = readTag(EXIF_TAG_MAKE);
  const model = readTag(EXIF_TAG_MODEL);
  const software = readTag(EXIF_TAG_SOFTWARE);
  const orientation = readTag(EXIF_TAG_ORIENTATION);
  const gpsPresent = ifd0.entries.has(EXIF_TAG_GPS_IFD);

  const camera = [make, model].filter((part): part is string => typeof part === "string" && part.length > 0).join(" ") || null;

  return {
    found: true,
    camera,
    software: typeof software === "string" ? software : null,
    orientation: typeof orientation === "number" ? orientation : null,
    gpsPresent,
  };
};

const extractMetadata = async (bytes: Buffer, filename: string, mimeType: string): Promise<ImageInspection> => {
  const dimensions = detectDimensions(bytes, mimeType);
  const exif = parseExif(bytes);
  const ai = await classifyImage(bytes);

  // Fall back to the coarser heuristic only when a real EXIF/TIFF block was
  // not found, e.g. formats or edge cases where the structured block is
  // absent, so we don't let a substring match override a real parse.
  const ascii = bytes.toString("latin1");
  const softwareMatch = !exif.found ? ascii.match(/(Adobe Photoshop|Adobe Lightroom|GIMP|Canva|Pixelmator|Affinity Photo)/i) : null;
  const cameraMatch = !exif.found ? ascii.match(/(Canon|NIKON|FUJIFILM|SONY|Panasonic|OLYMPUS|Apple iPhone|Google Pixel)/i) : null;
  const hasIccProfile = /ICC_PROFILE/i.test(ascii);

  const softwareValue = exif.software ?? softwareMatch?.[1] ?? null;
  const cameraValue = exif.camera ?? cameraMatch?.[1] ?? null;
  const gpsPresent = exif.found ? exif.gpsPresent : /\bGPS\b/.test(ascii);
  const hasMetadataMarkers = exif.found || hasIccProfile || Boolean(softwareValue) || Boolean(cameraValue) || gpsPresent;

  const metadata: FileMetadata = {
    filename,
    mime_type: mimeType,
    file_size_bytes: bytes.length,
    width: dimensions.width,
    height: dimensions.height,
    color_mode: dimensions.colorMode,
    format: dimensions.format,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    exif: hasMetadataMarkers
      ? {
          ...(cameraValue ? { camera: cameraValue } : {}),
          ...(softwareValue ? { software: softwareValue } : {}),
          ...(exif.orientation !== null ? { orientation: exif.orientation } : {}),
          ...(gpsPresent ? { gps_available: true } : {}),
          source: exif.found ? "exif_ifd" : "heuristic",
          metadata_note: "Sensitive coordinates are intentionally not exposed.",
        }
      : {},
  };

  const signals: ForensicSignal[] = [
    {
      detector: "metadata",
      finding: hasMetadataMarkers ? "metadata_present" : "metadata_unavailable",
      direction: "neutral",
      severity: "low",
      explanation: exif.found
        ? "Structured EXIF/TIFF tags were parsed from the file. Metadata can describe processing history but cannot establish authorship."
        : hasMetadataMarkers
          ? "Metadata-like markers were detected via heuristic search. Metadata can describe processing history but cannot establish authorship."
          : "No useful metadata was detected. This does not establish whether the content is AI-generated.",
      value: hasMetadataMarkers,
    },
    {
      detector: "image_statistics",
      finding: "byte_entropy_estimated",
      direction: "neutral",
      severity: "low",
      explanation: "A bounded byte-level entropy estimate is included as a reproducible signal. It is not an AI detector.",
      value: entropy(formatBytes(bytes)),
    },
    {
      detector: "provenance",
      finding: "content_credentials_not_checked",
      direction: "neutral",
      severity: "low",
      explanation: "C2PA Content Credentials are not configured in this MVP.",
    },
    ai.available && ai.probabilityAi !== null
      ? {
          detector: "ai_model",
          finding: "ai_probability_estimated",
          direction: ai.probabilityAi >= 0.5 ? "supports_ai" : "supports_authenticity",
          severity: Math.abs(ai.probabilityAi - 0.5) > 0.45 ? "high" : Math.abs(ai.probabilityAi - 0.5) > 0.35 ? "medium" : "low",
          confidence: round(ai.probabilityAi, 3),
          explanation: `An image classifier (${IMAGE_MODEL_STATS.modelVersion}, trained on ${IMAGE_MODEL_STATS.datasetNote}) estimates a ${round(ai.probabilityAi * 100, 1)}% probability this image is AI-generated. In evaluation on held-out data, this model was ${round(IMAGE_MODEL_STATS.accuracy * 100, 1)}% accurate with a ${round(IMAGE_MODEL_STATS.realFalsePositiveRate * 100, 2)}% chance of wrongly flagging a real photo as AI-generated. It has not been evaluated on generators outside its training data, and real-world accuracy is likely lower than this figure.`,
          value: round(ai.probabilityAi, 3),
        }
      : {
          detector: "ai_model",
          finding: "model_unavailable",
          direction: "neutral",
          severity: "low",
          explanation: "No image-generation classifier is configured, so no AI probability is reported.",
        },
  ];

  if (softwareValue) {
    signals.push({
      detector: "metadata",
      finding: "editing_software_present",
      direction: "supports_editing",
      severity: "medium",
      explanation: `The file includes a software marker associated with ${softwareValue}. This indicates processing, not deception.`,
      value: softwareValue,
    });
  }

  if (dimensions.width === null || dimensions.height === null) {
    signals.push({
      detector: "image_statistics",
      finding: "dimensions_unparsed",
      direction: "neutral",
      severity: "low",
      explanation:
        "Image dimensions could not be parsed from the file header; the file may be truncated, corrupted, or use an unsupported variant of this format.",
    });
  }

  return { metadata, signals, ai };
};

// A plain split on `.!?` breaks decimals (`$3.50`), abbreviations (`Dr.`,
// `U.S.`), and initials (`J. K. Rowling`) into false sentence boundaries,
// which skews average_sentence_length and sentence_count. This walks the
// terminator runs and skips over those known non-boundary cases.
const SENTENCE_ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "approx", "no", "vol", "fig",
  "al", "inc", "ltd", "co", "corp", "gen", "rev", "sgt", "col", "capt", "lt", "gov", "rep", "sen",
]);

const splitSentences = (text: string): string[] => {
  const sentences: string[] = [];
  let start = 0;
  const terminatorRegex = /[.!?]+/g;
  let match: RegExpExecArray | null;
  while ((match = terminatorRegex.exec(text)) !== null) {
    const end = match.index + match[0].length;
    const before = text.slice(start, match.index);
    const isDecimal = match[0] === "." && /\d$/.test(before) && /^\d/.test(text.slice(end));
    const lastWord = (before.trim().split(/\s+/).pop() ?? "").replace(/\.$/, "");
    const isAbbreviation = SENTENCE_ABBREVIATIONS.has(lastWord.toLowerCase());
    // Matches initial chains like "U", "U.S", "J. K" (single letters
    // separated by dots), which should not end a sentence on their own.
    const isInitialChain = /^([A-Za-z]\.)*[A-Za-z]$/.test(lastWord) && lastWord.replace(/\./g, "").length <= 3;
    if (isDecimal || isAbbreviation || isInitialChain) continue;
    const sentence = text.slice(start, end).trim();
    if (sentence) sentences.push(sentence);
    start = end;
  }
  const rest = text.slice(start).trim();
  if (rest) sentences.push(rest);
  return sentences;
};

const inspectText = async (text: string): Promise<{ statistics: TextStatistics; signals: ForensicSignal[]; ai: AiInspectionResult }> => {
  const words = text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
  const sentences = splitSentences(text);
  const normalizedWords = words.map((word) => word.toLocaleLowerCase());
  const uniqueWords = new Set(normalizedWords);
  const punctuationCount = (text.match(/[,:;!?()[\]"'-]/g) ?? []).length;
  const repetitionRate = words.length > 0 ? 1 - uniqueWords.size / words.length : 0;
  const statistics: TextStatistics = {
    word_count: words.length,
    sentence_count: sentences.length,
    average_sentence_length: sentences.length > 0 ? round(words.length / sentences.length, 2) : 0,
    vocabulary_diversity: words.length > 0 ? round(uniqueWords.size / words.length, 3) : 0,
    repetition_rate: round(repetitionRate, 3),
    punctuation_density: text.length > 0 ? round(punctuationCount / text.length, 3) : 0,
  };

  const ai = await classifyText(text);

  return {
    statistics,
    ai,
    signals: [
      {
        detector: "stylometry",
        finding: "transparent_statistics_computed",
        direction: "neutral",
        severity: "low",
        explanation: "Word, sentence, vocabulary, repetition, and punctuation statistics are shown as context, not authorship proof.",
      },
      ai.available && ai.probabilityAi !== null
        ? {
            detector: "ai_model",
            finding: "ai_probability_estimated",
            direction: ai.probabilityAi >= 0.5 ? "supports_ai" : "supports_authenticity",
            severity: Math.abs(ai.probabilityAi - 0.5) > 0.45 ? "high" : Math.abs(ai.probabilityAi - 0.5) > 0.35 ? "medium" : "low",
            confidence: round(ai.probabilityAi, 3),
            explanation: `A text classifier (${TEXT_MODEL_STATS.modelVersion}, trained on ${TEXT_MODEL_STATS.datasetNote}) estimates a ${round(ai.probabilityAi * 100, 1)}% probability this text is AI-generated. In evaluation on held-out data, this model was ${round(TEXT_MODEL_STATS.accuracy * 100, 1)}% accurate with a ${round(TEXT_MODEL_STATS.humanFalsePositiveRate * 100, 2)}% chance of wrongly flagging human writing as AI-generated. It was trained specifically on ChatGPT vs. human text; other AI writers, translated text, or lightly-edited AI text may not generalize well.`,
            value: round(ai.probabilityAi, 3),
          }
        : {
            detector: "ai_model",
            finding: "model_unavailable",
            direction: "neutral",
            severity: "low",
            explanation: "No text-generation classifier is configured, so no AI probability is reported.",
          },
      {
        detector: "provenance",
        finding: "provenance_unavailable",
        direction: "neutral",
        severity: "low",
        explanation: "Text provenance is not embedded in the submitted text.",
      },
    ],
  };
};

export const buildImageResult = async (input: {
  bytes: Buffer;
  filename: string;
  mimeType: string;
  processingTimeMs: number;
}): Promise<ForensicResult> => {
  const filename = safeFilename(input.filename);
  const inspection = await extractMetadata(input.bytes, filename, input.mimeType);
  const actionableSignalCount = inspection.signals.filter((signal) => signal.direction !== "neutral").length;

  const derived =
    inspection.ai.available && inspection.ai.probabilityAi !== null
      ? deriveClassification(inspection.ai.probabilityAi)
      : {
          classification: "inconclusive" as const,
          evidenceStrength: actionableSignalCount > 0 ? ("limited" as const) : ("insufficient" as const),
        };

  return {
    analysis_id: randomUUID(),
    modality: "image",
    filename,
    classification: derived.classification,
    overall_confidence: inspection.ai.available && inspection.ai.probabilityAi !== null ? round(inspection.ai.probabilityAi, 3) : null,
    evidence_strength: derived.evidenceStrength,
    provenance_status: "unavailable",
    signals: inspection.signals,
    limitations: buildLimitations(LIMITATIONS, inspection.ai.available),
    model_versions: inspection.ai.available ? [IMAGE_MODEL_STATS.modelVersion] : [],
    metadata: inspection.metadata,
    text_statistics: null,
    created_at: new Date(),
    processing_time_ms: input.processingTimeMs,
  };
};

export const buildTextResult = async (input: {
  text: string;
  filename?: string | null;
  processingTimeMs: number;
}): Promise<ForensicResult> => {
  const filename = safeFilename(input.filename?.trim() || "pasted-text.txt");
  const inspection = await inspectText(input.text);

  const derived =
    inspection.ai.available && inspection.ai.probabilityAi !== null
      ? deriveClassification(inspection.ai.probabilityAi)
      : { classification: "inconclusive" as const, evidenceStrength: "insufficient" as const };

  return {
    analysis_id: randomUUID(),
    modality: "text",
    filename,
    classification: derived.classification,
    overall_confidence: inspection.ai.available && inspection.ai.probabilityAi !== null ? round(inspection.ai.probabilityAi, 3) : null,
    evidence_strength: derived.evidenceStrength,
    provenance_status: "unavailable",
    signals: inspection.signals,
    limitations: buildLimitations(["Stylometric statistics vary by genre, author, language, and editing process.", ...LIMITATIONS], inspection.ai.available),
    model_versions: inspection.ai.available ? [TEXT_MODEL_STATS.modelVersion] : [],
    metadata: null,
    text_statistics: inspection.statistics,
    created_at: new Date(),
    processing_time_ms: input.processingTimeMs,
  };
};

export { hasImageSignature, safeFilename };