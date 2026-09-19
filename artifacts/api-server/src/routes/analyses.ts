import { Router, type IRouter } from "express";
import { desc, eq, sql } from "drizzle-orm";
import {
  AnalyzeImageBody,
  AnalyzeTextBody,
  DeleteAnalysisParams,
  GetAnalysisParams,
  type ForensicResult,
} from "@workspace/api-zod";
import { db } from "@workspace/db";
import {
  analysesTable,
  detectorResultsTable,
  evidenceTable,
  reportsTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { buildImageResult, buildTextResult, hasImageSignature } from "../services/forensics";

const router: IRouter = Router();
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const serializeSignalValue = (value: unknown) => {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
};

const saveResult = async (result: ForensicResult) => {
  await db.transaction(async (tx) => {
    await tx.insert(analysesTable).values({
      id: result.analysis_id,
      filename: result.filename,
      modality: result.modality,
      classification: result.classification,
      overallConfidence: result.overall_confidence,
      evidenceStrength: result.evidence_strength,
      provenanceStatus: result.provenance_status,
      createdAt: result.created_at,
      processingTimeMs: result.processing_time_ms,
    });

    if (result.signals.length > 0) {
      await tx.insert(evidenceTable).values(
        result.signals.map((signal, index) => ({
          id: `${result.analysis_id}-evidence-${index}`,
          analysisId: result.analysis_id,
          detector: signal.detector,
          finding: signal.finding,
          direction: signal.direction,
          confidence: signal.confidence ?? null,
          severity: signal.severity,
          explanation: signal.explanation,
          value: serializeSignalValue(signal.value),
        })),
      );
    }

    await tx.insert(detectorResultsTable).values(
      result.signals.map((signal, index) => ({
        id: `${result.analysis_id}-detector-${index}`,
        analysisId: result.analysis_id,
        detector: signal.detector,
        status: "completed",
        payload: signal,
      })),
    );

    await tx.insert(reportsTable).values({
      id: `${result.analysis_id}-report`,
      analysisId: result.analysis_id,
      metadata: result.metadata ?? null,
      textStatistics: result.text_statistics ?? null,
      limitations: result.limitations,
      modelVersions: result.model_versions,
    });
  });
};

const readResult = async (analysisId: string): Promise<ForensicResult | null> => {
  const [analysis] = await db
    .select()
    .from(analysesTable)
    .where(eq(analysesTable.id, analysisId))
    .limit(1);
  if (!analysis) return null;

  const [report] = await db
    .select()
    .from(reportsTable)
    .where(eq(reportsTable.analysisId, analysisId))
    .limit(1);
  const evidence = await db
    .select()
    .from(evidenceTable)
    .where(eq(evidenceTable.analysisId, analysisId));

  return {
    analysis_id: analysis.id,
    modality: analysis.modality as ForensicResult["modality"],
    filename: analysis.filename,
    classification: analysis.classification as ForensicResult["classification"],
    overall_confidence: analysis.overallConfidence,
    evidence_strength: analysis.evidenceStrength as ForensicResult["evidence_strength"],
    provenance_status: analysis.provenanceStatus as ForensicResult["provenance_status"],
    signals: evidence.map((item) => ({
      detector: item.detector,
      finding: item.finding,
      direction: item.direction as ForensicResult["signals"][number]["direction"],
      confidence: item.confidence,
      severity: item.severity as ForensicResult["signals"][number]["severity"],
      explanation: item.explanation,
      value: item.value,
    })),
    limitations: (report?.limitations as string[] | null) ?? [],
    model_versions: (report?.modelVersions as string[] | null) ?? [],
    metadata: (report?.metadata as ForensicResult["metadata"]) ?? null,
    text_statistics: (report?.textStatistics as ForensicResult["text_statistics"]) ?? null,
    created_at: analysis.createdAt,
    processing_time_ms: analysis.processingTimeMs,
  };
};

router.post("/analyze/image", async (req, res) => {
  const parsed = AnalyzeImageBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Provide a filename, supported image MIME type, and base64 image data." });

  const startedAt = performance.now();
  const { file_data: encoded, filename, mime_type: mimeType } = parsed.data;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    return res.status(400).json({ error: "Image data is not valid base64." });
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    return res.status(400).json({ error: "Image must be between 1 byte and 8 MB." });
  }
  if (!hasImageSignature(bytes, mimeType)) {
    return res.status(400).json({ error: "The file signature does not match the declared image type." });
  }

  try {
    const result = buildImageResult({
      bytes,
      filename,
      mimeType,
      processingTimeMs: Math.max(1, Math.round(performance.now() - startedAt)),
    });
    await saveResult(result);
    return res.status(201).json(result);
  } catch (error) {
    logger.error({ err: error }, "Image analysis failed");
    return res.status(500).json({ error: "The image could not be analyzed." });
  }
});

