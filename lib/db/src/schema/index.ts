import { jsonb, doublePrecision, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const analysesTable = pgTable("analyses", {
  id: text("id").primaryKey(),
  filename: text("filename").notNull(),
  modality: text("modality").notNull(),
  classification: text("classification").notNull(),
  // Fractional probability (0-1), not a whole number -- e.g. 0.714.
  overallConfidence: doublePrecision("overall_confidence"),
  evidenceStrength: text("evidence_strength").notNull(),
  provenanceStatus: text("provenance_status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  processingTimeMs: integer("processing_time_ms").notNull(),
});

export const evidenceTable = pgTable("evidence", {
  id: text("id").primaryKey(),
  analysisId: text("analysis_id")
    .notNull()
    .references(() => analysesTable.id, { onDelete: "cascade" }),
  detector: text("detector").notNull(),
  finding: text("finding").notNull(),
  direction: text("direction").notNull(),
  // Fractional probability (0-1), not a whole number -- e.g. 0.714.
  confidence: doublePrecision("confidence"),
  severity: text("severity").notNull(),
  explanation: text("explanation").notNull(),
  value: text("value"),
});

export const detectorResultsTable = pgTable("detector_results", {
  id: text("id").primaryKey(),
  analysisId: text("analysis_id")
    .notNull()
    .references(() => analysesTable.id, { onDelete: "cascade" }),
  detector: text("detector").notNull(),
  status: text("status").notNull(),
  payload: jsonb("payload").notNull(),
});

export const reportsTable = pgTable("reports", {
  id: text("id").primaryKey(),
  analysisId: text("analysis_id")
    .notNull()
    .references(() => analysesTable.id, { onDelete: "cascade" }),
  metadata: jsonb("metadata"),
  textStatistics: jsonb("text_statistics"),
  limitations: jsonb("limitations").notNull(),
  modelVersions: jsonb("model_versions").notNull(),
});