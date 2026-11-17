export type HypothesisDomain = 'inventory' | 'customer' | 'pricing' | 'branch';
export type StageName = 'VERIFY_FACT' | 'GENERATE_HYPOTHESIS' | 'TEST_HYPOTHESIS' | 'FINAL_SYNTHESIS';
export type UserIntentType = 'answer' | 'query' | 'diagram' | 'analysis';
export type DiagramChartType = 'vertical-bar' | 'line' | 'pie' | '';

export interface HypothesisItem {
  id: string;
  domain: HypothesisDomain;
  statement: string;
  validation_sql_goal: string;
}

export interface UnifiedGenesisOutput {
  detected_intent?: UserIntentType;
  chart_type?: DiagramChartType;
  direct_answer?: string;
  detected_domain: string;
  verification: {
    goal: string;
    sql_query: string;
  };
  hypotheses: Array<{
    id: string;
    domain: HypothesisDomain;
    statement: string;
    expected_metric: string;
    sql_query: string;
  }>;
}

export interface ExecutiveReportOutput {
  report_title: string;
  executive_summary: string;
  hypotheses_verdicts: Array<{
    statement: string;
    verdict: 'CONFIRMED' | 'REJECTED' | 'INCONCLUSIVE' | 'SUPPORTED';
    evidence: string;
  }>;
  root_cause_analysis: string;
  managerial_recommendations: string[];
}

export const UNIFIED_GENESIS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    detected_intent: { type: 'string', enum: ['answer', 'query', 'diagram', 'analysis'] },
    chart_type: { type: 'string', enum: ['vertical-bar', 'line', 'pie', ''] },
    direct_answer: { type: 'string' },
    detected_domain: { type: 'string' },
    verification: {
      type: 'object',
      properties: {
        goal: { type: 'string' },
        sql_query: { type: 'string' },
      },
      required: ['goal', 'sql_query'],
    },
    hypotheses: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          domain: { type: 'string' },
          statement: { type: 'string' },
          expected_metric: { type: 'string' },
          sql_query: { type: 'string' },
        },
        required: ['id', 'domain', 'statement', 'expected_metric', 'sql_query'],
      },
    },
  },
  required: ['detected_intent', 'detected_domain', 'verification', 'hypotheses'],
};

export const EXECUTIVE_REPORT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    report_title: { type: 'string' },
    executive_summary: { type: 'string' },
    hypotheses_verdicts: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          statement: { type: 'string' },
          verdict: { type: 'string', enum: ['CONFIRMED', 'REJECTED', 'INCONCLUSIVE'] },
          evidence: { type: 'string' },
        },
        required: ['statement', 'verdict', 'evidence'],
      },
    },
    root_cause_analysis: { type: 'string' },
    managerial_recommendations: {
      type: 'array',
      maxItems: 2,
      items: { type: 'string' },
    },
  },
  required: [
    'report_title',
    'executive_summary',
    'hypotheses_verdicts',
    'root_cause_analysis',
    'managerial_recommendations',
  ],
};
