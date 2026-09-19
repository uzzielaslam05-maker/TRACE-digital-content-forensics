import { createHash, randomUUID } from "node:crypto";
import type {
  FileMetadata,
  ForensicResult,
  ForensicSignal,
  TextStatistics,
} from "@workspace/api-zod";

type ImageInspection = {
  metadata: FileMetadata;
  signals: ForensicSignal[];
};

const LIMITATIONS = [
  "Deterministic file and language statistics cannot prove authorship, origin, or AI generation.",
  "The AI-generation model is not configured in this MVP.",
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
    const colorMode = colorType === 0 ? "L" : colorType === 4 ? "LA" : colorType === 6 ? "RGBA" : "RGB";
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

  if (mimeType === "image/webp" && bytes.length >= 30 && bytes.toString("ascii", 12, 16) === "VP8X") {
    const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
    const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    return { width, height, colorMode: "RGBA", format: "WEBP" };
  }

  if (mimeType === "image/jpeg" && bytes.length > 4) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      const length = bytes.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xc3 && length >= 7) {
        return {
          width: bytes.readUInt16BE(offset + 7),
          height: bytes.readUInt16BE(offset + 5),
          colorMode: bytes[offset + 9] === 1 ? "L" : "RGB",
          format: "JPEG",
        };
      }
      if (length < 2) break;
      offset += 2 + length;
    }
    return { width: null, height: null, colorMode: "RGB", format: "JPEG" };
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

const extractMetadata = (bytes: Buffer, filename: string, mimeType: string): ImageInspection => {
  const dimensions = detectDimensions(bytes, mimeType);
  const ascii = bytes.toString("latin1");
  const softwareMatch = ascii.match(/(Adobe Photoshop|Adobe Lightroom|GIMP|Canva|Pixelmator|Affinity Photo)/i);
  const cameraMatch = ascii.match(/(Canon|NIKON|FUJIFILM|SONY|Panasonic|OLYMPUS|Apple iPhone|Google Pixel)/i);
  const gpsPresent = /\bGPS\b/i.test(ascii);
  const hasExif = /Exif\u0000\u0000/i.test(ascii) || /ICC_PROFILE/i.test(ascii);
  const metadata: FileMetadata = {
    filename,
    mime_type: mimeType,
    file_size_bytes: bytes.length,
    width: dimensions.width,
    height: dimensions.height,
    color_mode: dimensions.colorMode,
    format: dimensions.format,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    exif: hasExif || softwareMatch || cameraMatch || gpsPresent
      ? {
          ...(cameraMatch ? { camera: cameraMatch[1] } : {}),
          ...(softwareMatch ? { software: softwareMatch[1] } : {}),
          ...(gpsPresent ? { gps_available: true } : {}),
          metadata_note: "Sensitive coordinates are intentionally not exposed.",
        }
      : {},
  };

  const signals: ForensicSignal[] = [
    {
      detector: "metadata",
      finding: hasExif ? "metadata_present" : "metadata_unavailable",
      direction: "neutral",
      severity: "low",
      explanation: hasExif
        ? "The file contains metadata-like markers. Metadata can describe processing history but cannot establish authorship."
        : "No useful metadata was detected. This does not establish whether the content is AI-generated.",
      value: hasExif,
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
    {
      detector: "ai_model",
      finding: "model_unavailable",
      direction: "neutral",
      severity: "low",
      explanation: "No image-generation classifier is configured, so no AI probability is reported.",
    },
  ];

  if (softwareMatch) {
    signals.push({
      detector: "metadata",
      finding: "editing_software_present",
      direction: "supports_editing",
      severity: "medium",
      explanation: `The file includes a software marker associated with ${softwareMatch[1]}. This indicates processing, not deception.`,
      value: softwareMatch[1],
    });
  }

  return { metadata, signals };
};

const inspectText = (text: string): { statistics: TextStatistics; signals: ForensicSignal[] } => {
  const words = text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
  const sentences = text.split(/[.!?]+/).map((sentence) => sentence.trim()).filter(Boolean);
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

  return {
    statistics,
    signals: [
      {
        detector: "stylometry",
        finding: "transparent_statistics_computed",
        direction: "neutral",
        severity: "low",
        explanation: "Word, sentence, vocabulary, repetition, and punctuation statistics are shown as context, not authorship proof.",
      },
      {
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

export const buildImageResult = (input: {
  bytes: Buffer;
  filename: string;
  mimeType: string;
  processingTimeMs: number;
}): ForensicResult => {
  const filename = safeFilename(input.filename);
  const inspection = extractMetadata(input.bytes, filename, input.mimeType);
  return {
    analysis_id: randomUUID(),
    modality: "image",
    filename,
    classification: "inconclusive",
    overall_confidence: null,
    evidence_strength: inspection.signals.length > 2 ? "limited" : "insufficient",
    provenance_status: "unavailable",
    signals: inspection.signals,
    limitations: LIMITATIONS,
    model_versions: [],
    metadata: inspection.metadata,
    text_statistics: null,
    created_at: new Date(),
    processing_time_ms: input.processingTimeMs,
  };
};

export const buildTextResult = (input: {
  text: string;
  filename?: string | null;
  processingTimeMs: number;
}): ForensicResult => {
  const filename = safeFilename(input.filename?.trim() || "pasted-text.txt");
  const inspection = inspectText(input.text);
  return {
    analysis_id: randomUUID(),
    modality: "text",
    filename,
    classification: "inconclusive",
    overall_confidence: null,
    evidence_strength: (inspection.statistics.word_count ?? 0) >= 20 ? "limited" : "insufficient",
    provenance_status: "unavailable",
    signals: inspection.signals,
    limitations: [
      "Stylometric statistics vary by genre, author, language, and editing process.",
      ...LIMITATIONS,
    ],
    model_versions: [],
    metadata: null,
    text_statistics: inspection.statistics,
    created_at: new Date(),
    processing_time_ms: input.processingTimeMs,
  };
};

export { hasImageSignature, safeFilename };