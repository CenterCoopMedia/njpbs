import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const template = JSON.parse(readFileSync(new URL('../../infrastructure/boardwalk-video-previews/template-v1.json', import.meta.url), 'utf8'));
const states = template.Resources.PreviewWorkflow.Properties.Definition.States;

describe('viewing-copy transient S3 retries', () => {
  it.each([
    ['createMultipartUpload', states['Start staging copy']],
    ['uploadPartCopy', states['Copy exact original parts'].ItemProcessor.States['Copy part']],
    ['completeMultipartUpload', states['Complete staging copy']],
  ])('retries the verified transport error for %s with bounded jitter', (action, state) => {
    expect(state.Resource).toBe(`arn:aws:states:::aws-sdk:s3:${action}`);
    // AWS SDK transport failures use this retryable error name.
    expect(state.Retry).toEqual([{
      ErrorEquals: ['S3.SdkClientException'],
      IntervalSeconds: 2, MaxAttempts: 5, BackoffRate: 2, MaxDelaySeconds: 30, JitterStrategy: 'FULL',
    }]);
  });

  it('keeps copy concurrency and the paid conversion policy', () => {
    expect(states['Copy exact original parts'].MaxConcurrency).toBe(4);
    expect(states['Copy exact original parts']).not.toHaveProperty('Retry');
    expect(states['Create viewing copy']).not.toHaveProperty('Retry');
  });
});
