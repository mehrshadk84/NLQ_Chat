# Repository Guidelines & Architecture Invariants

## Overview
This repository implements an on-premise Enterprise NLQ & BI Analytics engine for **GreenXERP** (Microsoft SQL Server) powered by local LLMs via **Ollama**.

## Core Architectural Modules
1. **API Layer (`src/app/api/chat/route.ts`):**
   - Exposes `POST /api/chat` supporting both single-payload JSON (`"stream": false`) for ERP backend integration and `application/x-ndjson` streaming for the web UI.
   - Validates all outgoing payloads against `readErpResponse` in `src/lib/erp/contract.ts`.
2. **Inference & Concurrency (`src/lib/ai/ollama-client.ts`):**
   - Serializes all LLM calls through a thread-safe **FIFO Queue** to maintain constant VRAM usage on single-GPU deployments.
   - Uses constrained JSON Schema decoding (`UNIFIED_GENESIS_JSON_SCHEMA` and `EXECUTIVE_REPORT_JSON_SCHEMA`).
3. **Hypothesis & Self-Healing SQL Engine (`src/lib/ai/hypothesis-engine.ts`):**
   - Classifies requests into 4 intents: `answer`, `query`, `diagram`, and `analysis`.
   - Applies deterministic schema normalization (`sanitizeErpSql`) and a 3-attempt runtime `Auto-Repair` loop (`runSql`) with automatic `LEFT JOIN` fallback on zero-row results.
4. **Schema Graph Orchestrator (`src/lib/mcp/orchestrator.ts` & `scripts/build-schema-graph.js`):**
   - Extracts compact, foreign-key-connected subgraphs per query rather than passing full database DDLs to the LLM.
5. **Security & Governance (`src/lib/erp/rbac.ts`, `src/lib/erp/sql-guard.ts`, `src/lib/ai/sanitizer.ts`):**
   - Enforces read-only `SELECT` execution, role-based schema/table access boundaries, surrogate key stripping, and PII masking.

## Security Rules for Contributors
- Never commit `.env.local`, database credentials, internal IP addresses, server hostnames, or full proprietary schema dumps (`data/schema-graph.json`).
- All database connections must use least-privilege `SELECT`-only credentials.