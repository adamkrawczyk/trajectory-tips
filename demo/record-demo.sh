#!/bin/bash
# Demo script for trajectory-tips recording
# Simulates: agent failure log → tip extraction → tip injection

set -e

# Setup temp demo environment
export TIPS_DIR="/tmp/demo-tips"
export OPENAI_API_KEY="${OPENAI_API_KEY}"
mkdir -p "$TIPS_DIR"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  trajectory-tips demo: from agent failure to memory"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

sleep 1

# Step 1: Show a realistic agent failure log
echo "📋 Step 1: Here's an agent failure log..."
echo ""
sleep 0.5

cat << 'FAILURE'
# Agent Session 2026-03-17

## Task: Deploy API to production

### Attempt 1 (FAILED)
- Ran: `docker build -t api:latest .`
- Ran: `docker push registry.io/api:latest`
- Ran: `ssh prod 'docker pull && docker-compose up -d'`
- ERROR: Container exits immediately with code 1
- Investigated: `docker logs` shows "exec format error"
- Root cause: Built on ARM Mac, deployed to x86 Linux
- Fix: Used `docker buildx build --platform linux/amd64`

### Attempt 2 (SUCCESS)
- Ran: `docker buildx build --platform linux/amd64 -t api:latest .`
- Pushed and deployed successfully
- Lesson: Always specify target platform for cross-arch deployments
FAILURE

sleep 2

echo ""
echo "📝 Step 2: Extract tips from the failure..."
echo ""
sleep 0.5

# Actually run tips extract with the demo log
cat << 'FAILURE' > /tmp/demo-agent-log.md
# Agent Session 2026-03-17

## Task: Deploy API to production

### Attempt 1 (FAILED)
- Ran: `docker build -t api:latest .`
- Ran: `docker push registry.io/api:latest`
- Ran: `ssh prod 'docker pull && docker-compose up -d'`
- ERROR: Container exits immediately with code 1
- Investigated: `docker logs` shows "exec format error"
- Root cause: Built on ARM Mac, deployed to x86 Linux
- Fix: Used `docker buildx build --platform linux/amd64`

### Attempt 2 (SUCCESS)
- Ran: `docker buildx build --platform linux/amd64 -t api:latest .`
- Pushed and deployed successfully
- Lesson: Always specify target platform for cross-arch deployments
FAILURE

tips extract /tmp/demo-agent-log.md --domain devops

echo ""
sleep 2

echo "🔍 Step 3: Query tips for a new deployment task..."
echo ""
sleep 0.5

tips query "deploying a docker container to production server"

echo ""
sleep 2

echo "💉 Step 4: Inject tips into the next agent prompt..."
echo ""
sleep 0.5

tips inject "Deploy the updated API to the production server"

echo ""
sleep 1
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ The agent now remembers what went wrong."
echo "  No fine-tuning. No RAG. Just structured YAML tips."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
