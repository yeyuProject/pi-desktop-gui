import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyModelError, redact, type ModelErrorKind } from '../shared/errors';

// Synthetic messages in provider/SDK formats; no credentials or user requests are recorded here.
const samples: [ModelErrorKind, string][] = [
  [
    'auth',
    '401 {"error":{"message":"Incorrect API key provided: sk-test1234567890123456","type":"invalid_request_error","code":"invalid_api_key"}}',
  ],
  ['auth', '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'],
  ['auth', '{"error":{"code":403,"message":"Permission denied","status":"PERMISSION_DENIED"}}'],
  ['auth', '{"error":{"message":"User not found.","code":401}}'],
  ['auth', '401 Authentication Fails'],
  ['auth', 'Unauthorized'],
  ['auth', 'INVALID API KEY'],
  ['auth', 'UNAUTHENTICATED'],
  [
    'quota',
    '429 {"error":{"type":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details."}}',
  ],
  ['quota', '{"error":{"code":402,"message":"Insufficient credits. Add more using the credits page."}}'],
  ['quota', '402 Insufficient Balance'],
  ['quota', '账户余额不足'],
  ['quota', 'quota exceeded'],
  ['quota', 'payment required'],
  ['quota', 'billing hard limit reached'],
  ['busy', '429 {"error":{"code":"rate_limit_exceeded","message":"Rate limit reached for requests"}}'],
  ['busy', '429 {"error":{"type":"rate_limit_error","message":"Too many requests"}}'],
  ['busy', '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'],
  ['busy', '{"error":{"code":429,"message":"Resource has been exhausted","status":"RESOURCE_EXHAUSTED"}}'],
  ['busy', '429 Rate Limit Reached'],
  ['busy', '503 Service Unavailable'],
  ['busy', 'Too Many Requests'],
  [
    'context',
    '400 {"error":{"code":"context_length_exceeded","message":"This model maximum context length is 128000 tokens"}}',
  ],
  [
    'context',
    '400 {"error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}',
  ],
  ['context', 'The request has too many tokens'],
  ['context', '503 gateway: context length exceeded'],
  [
    'model',
    '404 {"error":{"code":"model_not_found","message":"The model gpt-example does not exist or you do not have access to it"}}',
  ],
  ['model', '404 {"error":{"status":"NOT_FOUND","message":"models/example is not found"}}'],
  ['model', 'Model not found: example'],
  ['model', 'This model is not supported'],
  ['network', 'TypeError: fetch failed'],
  ['network', 'Connection error.'],
  ['network', 'connect ECONNREFUSED 127.0.0.1:12345'],
  ['network', 'getaddrinfo ENOTFOUND api.example.invalid'],
  ['network', 'connect ETIMEDOUT'],
  ['network', 'read ECONNRESET'],
  ['network', 'socket hang up'],
  ['network', 'network error'],
  ['network', 'unable to verify the first certificate'],
  ['network', 'Request timed out'],
  ['network', '503 proxy upstream: ECONNREFUSED'],
  ['unknown', '400 {"error":{"message":"Malformed input"}}'],
  ['unknown', 'request id 1401429503'],
  ['unknown', '404 route not found'],
  ['unknown', 'unexpected provider response'],
];
test('provider and proxy error formats classify with the documented precedence', () => {
  assert.ok(samples.length >= 30);
  for (const [kind, text] of samples) assert.equal(classifyModelError(text).kind, kind, text);
});
test('raw details redact credentials and remain readable', () => {
  const raw =
    '401 Authorization: Bearer secret-token API_KEY="private-key" sk-proj-abcdefghijklmnopqrstuvwxyz';
  const safe = redact(raw);
  for (const value of ['secret-token', 'private-key', 'sk-proj-abcdefghijklmnopqrstuvwxyz'])
    assert.ok(!safe.includes(value));
  assert.match(safe, /401/);
  assert.match(safe, /已隐藏/);
});

test('diagnostics hide custom credential fields, URL passwords, cookies, JWTs and provider keys', () => {
  const values = [
    'custom secret with spaces',
    'encoded-password',
    'cookie-session-value',
    'github_pat_' + 'A'.repeat(30),
    'AIza' + 'B'.repeat(35),
    'ASIA' + 'C'.repeat(16),
    'eyJ' + 'D'.repeat(20) + '.' + 'E'.repeat(20) + '.' + 'F'.repeat(20),
    'opaque-query-value',
    'opaque-client-value',
    'cHJpdmF0ZS1jcmVkZW50aWFs',
  ];
  const raw = `HTTP 401 at service.example: {"client_secret":"${values[0]}","my_provider_token":"${values[8]}"}\nhttps://user:${values[1]}@service.example/path?token=${values[7]}&mode=test\nCookie: session=${values[2]}; another=also-private\nAuthorization: Basic ${values[9]}\n${values.slice(3, 7).join(' ')}\n-----BEGIN PRIVATE KEY-----\nprivate-key-body\n-----END PRIVATE KEY-----`;
  const safe = redact(raw);
  for (const value of [...values, 'also-private', 'private-key-body'])
    assert.ok(!safe.includes(value), value);
  assert.match(safe, /HTTP 401/);
  assert.match(safe, /service\.example/);
  assert.match(safe, /mode=test/);
  assert.equal(
    redact('max_tokens=2000 tokenCount=3 token_limit=5'),
    'max_tokens=2000 tokenCount=3 token_limit=5',
  );
});

test('redacted errors stay stable across history, IPC and display boundaries', () => {
  for (const raw of [
    'apiKey=opaque-test-secret',
    'Cookie: session=opaque-test-secret; another=also-private',
    'Authorization: Bearer opaque-test-secret',
    'https://service.example/?access_token=opaque-test-secret&mode=test',
    '{"apiKey":"opaque-test-secret"}',
  ]) {
    const saved = redact(raw);
    assert.ok(!saved.includes('opaque-test-secret'));
    assert.equal(redact(redact(saved)), saved);
  }
  assert.equal(redact('Cookie: session=opaque-test-secret'), 'Cookie: [已隐藏]');
  assert.deepEqual(JSON.parse(redact('{"apiKey":"opaque-test-secret"}')), { apiKey: '[已隐藏]' });
});
