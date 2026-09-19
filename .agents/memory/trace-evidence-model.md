---
name: TRACE evidence model
description: Durable decisions for honest forensic analysis and the workspace upload contract.
---

TRACE treats forensic output as evidence plus a cautious interpretation. Deterministic metadata and signal findings must remain individually inspectable, while the overall classification stays inconclusive and confidence stays null unless a real, validated detector is available.

**Why:** Digital-authenticity tooling can create false certainty when missing metadata or simple statistics are presented as proof of AI generation or authorship.

**How to apply:** Add new detectors as evidence producers first; do not average unrelated signals into a synthetic probability or expose sensitive metadata such as GPS coordinates by default. In this workspace, image uploads use a bounded base64 JSON payload so the generated shared client remains compatible with the Node typecheck.