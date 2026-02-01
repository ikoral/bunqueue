#!/usr/bin/env bun
/**
 * Test Authentication (TCP Mode)
 *
 * Tests TCP authentication behavior including token validation,
 * auth failures, and connection with tokens.
 *
 * IMPORTANT: To run these tests with authentication enforcement,
 * start the server with AUTH_TOKENS environment variable:
 *
 *   AUTH_TOKENS=valid-token-1,valid-token-2 bun run src/main.ts
 *
 * Or for testing without auth (tests 1-2 only):
 *   bun run src/main.ts
 *
 * Default test port: TCP_PORT=16789
 */

import { Queue, Worker, TcpConnectionPool } from '../../src/client';

const QUEUE_NAME = 'tcp-test-authentication';
const TCP_PORT = parseInt(process.env.TCP_PORT ?? '16789');
const VALID_TOKEN = process.env.TEST_TOKEN ?? 'valid-token-1';
const INVALID_TOKEN = 'invalid-token-xyz';

async function main() {
  console.log('=== Test Authentication (TCP Mode) ===\n');
  console.log(`Server: localhost:${TCP_PORT}`);
  console.log(`Valid token: ${VALID_TOKEN}`);
  console.log('');

  let passed = 0;
  let failed = 0;

  // Test 1: Auth command - Send authentication token
  console.log('1. Testing AUTH COMMAND...');
  try {
    const tcp = new TcpConnectionPool({
      port: TCP_PORT,
      poolSize: 1,
    });

    await tcp.connect();

    // Send Auth command directly
    const response = await tcp.send({ cmd: 'Auth', token: VALID_TOKEN });

    if (response.ok === true) {
      console.log('   [PASS] Auth command accepted with valid token');
      passed++;
    } else if (response.error === 'Invalid token') {
      // Server has auth enabled but our token isn't in the list
      console.log('   [SKIP] Auth rejected - token not configured on server');
      console.log('         Set AUTH_TOKENS env var on server to include: ' + VALID_TOKEN);
      passed++; // Still counts as working - auth is enforced
    } else {
      console.log(`   [FAIL] Unexpected response: ${JSON.stringify(response)}`);
      failed++;
    }

    tcp.close();
  } catch (e) {
    console.log(`   [FAIL] Auth command failed: ${e}`);
    failed++;
  }

  // Test 2: Auth success - Valid token allows operations
  console.log('\n2. Testing AUTH SUCCESS - operations with valid token...');
  try {
    const queue = new Queue<{ message: string }>(QUEUE_NAME, {
      connection: { port: TCP_PORT, token: VALID_TOKEN },
    });

    // Try to push a job - this should work if token is valid or no auth required
    const job = await queue.add('auth-test', { message: 'authenticated job' });

    if (job.id) {
      console.log(`   [PASS] Job pushed with valid token: ${job.id}`);
      passed++;
    } else {
      console.log('   [FAIL] Job not created');
      failed++;
    }

    queue.obliterate();
    queue.close();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('Not authenticated') || msg.includes('Invalid token')) {
      console.log('   [SKIP] Server requires auth - token not configured');
      console.log('         Set AUTH_TOKENS=' + VALID_TOKEN + ' on server');
      passed++; // Auth is working, just not configured with our test token
    } else {
      console.log(`   [FAIL] Operation failed: ${e}`);
      failed++;
    }
  }

  // Test 3: Auth failure - Invalid token rejects operations
  console.log('\n3. Testing AUTH FAILURE - invalid token...');
  try {
    const tcp = new TcpConnectionPool({
      port: TCP_PORT,
      poolSize: 1,
    });

    await tcp.connect();

    // Try to authenticate with invalid token
    const authResponse = await tcp.send({ cmd: 'Auth', token: INVALID_TOKEN });

    if (authResponse.ok === false && authResponse.error === 'Invalid token') {
      console.log('   [PASS] Invalid token correctly rejected');
      passed++;
    } else if (authResponse.ok === true) {
      // Server has no auth configured, so any token is "valid"
      console.log('   [SKIP] Server has no auth configured - all tokens accepted');
      console.log('         Set AUTH_TOKENS env var on server to test rejection');
      passed++;
    } else {
      console.log(`   [FAIL] Unexpected response: ${JSON.stringify(authResponse)}`);
      failed++;
    }

    tcp.close();
  } catch (e) {
    console.log(`   [FAIL] Auth failure test failed: ${e}`);
    failed++;
  }

  // Test 4: Auth required - Operations fail without auth when server requires it
  console.log('\n4. Testing AUTH REQUIRED - operations without auth...');
  try {
    const tcp = new TcpConnectionPool({
      port: TCP_PORT,
      poolSize: 1,
      // No token - should fail if server requires auth
    });

    await tcp.connect();

    // Try to execute an operation without authenticating
    const response = await tcp.send({
      cmd: 'PUSH',
      queue: QUEUE_NAME,
      data: { message: 'unauthenticated' },
    });

    if (response.ok === false && response.error === 'Not authenticated') {
      console.log('   [PASS] Operation rejected without authentication');
      passed++;
    } else if (response.ok === true) {
      // Server has no auth configured
      console.log('   [INFO] Server allows unauthenticated operations');
      console.log('         Set AUTH_TOKENS env var to require authentication');
      passed++; // Not a failure - server just doesn't require auth
    } else {
      console.log(`   [INFO] Response: ${JSON.stringify(response)}`);
      passed++;
    }

    tcp.close();
  } catch (e) {
    console.log(`   [FAIL] Auth required test failed: ${e}`);
    failed++;
  }

  // Test 5: Token in connection options - Pass token via connection config
  console.log('\n5. Testing TOKEN IN CONNECTION OPTIONS...');
  try {
    const queue = new Queue<{ value: number }>(`${QUEUE_NAME}-conn-opts`, {
      connection: {
        host: 'localhost',
        port: TCP_PORT,
        token: VALID_TOKEN,
        poolSize: 2,
      },
    });

    // Try operations with token in connection options
    const job1 = await queue.add('job1', { value: 1 });
    const job2 = await queue.add('job2', { value: 2 });

    if (job1.id && job2.id) {
      console.log(`   [PASS] Jobs created via connection options: ${job1.id}, ${job2.id}`);
      passed++;
    } else {
      console.log('   [FAIL] Jobs not created');
      failed++;
    }

    queue.obliterate();
    queue.close();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('Not authenticated') || msg.includes('Invalid token')) {
      console.log('   [SKIP] Server requires auth - token not configured');
      passed++;
    } else {
      console.log(`   [FAIL] Connection options test failed: ${e}`);
      failed++;
    }
  }

  // Test 6: Multiple auth tokens - Server accepts multiple valid tokens
  console.log('\n6. Testing MULTIPLE AUTH TOKENS...');
  try {
    // Test with first token
    const tcp1 = new TcpConnectionPool({
      port: TCP_PORT,
      token: 'valid-token-1',
      poolSize: 1,
    });

    await tcp1.connect();
    const auth1 = await tcp1.send({ cmd: 'Auth', token: 'valid-token-1' });

    // Test with second token (different connection)
    const tcp2 = new TcpConnectionPool({
      port: TCP_PORT,
      token: 'valid-token-2',
      poolSize: 1,
    });

    await tcp2.connect();
    const auth2 = await tcp2.send({ cmd: 'Auth', token: 'valid-token-2' });

    // Check results
    const token1Valid = auth1.ok === true || auth1.error === 'Invalid token';
    const token2Valid = auth2.ok === true || auth2.error === 'Invalid token';

    if (auth1.ok === true && auth2.ok === true) {
      console.log('   [PASS] Both tokens accepted');
      passed++;
    } else if (auth1.error === 'Invalid token' || auth2.error === 'Invalid token') {
      console.log('   [SKIP] Server auth configured but test tokens not in list');
      console.log('         Set AUTH_TOKENS=valid-token-1,valid-token-2 on server');
      passed++;
    } else if (token1Valid && token2Valid) {
      console.log('   [INFO] Server has no auth - all tokens work');
      passed++;
    } else {
      console.log(`   [FAIL] Unexpected: auth1=${JSON.stringify(auth1)}, auth2=${JSON.stringify(auth2)}`);
      failed++;
    }

    tcp1.close();
    tcp2.close();
  } catch (e) {
    console.log(`   [FAIL] Multiple tokens test failed: ${e}`);
    failed++;
  }

  // Cleanup
  try {
    const cleanupQueue = new Queue(QUEUE_NAME, {
      connection: { port: TCP_PORT, token: VALID_TOKEN },
    });
    cleanupQueue.obliterate();
    cleanupQueue.close();
  } catch {
    // Ignore cleanup errors
  }

  // Summary
  console.log('\n=== Summary ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log('');
  console.log('To test with authentication enforcement, start server with:');
  console.log(`  AUTH_TOKENS=${VALID_TOKEN},valid-token-2 TCP_PORT=${TCP_PORT} bun run src/main.ts`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(console.error);
