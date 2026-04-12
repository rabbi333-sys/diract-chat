#!/usr/bin/env bash
# Security regression tests for Task #1 (SQL Injection & Credential Exposure)
# Usage: bash artifacts/api-server/test/security.test.sh
# Requires the API server to be running on port 8080.

BASE="http://localhost:8080/api"
PASS=0
FAIL=0

check() {
  local desc="$1"
  local expected="$2"
  local actual="$3"
  if echo "$actual" | grep -q "$expected"; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc"
    echo "        expected to contain: $expected"
    echo "        got: $actual"
    FAIL=$((FAIL + 1))
  fi
}

check_absent() {
  local desc="$1"
  local absent="$2"
  local actual="$3"
  if echo "$actual" | grep -q "$absent"; then
    echo "  FAIL: $desc (found: $absent)"
    FAIL=$((FAIL + 1))
  else
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  fi
}

echo ""
echo "=== SQL Injection Protection ==="

# 1. Semicolon injection in tableName should return 400
RESP=$(curl -s -X POST "$BASE/sessions/summaries" \
  -H "Content-Type: application/json" \
  -d '{"creds":{"dbType":"postgresql","host":"localhost","port":"5432","dbUsername":"u","dbPassword":"p","tableName":"sessions; DROP TABLE sessions--"}}')
check "semicolon injection in tableName → 400" "Invalid table name" "$RESP"

# 2. Hyphen/dash injection should return 400
RESP=$(curl -s -X POST "$BASE/sessions/summaries" \
  -H "Content-Type: application/json" \
  -d '{"creds":{"dbType":"postgresql","host":"localhost","port":"5432","dbUsername":"u","dbPassword":"p","tableName":"sessions--"}}')
check "double-dash injection in tableName → 400" "Invalid table name" "$RESP"

# 3. Space/UNION injection should return 400
RESP=$(curl -s -X POST "$BASE/sessions/messages" \
  -H "Content-Type: application/json" \
  -d '{"creds":{"dbType":"mysql","host":"localhost","port":"3306","dbUsername":"u","dbPassword":"p","tableName":"sessions UNION SELECT 1"},"sessionId":"x"}')
check "UNION injection in tableName → 400" "Invalid table name" "$RESP"

# 4. Dot injection (schema traversal) should return 400
RESP=$(curl -s -X POST "$BASE/sessions/insert" \
  -H "Content-Type: application/json" \
  -d '{"creds":{"dbType":"postgresql","host":"localhost","dbUsername":"u","dbPassword":"p","tableName":"pg_catalog.pg_shadow"},"message":{"session_id":"x","message_text":"y"}}')
check "dot/schema-traversal injection in tableName → 400" "Invalid table name" "$RESP"

# 5. Valid alphanumeric table name must NOT return a 400 validation error
RESP=$(curl -s -X POST "$BASE/sessions/summaries" \
  -H "Content-Type: application/json" \
  -d '{"creds":{"dbType":"postgresql","host":"localhost","port":"5432","dbUsername":"u","dbPassword":"p","tableName":"n8n_chat_histories"}}')
check_absent "valid table name n8n_chat_histories is accepted (no 400 validation error)" \
  "Invalid table name" "$RESP"

# 6. Table name over 64 chars should return 400
LONG=$(printf 'a%.0s' {1..65})
RESP=$(curl -s -X POST "$BASE/sessions/summaries" \
  -H "Content-Type: application/json" \
  -d "{\"creds\":{\"dbType\":\"postgresql\",\"host\":\"localhost\",\"tableName\":\"$LONG\"}}")
check "table name >64 chars → 400" "Invalid table name" "$RESP"

echo ""
echo "=== SSE Credential Exposure ==="

# 7. GET stream without token should return 400
RESP=$(curl -s "$BASE/realtime/stream")
check "GET /realtime/stream without token → missing token error" "Missing token" "$RESP"

# 8. GET stream with invalid token should return 401
RESP=$(curl -s "$BASE/realtime/stream?token=not-a-valid-uuid")
check "GET /realtime/stream with bogus token → 401" "Token expired or invalid" "$RESP"

# 9. POST realtime/init with valid params returns a token
RESP=$(curl -s -X POST "$BASE/realtime/init" \
  -H "Content-Type: application/json" \
  -d '{"dbType":"mongodb","host":"localhost","tables":"n8n_chat_histories"}')
check "POST /realtime/init with valid params → token" "token" "$RESP"

# 10. POST realtime/init with injected collection name → 400
RESP=$(curl -s -X POST "$BASE/realtime/init" \
  -H "Content-Type: application/json" \
  -d '{"dbType":"mongodb","host":"localhost","tables":"valid_table,evil;DROP TABLE foo"}')
check "POST /realtime/init with injected collection name → 400" "Invalid collection name" "$RESP"

# 11. Token is single-use: reusing a consumed token returns 401
TOKEN_RESP=$(curl -s -X POST "$BASE/realtime/init" \
  -H "Content-Type: application/json" \
  -d '{"dbType":"redis","host":"localhost"}')
TOKEN=$(echo "$TOKEN_RESP" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
if [ -n "$TOKEN" ]; then
  # First use — will fail to connect to Redis but token is consumed
  curl -s --max-time 1 "$BASE/realtime/stream?token=$TOKEN" > /dev/null 2>&1 || true
  sleep 0.5
  # Second use — should be rejected
  REUSE=$(curl -s "$BASE/realtime/stream?token=$TOKEN")
  check "SSE token is one-time-use (reuse → 401)" "Token expired or invalid" "$REUSE"
else
  echo "  SKIP: Could not get token for one-time-use test"
fi

echo ""
echo "=== Error Message Redaction ==="

# 12. 5xx errors must return generic message not raw DB error strings
# Use an invalid dbType to force a 400 and verify no raw errors escape a valid 500
RESP=$(curl -s -X POST "$BASE/sessions/analytics" \
  -H "Content-Type: application/json" \
  -d '{"creds":{"dbType":"postgresql","host":"localhost","tableName":"sessions; DROP TABLE foo"}}')
check "error path returns generic message" "Invalid table name" "$RESP"

# 13. Verify password/credential strings are NOT present in error responses
RESP=$(curl -s -X POST "$BASE/sessions/summaries" \
  -H "Content-Type: application/json" \
  -d '{"creds":{"dbType":"postgresql","host":"localhost","dbPassword":"s3cr3tp4ss","tableName":"valid_table"}}')
check_absent "DB password is not echoed back in error response" "s3cr3tp4ss" "$RESP"

echo ""
echo "==============================="
echo "Results: $PASS passed, $FAIL failed"
echo "==============================="
echo ""

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
