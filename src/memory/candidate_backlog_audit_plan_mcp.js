export function candidateBacklogAuditPlanToolConfig(z, scopedSchema) {
  return {
    title: 'Plan Memory Candidate Backlog Audit',
    description:
      'Build a provider-free, read-only backlog audit plan with deterministic triage, exact duplicate grouping, stale suggestions, bounded provider-call selection, and prompt-size/token/cost estimates. Pricing is calculated only from caller-supplied per-million-token rates.',
    inputSchema: {
      ...scopedSchema,
      candidateIds: z.array(z.string()).max(500).optional(),
      candidateType: z.string().optional(),
      promotionRecommendation: z.string().optional(),
      auditState: z.string().optional(),
      category: z.string().optional(),
      sourceAgent: z.string().optional(),
      order: z.enum(['asc', 'desc']).optional(),
      limit: z.number().int().positive().max(500).optional(),
      maxProviderCalls: z.number().int().positive().max(10).optional(),
      minConfidence: z.number().min(0).max(1).optional(),
      minStability: z.number().min(0).max(1).optional(),
      allowedCategories: z.array(z.string()).optional(),
      staleAfterMs: z.number().int().positive().optional(),
      asOf: z.string().optional(),
      charsPerToken: z.number().positive().optional(),
      estimatedOutputTokensPerCall: z.number().int().positive().optional(),
      inputUsdPerMillionTokens: z.number().nonnegative().optional(),
      outputUsdPerMillionTokens: z.number().nonnegative().optional(),
      includeCandidates: z.boolean().optional(),
    },
    annotations: {
      title: 'Plan Memory Candidate Backlog Audit',
      idempotentHint: true,
    },
  };
}