router.post("/analyze/text", async (req, res) => {
  const parsed = AnalyzeTextBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Provide text between 1 and 200,000 characters." });

  const startedAt = performance.now();
  try {
    const result = buildTextResult({
      text: parsed.data.text,
      filename: parsed.data.filename,
      processingTimeMs: Math.max(1, Math.round(performance.now() - startedAt)),
    });
    await saveResult(result);
    return res.status(201).json(result);
  } catch (error) {
    logger.error({ err: error }, "Text analysis failed");
    return res.status(500).json({ error: "The text could not be analyzed." });
  }
});

router.get("/analyses", async (_req, res) => {
  try {
    const rows = await db
      .select({
        analysis_id: analysesTable.id,
        filename: analysesTable.filename,
        modality: analysesTable.modality,
        classification: analysesTable.classification,
        evidence_strength: analysesTable.evidenceStrength,
        created_at: analysesTable.createdAt,
        processing_time_ms: analysesTable.processingTimeMs,
      })
      .from(analysesTable)
      .orderBy(desc(analysesTable.createdAt))
      .limit(50);
    return res.json(rows);
  } catch (error) {
    logger.error({ err: error }, "Could not list analyses");
    return res.status(500).json({ error: "Analysis history is unavailable." });
  }
});

router.get("/analyses/summary", async (_req, res) => {
  try {
    const [summary] = await db
      .select({
        total: sql<number>`count(*)::int`,
        image_count: sql<number>`count(*) filter (where ${analysesTable.modality} = 'image')::int`,
        text_count: sql<number>`count(*) filter (where ${analysesTable.modality} = 'text')::int`,
        inconclusive_count: sql<number>`count(*) filter (where ${analysesTable.classification} = 'inconclusive')::int`,
      })
      .from(analysesTable);
    return res.json(summary ?? { total: 0, image_count: 0, text_count: 0, inconclusive_count: 0 });
  } catch (error) {
    logger.error({ err: error }, "Could not summarize analyses");
    return res.status(500).json({ error: "Analysis summary is unavailable." });
  }
});

router.get("/analyses/:analysis_id", async (req, res) => {
  const parsed = GetAnalysisParams.safeParse(req.params);
  if (!parsed.success) return res.status(400).json({ error: "Invalid analysis ID." });
  try {
    const result = await readResult(parsed.data.analysis_id);
    return result ? res.json(result) : res.status(404).json({ error: "Analysis not found." });
  } catch (error) {
    logger.error({ err: error }, "Could not read analysis");
    return res.status(500).json({ error: "The analysis report is unavailable." });
  }
});

router.delete("/analyses/:analysis_id", async (req, res) => {
  const parsed = DeleteAnalysisParams.safeParse(req.params);
  if (!parsed.success) return res.status(400).json({ error: "Invalid analysis ID." });
  try {
    const deleted = await db
      .delete(analysesTable)
      .where(eq(analysesTable.id, parsed.data.analysis_id))
      .returning({ id: analysesTable.id });
    return deleted.length > 0 ? res.status(204).send() : res.status(404).json({ error: "Analysis not found." });
  } catch (error) {
    logger.error({ err: error }, "Could not delete analysis");
    return res.status(500).json({ error: "The analysis could not be deleted." });
  }
});

export default router;