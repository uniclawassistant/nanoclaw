#!/bin/bash
# Build the NanoClaw agent container image.
#
# By default, builds the image at $CONTAINER_IMAGE (the same env var the host
# runtime reads in src/config.ts), so per-bot deployments stay in sync — set
# CONTAINER_IMAGE=nanoclaw-agent-unic:latest in unic's launchd plist and
# CONTAINER_IMAGE=nanoclaw-agent-chef:latest in chef's, and each bot rebuilds
# its own image without overwriting the other.
#
# Override priority (highest first):
#   1. positional argument:    ./build.sh my-image:tag
#   2. CONTAINER_IMAGE env var
#   3. legacy default:         nanoclaw-agent:latest
#
# Context is sent directly to the builder; on Apple Container ≥0.12.0 the
# .dockerignore reliably excludes agent-runner/{node_modules,dist} so the
# host-side build artifacts never leak into the image. The 0.11.0 trap-aside
# workaround for apple/container#1375 was removed once 0.12.x burned in.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE="${1:-${CONTAINER_IMAGE:-nanoclaw-agent:latest}}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-container}"

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE}"

${CONTAINER_RUNTIME} build -t "${IMAGE}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE}"
