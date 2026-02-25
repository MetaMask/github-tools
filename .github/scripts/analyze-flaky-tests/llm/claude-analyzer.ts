import Anthropic from '@anthropic-ai/sdk';
import type { AnalysisResult, FlakyTestFailure } from '../types';
import { getToolDefinitions, executeToolCall } from './tools';
import type { ToolContext } from './tools';

const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 4096;
const MAX_ITERATIONS = 10;

function extractAnalysisFromToolCall(
  content: Anthropic.Messages.ContentBlock[],
  failure: FlakyTestFailure,
): AnalysisResult | null {
  for (const block of content) {
    if (block.type === 'tool_use' && block.name === 'submit_analysis') {
      const input = block.input as Record<string, unknown>;
      return {
        testName: failure.name,
        testPath: failure.path,
        classification: (input.classification as AnalysisResult['classification']) ?? 'flaky_test',
        confidence: typeof input.confidence === 'number' ? input.confidence : 50,
        rootCauseCategory: (input.rootCauseCategory as string) ?? 'other',
        rootCauseExplanation: (input.rootCauseExplanation as string) ?? 'Unable to determine root cause.',
        specificLines: Array.isArray(input.specificLines) ? (input.specificLines as string[]) : [],
        suggestedFix: (input.suggestedFix as string) ?? 'No suggestion available.',
        additionalNotes: (input.additionalNotes as string) ?? '',
      };
    }
  }
  return null;
}

export async function analyzeWithClaude(
  initialPrompt: string,
  failure: FlakyTestFailure,
  apiKey: string,
  toolContext: ToolContext,
): Promise<AnalysisResult> {
  const client = new Anthropic({ apiKey });
  const tools = getToolDefinitions(toolContext.owner, toolContext.repo);
  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: initialPrompt },
  ];

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      tools,
      messages,
    });

    const submittedAnalysis = extractAnalysisFromToolCall(response.content, failure);
    if (submittedAnalysis) {
      const submitBlock = response.content.find(
        (b) => b.type === 'tool_use' && b.name === 'submit_analysis',
      );
      if (submitBlock && submitBlock.type === 'tool_use') {
        messages.push({ role: 'assistant', content: response.content });
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: submitBlock.id,
              content: 'Analysis received. Thank you.',
            },
          ],
        });
      }
      return submittedAnalysis;
    }

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find((b) => b.type === 'text');
      if (textBlock && textBlock.type === 'text') {
        try {
          let cleaned = textBlock.text.trim();
          const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
          if (jsonMatch?.[1]) cleaned = jsonMatch[1].trim();
          const parsed = JSON.parse(cleaned) as Record<string, unknown>;
          return {
            testName: failure.name,
            testPath: failure.path,
            classification: (parsed.classification as AnalysisResult['classification']) ?? 'flaky_test',
            confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 50,
            rootCauseCategory: (parsed.rootCauseCategory as string) ?? 'other',
            rootCauseExplanation: (parsed.rootCauseExplanation as string) ?? 'Unable to determine root cause.',
            specificLines: Array.isArray(parsed.specificLines) ? (parsed.specificLines as string[]) : [],
            suggestedFix: (parsed.suggestedFix as string) ?? 'No suggestion available.',
            additionalNotes: (parsed.additionalNotes as string) ?? '',
          };
        } catch {
          throw new Error(`Claude ended without calling submit_analysis. Raw response: ${textBlock.text.substring(0, 200)}`);
        }
      }
      throw new Error('Claude ended conversation without producing an analysis.');
    }

    if (response.stop_reason !== 'tool_use') {
      throw new Error(`Unexpected stop_reason: ${response.stop_reason}`);
    }

    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.Messages.ToolUseBlock => block.type === 'tool_use',
    );

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const toolUse of toolUseBlocks) {
      if (toolUse.name === 'submit_analysis') continue;

      console.log(`    [tool] ${toolUse.name}(${JSON.stringify(toolUse.input).substring(0, 100)})`);

      const result = await executeToolCall(
        toolUse.name,
        toolUse.input as Record<string, unknown>,
        toolContext,
      );

      const truncated = result.length > 15000
        ? `${result.substring(0, 15000)}\n... (truncated, ${result.length} chars total)`
        : result;

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: truncated,
      });
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });
  }

  throw new Error(`Analysis did not complete within ${MAX_ITERATIONS} iterations.`);
}
