import { describe, expect, it } from 'vitest';
import { ProviderOutputError } from '../src/providers/decisionProvider.js';
import { FAILSAFE_RULE, executeDecisionWithTrace, fallbackRule } from '../src/providers/executeDecision.js';
import { OllamaProvider, type OllamaProviderOptions } from '../src/providers/ollamaProvider.js';
import { ollamaOptionsFromEnv } from '../src/providers/providerRegistry.js';
import { HardConstraint } from '../src/policies/policyEngine.js';
import { buildRecommendation, buildRequest } from './helpers.js';

type FetchArgs = Parameters<typeof fetch>;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const chatReply = (content: unknown): Response => json({ message: { role: 'assistant', content } });

/** Provider wired to a fake fetch; collects diagnostics instead of printing them. */
function createProvider(fetchImpl: (...args: FetchArgs) => Promise<Response>, options: OllamaProviderOptions = {}) {
  const logs: { message: string; details: Record<string, unknown> }[] = [];
  const provider = new OllamaProvider({
    fetchImpl: fetchImpl as typeof fetch,
    logger: (message, details) => logs.push({ message, details }),
    ...options,
  });
  return { provider, logs };
}

/** Never answers; rejects only when the caller's abort signal fires. */
const hangingFetch = (_url: FetchArgs[0], init?: FetchArgs[1]): Promise<Response> =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
  });

const unreachableFetch = async (): Promise<Response> => {
  throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:11434') });
};

describe('OllamaProvider.decide', () => {
  it('returns a contract-valid recommendation from the model', async () => {
    const recommendation = buildRecommendation({ decision: 'HUMAN_REVIEW', confidenceScore: 0.62 });
    const { provider, logs } = createProvider(async () => chatReply(JSON.stringify(recommendation)));

    expect(await provider.decide(buildRequest())).toEqual(recommendation);
    expect(logs).toEqual([]);
  });

  it('sends a schema-constrained, non-streaming chat request to the configured runtime', async () => {
    const calls: FetchArgs[] = [];
    const { provider } = createProvider(
      async (...args) => {
        calls.push(args);
        return chatReply(JSON.stringify(buildRecommendation()));
      },
      { baseUrl: 'http://ollama:11434/', model: 'llama3.2:1b' },
    );
    const request = buildRequest();
    await provider.decide(request);

    expect(calls).toHaveLength(1);
    const [url, init] = calls[0]!;
    const body = JSON.parse(String(init?.body));

    expect(url).toBe('http://ollama:11434/api/chat');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(body.model).toBe('llama3.2:1b');
    expect(body.stream).toBe(false);
    expect(body.options.temperature).toBe(0);
    expect(body.format).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['decision', 'confidenceScore', 'appliedPolicyRules', 'rationale'],
      properties: {
        decision: { enum: ['APPROVED', 'REJECTED', 'HUMAN_REVIEW'] },
        confidenceScore: { minimum: 0, maximum: 1 },
      },
    });
    expect(body.messages[0].content).toContain('untrusted');
    expect(JSON.parse(body.messages[1].content)).toEqual(request);
  });

  it.each([
    ['is unreachable', unreachableFetch, {}, 'UNREACHABLE', Error],
    ['times out', hangingFetch, { timeoutMs: 20 }, 'TIMEOUT', Error],
    [
      'never sends response headers',
      async () => {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) });
      },
      {},
      'TIMEOUT',
      Error,
    ],
    ['returns an HTTP error', async () => json({ error: 'model not found' }, 404), {}, 'HTTP_ERROR', Error],
    ['returns a non-JSON body', async () => new Response('<html>bad gateway</html>'), {}, 'MALFORMED_OUTPUT', ProviderOutputError],
    ['returns no message content', async () => json({ done: true }), {}, 'MALFORMED_OUTPUT', ProviderOutputError],
    ['returns prose instead of JSON', async () => chatReply('Sure! I approve this request.'), {}, 'MALFORMED_OUTPUT', ProviderOutputError],
    ['returns truncated JSON', async () => chatReply('{"decision":"APPROVED","confid'), {}, 'MALFORMED_OUTPUT', ProviderOutputError],
    ['returns an out-of-contract decision', async () => chatReply(JSON.stringify({ ...buildRecommendation(), decision: 'YES' })), {}, 'MALFORMED_OUTPUT', ProviderOutputError],
    ['returns an out-of-range confidence', async () => chatReply(JSON.stringify(buildRecommendation({ confidenceScore: 7 }))), {}, 'MALFORMED_OUTPUT', ProviderOutputError],
  ] as const)('throws and logs a diagnostic when Ollama %s', async (_label, fetchImpl, options, kind, errorType) => {
    const { provider, logs } = createProvider(fetchImpl, options);
    const request = buildRequest();

    const error = await provider.decide(request).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(errorType);
    expect(error instanceof ProviderOutputError).toBe(errorType === ProviderOutputError);
    expect((error as Error).message).toContain(kind);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.details).toMatchObject({ kind, requestId: request.requestId });
  });
});

describe('Ollama failures through executeDecision', () => {
  it.each([
    ['unreachable', unreachableFetch, 'error'],
    ['timeout', hangingFetch, 'error'],
    ['malformed JSON', async () => chatReply('APPROVED'), 'invalid_output'],
    ['contract violation', async () => chatReply(JSON.stringify({ decision: 'APPROVED' })), 'invalid_output'],
  ] as const)('abstains to HUMAN_REVIEW on %s, even for an approvable request', async (_label, fetchImpl, outcome) => {
    const { provider } = createProvider(fetchImpl, { timeoutMs: 20 });
    const { result, trace } = await executeDecisionWithTrace(buildRequest(), [provider]);

    expect(result.decision).toBe('HUMAN_REVIEW');
    expect(result.requiresHumanOversight).toBe(true);
    expect(result.confidenceScore).toBe(0);
    expect(result.appliedPolicyRules).toEqual([fallbackRule('LOCAL_OLLAMA'), FAILSAFE_RULE]);
    expect(trace.failsafe).toBe(true);
    expect(trace.providerDecision).toBeNull();
    expect(trace.attempts).toEqual([
      { provider: 'LOCAL_OLLAMA', outcome, reason: expect.stringContaining('Ollama') },
    ]);
  });

  it('still applies hard constraints to a well-formed model approval', async () => {
    const { provider } = createProvider(async () =>
      chatReply(JSON.stringify(buildRecommendation({ decision: 'APPROVED', confidenceScore: 1 }))),
    );
    const request = buildRequest({ riskLevel: 'HIGH', securityValidationCompleted: false });
    const { result, trace } = await executeDecisionWithTrace(request, [provider]);

    expect(result.decision).toBe('HUMAN_REVIEW');
    expect(result.providerUsed).toBe('LOCAL_OLLAMA');
    expect(trace.providerDecision).toBe('APPROVED');
    expect(trace.policyOverridden).toBe(true);
    expect(trace.violatedConstraints).toEqual([HardConstraint.SECURITY_VALIDATION_REQUIRED]);
  });
});

describe('OllamaProvider.checkHealth', () => {
  it('reports a reachable runtime with the model pulled', async () => {
    const { provider } = createProvider(async () => json({ models: [{ name: 'llama3.2:3b' }] }));
    expect(await provider.checkHealth()).toEqual({
      reachable: true,
      modelAvailable: true,
      baseUrl: 'http://localhost:11434',
      model: 'llama3.2:3b',
      error: null,
    });
  });

  it('reports a reachable runtime whose model has not been pulled', async () => {
    const { provider } = createProvider(async () => json({ models: [{ name: 'mistral:7b' }] }));
    const health = await provider.checkHealth();
    expect(health).toMatchObject({ reachable: true, modelAvailable: false });
    expect(health.error).toContain('has not been pulled');
  });

  it.each([
    ['unreachable', unreachableFetch],
    ['hanging', hangingFetch],
    ['erroring', async () => json({}, 500)],
  ] as const)('reports an %s runtime without throwing', async (_label, fetchImpl) => {
    const { provider } = createProvider(fetchImpl, { timeoutMs: 20 });
    const health = await provider.checkHealth();
    expect(health).toMatchObject({ reachable: false, modelAvailable: false });
    expect(health.error).toBeTruthy();
  });
});

describe('ollamaOptionsFromEnv', () => {
  it('reads overrides from the environment', () => {
    expect(
      ollamaOptionsFromEnv({ OLLAMA_BASE_URL: 'http://ollama:11434', OLLAMA_MODEL: 'mistral:7b', OLLAMA_TIMEOUT_MS: '8000' }),
    ).toEqual({ baseUrl: 'http://ollama:11434', model: 'mistral:7b', timeoutMs: 8000 });
  });

  it.each([undefined, '', 'abc', '0', '-5'])('ignores an OLLAMA_TIMEOUT_MS of %j', (value) => {
    expect(ollamaOptionsFromEnv({ OLLAMA_TIMEOUT_MS: value })).toEqual({});
  });
});
